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

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{Emitter, Manager};

/// Set once the user confirms quitting while a deploy is in progress, so the close/exit handlers
/// stop intercepting and let the app go.
static FORCE_QUIT: AtomicBool = AtomicBool::new(false);

/// Whether leaving now would interrupt a lab deploy. The UI reads this (and the handlers below
/// use it) to warn before quitting: an interrupted cloud apply can leave billable resources.
#[tauri::command]
fn deploy_in_progress() -> bool {
    runtime::active_deploys() > 0
}

/// The labs currently starting or stopping. The UI reads this on load to rehydrate the "this lab
/// is starting" state after a window reload: the deploy keeps running in this process even when
/// the webview reloaded and lost its own in-memory deploy state.
#[tauri::command]
fn deploying_labs() -> Vec<String> {
    runtime::deploying_labs()
}

/// The user chose to quit anyway from the "a lab is still deploying" prompt: stop intercepting
/// and exit.
#[tauri::command]
fn force_quit(app: tauri::AppHandle) {
    FORCE_QUIT.store(true, Ordering::SeqCst);
    app.exit(0);
}

/// Opens Settings in its own window (label `settings`), focusing it if already open. The window
/// loads the main entry with `?window=settings` so the frontend renders only the settings screen.
fn open_settings_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    if let Some(existing) = app.get_webview_window("settings") {
        let _ = existing.set_focus();
        return Ok(());
    }
    let mut builder = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("index.html?window=settings".into()))
        .title("Settings")
        .inner_size(760.0, 640.0)
        .min_inner_size(560.0, 480.0)
        .resizable(true);
    #[cfg(target_os = "macos")]
    {
        builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    }
    if let Some(main) = app.get_webview_window("main") {
        builder = builder.parent(&main)?;
    }
    builder.build()?;
    Ok(())
}

/// Opens the Settings window. Used by the sidebar footer and the app-menu item.
#[tauri::command]
fn open_settings(app: tauri::AppHandle) -> std::result::Result<(), String> {
    open_settings_window(&app).map_err(|e| e.to_string())
}

/// If a deploy is in progress (and the user hasn't already confirmed), keep the app open and ask
/// the frontend to confirm. Returns true when the quit was intercepted.
fn intercept_quit(app: &tauri::AppHandle) -> bool {
    if FORCE_QUIT.load(Ordering::SeqCst) || runtime::active_deploys() == 0 {
        return false;
    }
    let _ = app.emit("quit-blocked", runtime::active_deploys());
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_focus();
    }
    true
}

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
        // Quitting mid-deploy can leave resources running (a cloud apply keeps billing). Hold the
        // window open and let the frontend confirm; the red-button close is handled here, Cmd+Q /
        // app exit in the run() callback below.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event
                && intercept_quit(&window.app_handle().clone())
            {
                api.prevent_close();
            }
        })
        // macOS app menu: Tauri's default menu labels the About/Hide/Quit items with the
        // crate name (cyberctf-desktop); build it explicitly so they read "Cyber CTF".
        // Edit + Window are kept so clipboard shortcuts and window controls still work.
        .menu(|handle| {
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{AboutMetadata, MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder};
                let about = AboutMetadata { name: Some("Cyber CTF".into()), version: Some(env!("CARGO_PKG_VERSION").into()), ..Default::default() };
                // Standard Preferences slot: Cmd+, opens Settings in its own window (see on_menu_event).
                let settings = MenuItem::with_id(handle, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
                let app_menu = SubmenuBuilder::new(handle, "Cyber CTF")
                    .item(&PredefinedMenuItem::about(handle, Some("About Cyber CTF"), Some(about))?)
                    .separator()
                    .item(&settings)
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
        // App-menu clicks: "Settings…" opens the settings window.
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "settings" {
                let _ = open_settings_window(app);
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
            machine::images::image_download_size,
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
            account::agent::confirm_launch,
            platform::install::install_dependency,
            cloud::cloud_login,
            cloud::aws_cli_identity,
            cloud::aws_profiles,
            cloud::aws_login,
            cloud::aws_month_to_date_cost,
            cloud::azure_subscriptions,
            cloud::gcp_account,
            cloud::gcp_billing_accounts,
            cloud::gcp_organizations,
            cloud::oci_config,
            provisioning::provisioning_images,
            provisioning::provisioning_pull,
            platform::install::install_vagrant_plugin,
            labs::lab_launch,
            runtime::lab_start,
            runtime::lab_stop,
            runtime::lab_status,
            runtime::lab_check,
            runtime::lab_tools,
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
            runtime::server::server_public_key,
            runtime::server::server_running_labs,
            runtime::server::server_capacity,
            runtime::server_selftest::server_selftest,
            runtime::server::server_open_setup,
            deploy_in_progress,
            deploying_labs,
            force_quit,
            open_settings,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Cyber CTF")
        .run(|app, event| {
            // Cmd+Q, the Quit menu item and a system shutdown come through here, not the window
            // close event. Intercept the same way, so a deploy in progress isn't cut off.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = &event
                && code.is_none()
                && intercept_quit(app)
            {
                api.prevent_exit();
            }
        });
}
