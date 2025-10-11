// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::fs;
use tauri_plugin_android_fs::{AndroidFsExt, PersistedUriPermission};
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
async fn read_file_as_bytes(file_path: String) -> Result<Vec<u8>, String> {
    println!("成功释放权限 for URI: {}", file_path);
    // 使用 std::fs::read 一次性读取文件为 Vec<u8>
    let data = fs::read(&file_path).map_err(|e| e.to_string())?;
    Ok(data) // Vec<u8> 会被 Tauri 高效地传递给前端
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    builder
        .plugin(tauri_plugin_android_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            clear_url,
            clear_all_url,
            pick_file,
            read_file_as_bytes
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
