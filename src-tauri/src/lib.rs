mod account;
mod cloud;
mod config;
mod error;
mod exec;
mod labs;
mod machine;
mod platform;
mod provisioning;
mod runtime;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Before anything else: GUI launches don't get the shell PATH (docker, vagrant, ovftool).
    platform::env_path::augment();
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
        // macOS app menu: Tauri's default menu labels the About/Hide/Quit items with the
        // crate name (cyberctf-desktop); build it explicitly so they read "Cyber CTF".
        // Edit + Window are kept so clipboard shortcuts and window controls still work.
        .menu(|handle| {
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{AboutMetadata, MenuBuilder, PredefinedMenuItem, SubmenuBuilder};
                let about = AboutMetadata { name: Some("Cyber CTF".into()), version: Some(env!("CARGO_PKG_VERSION").into()), ..Default::default() };
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
                let edit_menu = SubmenuBuilder::new(handle, "Edit").undo().redo().separator().cut().copy().paste().select_all().build()?;
                let window_menu = SubmenuBuilder::new(handle, "Window").minimize().separator().close_window().build()?;
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
                app.handle().plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())?;
            }
            // Bring your own compute: register this machine and run the player's labs on it.
            account::agent::spawn(app.handle().clone());
            // Timed teardown of expired cloud labs: once on startup, then every 5 minutes, so a
            // forgotten (or app-was-closed) lab stops billing instead of lingering.
            let reaper = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    runtime::reap_expired_labs(&reaper).await;
                    tokio::time::sleep(std::time::Duration::from_secs(300)).await;
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            machine::system::system_check,
            machine::system::docker_use_engine,
            machine::system::machine_metrics,
            machine::system::machine_open_setup,
            machine::selftest::machine_selftest,
            machine::selftest::machine_selftest_prefetch,
            machine::workloads::machine_workloads,
            machine::workloads::machine_workload_stop,
            machine::workloads::machine_storage,
            machine::workloads::machine_storage_clean,
            account::auth::auth_login,
            account::auth::auth_status,
            account::auth::auth_logout,
            account::api::api_query,
            account::agent::agent_info,
            platform::install::install_dependency,
            cloud::cloud_login,
            cloud::aws_cli_identity,
            cloud::aws_profiles,
            cloud::aws_login,
            cloud::aws_month_to_date_cost,
            cloud::azure_subscriptions,
            cloud::gcp_account,
            cloud::gcp_projects,
            provisioning::provisioning_images,
            provisioning::provisioning_pull,
            platform::install::install_vagrant_plugin,
            labs::lab_launch,
            runtime::lab_start,
            runtime::lab_stop,
            runtime::lab_status,
            runtime::lab_check,
            runtime::exegol_status,
            runtime::exegol_start,
            runtime::exegol_stop,
            runtime::exegol_shell,
            runtime::lab_attack_shell,
            runtime::server::server_list,
            runtime::server::server_save,
            runtime::server::server_remove,
            runtime::server::server_set_default,
            runtime::server::server_test,
            runtime::server::server_running_labs,
            runtime::server::server_capacity,
            runtime::server_selftest::server_selftest,
            runtime::server::server_open_setup,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Cyber CTF");
}
