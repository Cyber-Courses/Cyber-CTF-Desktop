mod account;
mod cloud;
mod config;
mod deploy_worker;
mod error;
mod exec;
mod labs;
mod lan_relay;
mod machine;
mod platform;
mod provisioning;
mod runtime;
mod shared_folder;
mod terminal;

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{Emitter, Manager};

/// Set once the user confirms quitting while a deploy is in progress, so the close/exit handlers
/// stop intercepting and let the app go.
static FORCE_QUIT: AtomicBool = AtomicBool::new(false);
/// Set while the app finishes in the background with its windows hidden (`linger_quit`); a
/// relaunch clears it, so the app stays open instead of exiting once the deploys are done.
static LINGERING: AtomicBool = AtomicBool::new(false);

/// Whether leaving now would interrupt a lab deploy. The UI reads this (and the handlers below
/// use it) to warn before quitting: an interrupted cloud apply can leave billable resources.
#[tauri::command]
fn deploy_in_progress(app: tauri::AppHandle) -> bool {
    runtime::active_deploys() > 0 || !deploy_worker::running(&app).is_empty()
}

/// The labs currently starting or stopping. The UI reads this on load to rehydrate the "this lab
/// is starting" state after a window reload: the deploy keeps running in this process even when
/// the webview reloaded and lost its own in-memory deploy state.
/// A window height of `wanted` logical pixels, or as much as the primary screen can show (with
/// room for the menu bar and dock) when that is less, so a tall dialog fits its content on a big
/// display and still opens fully on a small laptop screen, where its body scrolls instead.
pub(crate) fn window_height_fitting(app: &tauri::AppHandle, wanted: f64) -> f64 {
    let available = app.primary_monitor().ok().flatten().map(|m| m.size().height as f64 / m.scale_factor() - 80.0).unwrap_or(wanted);
    wanted.min(available).max(480.0)
}

#[tauri::command]
fn deploying_labs(app: tauri::AppHandle) -> Vec<String> {
    // Deploys running in this process (the fallback) and in detached worker processes.
    let mut ids = runtime::deploying_labs();
    // Worker keys with a dot are attack VM starts beside a lab, not the lab's own deploy.
    for id in deploy_worker::running(&app).into_iter().filter(|k| !k.contains('.')) {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids
}

/// Relaunches the app, so an installed update applies without the player quitting by hand.
#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

/// The labs being stopped right now, so the UI says "Stopping", never "Deploying", for a teardown.
#[tauri::command]
fn stopping_labs() -> Vec<String> {
    runtime::stopping_labs()
}

/// The labs being paused or shut down right now (machines kept), for the sidebar's label.
#[tauri::command]
fn parking_labs() -> Vec<String> {
    runtime::parking_labs()
}

/// One operation in flight on a lab, for the sidebar: what it is and the step it is at.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ActiveOperation {
    lab_id: String,
    /// "launch", "resume", "pause", "shutdown", "provision", "attack_vm" or "stop".
    op: &'static str,
    /// The machine a provisioning run targets, when one.
    machine: Option<String>,
    /// The last meaningful line of the operation's log (detached workers only).
    step: Option<String>,
}

/// Every lab operation in flight: the detached workers (with the step their log is at) and the
/// in-process ones (a stop, or the fallback when no worker could start).
#[tauri::command]
fn active_operations(app: tauri::AppHandle) -> Vec<ActiveOperation> {
    use deploy_worker::Op;
    use runtime::{Action, Park};
    let mut out: Vec<ActiveOperation> = deploy_worker::running_jobs(&app)
        .into_iter()
        .map(|(job, step)| {
            let (op, machine) = match &job.op {
                Op::Launch => ("launch", None),
                Op::Resume { .. } => ("resume", None),
                Op::Park { mode: Park::Pause, .. } => ("pause", None),
                Op::Park { mode: Park::Shutdown, .. } => ("shutdown", None),
                Op::Provision { machine, .. } => ("provision", machine.clone()),
                Op::AttackVm { .. } => ("attack_vm", None),
            };
            ActiveOperation { lab_id: job.lab_id, op, machine, step }
        })
        .collect();
    for (id, action) in runtime::active_actions() {
        if out.iter().any(|o| o.lab_id == id) {
            continue;
        }
        let op = match action {
            Action::Start => "launch",
            Action::Stop => "stop",
            Action::Park => "pause",
        };
        out.push(ActiveOperation { lab_id: id, op, machine: None, step: None });
    }
    out.sort_by(|a, b| a.lab_id.cmp(&b.lab_id));
    out
}

/// The log so far of a lab's deploy in its worker process, so a reloaded or relaunched app can
/// re-attach to a deploy still in progress.
#[tauri::command]
fn lab_deploy_log(app: tauri::AppHandle, id: String) -> std::result::Result<String, String> {
    deploy_worker::log_so_far(&app, &id).map_err(|e| e.to_string())
}

