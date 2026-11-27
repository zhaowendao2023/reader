//! Android 原生视频播放 + 封面抓帧命令层。
//!
//! 镜像桌面端 `mpv_*` 命令的语义（play/set_bounds/pause/seek/volume/speed/
//! stop/release/get_state/grab_frame），让前端 `VideoPlayer.vue` 与
//! `bookData.js` 只需按 platform 切换命令前缀即可复用全部 UI 与轮询逻辑。
//!
//! 实现：每个命令经 `PluginHandle` 桥接到 Kotlin `VideoPlugin`（ExoPlayer 池 +
//! TextureView 叠加 + 状态缓存 + MediaMetadataRetriever 抓帧）。非 Android
//! 平台由前端按前缀分流不会调用；作为兜底，部分命令返回默认值、部分返回
//! `Err("video is Android-only")`。
//!
//! 命令层统一走 `android_call!` + `mobile_call`：每个命令都要维护
//! Android/非 Android 两套 cfg 分支，且 Android 分支的 `run_mobile_plugin`
//! 取值/映射/错误转换逐字相同；集中一处后新增命令只需写 payload 与兜底值，
//! 不会出现只改一侧 cfg 分支、另一侧悄悄漂移的情况。

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

// payload 会经 serde_json::to_value 序列化，因此绝大多数命令传
// serde_json::json!({...}) 对象；stopAll / resetScreenBrightness 沿用空字符串
// （Kotlin 侧不读参数，空字符串序列化为 JSON 字符串同样可用）。
#[cfg(target_os = "android")]
fn mobile_call<T: serde::de::DeserializeOwned>(
    app: &AppHandle,
    method: &str,
    payload: impl serde::Serialize,
) -> Result<T, String> {
    let handle = app.state::<VideoAccess<tauri::Wry>>();
    handle
        .0
        .run_mobile_plugin::<T>(method, payload)
        .map_err(|e| e.to_string())
}

/// Android 走插件调用，其它平台返回各自的兜底值（默认值或 Android-only 错误）。
/// `$fallback` 只在非 Android 分支求值。
///
/// Kotlin 侧对无返回值方法只回 OK，因此无返回值的命令统一按
/// `serde_json::Value` 接收再丢弃；有返回值的命令由额外 arm 接收转换闭包，
/// 让两条 cfg 分支在各自编译时都得到同一个 Rust 类型。
macro_rules! android_call {
    ($app:expr, $method:expr, $payload:expr, $fallback:expr) => {{
        #[cfg(target_os = "android")]
        {
            mobile_call::<serde_json::Value>(&$app, $method, $payload).map(|_| ())
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = (&$app, &$payload);
            $fallback
        }
    }};
    // 数值/状态类命令：插件返回值需要转换后才与兜底值同型；`$convert` 只在
    // Android 分支出现（VideoStateValue 等类型也只在 Android 存在）。
    ($app:expr, $method:expr, $payload:expr, $fallback:expr, $convert:expr) => {{
        #[cfg(target_os = "android")]
        {
            mobile_call(&$app, $method, $payload).map($convert)
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = (&$app, &$payload);
            $fallback
        }
    }};
}

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
    android_call!(
        app,
        "play",
        serde_json::json!({
            "id": id,
            "path": path,
            "x": x,
            "y": y,
            "width": width,
            "height": height,
        }),
        Err("video is Android-only".to_string())
    )
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
    android_call!(
        app,
        "setBounds",
        serde_json::json!({
            "id": id,
            "x": x,
            "y": y,
            "width": width,
            "height": height,
        }),
        Err("video is Android-only".to_string())
    )
}

#[tauri::command]
pub async fn video_pause(app: AppHandle, id: usize, paused: bool) -> Result<(), String> {
    android_call!(
        app,
        "pause",
        serde_json::json!({ "id": id, "paused": paused }),
        Err("video is Android-only".to_string())
    )
}

#[tauri::command]
pub async fn video_seek(app: AppHandle, id: usize, seconds: f64) -> Result<(), String> {
    android_call!(
        app,
        "seek",
        serde_json::json!({ "id": id, "seconds": seconds }),
        Err("video is Android-only".to_string())
    )
}

#[tauri::command]
pub async fn video_get_volume(app: AppHandle, id: usize) -> Result<f64, String> {
    android_call!(
        app,
        "getVolume",
        serde_json::json!({ "id": id }),
        Ok(100.0),
        |r: NumberValue| r.value
    )
}

#[tauri::command]
pub async fn video_set_volume(app: AppHandle, id: usize, volume: f64) -> Result<f64, String> {
    android_call!(
        app,
        "setVolume",
        serde_json::json!({ "id": id, "volume": volume }),
        Ok(volume),
        |r: NumberValue| r.value
    )
}

#[tauri::command]
pub async fn video_set_speed(app: AppHandle, id: usize, speed: f64) -> Result<f64, String> {
    android_call!(
        app,
        "setSpeed",
        serde_json::json!({ "id": id, "speed": speed }),
        Ok(speed.clamp(0.5, 3.0)),
        |r: NumberValue| r.value
    )
}

#[tauri::command]
pub async fn video_stop(app: AppHandle, id: usize) -> Result<(), String> {
    android_call!(
        app,
        "stop",
        serde_json::json!({ "id": id }),
        Err("video is Android-only".to_string())
    )
}

#[tauri::command]
pub async fn video_stop_all(app: AppHandle) -> Result<(), String> {
    android_call!(app, "stopAll", "", Err("video is Android-only".to_string()))
}

#[tauri::command]
pub async fn video_release(app: AppHandle, id: usize) -> Result<(), String> {
    android_call!(
        app,
        "release",
        serde_json::json!({ "id": id }),
        Err("video is Android-only".to_string())
    )
}

/// 设置屏幕亮度（0-100，Android 窗口级，左半屏上下滑手势）。
/// 首次设置记录系统亮度，离开视频页（video_release）时自动恢复。
#[tauri::command]
pub async fn video_set_screen_brightness(app: AppHandle, brightness: f64) -> Result<f64, String> {
    android_call!(
        app,
        "setScreenBrightness",
        serde_json::json!({ "brightness": brightness }),
        Ok(brightness),
        |r: NumberValue| r.value
    )
}

/// 恢复屏幕亮度（跟随系统）。前端离开播放页/取消手势时调用。
#[tauri::command]
pub async fn video_reset_screen_brightness(app: AppHandle) -> Result<(), String> {
    android_call!(app, "resetScreenBrightness", "", Ok(()))
}

/// 读取 ExoPlayer 缓存快照（前端 500ms 轮询，不占阻塞线程）。
#[tauri::command]
pub async fn video_get_state(app: AppHandle, id: usize) -> Result<VideoState, String> {
    android_call!(
        app,
        "getState",
        serde_json::json!({ "id": id }),
        Ok(VideoState {
            playing: false,
            paused: false,
            position: 0.0,
            duration: 0.0,
            speed: 1.0,
            path: String::new(),
            codec: None,
        }),
        |r: VideoStateValue| VideoState {
            playing: r.playing,
            paused: r.paused,
            position: r.position,
            duration: r.duration,
            speed: r.speed,
            path: r.path,
            codec: r.codec,
        }
    )
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
    android_call!(
        app,
        "grabFrame",
        match seek {
            Some(sec) => serde_json::json!({ "path": path, "seek": sec }),
            None => serde_json::json!({ "path": path }),
        },
        Err("video frame grab is Android-only".to_string()),
        |bytes: Vec<u8>| bytes
    )
}
