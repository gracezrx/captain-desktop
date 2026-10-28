//! Captain Desktop's native core: the menu bar icon, the global shortcut,
//! the frosted panel that drops down from the icon, screen snapshots,
//! notifications that open the right thread, and the Keychain.
//!
//! Everything else (chats, messages, decisions) lives in the web view and
//! talks to Mattermost directly.

use std::sync::Mutex;
use std::time::Duration;

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

// ------------------------------------------------------------ app

pub fn run() {
    let shortcut = Shortcut::new(Some(Modifiers::ALT | Modifiers::SHIFT), Code::Space);

    tauri::Builder::default()
        .manage(AppState::default())
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
        ])
        .setup(move |app| {
            let handle = app.handle().clone();

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
            let _ = (app, event);
        });
}
