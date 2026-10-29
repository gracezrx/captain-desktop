//! Captain Desktop's native core: the menu bar icon, the global shortcut,
//! the frosted panel that drops down from the icon, screen snapshots,
//! notifications that open the right thread, and the Keychain.
//!
//! Everything else (chats, messages, decisions) lives in the web view and
//! talks to the Captain server directly (REST and one WebSocket). That server
//! can be a hosted one, or the one built into this app (see "built-in server").

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const KEYCHAIN_SERVICE: &str = "ai.captainspace.desktop";
const TRAY_ID: &str = "captain";

/// Which view the panel should open on. Matches `PanelTarget` in src/lib/native.ts.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PanelTarget {
    mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    channel_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    post_id: Option<String>,
}

impl PanelTarget {
    fn mode(mode: &str) -> Self {
        Self { mode: mode.into(), ..Default::default() }
    }
}

#[derive(Default)]
struct AppState {
    /// Where the menu bar icon is, in physical pixels: x, y, width, height.
    tray_rect: Mutex<Option<(f64, f64, f64, f64)>>,
    /// True while a snapshot is being taken, so the panel doesn't hide itself.
    capturing: Mutex<bool>,
}

// ------------------------------------------------------------ panel

fn panel(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("panel")
}

/// Put the panel just under the menu bar icon, or at the top right of the
/// screen if we don't know where the icon is yet.
fn position_panel(app: &AppHandle, window: &WebviewWindow) {
    let scale = window.scale_factor().unwrap_or(2.0);
    let width = window.outer_size().map(|s| s.width as f64).unwrap_or(400.0 * scale);
    let monitor = window.current_monitor().ok().flatten().or_else(|| window.primary_monitor().ok().flatten());
    let gap = 6.0 * scale;

    let rect = *app.state::<AppState>().tray_rect.lock().unwrap();
    let (mut x, y) = match rect {
        Some((tx, ty, tw, th)) => (tx + tw / 2.0 - width / 2.0, ty + th + gap),
        None => match &monitor {
            Some(m) => (
                m.position().x as f64 + m.size().width as f64 - width - 12.0 * scale,
                m.position().y as f64 + 30.0 * scale,
            ),
            None => (0.0, 30.0 * scale),
        },
    };
    if let Some(m) = &monitor {
        let left = m.position().x as f64 + 8.0 * scale;
        let right = m.position().x as f64 + m.size().width as f64 - width - 8.0 * scale;
        x = x.clamp(left, right.max(left));
    }
    let _ = window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
}

fn open_panel(app: &AppHandle, target: PanelTarget) {
    let Some(window) = panel(app) else { return };
    position_panel(app, &window);
    let _ = app.emit_to("panel", "panel-target", target);
    let _ = window.show();
    let _ = window.set_focus();
}

/// The shortcut and the icon toggle the panel: a second press closes it.
fn toggle_panel(app: &AppHandle, target: PanelTarget) {
    if let Some(window) = panel(app) {
        if window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false) {
            let _ = window.hide();
            return;
        }
    }
    open_panel(app, target);
}

#[tauri::command]
fn show_panel(app: AppHandle, target: PanelTarget) {
    open_panel(&app, target);
}

#[tauri::command]
fn hide_panel(app: AppHandle) {
    if let Some(window) = panel(&app) {
        let _ = window.hide();
    }
}

// ------------------------------------------------------------ dashboard

fn show_dashboard(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    if let Some(window) = panel(app) {
        let _ = window.hide();
    }
}

#[tauri::command]
fn open_dashboard(app: AppHandle) {
    show_dashboard(&app);
}

// ------------------------------------------------------------ badge

/// The number of things waiting for you, shown next to the menu bar icon.
#[tauri::command]
fn set_badge(app: AppHandle, count: u32) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let title = if count > 0 { Some(count.to_string()) } else { None };
        let _ = tray.set_title(title);
        let _ = tray.set_tooltip(Some(if count > 0 {
            format!("Captain · {count} waiting")
        } else {
            "Captain".to_string()
        }));
    }
}

// ------------------------------------------------------------ notifications

