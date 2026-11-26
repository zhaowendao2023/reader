// 动态加载 libmpv-2.dll 的嵌入层。
//
// 线程模型（关键）：
//   每个 mpv 实例拥有一个专用泵线程，该线程运行 Windows 消息泵
//   （GetMessage/TranslateMessage/DispatchMessage），并串行执行所有
//   mpv 调用与窗口操作（CreateWindowEx / SetWindowPos / ShowWindow）。
//   mpv 的 d3d11 渲染依赖窗口线程存在消息泵；此前用 spawn_blocking
//   创建窗口后线程立即退出，导致画面永久丢失、EOF 卡死，这是根因。
//   所有命令经队列派发到泵线程，保证 libmpv 与 HWND 只在线程本身上被访问。
//   MpvPlayer 是控制器（可跨线程 Send），泵线程在 drop/释放时销毁。
//
//   抓帧（mpv_grab_frame）复用独立 GrabPool（抓帧专用池）：池内每槽一个
//   隐藏离屏实例（自带泵线程），批量提取封面时不重复创建/销毁实例与子窗口
//   （此前每抓一帧就新建线程 + libmpv 实例，带来 DLL 加载、d3d11 swapchain、
//   窗口创建/销毁的重复开销与窗口闪烁）。

use tauri::{AppHandle, Manager};

use std::sync::Arc;

#[cfg(target_os = "windows")]
use std::sync::Mutex;

#[cfg(target_os = "windows")]
use windows::Win32::Foundation::HWND;

pub const MPV_POOL_SIZE: usize = 3;

/// Representative-frame policy for video covers: 10% into the file, clamped
/// to [1s, 120s] so short clips stay near the start and long movies don't
/// seek to the end credits.
pub const FRAME_SEEK_RATIO: f64 = 0.10;
pub const FRAME_SEEK_MIN: f64 = 1.0;
pub const FRAME_SEEK_MAX: f64 = 120.0;
// 封面首帧快速路径：seek≈0 直接取 load_paused 后已就绪的首帧。
// 首帧若是黑场/纯色（PNG 体积极小），回退到近起点采样避免封面全黑。
pub const FIRST_FRAME_BLACK_PNG_BYTES: usize = 12 * 1024;
pub const FIRST_FRAME_FALLBACK_SEEK: f64 = 3.0;

/// Global throttle for thumbnail grabs (independent of the playback pool).
pub const GRAB_CONCURRENCY: usize = 2;

/// Number of hidden offscreen mpv instances kept alive and reused across
/// `mpv_grab_frame` calls. Previously every cover grab created a fresh pump
/// thread + libmpv instance (DLL load, d3d11 swapchain, window create/destroy
/// per call) — the batch-extraction cost and flicker spike. Sized to
/// GRAB_CONCURRENCY so each in-flight grab always finds a private slot and
/// never waits on the pool lock.
pub const GRAB_POOL_SIZE: usize = 2;

#[cfg(target_os = "windows")]
mod imp {
    use std::collections::VecDeque;
    use std::ffi::{c_char, c_int, c_void, CStr, CString};
    use std::path::{Path, PathBuf};
    use std::ptr;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{mpsc, Arc, Mutex};
    use std::thread::{self, JoinHandle};
    use std::time::Duration;

    use windows::core::{w, PCSTR, PCWSTR};
    use windows::Win32::Foundation::{FreeLibrary, HINSTANCE, HMODULE, HWND};
    use windows::Win32::System::LibraryLoader::{
        GetModuleHandleW, GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, DispatchMessageW, IsWindow, MSG, PeekMessageW,
        SetWindowPos, TranslateMessage, HWND_BOTTOM, PM_REMOVE, SWP_HIDEWINDOW, SWP_NOACTIVATE,
        SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, WM_QUIT, WS_CHILD, WS_DISABLED, WS_VISIBLE,
    };

    type MpvCreate = unsafe extern "C" fn() -> *mut c_void;
    type MpvInitialize = unsafe extern "C" fn(*mut c_void) -> c_int;
    type MpvSetOptionString = unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> c_int;
    type MpvSetPropertyString = unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> c_int;
    type MpvGetPropertyString = unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_char;
    type MpvCommand = unsafe extern "C" fn(*mut c_void, *const *const c_char) -> c_int;
    type MpvCommandString = unsafe extern "C" fn(*mut c_void, *const c_char) -> c_int;
    type MpvErrorString = unsafe extern "C" fn(c_int) -> *const c_char;
    type MpvFree = unsafe extern "C" fn(*mut c_void);
    type MpvTerminateDestroy = unsafe extern "C" fn(*mut c_void);

    /// 泵线程任务：在泵线程上执行。闭包捕获所需数据并返回 Result。
    type PumpTask = Box<dyn FnOnce() + Send>;

    /// 泵线程低频采样的播放状态快照。`mpv_get_state` 的 500ms 轮询读这份
    /// 缓存即可，无需每次做泵线程往返，也不占 spawn_blocking 线程。
    #[derive(Clone)]
    pub struct StateSnapshot {
        pub playing: bool,
        pub paused: bool,
        pub position: f64,
        pub duration: f64,
        pub speed: f64,
        pub path: Option<String>,
        pub codec: Option<String>,
    }

    impl Default for StateSnapshot {
        fn default() -> Self {
            Self {
                playing: false,
                paused: false,
                position: 0.0,
                duration: 0.0,
                speed: 1.0,
                path: None,
                codec: None,
            }
        }
    }

    /// 所有 mpv/窗口状态。只允许在泵线程上访问内部可变状态，
    /// 外部通过 Arc 上的方法（自身只读）拿快照。
    pub struct MpvObjects {
        _module: HMODULE,
        handle: *mut c_void,
        child: HWND,
        loaded: AtomicBool,
        // 状态缓存：泵线程在任务执行后/空闲节流时采样写入；外部读快照
        // 只是克隆几个小字符串（微秒级），不阻塞、不往返泵线程。
        cached: Mutex<StateSnapshot>,
        mpv_set_property_string: MpvSetPropertyString,
        mpv_get_property_string: MpvGetPropertyString,
        mpv_command: MpvCommand,
        mpv_command_string: MpvCommandString,
        mpv_error_string: MpvErrorString,
        mpv_free: MpvFree,
        mpv_terminate_destroy: MpvTerminateDestroy,
    }

