// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
// use std::path::PathBuf;
// use std::time::Instant;
mod db;
mod import;
mod mpv;
mod paths;
mod sync;
mod tags;
mod video;

use std::sync::Arc;

use tauri::Manager;
// use tokio::fs::File;
// use tokio::io::{AsyncReadExt, BufReader};
#[tauri::command]
fn get_test_file() -> Option<String> {
    std::env::var("READER_TEST_FILE").ok()
}

/// Reads and inflates a single archive entry on the Rust side, so CBZ image
/// loading avoids many small plugin-fs reads plus JS-side decompression.
#[tauri::command]
async fn read_cbz_entry(path: String, name: String) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
        let mut entry = archive.by_name(&name).map_err(|e| e.to_string())?;
        let mut out = Vec::with_capacity(entry.size() as usize);
        std::io::Read::read_to_end(&mut entry, &mut out).map_err(|e| e.to_string())?;
        Ok::<_, String>(out)
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(tauri::ipc::Response::new(bytes))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CoverCacheEntry {
    /// 64-char sha256 hex of the lowercased source path（与 JS calculateHash 一致）。
    /// Rust 侧当纯 id 用，仅允许 [0-9a-f]{64}，杜绝路径穿越。
    id: String,
    /// 缓存文件名白名单：cover.webp | cover.jpg | cover.raw
    file_name: String,
}

/// 批量读取磁盘封面缓存：一次 IPC 并行读完 N 个 cover-cache/v<version>/<id>/<file>。
///
/// 为什么：热路径每个封面要打两次 plugin-fs IPC（stat 源文件 + readFile 缓存），
/// Android WebView 的 bridge 每次往返固定 ~90ms，批量后摊到 ~1/24 次。
///
/// 返回原始二进制（tauri::ipc::Response），格式为长度前缀拼接：
///   [u32 LE len0][bytes0][u32 LE len1][bytes1]...
///   缺失条目 len = 0xFFFFFFFF 占位。JS 拿到 ArrayBuffer 按 len 切分即得各封面字节。
///
/// 备注：源文件 stat 仍走 JS 端缓存 cachedStat（60s TTL）——它要返回给
/// matchesMeta 做 mtime/size 校验，塞进二进制 payload 会破坏切分、塞 JSON 会
/// 多一次往返；且批量后 IPC 已近 0，stat 非瓶颈。本命令只负责读文件。
#[tauri::command]
async fn read_cover_cache_batch(
    app: tauri::AppHandle,
    cache_root: String,
    entries: Vec<CoverCacheEntry>,
) -> Result<tauri::ipc::Response, String> {
    if entries.is_empty() {
        return Ok(tauri::ipc::Response::new(Vec::new()));
    }
    if entries.len() > 512 {
        return Err("batch too large".into());
    }

    // cache_root 白名单：必须形如 cover-cache/v<N>，杜绝路径穿越。
    let valid_root = cache_root
        .strip_prefix("cover-cache/v")
        .map(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
        .unwrap_or(false);
    if !valid_root {
        return Err(format!("invalid cache_root: {cache_root}"));
    }

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    // 只允许白名单 id（64 位 hex，天然杜绝路径穿越）+ 白名单文件名。
    let is_valid_id = |id: &str| id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit());
    let is_valid_file = |f: &str| matches!(f, "cover.webp" | "cover.jpg" | "cover.raw");

    const MISSING: u32 = 0xFFFF_FFFF;
    let mut payload: Vec<u8> = Vec::new();
    for entry in &entries {
        if !is_valid_id(&entry.id) || !is_valid_file(&entry.file_name) {
            payload.extend_from_slice(&MISSING.to_le_bytes());
            continue;
        }
        let mut path = data_dir.join(&cache_root);
        path.push(&entry.id);
        path.push(&entry.file_name);
        match std::fs::read(&path) {
            Ok(bytes) => {
                let len = bytes.len();
                payload.extend_from_slice(&(len as u32).to_le_bytes());
                payload.extend_from_slice(&bytes);
            }
            Err(_) => payload.extend_from_slice(&MISSING.to_le_bytes()),
        }
    }

    Ok(tauri::ipc::Response::new(payload))
}