/// Show a banner; clicking it opens the panel on that thread.
#[tauri::command]
fn notify(app: AppHandle, title: String, body: String, target: PanelTarget) {
    #[cfg(target_os = "macos")]
    {
        std::thread::spawn(move || {
            use mac_notification_sys::{Notification, NotificationResponse};
            let _ = mac_notification_sys::set_application(&app.config().identifier);
            let response = Notification::new()
                .title(&title)
                .message(&body)
                .wait_for_click(true)
                .send();
            if let Ok(NotificationResponse::Click) = response {
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || open_panel(&handle, target));
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_notification::NotificationExt;
        let _ = target;
        let _ = app.notification().builder().title(title).body(body).show();
    }
}

// ------------------------------------------------------------ screen capture

/// Take a snapshot of the main display (or, with `region`, let the person
/// drag a region). Returns PNG bytes, or nothing if they cancelled.
#[tauri::command]
async fn capture_screen(app: AppHandle, region: bool) -> Result<tauri::ipc::Response, String> {
    let state = app.state::<AppState>();
    *state.capturing.lock().unwrap() = true;
    let window = panel(&app);
    if let Some(w) = &window {
        let _ = w.hide();
    }
    // Let the panel fade out of the frame before capturing.
    std::thread::sleep(Duration::from_millis(220));
    let result = capture_png(region);
    if let Some(w) = &window {
        let _ = w.show();
        let _ = w.set_focus();
    }
    *state.capturing.lock().unwrap() = false;
    result.map(tauri::ipc::Response::new)
}

#[cfg(target_os = "macos")]
fn capture_png(region: bool) -> Result<Vec<u8>, String> {
    use std::process::Command;
    let path = std::env::temp_dir().join(format!(
        "captain-snapshot-{}.png",
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
    ));
    // -x: no sound. -m: main display only. -i: drag a region (Esc cancels).
    let mut args: Vec<&str> = vec!["-x", "-t", "png"];
    args.push(if region { "-i" } else { "-m" });
    let status = Command::new("/usr/sbin/screencapture")
        .args(&args)
        .arg(&path)
        .status()
        .map_err(|e| format!("Couldn't start the screen capture: {e}"))?;
    if !status.success() || !path.exists() {
        // Cancelled, or Screen Recording permission is off.
        return Ok(Vec::new());
    }
    // Keep uploads light: cap the long edge at 2400 px.
    let _ = Command::new("/usr/bin/sips").args(["-Z", "2400"]).arg(&path).output();
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&path);
    Ok(bytes)
}

#[cfg(not(target_os = "macos"))]
fn capture_png(_region: bool) -> Result<Vec<u8>, String> {
    Err("Screen snapshots are only available on macOS for now.".into())
}

// ------------------------------------------------------------ keychain

#[tauri::command]
fn secret_get(key: String) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &key).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, &key)
        .and_then(|e| e.set_password(&value))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn secret_delete(key: String) -> Result<(), String> {
    match keyring::Entry::new(KEYCHAIN_SERVICE, &key).and_then(|e| e.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ------------------------------------------------------------ built-in server
//
// The app carries the Captain server's code (Resources/server) and runs it
// with the Mac's Node.js, so the person never opens a terminal. Its database
// address and secret live in the Keychain. It listens on 127.0.0.1 only.

const LOCAL_PORT: u16 = 8787;
const KEY_DATABASE_URL: &str = "local-server.database-url";
const KEY_APP_SECRET: &str = "local-server.app-secret";

#[derive(Default)]
struct LocalServer {
    child: Mutex<Option<Child>>,
    error: Mutex<Option<String>>,
    starting: Mutex<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalServerStatus {
    configured: bool,
    running: bool,
    starting: bool,
    url: String,
    error: Option<String>,
    log: Option<String>,
}

fn local_url() -> String {
    format!("http://127.0.0.1:{LOCAL_PORT}")
}

fn keychain_get(key: &str) -> Option<String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, key).ok()?.get_password().ok().filter(|v| !v.is_empty())
}

fn keychain_set(key: &str, value: &str) -> Result<(), String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, key).and_then(|e| e.set_password(value)).map_err(|e| e.to_string())
}