    // libmpv 句柄在线程间转移仅发生在 drop 时（泵线程上销毁），
    // 且我们保证所有调用都串行在泵线程上，Send 是安全的。
    unsafe impl Send for MpvObjects {}
    unsafe impl Sync for MpvObjects {}

    fn locate_mpv_dll() -> Result<PathBuf, String> {
        if let Some(path) = std::env::var_os("READER_MPV_DLL") {
            let path = PathBuf::from(path);
            if path.exists() {
                return Ok(path);
            }
        }
        if let Ok(exe) = std::env::current_exe() {
            let candidate = exe
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join("libmpv-2.dll");
            if candidate.exists() {
                return Ok(candidate);
            }
        }
        Err("libmpv-2.dll not found; copy it next to reader.exe or set READER_MPV_DLL".to_string())
    }

    unsafe fn symbol<T: Copy>(module: HMODULE, name: &str) -> Result<T, String> {
        let name = CString::new(name).map_err(|e| e.to_string())?;
        let proc = GetProcAddress(module, PCSTR::from_raw(name.as_ptr().cast()));
        let Some(proc) = proc else {
            return Err(format!("missing mpv symbol: {name:?}"));
        };
        Ok(std::mem::transmute_copy(&proc))
    }

    impl MpvObjects {
        fn check(&self, code: c_int) -> Result<(), String> {
            if code >= 0 {
                return Ok(());
            }
            let message = unsafe {
                let ptr = (self.mpv_error_string)(code);
                if ptr.is_null() {
                    "unknown mpv error".to_string()
                } else {
                    CStr::from_ptr(ptr).to_string_lossy().into_owned()
                }
            };
            Err(format!("mpv error {code}: {message}"))
        }

        fn command(&self, args: &[&str]) -> Result<(), String> {
            let c_args: Vec<CString> = args
                .iter()
                .map(|arg| CString::new(*arg).map_err(|e| e.to_string()))
                .collect::<Result<_, _>>()?;
            let mut ptrs: Vec<*const c_char> = c_args.iter().map(|c| c.as_ptr()).collect();
            ptrs.push(ptr::null());
            let code = unsafe { (self.mpv_command)(self.handle, ptrs.as_ptr()) };
            self.check(code)
        }

        fn command_string(&self, args: &str) -> Result<(), String> {
            let args = CString::new(args).map_err(|e| e.to_string())?;
            let code = unsafe { (self.mpv_command_string)(self.handle, args.as_ptr()) };
            self.check(code)
        }

        fn set_property_string(&self, name: &str, value: &str) -> Result<(), String> {
            let name = CString::new(name).map_err(|e| e.to_string())?;
            let value = CString::new(value).map_err(|e| e.to_string())?;
            let code = unsafe {
                (self.mpv_set_property_string)(self.handle, name.as_ptr(), value.as_ptr())
            };
            self.check(code)
        }

        fn get_property_string(&self, name: &str) -> Option<String> {
            let name = CString::new(name).ok()?;
            let ptr = unsafe { (self.mpv_get_property_string)(self.handle, name.as_ptr()) };
            if ptr.is_null() {
                return None;
            }
            let value = unsafe { CStr::from_ptr(ptr) }
                .to_string_lossy()
                .into_owned();
            unsafe { (self.mpv_free)(ptr.cast()) };
            Some(value)
        }

        fn play(&self, path: &str) -> Result<(), String> {
            self.command(&["loadfile", path, "replace"])?;
            self.set_property_string("pause", "no")?;
            self.loaded.store(true, Ordering::SeqCst);
            Ok(())
        }

        fn pause(&self, paused: bool) -> Result<(), String> {
            self.set_property_string("pause", if paused { "yes" } else { "no" })
        }

        fn seek(&self, seconds: f64) -> Result<(), String> {
            self.command_string(&format!("seek {seconds} absolute+exact"))
        }

        fn set_bounds(&self, x: i32, y: i32, width: i32, height: i32) -> Result<(), String> {
            // Keep mpv below WebView2 so transparent page overlays can sit above the video.
            unsafe {
                SetWindowPos(
                    self.child,
                    Some(HWND_BOTTOM),
                    x,
                    y,
                    width,
                    height,
                    SWP_NOACTIVATE,
                )
            }
            .map_err(|e| format!("mpv bounds failed: {e}"))
        }

        fn set_visible(&self, visible: bool) -> Result<(), String> {
            unsafe {
                // 关键：SWP_NOMOVE|SWP_NOSIZE 必须带上，否则 SetWindowPos
                // 会按传入的 (0,0,0,0) 把窗口折叠成 0x0，画面消失（音频还在放）。
                let (insert_after, flags) = if visible {
                    (Some(HWND_BOTTOM), SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_NOMOVE | SWP_NOSIZE)
                } else {
                    (None, SWP_NOACTIVATE | SWP_HIDEWINDOW | SWP_NOMOVE | SWP_NOSIZE)
                };
                SetWindowPos(self.child, insert_after, 0, 0, 0, 0, flags)
            }
            .map_err(|e| format!("mpv visibility failed: {e}"))
        }

        fn stop(&self) -> Result<(), String> {
            // mpv 的 stop 命令会让 wid 子窗口失效并卡住，当前页面不使用它，
            // 改用 release 直接销毁实例。保留 pause 折叠作为安全降级路径。
            self.pause(true)?;
            self.set_bounds(0, 0, 0, 0)
        }

        fn needs_recreate(&self) -> bool {
            let window_valid = unsafe { IsWindow(Some(self.child)).as_bool() };
            if !window_valid {
                return true;
            }
            self.loaded.load(Ordering::SeqCst)
                && self
                    .get_property_string("idle-active")
                    .map(|v| v == "yes")
                    .unwrap_or(false)
        }

        fn state(&self) -> (bool, bool, f64, f64, f64, Option<String>, Option<String>) {
            let idle = self.get_property_string("idle-active").unwrap_or_default();
            let playing = idle != "yes";
            let paused = self.get_property_string("pause").unwrap_or_default() == "yes";
            let position = self
                .get_property_string("time-pos")
                .and_then(|v| v.parse().ok())
                .unwrap_or(0.0);
            let duration = self
                .get_property_string("duration")
                .and_then(|v| v.parse().ok())
                .unwrap_or(0.0);
            let speed = self
                .get_property_string("speed")
                .and_then(|v| v.parse().ok())
                .unwrap_or(1.0);
            let path = self.get_property_string("path");
            let codec = self.get_property_string("video-params/codec");
            (playing, paused, position, duration, speed, path, codec)
        }

