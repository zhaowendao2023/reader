//! Android 原生视频播放 + 封面抓帧命令层。
//!
//! 镜像桌面端 `mpv_*` 命令的完整语义（play/set_bounds/pause/seek/volume/speed/
//! stop/release/get_state/pool_info/grab_frame），让前端 `VideoPlayer.vue` 与
//! `bookData.js` 只需按 platform 切换命令前缀即可复用全部 UI 与轮询逻辑。
//!
//! 实现：每个命令经 `PluginHandle` 桥接到 Kotlin `VideoPlugin`（ExoPlayer 池 +
//! TextureView 叠加 + 状态缓存 + MediaMetadataRetriever 抓帧）。非 Android
//! 平台统一返回 `Err("video is Android-only")`，与 mpv 命令在非 Windows 的
//! 行为对称。

use tauri::AppHandle;
#[cfg(target_os = "android")]
use tauri::Manager;

/// Kotlin `VideoPlugin` 的 Rust 侧句柄（仅 Android 编译）。
#[cfg(target_os = "android")]
pub struct VideoAccess<R: tauri::Runtime>(pub tauri::plugin::PluginHandle<R>);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoState {
    playing: bool,
    paused: bool,
    position: f64,
    duration: f64,
    speed: f64,
    path: String,
    codec: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoSlotInfo {
    exists: bool,
    child: Option<u64>,
    valid: bool,
}

#[cfg(target_os = "android")]
#[derive(serde::Deserialize)]
struct VideoStateValue {
    playing: bool,
    paused: bool,
    position: f64,
    duration: f64,
    speed: f64,
    path: String,
    codec: Option<String>,
}

#[cfg(target_os = "android")]
#[derive(serde::Deserialize)]
struct NumberValue {
    value: f64,
}

// 注意：run_mobile_plugin 的 payload 会经 serde_json::to_value 序列化，
// 因此必须传 serde_json::json!({...}) 对象（传 String 会被包成带引号的
// 字符串字面值，Kotlin 侧 getArgs() 解析会失败）。

/// 启动播放并定位 TextureView 到前端 stage rect（CSS 像素 × dpr 已在前端算好）。
#[tauri::command]
pub async fn video_play(
    app: AppHandle,
    id: usize,
    path: String,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let handle = app.state::<VideoAccess<tauri::Wry>>();
        let payload = serde_json::json!({
            "id": id,
            "path": path,
            "x": x,
            "y": y,
            "width": width,
            "height": height,
        });
        handle
            .0
            .run_mobile_plugin::<serde_json::Value>("play", payload)
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, id, path, x, y, width, height);
        Err("video is Android-only".to_string())
    }
}

/// 移动 TextureView 到新的 stage rect（旋转/全屏/播放列表展开时由前端 onResize 触发）。
#[tauri::command]
pub async fn video_set_bounds(
    app: AppHandle,
    id: usize,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let handle = app.state::<VideoAccess<tauri::Wry>>();
        let payload = serde_json::json!({
            "id": id,
            "x": x,
            "y": y,
            "width": width,
            "height": height,
        });
        handle
            .0
            .run_mobile_plugin::<serde_json::Value>("setBounds", payload)
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, id, x, y, width, height);
        Err("video is Android-only".to_string())
    }
}

#[tauri::command]
pub async fn video_pause(app: AppHandle, id: usize, paused: bool) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let handle = app.state::<VideoAccess<tauri::Wry>>();
        let payload = serde_json::json!({ "id": id, "paused": paused });
        handle
            .0
            .run_mobile_plugin::<serde_json::Value>("pause", payload)
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, id, paused);
        Err("video is Android-only".to_string())
    }
}

#[tauri::command]
pub async fn video_seek(app: AppHandle, id: usize, seconds: f64) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let handle = app.state::<VideoAccess<tauri::Wry>>();
        let payload = serde_json::json!({ "id": id, "seconds": seconds });
        handle
            .0
            .run_mobile_plugin::<serde_json::Value>("seek", payload)
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, id, seconds);
        Err("video is Android-only".to_string())
    }
}

#[tauri::command]
pub async fn video_get_volume(app: AppHandle, id: usize) -> Result<f64, String> {
    #[cfg(target_os = "android")]
    {
        let handle = app.state::<VideoAccess<tauri::Wry>>();
        let payload = serde_json::json!({ "id": id });
        handle
            .0
            .run_mobile_plugin::<NumberValue>("getVolume", payload)
            .map(|r| r.value)
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, id);
        Ok(100.0)
    }
}

#[tauri::command]
pub async fn video_set_volume(app: AppHandle, id: usize, volume: f64) -> Result<f64, String> {
    #[cfg(target_os = "android")]
    {
        let handle = app.state::<VideoAccess<tauri::Wry>>();
        let payload = serde_json::json!({ "id": id, "volume": volume });
        handle
            .0
            .run_mobile_plugin::<NumberValue>("setVolume", payload)
            .map(|r| r.value)
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, id, volume);
        Ok(volume)
    }
}