/// “所有文件访问权限”桥接（Android 11+ 的 MANAGE_EXTERNAL_STORAGE）
struct AllFilesAccess<R: tauri::Runtime>(tauri::plugin::PluginHandle<R>);

#[derive(serde::Deserialize)]
struct BoolValue {
    value: bool,
}

#[derive(serde::Deserialize)]
struct StringValue {
    value: String,
}

#[tauri::command]
fn check_all_files_access(app: tauri::AppHandle) -> bool {
    #[cfg(target_os = "android")]
    {
        let handle = app.state::<AllFilesAccess<tauri::Wry>>();
        handle
            .0
            .run_mobile_plugin::<BoolValue>("checkAllFilesAccess", "")
            .map(|r| r.value)
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "android"))]
    {
        false
    }
}

#[tauri::command]
fn open_all_files_access_settings(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let handle = app.state::<AllFilesAccess<tauri::Wry>>();
        handle.0.run_mobile_plugin::<serde_json::Value>("openAllFilesAccessSettings", "").map(|_| ()).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(())
    }
}

/// Android 系统返回键兜底：前端确认已到根路由时调用，真正退出应用。
/// （默认 WryActivity 的 finish() 会在 SPA 还有路由历史时就退出整个 App）
#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn get_primary_storage_path(app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        let handle = app.state::<AllFilesAccess<tauri::Wry>>();
        handle
            .0
            .run_mobile_plugin::<StringValue>("getPrimaryStoragePath", "")
            .map(|r| r.value)
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok("/storage/emulated/0".to_string())
    }
}

/// 列出可用盘符（Windows）
#[tauri::command]
fn list_drives() -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        let mut drives = Vec::new();
        for letter in b'A'..=b'Z' {
            let path = format!("{}:\\", letter as char);
            if std::path::Path::new(&path).exists() {
                drives.push(path);
            }
        }
        drives
    }
    #[cfg(not(target_os = "windows"))]
    {
        Vec::new()
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DirMetaEntry {
    name: String,
    is_dir: bool,
    mtime: Option<i64>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DirMeta {
    /// The directory's own last-modified time (ms), so a single call can tell
    /// whether any direct child changed since the last sync.
    self_mtime: Option<i64>,
    entries: Vec<DirMetaEntry>,
}

fn file_mtime_ms(path: &std::path::Path) -> Option<i64> {
    std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis() as i64))
}

/// Lists a directory with per-entry mtime. The frontend uses these mtimes to
/// serve unchanged subtrees straight from the SQLite index instead of
/// re-reading the whole tree on every entry/exit/delete.
///
/// Works on the real-filesystem path model: desktop and Android "all files
/// access" browsing (favorite roots are real `/storage/emulated/0/...`
/// paths) — direct `std::fs`, directory mtime included.
#[tauri::command]
fn read_dir_meta(path: String) -> Result<DirMeta, String> {
    let dir = std::path::Path::new(&path);
    let self_mtime = file_mtime_ms(dir);
    let rd = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
    let mut entries = Vec::new();
    for entry in rd {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let mtime = file_mtime_ms(&entry.path());
        entries.push(DirMetaEntry { name, is_dir, mtime });
    }
    Ok(DirMeta { self_mtime, entries })
}

// const CHUNK_SIZE: usize = 1024 * 1024; // 1MB

// #[tauri::command]
// async fn read_file_as_bytes() -> Result<Vec<u8>, String> {
//     // 记录开始时间
//     let start = Instant::now();
//     let path = PathBuf::from("F:\\comics\\[WaterRing] Chiori (Genshin Impact) [Decensored].cbz");