        /// 采样当前播放状态写入缓存（仅泵线程调用；只读几个 mpv 属性，成本可忽略）。
        fn sample_state(&self) {
            let (playing, paused, position, duration, speed, path, codec) = self.state();
            if let Ok(mut guard) = self.cached.lock() {
                *guard = StateSnapshot {
                    playing,
                    paused,
                    position,
                    duration,
                    speed,
                    path,
                    codec,
                };
            }
        }

        /// 读取状态缓存快照：不做泵线程往返、不阻塞调用线程。
        fn snapshot(&self) -> StateSnapshot {
            self.cached.lock().map(|g| g.clone()).unwrap_or_default()
        }

        fn volume(&self) -> f64 {
            self.get_property_string("volume")
                .and_then(|v| v.parse().ok())
                .unwrap_or(100.0)
        }

        fn set_volume(&self, volume: f64) -> Result<f64, String> {
            self.command_string(&format!("set volume {:.0}", volume.clamp(0.0, 100.0)))?;
            Ok(self.volume())
        }

        fn speed(&self) -> f64 {
            self.get_property_string("speed")
                .and_then(|v| v.parse().ok())
                .unwrap_or(1.0)
        }

        fn set_speed(&self, speed: f64) -> Result<f64, String> {
            let speed = speed.clamp(0.5, 2.0);
            self.command_string(&format!("set speed {speed:.2}"))?;
            Ok(self.speed())
        }

        /// Start a paused load of `path`. The caller must give the pump loop
        /// time to process window messages between steps (d3d11 needs it).
        fn load_paused(&self, path: &str) -> Result<(), String> {
            self.set_property_string("pause", "yes")?;
            self.command(&["loadfile", path, "replace"])
        }

        /// Returns (has_video_format, duration_seconds).
        /// `video-params/codec` stays empty in this mpv build until playback
        /// actually renders; `video-format` becomes available as soon as the
        /// decoder initializes, so it is the reliable readiness signal.
        fn video_ready(&self) -> (bool, f64) {
            let has_video = self.get_property_string("video-format").is_some();
            let duration = self
                .get_property_string("duration")
                .and_then(|v| v.parse().ok())
                .unwrap_or(0.0);
            (has_video, duration)
        }

        fn current_pos(&self) -> f64 {
            self.get_property_string("time-pos")
                .and_then(|v| v.parse().ok())
                .unwrap_or(0.0)
        }

        fn screenshot_to(&self, path: &str) -> Result<(), String> {
            self.command(&["screenshot-to-file", path, "video"])
        }
    }

    impl Drop for MpvObjects {
        fn drop(&mut self) {
            unsafe {
                (self.mpv_terminate_destroy)(self.handle);
                let _ = DestroyWindow(self.child);
                let _ = FreeLibrary(self._module);
            }
        }
    }

    /// 控制器：可跨线程 Send。所有命令派发到泵线程执行。
    pub struct MpvPlayer {
        objects: Arc<MpvObjects>,
        // 泵线程基础设施（drop 时用来通知退出）
        queue: Arc<Mutex<VecDeque<PumpTask>>>,
        stop: Arc<AtomicBool>,
        thread: Option<JoinHandle<()>>,
    }

    impl MpvPlayer {
        /// 创建泵线程并在其上构建 mpv 实例（含子窗口）。
        pub fn create(
            parent: HWND,
            x: i32,
            y: i32,
            width: i32,
            height: i32,
        ) -> Result<Self, String> {
            Self::create_impl(parent, x, y, width, height, Vec::new())
        }

        /// 诊断专用：创建实例时额外注入 mpv 选项（如 log-file）。
        pub fn create_diag(
            parent: HWND,
            x: i32,
            y: i32,
            width: i32,
            height: i32,
            extra: Vec<(String, String)>,
        ) -> Result<Self, String> {
            Self::create_impl(parent, x, y, width, height, extra)
        }

        fn create_impl(
            parent: HWND,
            x: i32,
            y: i32,
            width: i32,
            height: i32,
            extra: Vec<(String, String)>,
        ) -> Result<Self, String> {
            let queue: Arc<Mutex<VecDeque<PumpTask>>> = Arc::new(Mutex::new(VecDeque::new()));
            let stop = Arc::new(AtomicBool::new(false));
            let (create_tx, create_rx) = mpsc::channel::<Result<Arc<MpvObjects>, String>>();
            let parent_raw = parent.0 as isize;

            let thread = {
                let queue = queue.clone();
                let stop = stop.clone();
                thread::Builder::new()
                    .name("mpv-pump".to_string())
                    .spawn(move || {
                        // 泵线程需要消息队列；GetMessageW 会隐式创建。
                        // 先执行创建任务，再进入消息循环。
                        let parent = HWND(parent_raw as *mut _);
                        let created =
                            unsafe { create_objects(parent, x, y, width, height, extra) };
                        let objects = match created {
                            Ok(o) => {
                                let arc = Arc::new(o);
                                let _ = create_tx.send(Ok(arc.clone()));
                                arc
                            }
                            Err(e) => {
                                let _ = create_tx.send(Err(e));
                                return;
                            }
                        };
                        pump_loop(queue, stop, objects);
                    })
                    .map_err(|e| format!("spawn mpv pump thread failed: {e}"))?
            };

            // 等待创建完成
            let objects = create_rx
                .recv()
                .map_err(|_| "mpv pump thread died during create".to_string())??;

            Ok(MpvPlayer {
                objects,
                queue,
                stop,
                thread: Some(thread),
            })
        }

        /// 在泵线程上执行 `f`，同步等待结果。
        fn pump<F, T>(&self, f: F) -> Result<T, String>
        where
            F: FnOnce(&MpvObjects) -> Result<T, String> + Send + 'static,
            T: Send + 'static,
        {
            let (tx, rx) = mpsc::channel::<Result<T, String>>();
            let objects = self.objects.clone();
            let task: PumpTask = Box::new(move || {
                let result = f(&objects);
                let _ = tx.send(result);
            });
            self.queue.lock().unwrap().push_back(task);
            rx.recv().map_err(|_| "mpv pump thread gone".to_string())?
        }