/// Quit by finishing in the background: the windows go away now; the process exits once the
/// in-app deploys (the fallback when no worker could be started) are done.
#[tauri::command]
fn linger_quit(app: tauri::AppHandle) {
    for (_, w) in app.webview_windows() {
        let _ = w.hide();
    }
    LINGERING.store(true, Ordering::SeqCst);
    tauri::async_runtime::spawn(async move {
        // Bounded: a wedged operation (a hung VBoxManage) must not keep an invisible app alive
        // for good. Past the cap it exits anyway; a detached worker would have been unaffected.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60 * 60);
        while runtime::active_deploys() > 0 && std::time::Instant::now() < deadline && LINGERING.load(Ordering::SeqCst) {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
        // Relaunched meanwhile (the windows are back): stay open.
        if !LINGERING.swap(false, Ordering::SeqCst) {
            return;
        }
        FORCE_QUIT.store(true, Ordering::SeqCst);
        app.exit(0);
    });
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
    // The root page in Settings mode. Not `index.html?...`: in `tauri dev` that resolves against
    // the Next dev server, which has no `/index.html` route (a 404 page), while the root serves
    // in both dev and the static export.
    let mut builder = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("?window=settings".into()))
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

/// When the last quit prompt was shown, so a second quit right after it means "quit anyway":
/// there must always be a way out that doesn't go through Activity Monitor or Task Manager.
static QUIT_PROMPTED_AT: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);
const QUIT_AGAIN_WINDOW: std::time::Duration = std::time::Duration::from_secs(20);

/// If an in-app operation is in progress (and the user hasn't already confirmed), keep the app
/// open and ask the frontend to confirm. Returns true when the quit was intercepted. Detached
/// workers never hold the app: they finish on their own. Nothing is intercepted when no window
/// could show the prompt (the app already lingers hidden), nor on a second quit within a few
/// seconds of the prompt: that is the user insisting.
fn intercept_quit(app: &tauri::AppHandle) -> bool {
    if FORCE_QUIT.load(Ordering::SeqCst) || runtime::active_deploys() == 0 {
        return false;
    }
    let visible = app.webview_windows().values().any(|w| w.is_visible().unwrap_or(false));
    let mut prompted = QUIT_PROMPTED_AT.lock().unwrap_or_else(|e| e.into_inner());
    let insisting = prompted.is_some_and(|t| t.elapsed() < QUIT_AGAIN_WINDOW);
    if !visible || insisting {
        FORCE_QUIT.store(true, Ordering::SeqCst);
        return false;
    }
    *prompted = Some(std::time::Instant::now());
    let _ = app.emit("quit-blocked", runtime::active_deploys());
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_focus();
    }
    true
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    runtime::server::mark_started();
    // Before anything else: GUI launches don't get the shell PATH (docker, vagrant, ovftool).
    platform::env_path::augment();
    // One context (the embedded config and assets) for whichever role this process plays.
    let context = tauri::generate_context!();
    // `cyberctf-desktop deploy --job <file>`: this process is a deploy worker, not the app. It
    // runs one lab's deploy headless and exits; the app that started it only follows its log, so
    // quitting the app never cuts a deploy short.
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("deploy")
        && args.get(2).map(String::as_str) == Some("--job")
        && let Some(job) = args.get(3)
    {
        deploy_worker::worker_main(std::path::PathBuf::from(job), context);
        return;
    }
    tauri::Builder::default()
        // First: a cyberctf:// link opened while the app runs goes to that window
        // (Windows/Linux would otherwise start a second instance).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // The windows may be hidden (finishing in the background) or minimized: bring the
            // main one back, and keep the app open instead of exiting once its deploys end.
            LINGERING.store(false, Ordering::SeqCst);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
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
            // Linux and Windows: no menu bar. The default one drew a light strip above the dark
            // UI and pushed the webview out of the window; Ctrl+, opens Settings from the page.
            #[cfg(not(target_os = "macos"))]
            {
                tauri::menu::Menu::new(handle)
            }
        })
        // App-menu clicks: "Settings…" opens the settings window.
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "settings" {
                let _ = open_settings_window(app);
            }
        })
        .setup(|app| {
            shared_folder::init(app.handle());
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
            machine::system::docker_start_engine,
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
            platform::uninstall::installed_tools,
            platform::uninstall::uninstall_dependency,
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
            runtime::lab_park,
            runtime::lab_resume,
            runtime::lab_provision,
            runtime::lab_status,
            runtime::running_labs,
            runtime::lab_check,
            runtime::lab_tools,
            runtime::exegol_status,
            runtime::exegol_start,
            runtime::exegol_stop,
            runtime::exegol_shell,
            runtime::attack_vm_status,
            runtime::attack_vm_start,
            runtime::attack_vm_stop,
            runtime::attack_vm_shell,
            runtime::lab_attack_shell,
            terminal::terminal_open,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_close,
            terminal::terminal_window,
            shared_folder::shared_folder_get,
            shared_folder::shared_folder_set,
            shared_folder::shared_folder_open,
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
            stopping_labs,
            restart_app,
            parking_labs,
            active_operations,
            lab_deploy_log,
            linger_quit,
            force_quit,
            open_settings,
        ])
        .build(context)
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
            if let tauri::RunEvent::Exit = event {
                exec::kill_live_tools();
                terminal::close_all();
            }
        });
}
