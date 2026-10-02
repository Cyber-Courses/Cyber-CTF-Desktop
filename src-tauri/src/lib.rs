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
        ])
        .run(tauri::generate_context!())
        .expect("error while running CyberCTF");
}