        pub fn play(&self, path: &str) -> Result<(), String> {
            let path = path.to_string();
            self.pump(move |o| o.play(&path))
        }

        pub fn pause(&self, paused: bool) -> Result<(), String> {
            self.pump(move |o| o.pause(paused))
        }

        pub fn seek(&self, seconds: f64) -> Result<(), String> {
            self.pump(move |o| o.seek(seconds))
        }

        pub fn volume(&self) -> f64 {
            self.pump(|o| Ok(o.volume())).unwrap_or(100.0)
        }

        pub fn set_volume(&self, volume: f64) -> Result<f64, String> {
            self.pump(move |o| o.set_volume(volume))
        }

        pub fn set_speed(&self, speed: f64) -> Result<f64, String> {
            self.pump(move |o| o.set_speed(speed))
        }

        pub fn set_bounds(&self, x: i32, y: i32, width: i32, height: i32) -> Result<(), String> {
            self.pump(move |o| o.set_bounds(x, y, width, height))
        }

        pub fn set_visible(&self, visible: bool) -> Result<(), String> {
            self.pump(move |o| o.set_visible(visible))
        }

        pub fn stop(&self) -> Result<(), String> {
            self.pump(|o| o.stop())
        }

        pub fn needs_recreate(&self) -> bool {
            self.pump(|o| Ok(o.needs_recreate())).unwrap_or(true)
        }

        /// 实时读状态（泵线程往返；诊断/测试用，低频调用）。
        #[allow(dead_code)]
        pub fn state(&self) -> (bool, bool, f64, f64, f64, Option<String>, Option<String>) {
            self.pump(|o| Ok(o.state()))
                .unwrap_or((false, false, 0.0, 0.0, 1.0, None, None))
        }

        /// 读泵线程维护的状态缓存快照：不做泵线程往返、不占阻塞线程。
        /// 高频轮询（VideoPlayer 500ms mpv_get_state）走这里。
        pub fn cached_state(&self) -> StateSnapshot {
            self.objects.snapshot()
        }

        /// Capture a representative frame from `path` on this hidden instance
        /// and return the PNG bytes. The instance is independent of the pool.
        ///
        /// Each mpv call is a separate pump task so the pump thread keeps
        /// servicing the window message loop (d3d11 rendering depends on it);
        /// long waits happen on the caller thread between tasks.
        ///
        /// `seek` semantics:
        /// - `None` → 10% 位置（`FRAME_SEEK_RATIO`，封面默认策略）；
        /// - `Some(s > 0.01)` → 显式 seek 到该秒数后截图；
        /// - `Some(s ≤ 0.01)` → **首帧快速路径**：`load_paused` 后第一帧已
        ///   解码就绪，跳过 seek→settle 整段（长视频深 seek 是最耗时部分），
        ///   只等 VO 呈现后直接截图；若首帧是黑场/纯色（PNG 体积极小），
        ///   自动回退到 `FIRST_FRAME_FALLBACK_SEEK` 采样，避免封面全黑。
        pub fn grab_frame(&self, path: &str, seek: Option<f64>) -> Result<Vec<u8>, String> {
            let path = path.to_string();
            self.pump(move |o| o.load_paused(&path))?;

            let start = std::time::Instant::now();
            let mut duration = 0.0;
            loop {
                let (has_video, dur) = self.pump(|o| Ok(o.video_ready()))?;
                duration = dur;
                if has_video && duration > 0.0 {
                    break;
                }
                if start.elapsed().as_secs_f64() >= 10.0 {
                    return Err("mpv: no decodable video stream (video-format never set)".to_string());
                }
                std::thread::sleep(Duration::from_millis(80));
            }

            // 封面首帧快速路径：seek≈0 时第一帧已就绪，跳过 seek/settle。
            let first_frame = seek.is_some_and(|s| s <= 0.01);
            if !first_frame {
                let target = match seek {
                    Some(s) => s.max(0.0),
                    None => (duration * super::FRAME_SEEK_RATIO)
                        .clamp(super::FRAME_SEEK_MIN, super::FRAME_SEEK_MAX),
                };
                self.pump(move |o| o.seek(target))?;

                let mut settled = false;
                while start.elapsed().as_secs_f64() < 15.0 {
                    let pos = self.pump(|o| Ok(o.current_pos()))?;
                    if pos > 0.0 && (pos - target).abs() <= 1.0 {
                        settled = true;
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(80));
                }
                if !settled {
                    return Err("mpv: frame grab timed out while seeking".to_string());
                }
            }

            // 截图并校验 PNG 魔数
            let screenshot_png = |player: &Self| -> Result<Vec<u8>, String> {
                static SHOT_ID: AtomicU64 = AtomicU64::new(0);
                let id = SHOT_ID.fetch_add(1, Ordering::Relaxed);
                let tmp = std::env::temp_dir()
                    .join(format!("reader-frame-{}-{id}.png", std::process::id()));
                let tmp_str = tmp.to_string_lossy().into_owned();
                let shot = player.pump(move |o| o.screenshot_to(&tmp_str));
                if let Err(error) = shot {
                    let _ = std::fs::remove_file(&tmp);
                    return Err(error);
                }
                let bytes = std::fs::read(&tmp).map_err(|error| {
                    let _ = std::fs::remove_file(&tmp);
                    format!("mpv screenshot read failed: {error}")
                })?;
                let _ = std::fs::remove_file(&tmp);
                if bytes.len() < 8 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
                    return Err("mpv screenshot returned invalid png".to_string());
                }
                Ok(bytes)
            };

            // Give the VO a moment to present the target frame. 首帧路径下
            // 从 0 起渲染，多留一点窗口保证画面已呈现。
            std::thread::sleep(Duration::from_millis(if first_frame { 320 } else { 250 }));
            let mut bytes = screenshot_png(self)?;

