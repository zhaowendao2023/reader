// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
// use std::path::PathBuf;
// use std::time::Instant;
use tauri_plugin_android_fs::{AndroidFsExt, PersistedUriPermission, FileUri, PersistableAccessMode};
use tauri::Manager;
// use tokio::fs::File;
// use tokio::io::{AsyncReadExt, BufReader};
#[tauri::command]
async fn pick_file(app: tauri::AppHandle) -> Result<String, String> {
    let api = app.android_fs();
    let selected_files = api
        .file_picker()
        .pick_files(None, &["*/*"])
        .map_err(|e| e.to_string())?;
    if selected_files.is_empty() {
        return Err("用户取消了选择".to_string());
    }

    let file_uri = &selected_files[0];

    api.take_persistable_uri_permission(file_uri)
        .map_err(|e| e.to_string())?;

    // 5. 将文件内容返回给前端
    Ok(format!("{}", file_uri.uri))
}

#[tauri::command]
fn clear_url(url: &str, app: tauri::AppHandle) {
    let api = app.android_fs();
    match api.get_all_persisted_uri_permissions() {
        Ok(permissions_iter) => {
            for permission in permissions_iter {
                let uri_str = match &permission {
                    PersistedUriPermission::File { uri, .. } => uri,
                    PersistedUriPermission::Dir { uri, .. } => uri,
                };
                if uri_str.uri == url {
                    if let Err(e) = api.release_persisted_uri_permission(&uri_str) {
                        eprintln!("释放权限失败 for URI {}: {}", url, e);
                    } else {
                        println!("成功释放权限 for URI: {}", url);
                    }
                    break;
                }
            }
        }
        Err(e) => {
            eprintln!("获取持久化URI权限时出错: {}", e);
            return;
        }
    }
    println!("权限已释放 for URI: {}", url);
}

#[tauri::command]
fn clear_all_url(app: tauri::AppHandle) {
    let api = app.android_fs();
    let _ = api.release_all_persisted_uri_permissions();
}

#[tauri::command]
fn get_test_file() -> Option<String> {
    std::env::var("READER_TEST_FILE").ok()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryEntry {
    name: String,
    uri: String,
    tree_uri: String,
    is_dir: bool,
}

/// 弹出 SAF 目录选择器并持久授权，返回目录 URI（仅 Android）
#[tauri::command]
fn pick_directory(app: tauri::AppHandle, initial_uri: Option<String>) -> Result<Option<FileUri>, String> {
    let api = app.android_fs();
    // 有上次的根目录时，把选择器定位到那里方便换根；首次让系统用默认视图打开，
    // 避免部分机型（如 MIUI）对定位到存储根弹出"无法使用此文件夹"的拒绝提示。
    let initial = initial_uri.map(|u| FileUri { uri: u, document_top_tree_uri: None });
    let picked = api.file_picker().pick_dir(initial.as_ref()).map_err(|e| e.to_string())?;
    if let Some(uri) = picked {
        api.take_persistable_uri_permission(&uri).map_err(|e| e.to_string())?;
        Ok(Some(uri))
    } else {
        Ok(None)
    }
}

/// 列出目录 URI 下的子项（仅 Android）
#[tauri::command]
fn list_directory(uri: String, tree_uri: String, app: tauri::AppHandle) -> Result<Vec<DirectoryEntry>, String> {
    let api = app.android_fs();
    let file_uri = FileUri { uri, document_top_tree_uri: Some(tree_uri) };
    let entries = api.read_dir(&file_uri).map_err(|e| e.to_string())?;
    Ok(entries
        .map(|e| DirectoryEntry {
            name: e.name().to_string(),
            uri: e.uri().uri.clone(),
            tree_uri: e.uri().document_top_tree_uri.clone().unwrap_or_default(),
            is_dir: e.is_dir(),
        })
        .collect())
}

/// 获取目录 URI 的显示名称（仅 Android）
#[tauri::command]
fn get_directory_name(uri: String, app: tauri::AppHandle) -> Result<String, String> {
    let api = app.android_fs();
    let file_uri = FileUri { uri, document_top_tree_uri: None };
    api.get_name(&file_uri).map_err(|e| e.to_string())
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

/// 检查 SAF 目录授权是否仍然有效（仅 Android）
#[tauri::command]
fn check_directory_grant(uri: String, tree_uri: String, app: tauri::AppHandle) -> bool {
    let api = app.android_fs();
    let file_uri = FileUri { uri, document_top_tree_uri: Some(tree_uri) };
    api.check_persisted_uri_permission(&file_uri, PersistableAccessMode::Read)
        .unwrap_or(false)
}

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
        .plugin(tauri_plugin_android_fs::init())
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
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            clear_url,
            clear_all_url,
            pick_file,
            get_test_file,
            list_drives,
            pick_directory,
            list_directory,
            get_directory_name,
            check_directory_grant,
            check_all_files_access,
            open_all_files_access_settings,
            get_primary_storage_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