fn random_hex(bytes: usize) -> Result<String, String> {
    let mut buf = vec![0u8; bytes];
    std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut buf)).map_err(|e| e.to_string())?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

/// Run a command for at most `limit`, returning its output if it finished.
fn output_within(mut cmd: Command, limit: Duration) -> Option<String> {
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < limit => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    Some(out)
}

fn node_major(node: &Path) -> Option<u32> {
    let mut cmd = Command::new(node);
    cmd.arg("-v");
    let v = output_within(cmd, Duration::from_secs(5))?;
    v.trim().trim_start_matches('v').split('.').next()?.parse().ok()
}

/// Find Node.js 22 or newer. Apps opened from the Finder don't get the
/// terminal's PATH, so look in the usual places and ask the login shell.
fn find_node() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut candidates: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin/node"),
        PathBuf::from("/usr/local/bin/node"),
        PathBuf::from(format!("{home}/.volta/bin/node")),
        PathBuf::from(format!("{home}/.local/bin/node")),
    ];
    for dir in [format!("{home}/.nvm/versions/node"), format!("{home}/Library/Application Support/fnm/node-versions"), format!("{home}/.local/share/fnm/node-versions")] {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for e in entries.flatten() {
                candidates.push(e.path().join("bin/node"));
                candidates.push(e.path().join("installation/bin/node"));
            }
        }
    }
    for flags in ["-lc", "-ilc"] {
        let mut cmd = Command::new("/bin/zsh");
        cmd.args([flags, "command -v node"]);
        if let Some(out) = output_within(cmd, Duration::from_secs(6)) {
            if let Some(line) = out.lines().rev().map(str::trim).find(|l| l.starts_with('/')) {
                candidates.push(PathBuf::from(line));
            }
        }
    }
    let mut best: Option<(u32, PathBuf)> = None;
    for c in candidates.into_iter().filter(|c| c.exists()) {
        if let Some(major) = node_major(&c) {
            if major >= 22 && best.as_ref().map_or(true, |(m, _)| major > *m) {
                best = Some((major, c));
            }
        }
    }
    best.map(|(_, p)| p).ok_or_else(|| "Captain needs Node.js 22 or newer on this Mac to run its own server. Install it from nodejs.org, then try again.".to_string())
}

fn port_in_use() -> bool {
    std::net::TcpStream::connect_timeout(&([127, 0, 0, 1], LOCAL_PORT).into(), Duration::from_millis(300)).is_ok()
}

fn log_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_log_dir().ok().map(|d| d.join("server.log"))
}

fn log_tail(app: &AppHandle) -> Option<String> {
    let text = std::fs::read_to_string(log_path(app)?).ok()?;
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(12);
    Some(lines[start..].join("\n")).filter(|s| !s.is_empty())
}

/// True when our server process is alive (and forgets it once it has exited).
fn child_alive(state: &LocalServer) -> bool {
    let mut guard = state.child.lock().unwrap();
    match guard.as_mut().map(|c| c.try_wait()) {
        Some(Ok(None)) => true,
        Some(_) => {
            *guard = None;
            false
        }
        None => false,
    }
}