            // 首帧疑似黑场/纯色（PNG 体积极小）→ 补一次近起点采样，
            // 避免封面全黑；只有采样成功才覆盖（失败保留首帧，不报错）。
            if first_frame
                && duration > super::FIRST_FRAME_FALLBACK_SEEK + 0.5
                && bytes.len() < super::FIRST_FRAME_BLACK_PNG_BYTES
            {
                let fb_target = super::FIRST_FRAME_FALLBACK_SEEK;
                self.pump(move |o| o.seek(fb_target))?;
                let fb_start = std::time::Instant::now();
                let mut settled = false;
                while fb_start.elapsed().as_secs_f64() < 4.0 {
                    let pos = self.pump(|o| Ok(o.current_pos()))?;
                    if pos > 0.0 && (pos - fb_target).abs() <= 1.0 {
                        settled = true;
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(80));
                }
                if settled {
                    std::thread::sleep(Duration::from_millis(250));
                    if let Ok(again) = screenshot_png(self) {
                        bytes = again;
                    }
                }
            }
            Ok(bytes)
        }
    }

    impl Drop for MpvPlayer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    fn create_objects(
        parent: HWND,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        extra: Vec<(String, String)>,
    ) -> Result<MpvObjects, String> {
        unsafe { create_objects_unsafe(parent, x, y, width, height, extra) }
    }

    unsafe fn create_objects_unsafe(
        parent: HWND,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        extra: Vec<(String, String)>,
    ) -> Result<MpvObjects, String> {
        let dll = locate_mpv_dll()?;
        let wide: Vec<u16> = dll
            .to_string_lossy()
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let module = LoadLibraryExW(
            PCWSTR::from_raw(wide.as_ptr()),
            None,
            LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
        )
        .map_err(|e| format!("load libmpv failed: {e}"))?;

        let module_handle = HMODULE(module.0);
        let mpv_create: MpvCreate = symbol(module_handle, "mpv_create")?;
        let mpv_initialize: MpvInitialize = symbol(module_handle, "mpv_initialize")?;
        let mpv_set_option_string: MpvSetOptionString =
            symbol(module_handle, "mpv_set_option_string")?;
        let mpv_set_property_string: MpvSetPropertyString =
            symbol(module_handle, "mpv_set_property_string")?;
        let mpv_get_property_string: MpvGetPropertyString =
            symbol(module_handle, "mpv_get_property_string")?;
        let mpv_command: MpvCommand = symbol(module_handle, "mpv_command")?;
        let mpv_command_string: MpvCommandString = symbol(module_handle, "mpv_command_string")?;
        let mpv_error_string: MpvErrorString = symbol(module_handle, "mpv_error_string")?;
        let mpv_free: MpvFree = symbol(module_handle, "mpv_free")?;
        let mpv_terminate_destroy: MpvTerminateDestroy =
            symbol(module_handle, "mpv_terminate_destroy")?;

        let instance = GetModuleHandleW(None).ok().map(|m| HINSTANCE(m.0));
        let child = CreateWindowExW(
            Default::default(),
            w!("STATIC"),
            w!("mpv-surface"),
            // WS_DISABLED：禁用窗口不接收鼠标消息，点击/光标会穿透到 WebView2，
            // 渲染不受影响；这是原生子窗口混合嵌入下修光标的最小改动。
            WS_CHILD | WS_VISIBLE | WS_DISABLED,
            x,
            y,
            width,
            height,
            Some(parent),
            None,
            instance,
            None,
        )
        .map_err(|e| format!("create mpv child window failed: {e}"))?;

        let handle = mpv_create();
        if handle.is_null() {
            let _ = DestroyWindow(child);
            return Err("mpv_create returned null".to_string());
        }
        let objects = MpvObjects {
            _module: module_handle,
            handle,
            child,
            loaded: AtomicBool::new(false),
            cached: Mutex::new(StateSnapshot::default()),
            mpv_set_property_string,
            mpv_get_property_string,
            mpv_command,
            mpv_command_string,
            mpv_error_string,
            mpv_free,
            mpv_terminate_destroy,
        };

        let wid = CString::new((child.0 as isize).to_string()).map_err(|e| e.to_string())?;
        let options = [
            ("wid", wid.as_c_str()),
            ("vo", c"gpu"),
            ("gpu-context", c"d3d11"),
            ("hwdec", c"auto"),
            ("keep-open", c"no"),
            ("osc", c"no"),
            ("load-scripts", c"no"),
            ("input-default-bindings", c"no"),
            ("terminal", c"no"),
            ("keepaspect", c"yes"),
            ("video-unscaled", c"no"),
            ("osd-level", c"0"),
        ];
        for (key, value) in options {
            let key = CString::new(key).map_err(|e| e.to_string())?;
            objects
                .check(mpv_set_option_string(handle, key.as_ptr(), value.as_ptr()))
                .map_err(|e| {
                    let _ = DestroyWindow(child);
                    e
                })?;
        }
        for (key, value) in extra {
            let key = CString::new(key).map_err(|e| e.to_string())?;
            let value = CString::new(value).map_err(|e| e.to_string())?;
            objects
                .check(mpv_set_option_string(handle, key.as_ptr(), value.as_ptr()))
                .map_err(|e| {
                    let _ = DestroyWindow(child);
                    e
                })?;
        }

        let code = mpv_initialize(handle);
        objects.check(code).map_err(|e| {
            let _ = DestroyWindow(child);
            e
        })?;
        // 光标相关是运行时属性，必须在 initialize 之后设置。
        // input-cursor=no：mpv 不改变光标形状（否则鼠标移到视频区光标会变）。
        // cursor-autohide=always：永不在播放中隐藏光标。
        for (key, value) in [
            ("input-cursor", c"no"),
            ("cursor-autohide", c"always"),
            ("panscan", c"0"),
        ] {
            let key = CString::new(key).map_err(|e| e.to_string())?;
            objects
                .check(mpv_set_option_string(handle, key.as_ptr(), value.as_ptr()))
                .map_err(|e| {
                    let _ = DestroyWindow(child);
                    e
                })?;
        }
        objects.set_bounds(x, y, width, height)?;
        Ok(objects)
    }

    /// 泵线程主循环：GetMessage 处理窗口消息，队列任务在消息间隙执行。
    fn pump_loop(
        queue: Arc<Mutex<VecDeque<PumpTask>>>,
        stop: Arc<AtomicBool>,
        objects: Arc<MpvObjects>,
    ) {
        let mut msg = MSG::default();
        // 状态缓存采样：任务执行后立即刷新（play/pause/seek 后前端下一轮
        // 轮询立刻拿到新状态），空闲时按固定间隔刷新（播放进度推进）。
        // 采样只读几个 mpv 属性，成本可忽略，换来 500ms 轮询零泵线程往返。
        const STATE_SAMPLE_INTERVAL: Duration = Duration::from_millis(250);
        let mut last_sample = std::time::Instant::now() - STATE_SAMPLE_INTERVAL;
        loop {
            // 先执行队列中的任务
            let mut ran_task = false;
            loop {
                let task = queue.lock().unwrap().pop_front();
                match task {
                    Some(task) => {
                        ran_task = true;
                        task();
                    }
                    None => break,
                }
            }
            if ran_task || last_sample.elapsed() >= STATE_SAMPLE_INTERVAL {
                objects.sample_state();
                last_sample = std::time::Instant::now();
            }
            if stop.load(Ordering::SeqCst) {
                break;
            }
            // 处理窗口消息；无消息时短暂休眠以便轮询队列/stop。
            if unsafe { PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() } {
                if msg.message == WM_QUIT {
                    break;
                }
                unsafe {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            } else {
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        // objects 在此函数结束时 drop（terminate_destroy + DestroyWindow）
        drop(objects);
    }
}

#[cfg(target_os = "windows")]
unsafe impl Send for imp::MpvPlayer {}

#[cfg(target_os = "windows")]
pub struct MpvPool(pub Arc<Mutex<Vec<Option<imp::MpvPlayer>>>>);

#[cfg(not(target_os = "windows"))]
pub struct MpvPool;

#[cfg(target_os = "windows")]
impl Default for MpvPool {
    fn default() -> Self {
        Self(Arc::new(Mutex::new((0..MPV_POOL_SIZE).map(|_| None).collect())))
    }
}

/// Reusable hidden instances for frame grabbing, independent of the playback
/// pool: covers must never disturb (or be disturbed by) the visible player
/// slots, and per-grab churn shrinks to a one-time creation per slot.
#[cfg(target_os = "windows")]
pub struct GrabPool(pub Arc<Mutex<Vec<Option<imp::MpvPlayer>>>>);

#[cfg(not(target_os = "windows"))]
pub struct GrabPool;

/// Concurrency gate for `mpv_grab_frame`; independent of the playback pool.
pub struct GrabState(pub Arc<tokio::sync::Semaphore>);

#[cfg(target_os = "windows")]
impl Default for GrabPool {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(
            (0..GRAB_POOL_SIZE).map(|_| None).collect(),
        )))
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvState {
    playing: bool,
    paused: bool,
    position: f64,
    duration: f64,
    speed: f64,
    path: Option<String>,
    codec: Option<String>,
}

#[tauri::command]
pub async fn mpv_play(
    app: AppHandle,
    id: usize,
    path: String,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let handle = app.state::<MpvPool>().0.clone();
        let window = app.get_webview_window("main").ok_or("no main window")?;
        let parent = window.hwnd().map_err(|e| e.to_string())?;
        let parent_raw = parent.0 as isize;
        // 前端首次挂载时 stage 尺寸可能还没就绪（0x0），用父窗口 client 区兜底。
        let (x, y, width, height) = if width <= 0 || height <= 0 {
            let w = window.inner_size().map_err(|e| e.to_string())?;
            (0, 0, w.width as i32, w.height as i32)
        } else {
            (x, y, width, height)
        };
        tauri::async_runtime::spawn_blocking(move || {
            let mut guard = handle
                .lock()
                .map_err(|_| "mpv state lock poisoned".to_string())?;
            if id >= MPV_POOL_SIZE {
                return Err(format!("mpv slot {id} out of range"));
            }
            let slot = guard
                .get_mut(id)
                .ok_or_else(|| format!("mpv slot {id} missing"))?;
            if slot.is_none() {
                let parent = HWND(parent_raw as *mut _);
                *slot = Some(imp::MpvPlayer::create(parent, x, y, width, height)?);
            }
            let parent = HWND(parent_raw as *mut _);
            if slot.as_ref().unwrap().needs_recreate() {
                *slot = None;
                *slot = Some(imp::MpvPlayer::create(parent, x, y, width, height)?);
            }
            let player = slot.as_mut().unwrap();
            player.set_bounds(x, y, width, height)?;
            player.set_visible(true)?;
            player.play(&path)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, id, path, x, y, width, height);
        Err("mpv spike is Windows-only".to_string())
    }
}

#[tauri::command]
pub async fn mpv_set_bounds(
    app: AppHandle,
    id: usize,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let handle = app.state::<MpvPool>().0.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mut guard = handle
                .lock()
                .map_err(|_| "mpv state lock poisoned".to_string())?;
            if let Some(player) = guard
                .get_mut(id)
                .ok_or_else(|| format!("mpv slot {id} missing"))?
                .as_mut()
            {
                player.set_bounds(x, y, width, height)?;
            }
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, id, x, y, width, height);
        Err("mpv spike is Windows-only".to_string())
    }
}

