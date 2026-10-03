mod agent;
mod api;
mod auth;
mod colocation;
mod config;
mod error;
mod exec;
mod install;
mod labs;
mod runtime;
mod system;
mod terminal;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // First: a cyberctf:// link opened while the app runs goes to that window
        // (Windows/Linux would otherwise start a second instance).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(terminal::Shells::default())
        // macOS app menu: Tauri's default menu labels the About/Hide/Quit items with the
        // crate name (cyberctf-desktop); build it explicitly so they read "Cyber CTF".
        // Edit + Window are kept so clipboard shortcuts and window controls still work.
        .menu(|handle| {
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{AboutMetadata, MenuBuilder, PredefinedMenuItem, SubmenuBuilder};
                let about = AboutMetadata {
                    name: Some("Cyber CTF".into()),
                    version: Some(env!("CARGO_PKG_VERSION").into()),
                    ..Default::default()
                };
                let app_menu = SubmenuBuilder::new(handle, "Cyber CTF")
                    .item(&PredefinedMenuItem::about(handle, Some("About Cyber CTF"), Some(about))?)
                    .separator()
                    .services()
                    .separator()
                    .item(&PredefinedMenuItem::hide(handle, Some("Hide Cyber CTF"))?)
                    .hide_others()
                    .show_all()
                    .separator()
                    .item(&PredefinedMenuItem::quit(handle, Some("Quit Cyber CTF"))?)
                    .build()?;
                let edit_menu = SubmenuBuilder::new(handle, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;
                let window_menu = SubmenuBuilder::new(handle, "Window")
                    .minimize()
                    .separator()
                    .close_window()
                    .build()?;
                MenuBuilder::new(handle).items(&[&app_menu, &edit_menu, &window_menu]).build()
            }
            #[cfg(not(target_os = "macos"))]
            {
                tauri::menu::Menu::default(handle)
            }
        })
        .setup(|app| {
            // Linux and Windows dev builds: register cyberctf:// at runtime (installers do it otherwise).
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register_all();
            }
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // Bring your own compute: register this machine and run the player's labs on it.
            agent::spawn(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            system::system_check,
            system::machine_metrics,
            auth::auth_login,
            auth::auth_status,
            auth::auth_logout,
            api::api_query,
            agent::agent_info,
            install::install_dependency,
            install::install_vagrant_plugin,
            labs::lab_launch,
            runtime::lab_start,
            runtime::lab_stop,
            runtime::lab_status,
            runtime::exegol_status,
            runtime::exegol_start,
            runtime::exegol_stop,
            runtime::exegol_shell,
            terminal::exegol_shell_open,
            terminal::exegol_shell_write,
            terminal::exegol_shell_resize,
            terminal::exegol_shell_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running CyberCTF");
}