fn start_local(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<LocalServer>();
    if child_alive(&state) {
        return Ok(());
    }
    if port_in_use() {
        // A server from an earlier run (or Start Captain) is already answering there.
        return Ok(());
    }
    let database_url = keychain_get(KEY_DATABASE_URL).ok_or("Add your database address first.")?;
    let app_secret = match keychain_get(KEY_APP_SECRET) {
        Some(v) => v,
        None => {
            let v = random_hex(32)?;
            keychain_set(KEY_APP_SECRET, &v)?;
            v
        }
    };
    let node = find_node()?;
    let server_dir = app.path().resource_dir().map_err(|e| e.to_string())?.join("server");
    if !server_dir.join("dist/src/main.js").exists() {
        return Err("This copy of Captain doesn't include its server. Download the full app again.".into());
    }
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let log_file = log_path(app).ok_or("No place for the log.")?;
    std::fs::create_dir_all(data_dir.join("files")).map_err(|e| e.to_string())?;
    if let Some(dir) = log_file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let log = std::fs::File::create(&log_file).map_err(|e| e.to_string())?;
    let child = Command::new(node)
        .arg("dist/src/main.js")
        .current_dir(&server_dir)
        .env("NODE_ENV", "production")
        .env("CAPTAIN_IGNORE_ENV_FILE", "1")
        .env("DATABASE_URL", database_url)
        .env("APP_SECRET", app_secret)
        .env("HOST", "127.0.0.1")
        .env("PORT", LOCAL_PORT.to_string())
        .env("PUBLIC_URL", local_url())
        .env("FILES_DIR", data_dir.join("files"))
        .env("WEB_DIST", server_dir.join("web"))
        .env("LOG_LEVEL", "info")
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log)
        .spawn()
        .map_err(|e| format!("Couldn't start the server: {e}"))?;
    *state.child.lock().unwrap() = Some(child);
    *state.error.lock().unwrap() = None;
    Ok(())
}