#[tauri::command]
pub async fn mpv_pause(app: AppHandle, id: usize, paused: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let handle = app.state::<MpvPool>().0.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mut guard = handle
                .lock()
                .map_err(|_| "mpv state lock poisoned".to_string())?;
            if let Some(player) = guard
                .get_mut(id)
                .ok_or_else(|| format!("mpv slot {id} missing"))?
                .as_mut()
            {
                player.pause(paused)?;
            }
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, id, paused);
        Err("mpv spike is Windows-only".to_string())
    }
}

#[tauri::command]
pub async fn mpv_seek(app: AppHandle, id: usize, seconds: f64) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let handle = app.state::<MpvPool>().0.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mut guard = handle
                .lock()
                .map_err(|_| "mpv state lock poisoned".to_string())?;
            if let Some(player) = guard
                .get_mut(id)
                .ok_or_else(|| format!("mpv slot {id} missing"))?
                .as_mut()
            {
                player.seek(seconds)?;
            }
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, id, seconds);
        Err("mpv spike is Windows-only".to_string())
    }
}

#[tauri::command]
pub async fn mpv_get_volume(app: AppHandle, id: usize) -> Result<f64, String> {
    #[cfg(target_os = "windows")]
    {
        let handle = app.state::<MpvPool>().0.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mut guard = handle
                .lock()
                .map_err(|_| "mpv state lock poisoned".to_string())?;
            if let Some(player) = guard
                .get_mut(id)
                .ok_or_else(|| format!("mpv slot {id} missing"))?
                .as_mut()
            {
                Ok(player.volume())
            } else {
                Ok(100.0)
            }
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, id);
        Ok(100.0)
    }
}