#[tauri::command]
pub async fn video_set_speed(app: AppHandle, id: usize, speed: f64) -> Result<f64, String> {
    #[cfg(target_os = "android")]
    {
        let handle = app.state::<VideoAccess<tauri::Wry>>();
        let payload = serde_json::json!({ "id": id, "speed": speed });
        handle
            .0
            .run_mobile_plugin::<NumberValue>("setSpeed", payload)
            .map(|r| r.value)
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, id);
        Ok(speed.clamp(0.5, 2.0))
    }
}

#[tauri::command]
pub async fn video_stop(app: AppHandle, id: usize) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let handle = app.state::<VideoAccess<tauri::Wry>>();
        let payload = serde_json::json!({ "id": id });
        handle
            .0
            .run_mobile_plugin::<serde_json::Value>("stop", payload)
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, id);
        Err("video is Android-only".to_string())
    }
}

#[tauri::command]
pub async fn video_stop_all(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let handle = app.state::<VideoAccess<tauri::Wry>>();
        handle
            .0
            .run_mobile_plugin::<serde_json::Value>("stopAll", "")
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("video is Android-only".to_string())
    }
}

#[tauri::command]
pub async fn video_release(app: AppHandle, id: usize) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let handle = app.state::<VideoAccess<tauri::Wry>>();
        let payload = serde_json::json!({ "id": id });
        handle
            .0
            .run_mobile_plugin::<serde_json::Value>("release", payload)
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, id);
        Err("video is Android-only".to_string())
    }
}

/// 设置屏幕亮度（0-100，Android 窗口级，左半屏上下滑手势）。
/// 首次设置记录系统亮度，离开视频页（video_release）时自动恢复。
#[tauri::command]
pub async fn video_set_screen_brightness(app: AppHandle, brightness: f64) -> Result<f64, String> {
    #[cfg(target_os = "android")]
    {
        let handle = app.state::<VideoAccess<tauri::Wry>>();
        let payload = serde_json::json!({ "brightness": brightness });
        handle
            .0
            .run_mobile_plugin::<NumberValue>("setScreenBrightness", payload)
            .map(|r| r.value)
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, brightness);
        Ok(brightness)
    }
}

/// 恢复屏幕亮度（跟随系统）。前端离开播放页/取消手势时调用。
#[tauri::command]
pub async fn video_reset_screen_brightness(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let handle = app.state::<VideoAccess<tauri::Wry>>();
        handle
            .0
            .run_mobile_plugin::<serde_json::Value>("resetScreenBrightness", "")
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(())
    }
}

/// 读取 ExoPlayer 缓存快照（前端 500ms 轮询，不占阻塞线程）。
#[tauri::command]
pub async fn video_get_state(app: AppHandle, id: usize) -> Result<VideoState, String> {
    #[cfg(target_os = "android")]
    {
        let handle = app.state::<VideoAccess<tauri::Wry>>();
        let payload = serde_json::json!({ "id": id });
        let r = handle
            .0
            .run_mobile_plugin::<VideoStateValue>("getState", payload)
            .map_err(|e| e.to_string())?;
        Ok(VideoState {
            playing: r.playing,
            paused: r.paused,
            position: r.position,
            duration: r.duration,
            speed: r.speed,
            path: r.path,
            codec: r.codec,
        })
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, id);
        Ok(VideoState {
            playing: false,
            paused: false,
            position: 0.0,
            duration: 0.0,
            speed: 1.0,
            path: String::new(),
            codec: None,
        })
    }
}

/// 播放池诊断（对齐 mpv_pool_info）。
#[tauri::command]
pub async fn video_pool_info(app: AppHandle) -> Result<Vec<VideoSlotInfo>, String> {
    #[cfg(target_os = "android")]
    {
        let handle = app.state::<VideoAccess<tauri::Wry>>();
        let raw = handle
            .0
            .run_mobile_plugin::<Vec<VideoSlotInfo>>("poolInfo", "")
            .map_err(|e| e.to_string())?;
        Ok(raw)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(Vec::new())
    }
}

/// 抓视频封面帧：返回 PNG 字节（前端转 Blob）。seek 可选，缺省按桌面
/// FRAME_SEEK_RATIO=0.10 clamp [1s,120s] 策略（Kotlin 侧实现）。
///
/// Kotlin 插件经 `resolveObject(IntArray)` 把 PNG 字节编码为 JSON 数字数组，
/// serde 会把数字数组反序列化为 Vec<u8>（与 mpv_grab_frame 的 Vec<u8> 语义一致）。
#[tauri::command]
pub async fn video_grab_frame(
    app: AppHandle,
    path: String,
    seek: Option<f64>,
) -> Result<Vec<u8>, String> {
    #[cfg(target_os = "android")]
    {
        let handle = app.state::<VideoAccess<tauri::Wry>>();
        let payload = match seek {
            Some(sec) => serde_json::json!({ "path": path, "seek": sec }),
            None => serde_json::json!({ "path": path }),
        };
        handle
            .0
            .run_mobile_plugin::<Vec<u8>>("grabFrame", payload)
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, path, seek);
        Err("video frame grab is Android-only".to_string())
    }
}