//     // 内存映射
//     let file = File::open(&path).await.map_err(|e| e.to_string())?;
//     let mut reader = BufReader::new(file);

//     let mut buffer = vec![0; CHUNK_SIZE];
//     let mut chunks = Vec::new();

//     loop {
//         let n = reader.read(&mut buffer).await.map_err(|e| e.to_string())?;
//         if n == 0 {
//             break;
//         }

//         // 截取实际读取部分
//         let chunk = buffer[..n].to_vec();
//         chunks.push(chunk);
//     }

//     // 计算耗时
//     let duration = start.elapsed();
//     println!("读取耗时: {:?}", duration);
//     Ok(chunks)
// }

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    builder
        .plugin(
            tauri::plugin::Builder::new("allfiles")
                .setup(|app: &tauri::AppHandle, api: tauri::plugin::PluginApi<tauri::Wry, ()>| {
                    #[cfg(target_os = "android")]
                    {
                        let handle = api
                            .register_android_plugin("com.tauri_app.reader", "AllFilesPlugin")
                            .map_err(|e| -> Box<dyn std::error::Error> { Box::new(e) })?;
                        app.manage(AllFilesAccess(handle));
                    }
                    Ok(())
                })
                .build(),
        )
        .plugin(
            tauri::plugin::Builder::new("video")
                .setup(|app: &tauri::AppHandle, api: tauri::plugin::PluginApi<tauri::Wry, ()>| {
                    #[cfg(target_os = "android")]
                    {
                        let handle = api
                            .register_android_plugin("com.tauri_app.reader", "VideoPlugin")
                            .map_err(|e| -> Box<dyn std::error::Error> { Box::new(e) })?;
                        app.manage(video::VideoAccess(handle));
                    }
                    Ok(())
                })
                .build(),
        )
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            app.manage(db::AppDb::open(app.handle())?);
            #[cfg(target_os = "windows")]
            {
                app.manage(mpv::MpvPool::default());
                app.manage(mpv::GrabPool::default());
                app.manage(mpv::GrabState(Arc::new(tokio::sync::Semaphore::new(
                    mpv::GRAB_CONCURRENCY,
                ))));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_test_file,
            read_cbz_entry,
            read_cover_cache_batch,
            sync::sync_favorite,
            sync::list_items,
            sync::search_items,
            sync::library_meta,
            sync::get_progress,
            sync::save_progress_map,
            sync::get_favorites,
            sync::add_favorite,
            sync::remove_favorite,
            sync::clear_library,
            sync::force_rescan,
            tags::list_tags,
            tags::get_item_tags,
            tags::set_item_tags,
            tags::rename_tag,
            tags::delete_tag,
            tags::get_tag_items,
            tags::set_tag_kind,
            tags::get_tag_samples,
            list_drives,
            read_dir_meta,
            check_all_files_access,
            open_all_files_access_settings,
            get_primary_storage_path,
            exit_app,
            mpv::mpv_play,
            mpv::mpv_set_bounds,
            mpv::mpv_pause,
            mpv::mpv_seek,
            mpv::mpv_get_volume,
            mpv::mpv_set_volume,
            mpv::mpv_set_speed,
            mpv::mpv_volume_debug,
            mpv::mpv_stop,
            mpv::mpv_stop_all,
            mpv::mpv_release,
            mpv::mpv_get_state,
            mpv::mpv_pool_info,
            mpv::mpv_grab_pool_info,
            mpv::mpv_grab_frame,
            video::video_play,
            video::video_set_bounds,
            video::video_pause,
            video::video_seek,
            video::video_get_volume,
            video::video_set_volume,
            video::video_set_speed,
            video::video_stop,
            video::video_stop_all,
            video::video_release,
            video::video_get_state,
            video::video_pool_info,
            video::video_grab_frame,
            video::video_set_screen_brightness,
            video::video_reset_screen_brightness
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
