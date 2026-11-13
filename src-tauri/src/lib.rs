mod ipc;
mod remote;
mod store;
mod transfers;
mod updater;

use std::sync::Arc;
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager, RunEvent};

const IS_MAC: bool = cfg!(target_os = "macos");

/// mac accelerator vs Windows/Linux accelerator (avoids shell keys like Ctrl+W/K/R in the terminal)
fn acc(mac: &str, other: &str) -> Option<String> {
    let a = if IS_MAC { mac } else { other };
    (!a.is_empty()).then(|| a.to_string())
}

fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let item = |id: &str, label: &str, a: Option<String>| MenuItem::with_id(app, id, label, true, a.as_deref());
    let app_menu = Submenu::with_items(
        app,
        "SSH OS",
        true,
        &[
            &item("about", "About SSH OS", None)?,
            &item("updates", "Check for Updates…", None)?,
            &PredefinedMenuItem::separator(app)?,
            &item("settings", "Settings…", acc("Cmd+,", "Ctrl+,"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &item("new-finder", "New Finder Window", acc("Cmd+N", "Ctrl+Alt+N"))?,
            &item("new-terminal", "New Terminal", acc("Cmd+Shift+T", "Ctrl+Alt+T"))?,
            &item("new-tab", "New Tab", acc("Cmd+T", "Ctrl+Shift+T"))?,
            &PredefinedMenuItem::separator(app)?,
            &item("servers", "Connect to Server…", acc("Cmd+K", "Ctrl+Alt+K"))?,
            &PredefinedMenuItem::separator(app)?,
            &item("close-window", "Close Window", acc("Cmd+W", "Ctrl+Shift+W"))?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &item("spotlight", "Spotlight", acc("Cmd+Shift+Space", "Ctrl+Shift+Space"))?,
            &item("toggle-hidden", "Show Hidden Files", acc("Cmd+Shift+.", "Ctrl+Shift+."))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    let go = Submenu::with_items(
        app,
        "Go",
        true,
        &[
            &item("go-home", "Home", acc("Cmd+Shift+H", "Ctrl+Shift+H"))?,
            &item("go-root", "Computer (/)", acc("Cmd+Shift+C", "Ctrl+Alt+C"))?,
            &item("go-folder", "Go to Folder…", acc("Cmd+Shift+G", "Ctrl+Shift+G"))?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &item("minimize-window", "Minimize", acc("Cmd+M", ""))?,
            &item("zoom-window", "Zoom", None)?,
            &PredefinedMenuItem::separator(app)?,
            &item("cycle-windows", "Cycle Windows", acc("Cmd+`", "Ctrl+`"))?,
        ],
    )?;
    let help = Submenu::with_items(app, "Help", true, &[&item("help", "Keyboard Shortcuts", None)?])?;
    let _ = AboutMetadata::default();
    if IS_MAC {
        Menu::with_items(app, &[&app_menu, &file, &edit, &view, &go, &window, &help])
    } else {
        // Windows/Linux: menu bar is hidden; items still provide the keyboard accelerators.
        Menu::with_items(app, &[&app_menu, &file, &view, &go, &window, &help])
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            #[allow(unused_mut)]
            let mut dir = app.path().app_data_dir()?;
            // Debug builds only: isolated data folder for automated tests (never the user's real data)
            #[cfg(debug_assertions)]
            if let Ok(p) = std::env::var("SSHOS_TEST_PROFILE") {
                dir = std::path::PathBuf::from(p);
            }
            let store = Arc::new(store::Store::load(dir));
            let handle = app.handle().clone();
            let http = reqwest::Client::builder()
                .user_agent(format!("ssh-os/{} (minecraft server manager)", app.package_info().version))
                .timeout(std::time::Duration::from_secs(20))
                .build()?;
            let state = ipc::AppState {
                updater: Arc::new(updater::Updater::new(handle.clone(), reqwest::Client::builder().user_agent(format!("ssh-os/{}", app.package_info().version)).build()?)),
                conns: remote::Conns::new(handle.clone(), store.clone()),
                transfers: transfers::Transfers::new(handle.clone()),
                http,
                store: store.clone(),
            };
            app.manage(state);
            app.set_menu(build_menu(&handle)?)?;
            app.on_menu_event(|app, ev| {
                let _ = app.emit("menu", ev.id().as_ref());
            });
            ipc::apply_theme(&handle, store.get("settings")["appearance"].as_str().unwrap_or("auto"));
            // Debug builds only: run a JS self-test inside the real app (used by CI/dev checks).
            #[cfg(debug_assertions)]
            if let Ok(p) = std::env::var("SSHOS_SELFTEST") {
                let js = std::fs::read_to_string(p)?;
                if let Some(w) = app.get_webview_window("main") {
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_secs(4));
                        let _ = w.eval(&js);
                    });
                }
            }
            #[cfg(not(target_os = "macos"))]
            if let Some(w) = app.get_webview_window("main") {
                // custom window controls are drawn by the UI
                let _ = w.set_decorations(false);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![ipc::ipc, ipc::term_write, ipc::term_resize])
        .build(tauri::generate_context!())
        .expect("error while building SSH OS")
        .run(|app, ev| {
            if let RunEvent::ExitRequested { .. } = ev {
                let st = app.state::<ipc::AppState>();
                let conns = st.conns.clone();
                tauri::async_runtime::block_on(async move { conns.disconnect_all().await });
            }
        });
}