fn stop_local(app: &AppHandle) {
    let state = app.state::<LocalServer>();
    let taken = state.child.lock().unwrap().take();
    if let Some(mut child) = taken {
        // Ask nicely first, so jobs and connections close cleanly.
        let _ = Command::new("/bin/kill").args(["-TERM", &child.id().to_string()]).status();
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(5) {
            if let Ok(Some(_)) = child.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Start in the background (finding Node can take a few seconds).
fn start_local_in_background(app: &AppHandle) {
    let handle = app.clone();
    *app.state::<LocalServer>().starting.lock().unwrap() = true;
    std::thread::spawn(move || {
        let result = start_local(&handle);
        let state = handle.state::<LocalServer>();
        *state.error.lock().unwrap() = result.err();
        *state.starting.lock().unwrap() = false;
    });
}

#[tauri::command]
fn local_server_status(app: AppHandle) -> LocalServerStatus {
    let state = app.state::<LocalServer>();
    let alive = child_alive(&state);
    let running = alive || port_in_use();
    let starting = *state.starting.lock().unwrap();
    let mut error = state.error.lock().unwrap().clone();
    // The process ended on its own: say why.
    let log = if !running && !starting { log_tail(&app) } else { None };
    if error.is_none() && !running && !starting && log.is_some() {
        error = Some("The server stopped.".into());
    }
    LocalServerStatus { configured: keychain_get(KEY_DATABASE_URL).is_some(), running, starting, url: local_url(), error, log }
}

/// Save the database address (and, from a pasted .env, its APP_SECRET) and start.
#[tauri::command]
fn local_server_setup(app: AppHandle, database_url: String, app_secret: Option<String>) -> Result<(), String> {
    let url = database_url.trim();
    if !(url.starts_with("postgres://") || url.starts_with("postgresql://")) {
        return Err("That doesn't look like a database address. It starts with postgresql://".into());
    }
    if url.contains("[YOUR-PASSWORD]") {
        return Err("Put your database password in place of [YOUR-PASSWORD] first.".into());
    }
    keychain_set(KEY_DATABASE_URL, url)?;
    if let Some(secret) = app_secret.map(|s| s.trim().to_string()).filter(|s| s.len() >= 32) {
        keychain_set(KEY_APP_SECRET, &secret)?;
    }
    stop_local(&app);
    start_local_in_background(&app);
    Ok(())
}

#[tauri::command]
fn local_server_start(app: AppHandle) {
    start_local_in_background(&app);
}

#[tauri::command]
fn local_server_restart(app: AppHandle) {
    stop_local(&app);
    start_local_in_background(&app);
}

#[tauri::command]
fn local_server_stop(app: AppHandle) {
    stop_local(&app);
}

/// Forget the database address (the secret stays, so saved keys still work).
#[tauri::command]
fn local_server_forget(app: AppHandle) -> Result<(), String> {
    stop_local(&app);
    match keyring::Entry::new(KEYCHAIN_SERVICE, KEY_DATABASE_URL).and_then(|e| e.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ------------------------------------------------------------ app

pub fn run() {
    let shortcut = Shortcut::new(Some(Modifiers::ALT | Modifiers::SHIFT), Code::Space);

    tauri::Builder::default()
        .manage(AppState::default())
        .manage(LocalServer::default())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, pressed, event| {
                    if pressed == &shortcut && event.state() == ShortcutState::Pressed {
                        toggle_panel(app, PanelTarget::mode("compose"));
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            show_panel,
            hide_panel,
            open_dashboard,
            set_badge,
            notify,
            capture_screen,
            secret_get,
            secret_set,
            secret_delete,
            local_server_status,
            local_server_setup,
            local_server_start,
            local_server_restart,
            local_server_stop,
            local_server_forget,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();

            // Start the built-in server if it's been set up.
            if keychain_get(KEY_DATABASE_URL).is_some() {
                start_local_in_background(&handle);
            }

            // ⌥⇧Space opens the panel ready to write, from anywhere.
            if let Err(e) = app.global_shortcut().register(shortcut) {
                eprintln!("Couldn't register ⌥⇧Space (another app may be using it): {e}");
            }

            // The menu bar icon: click for the inbox, right-click for a menu.
            let menu = Menu::with_items(
                app,
                &[
                    &MenuItem::with_id(app, "write", "New message      ⌥⇧Space", true, None::<&str>)?,
                    &MenuItem::with_id(app, "inbox", "Inbox", true, None::<&str>)?,
                    &MenuItem::with_id(app, "open", "Open Captain", true, None::<&str>)?,
                    &MenuItem::with_id(app, "restart-server", "Restart Captain on this Mac", true, None::<&str>)?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "quit", "Quit Captain", true, None::<&str>)?,
                ],
            )?;
            TrayIconBuilder::with_id(TRAY_ID)
                .icon(Image::from_bytes(include_bytes!("../icons/tray@2x.png"))?)
                .icon_as_template(true)
                .tooltip("Captain")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "write" => open_panel(app, PanelTarget::mode("compose")),
                    "inbox" => open_panel(app, PanelTarget::mode("inbox")),
                    "open" => show_dashboard(app),
                    "restart-server" => {
                        stop_local(app);
                        start_local_in_background(app);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { rect, button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        let app = tray.app_handle();
                        let scale = panel(app).and_then(|w| w.scale_factor().ok()).unwrap_or(2.0);
                        let pos = rect.position.to_physical::<f64>(scale);
                        let size = rect.size.to_physical::<f64>(scale);
                        *app.state::<AppState>().tray_rect.lock().unwrap() = Some((pos.x, pos.y, size.width, size.height));
                        toggle_panel(app, PanelTarget::mode("inbox"));
                    }
                })
                .build(app)?;

            // The panel: frosted glass, hides when you click elsewhere.
            if let Some(window) = panel(&handle) {
                #[cfg(target_os = "macos")]
                {
                    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
                    let _ = apply_vibrancy(&window, NSVisualEffectMaterial::Popover, Some(NSVisualEffectState::Active), Some(20.0));
                }
                let _ = window.set_visible_on_all_workspaces(true);
                let app_for_blur = handle.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::Focused(false) = event {
                        let capturing = *app_for_blur.state::<AppState>().capturing.lock().unwrap();
                        if !capturing {
                            if let Some(w) = panel(&app_for_blur) {
                                let _ = w.hide();
                            }
                        }
                    }
                });
            }

            // Closing the dashboard keeps Captain in the menu bar, and the
            // dashboard keeps the one live connection running while hidden.
            if let Some(main) = handle.get_webview_window("main") {
                let app_for_close = handle.clone();
                main.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        if let Some(w) = app_for_close.get_webview_window("main") {
                            let _ = w.hide();
                        }
                        #[cfg(target_os = "macos")]
                        let _ = app_for_close.set_activation_policy(tauri::ActivationPolicy::Accessory);
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Captain")
        .run(|app, event| {
            // Clicking the Dock icon brings the dashboard back.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                show_dashboard(app);
            }
            // Quitting Captain stops its built-in server.
            if let tauri::RunEvent::Exit = event {
                stop_local(app);
            }
            let _ = (app, event);
        });
}