#[tauri::command]
pub async fn mpv_set_volume(app: AppHandle, id: usize, volume: f64) -> Result<f64, String> {
    #[cfg(target_os = "windows")]
    {
        let handle = app.state::<MpvPool>().0.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mut guard = handle
                .lock()
                .map_err(|_| "mpv state lock poisoned".to_string())?;
            if let Some(player) = guard
                .get_mut(id)
                .ok_or_else(|| format!("mpv slot {id} missing"))?
                .as_mut()
            {
                Ok(player.set_volume(volume)?)
            } else {
                Ok(100.0)
            }
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, id, volume);
        Ok(100.0)
    }
}

#[tauri::command]
pub async fn mpv_set_speed(app: AppHandle, id: usize, speed: f64) -> Result<f64, String> {
    #[cfg(target_os = "windows")]
    {
        let handle = app.state::<MpvPool>().0.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mut guard = handle
                .lock()
                .map_err(|_| "mpv state lock poisoned".to_string())?;
            if let Some(player) = guard
                .get_mut(id)
                .ok_or_else(|| format!("mpv slot {id} missing"))?
                .as_mut()
            {
                player.set_speed(speed)
            } else {
                Ok(1.0)
            }
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, id);
        Ok(speed.clamp(0.5, 2.0))
    }
}

#[tauri::command]
pub async fn mpv_stop(app: AppHandle, id: usize) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let handle = app.state::<MpvPool>().0.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mut guard = handle
                .lock()
                .map_err(|_| "mpv state lock poisoned".to_string())?;
            if let Some(player) = guard
                .get_mut(id)
                .ok_or_else(|| format!("mpv slot {id} missing"))?
                .as_mut()
            {
                player.stop()?;
            }
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, id);
        Err("mpv spike is Windows-only".to_string())
    }
}

#[tauri::command]
pub async fn mpv_stop_all(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let handle = app.state::<MpvPool>().0.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mut guard = handle
                .lock()
                .map_err(|_| "mpv state lock poisoned".to_string())?;
            for slot in guard.iter_mut() {
                *slot = None;
            }
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Err("mpv spike is Windows-only".to_string())
    }
}

#[tauri::command]
pub async fn mpv_release(app: AppHandle, id: usize) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let handle = app.state::<MpvPool>().0.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mut guard = handle
                .lock()
                .map_err(|_| "mpv state lock poisoned".to_string())?;
            if let Some(slot) = guard.get_mut(id) {
                *slot = None;
            }
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, id);
        Err("mpv spike is Windows-only".to_string())
    }
}

#[tauri::command]
pub async fn mpv_get_state(app: AppHandle, id: usize) -> Result<MpvState, String> {
    #[cfg(target_os = "windows")]
    {
        let handle = app.state::<MpvPool>().0.clone();
        // 读泵线程维护的状态缓存快照：临界区只克隆几个小字符串（微秒级），
        // 不再 spawn_blocking 占阻塞线程、不再做泵线程往返。500ms 轮询不再
        // 与其它 mpv 命令串行争池锁（play/seek 等仍走 spawn_blocking 泵线程）。
        let guard = handle
            .lock()
            .map_err(|_| "mpv state lock poisoned".to_string())?;
        let slot = guard
            .get(id)
            .ok_or_else(|| format!("mpv slot {id} missing"))?;
        let Some(player) = slot.as_ref() else {
            return Ok(MpvState {
                playing: false,
                paused: false,
                position: 0.0,
                duration: 0.0,
                speed: 1.0,
                path: None,
                codec: None,
            });
        };
        let s = player.cached_state();
        Ok(MpvState {
            playing: s.playing,
            paused: s.paused,
            position: s.position,
            duration: s.duration,
            speed: s.speed,
            path: s.path,
            codec: s.codec,
        })
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, id);
        Ok(MpvState {
            playing: false,
            paused: false,
            position: 0.0,
            duration: 0.0,
            speed: 1.0,
            path: None,
            codec: None,
        })
    }
}

