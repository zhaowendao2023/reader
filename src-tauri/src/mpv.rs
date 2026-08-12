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

use tauri::{AppHandle, Manager};

#[cfg(target_os = "windows")]
use std::sync::{Arc, Mutex};

#[cfg(target_os = "windows")]
use windows::Win32::Foundation::HWND;

pub const MPV_POOL_SIZE: usize = 3;

#[cfg(target_os = "windows")]
mod imp {
    use std::collections::VecDeque;
    use std::ffi::{c_char, c_int, c_void, CStr, CString};
    use std::path::{Path, PathBuf};
    use std::ptr;
    use std::sync::atomic::{AtomicBool, Ordering};
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
        SetWindowPos, TranslateMessage, HWND_TOP, PM_REMOVE, SWP_HIDEWINDOW, SWP_NOACTIVATE,
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

    /// 所有 mpv/窗口状态。只允许在泵线程上访问内部可变状态，
    /// 外部通过 Arc 上的方法（自身只读）拿快照。
    pub struct MpvObjects {
        _module: HMODULE,
        handle: *mut c_void,
        child: HWND,
        loaded: AtomicBool,
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
        let dev_fallback = PathBuf::from("E:\\develop\\mpv-dev\\libmpv-2.dll");
        if dev_fallback.exists() {
            return Ok(dev_fallback);
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
            unsafe {
                SetWindowPos(
                    self.child,
                    Some(HWND_TOP),
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
                    (Some(HWND_TOP), SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_NOMOVE | SWP_NOSIZE)
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

        fn child_handle(&self) -> isize {
            self.child.0 as isize
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

        fn state(&self) -> (bool, bool, f64, f64, Option<String>, Option<String>) {
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
            let path = self.get_property_string("path");
            let codec = self.get_property_string("video-params/codec");
            (playing, paused, position, duration, path, codec)
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
                        let created = unsafe { create_objects(parent, x, y, width, height) };
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

        pub fn set_bounds(&self, x: i32, y: i32, width: i32, height: i32) -> Result<(), String> {
            self.pump(move |o| o.set_bounds(x, y, width, height))
        }

        pub fn set_visible(&self, visible: bool) -> Result<(), String> {
            self.pump(move |o| o.set_visible(visible))
        }

        pub fn stop(&self) -> Result<(), String> {
            self.pump(|o| o.stop())
        }

        pub fn child_handle(&self) -> isize {
            self.objects.child_handle()
        }

        pub fn needs_recreate(&self) -> bool {
            self.pump(|o| Ok(o.needs_recreate())).unwrap_or(true)
        }

        pub fn state(&self) -> (bool, bool, f64, f64, Option<String>, Option<String>) {
            self.pump(|o| Ok(o.state()))
                .unwrap_or((false, false, 0.0, 0.0, None, None))
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
    ) -> Result<MpvObjects, String> {
        unsafe { create_objects_unsafe(parent, x, y, width, height) }
    }

    unsafe fn create_objects_unsafe(
        parent: HWND,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
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

        let code = mpv_initialize(handle);
        objects.check(code).map_err(|e| {
            let _ = DestroyWindow(child);
            e
        })?;
        // 光标相关是运行时属性，必须在 initialize 之后设置。
        // input-cursor=no：mpv 不改变光标形状（否则鼠标移到视频区光标会变）。
        // cursor-autohide=always：永不在播放中隐藏光标。
        for (key, value) in [("input-cursor", c"no"), ("cursor-autohide", c"always")] {
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
        loop {
            // 先执行队列中的任务
            loop {
                let task = queue.lock().unwrap().pop_front();
                match task {
                    Some(task) => task(),
                    None => break,
                }
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvState {
    playing: bool,
    paused: bool,
    position: f64,
    duration: f64,
    path: Option<String>,
    codec: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvSlotInfo {
    exists: bool,
    child: Option<u64>,
    valid: bool,
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
        tauri::async_runtime::spawn_blocking(move || {
            let mut guard = handle
                .lock()
                .map_err(|_| "mpv state lock poisoned".to_string())?;
            if let Some(player) = guard
                .get_mut(id)
                .ok_or_else(|| format!("mpv slot {id} missing"))?
                .as_mut()
            {
                let (playing, paused, position, duration, path, codec) = player.state();
                Ok(MpvState {
                    playing,
                    paused,
                    position,
                    duration,
                    path,
                    codec,
                })
            } else {
                Ok(MpvState {
                    playing: false,
                    paused: false,
                    position: 0.0,
                    duration: 0.0,
                    path: None,
                    codec: None,
                })
            }
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, id);
        Ok(MpvState {
            playing: false,
            paused: false,
            position: 0.0,
            duration: 0.0,
            path: None,
            codec: None,
        })
    }
}

#[tauri::command]
pub async fn mpv_pool_info(app: AppHandle) -> Result<Vec<MpvSlotInfo>, String> {
    #[cfg(target_os = "windows")]
    {
        let handle = app.state::<MpvPool>().0.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let guard = handle
                .lock()
                .map_err(|_| "mpv state lock poisoned".to_string())?;
            Ok(guard
                .iter()
                .map(|slot| match slot {
                    Some(player) => {
                        let child = player.child_handle() as u64;
                        MpvSlotInfo {
                            exists: true,
                            child: Some(child),
                            valid: unsafe {
                                windows::Win32::UI::WindowsAndMessaging::IsWindow(
                                    Some(HWND(child as usize as *mut _)),
                                )
                                .as_bool()
                            },
                        }
                    }
                    None => MpvSlotInfo {
                        exists: false,
                        child: None,
                        valid: false,
                    },
                })
                .collect::<Vec<_>>())
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Ok(Vec::new())
    }
}