#[tauri::command]
pub async fn mpv_grab_frame(
    app: AppHandle,
    path: String,
    seek: Option<f64>,
) -> Result<Vec<u8>, String> {
    #[cfg(target_os = "windows")]
    {
        let sem = app.state::<GrabState>().0.clone();
        let _permit = sem.acquire().await.map_err(|e| e.to_string())?;
        let window = app.get_webview_window("main").ok_or("no main window")?;
        let parent = window.hwnd().map_err(|e| e.to_string())?;
        let parent_raw = parent.0 as isize;
        let pool = app.state::<GrabPool>().0.clone();
        tauri::async_runtime::spawn_blocking(move || {
            // Check a player out of the grab pool: reuse an existing hidden
            // instance so batch covers don't rebuild a pump thread + libmpv
            // context per file. The pool lock is only held to take/put back —
            // the grab itself runs outside the lock so concurrent grabs don't
            // serialize on it (GRAB_POOL_SIZE == GRAB_CONCURRENCY guarantees
            // every in-flight grab gets a private slot).
            let (slot, mut player) = {
                let mut guard = pool
                    .lock()
                    .map_err(|_| "mpv grab pool lock poisoned".to_string())?;
                match guard.iter().position(|s| s.is_some()) {
                    Some(i) => (i, Some(guard[i].take().expect("slot was Some"))),
                    None => {
                        let i = guard.iter().position(|s| s.is_none()).unwrap_or(0);
                        (i, None)
                    }
                }
            };
            // Hidden, offscreen child window: WS_VISIBLE child of a visible
            // parent but placed far outside the screen, so d3d11 keeps a valid
            // swapchain without ever being seen.
            let parent = HWND(parent_raw as *mut _);
            let mut player = match player {
                Some(p) => p,
                None => imp::MpvPlayer::create(parent, -32000, -32000, 320, 180)?,
            };
            if player.needs_recreate() {
                // Discard a dead/broken instance (e.g. the main window was
                // recreated, or the previous grab left it idle); recreate
                // against the current parent.
                player = imp::MpvPlayer::create(parent, -32000, -32000, 320, 180)?;
            }
            let result = player.grab_frame(&path, seek);
            // Return the instance to its slot even on failure; needs_recreate
            // guards the next borrower against a poisoned slot.
            let mut guard = pool
                .lock()
                .map_err(|_| "mpv grab pool lock poisoned".to_string())?;
            guard[slot] = Some(player);
            drop(guard);
            result
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, path, seek);
        Err("mpv frame grab is Windows-only".to_string())
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;
    use windows::Win32::UI::WindowsAndMessaging::DestroyWindow;

    fn make_parent() -> windows::Win32::Foundation::HWND {
        use windows::Win32::Foundation::HINSTANCE;
        use windows::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
        };
        use windows::core::w;
        let instance = unsafe { GetModuleHandleW(None) }
            .ok()
            .map(|m| HINSTANCE(m.0));
        let parent = unsafe {
            CreateWindowExW(
                Default::default(),
                w!("STATIC"),
                w!("reader-thumb-test"),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                40,
                40,
                480,
                320,
                None,
                None,
                instance,
                None,
            )
        }
        .expect("test window should be created");
        parent
    }

    fn fixture() -> String {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("scripts")
            .join("test10bit.mkv")
            .to_string_lossy()
            .into_owned()
    }

    fn mpv_dll() -> bool {
        std::env::var_os("READER_MPV_DLL")
            .map(|p| std::path::Path::new(&p).exists())
            .unwrap_or(false)
            || std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("libmpv-2.dll")
                .exists()
    }

    // The parent window is owned by the test thread. mpv's pump thread creates
    // the child under it, and cross-thread window messages (WM_PARENTNOTIFY
    // etc.) must be serviced by the owner thread, so the grab runs on a worker
    // thread while this thread pumps messages until it finishes.
    fn grab_with<F, T>(x: i32, y: i32, tag: &str, run: F) -> Result<T, String>
    where
        F: FnOnce(&imp::MpvPlayer) -> Result<T, String> + Send + 'static,
        T: Send + 'static,
    {
        use windows::Win32::UI::WindowsAndMessaging::{
            DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE, WM_QUIT,
        };

        let log = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("mpv-{tag}.log"));
        let parent = make_parent();
        let parent_raw = parent.0 as isize;
        let worker = std::thread::spawn(move || {
            let parent = HWND(parent_raw as *mut _);
            let player = imp::MpvPlayer::create_diag(
                parent,
                x,
                y,
                320,
                180,
                vec![("log-file".to_string(), log.to_string_lossy().into_owned())],
            )?;
            let result = run(&player);
            drop(player);
            unsafe { let _ = DestroyWindow(parent); }
            result
        });

        loop {
            unsafe {
                let mut msg = MSG::default();
                while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                    if msg.message == WM_QUIT {
                        break;
                    }
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
            if worker.is_finished() {
                return worker
                    .join()
                    .map_err(|_| "grab worker panicked".to_string())?;
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    }

    #[test]
    fn diag_offscreen_frame_grab() {
        if !mpv_dll() || !std::path::Path::new(&fixture()).exists() {
            eprintln!("skipping (libmpv or fixture missing)");
            return;
        }
        let fixture = fixture();
        let bytes = grab_with(-32000, -32000, "offscreen", move |player| {
            player.grab_frame(&fixture, Some(1.0))
        })
        .expect("offscreen frame grab should succeed");
        assert!(bytes.len() > 1000, "png too small: {}", bytes.len());
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n", "not a png");
        println!("OFFSCREEN OK: png {} bytes", bytes.len());
    }

    #[test]
    fn diag_visible_frame_grab() {
        if !mpv_dll() || !std::path::Path::new(&fixture()).exists() {
            eprintln!("skipping (libmpv or fixture missing)");
            return;
        }
        let fixture = fixture();
        let bytes = grab_with(50, 50, "visible", move |player| {
            player.grab_frame(&fixture, Some(1.0))
        })
        .expect("visible frame grab should succeed");
        assert!(bytes.len() > 1000, "png too small: {}", bytes.len());
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n", "not a png");
        println!("VISIBLE OK: png {} bytes", bytes.len());
    }

    /// The grab pool hands the same hidden instance to consecutive grabs —
    /// this guards the reuse path: a second grab on an already-used player
    /// (file loaded + paused from the first grab) must succeed and yield a
    /// fresh PNG without any recreation.
    #[test]
    fn diag_reused_instance_grab() {
        if !mpv_dll() || !std::path::Path::new(&fixture()).exists() {
            eprintln!("skipping (libmpv or fixture missing)");
            return;
        }
        let fixture = fixture();
        let (first, second) = grab_with(-32000, -32000, "reuse", move |player| {
            let a = player.grab_frame(&fixture, Some(1.0))?;
            let b = player.grab_frame(&fixture, Some(3.0))?;
            Ok((a, b))
        })
        .expect("reused instance grabs should succeed");
        for (label, bytes) in [("first", &first), ("second", &second)] {
            assert!(bytes.len() > 1000, "{label} png too small: {}", bytes.len());
            assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n", "{label} not a png");
        }
        assert_ne!(first, second, "two grabs at different seeks should differ");
        println!("REUSE OK: {} + {} bytes", first.len(), second.len());
    }

    /// 封面首帧快速路径（seek=0） vs 深 seek（None）的实测耗时对比，诊断用，
    /// 不设耗时断言。默认用 test10bit.mkv 夹具；设 READER_BENCH_VIDEO 用真实长视频。
    #[test]
    fn bench_first_frame_vs_deep_seek() {
        if !mpv_dll() {
            eprintln!("skipping (libmpv missing)");
            return;
        }
        let path = std::env::var("READER_BENCH_VIDEO").unwrap_or_else(|_| fixture());
        if !std::path::Path::new(&path).exists() {
            eprintln!("skipping (video missing: {path})");
            return;
        }
        for (label, seek) in [
            ("deep-seek (seek=None)", None),
            ("first-frame (seek=0)", Some(0.0)),
            ("near-start (seek=1)", Some(1.0)),
            ("near-start (seek=3)", Some(3.0)),
        ] {
            let p = path.clone();
            let r = grab_with(-32000, -32000, "bench", move |player| {
                let t0 = std::time::Instant::now();
                let bytes = player.grab_frame(&p, seek)?;
                println!(
                    "{label}: {} ms, png {} bytes",
                    t0.elapsed().as_millis(),
                    bytes.len()
                );
                Ok(bytes.len())
            });
            assert!(r.is_ok(), "{label} grab failed: {r:?}");
        }
    }
}
