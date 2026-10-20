//! Tauri composition; the state machine never grants a renderer quit-now API.
use super::{
    GuardState, Lifecycle, Phase,
    singleton::{self, Admission, Singleton},
};
use crate::{Result, desktop::ProductBridge, runtime_services::RuntimeServices};
use std::{
    sync::{Arc, atomic::Ordering},
    time::Duration,
};
use tauri::{
    AppHandle, Emitter, Manager,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

pub(crate) fn window_state(window: &tauri::Window) {
    let _=window.emit("product-window-state",serde_json::json!({"version":1,"visible":window.is_visible().unwrap_or(false),"focused":window.is_focused().unwrap_or(false)}));
}
pub(crate) fn show(app: &AppHandle) {
    if app.state::<Arc<Lifecycle>>().phase() == Phase::Exiting {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        if window
            .unminimize()
            .and_then(|_| window.show())
            .and_then(|_| window.set_focus())
            .is_err()
        {
            eprintln!("Momoki: existing window activation failed");
        }
        window_state(&window.as_ref().window());
    }
}
fn emit(app: &AppHandle, lifecycle: &Lifecycle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit(
            "product-lifecycle",
            lifecycle.snapshot(
                window.is_visible().unwrap_or(false),
                window.is_focused().unwrap_or(false),
            ),
        );
    }
}
pub(crate) fn preflight(identifier: &str) -> Result<Singleton> {
    // This must precede even NSApplication/EventLoop creation: on macOS a
    // second raw launch may never reach Tauri setup while the app is resident.
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME")
        .map(|home| std::path::PathBuf::from(home).join("Library/Application Support"));
    #[cfg(windows)]
    let base = windows_data_dir();
    #[cfg(not(any(target_os = "macos", windows)))]
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(".local/share"))
        });
    let root = base
        .ok_or_else(|| crate::Error::new("profile", "Application data directory unavailable"))?
        .join(identifier)
        .join("application-lifecycle-v1");
    Ok(match singleton::acquire(&root)? {
        Admission::Owner(owner) => owner,
        Admission::Contender(root) => {
            let result = tauri::async_runtime::block_on(singleton::activate(&root));
            // Contenders never continue product setup, even after lost activation.
            std::process::exit(if result == singleton::Ack::Accepted {
                0
            } else {
                1
            });
        }
    })
}
#[cfg(windows)]
fn windows_data_dir() -> Option<std::path::PathBuf> {
    use std::{os::windows::ffi::OsStringExt, ptr};
    use windows_sys::Win32::{
        System::Com::CoTaskMemFree,
        UI::Shell::{FOLDERID_RoamingAppData, KF_FLAG_DONT_VERIFY, SHGetKnownFolderPath},
    };
    let mut path = ptr::null_mut();
    // Same pinned dirs-sys KnownFolder API/flags as Tauri's path resolver.
    let result = unsafe {
        SHGetKnownFolderPath(
            &FOLDERID_RoamingAppData,
            KF_FLAG_DONT_VERIFY as u32,
            ptr::null_mut(),
            &mut path,
        )
    };
    if result < 0 || path.is_null() {
        return None;
    }
    let mut len = 0;
    unsafe {
        while *path.add(len) != 0 {
            len += 1;
        }
    }
    let value = unsafe { std::ffi::OsString::from_wide(std::slice::from_raw_parts(path, len)) };
    unsafe {
        CoTaskMemFree(path.cast());
    }
    Some(value.into())
}
pub(crate) fn setup(app: &mut tauri::App, lifecycle: Arc<Lifecycle>) -> Result<bool> {
    let singleton = app.state::<Singleton>();
    let actual = app
        .path()
        .app_data_dir()
        .map_err(|_| crate::Error::new("profile", "Application data directory unavailable"))?
        .join("application-lifecycle-v1");
    if !singleton.matches_root(&actual) {
        return Err(crate::Error::new(
            "profile",
            "Application ownership directory mismatch",
        ));
    }
    let handle = app.handle().clone();
    singleton.listen(
        lifecycle.activation.clone(),
        Arc::new(move || show(&handle)),
    )?;
    let open = MenuItem::with_id(app, "momoki-open", "打开 Momoki", true, None::<&str>)
        .map_err(|_| crate::Error::new("lifecycle", "Unable to create application menu"))?;
    let quit = MenuItem::with_id(app, "momoki-quit", "退出 Momoki", true, None::<&str>)
        .map_err(|_| crate::Error::new("lifecycle", "Unable to create application menu"))?;
    let menu = Menu::with_items(app, &[&open, &quit])
        .map_err(|_| crate::Error::new("lifecycle", "Unable to create application menu"))?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| crate::Error::new("lifecycle", "Application tray icon unavailable"))?;
    TrayIconBuilder::with_id("momoki-main")
        .icon(icon)
        .tooltip("Momoki")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "momoki-open" => show(app),
            "momoki-quit" => request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show(tray.app_handle());
            }
        })
        .build(app)
        .map_err(|_| crate::Error::new("lifecycle", "Unable to install application tray"))?;
    Ok(true)
}
pub(crate) fn ready(app: &AppHandle) {
    let lifecycle = app.state::<Arc<Lifecycle>>();
    lifecycle.activation.ready.store(true, Ordering::Release);
    if lifecycle.activation.pending.swap(false, Ordering::AcqRel) {
        show(app);
    }
}
pub(crate) fn request_quit(app: &AppHandle) {
    let lifecycle = app.state::<Arc<Lifecycle>>().inner().clone();
    let Some(intent) = lifecycle.begin() else {
        return;
    };
    let app = app.clone();
    eprintln!("Momoki lifecycle: Quit intent checking drafts");
    emit(&app, &lifecycle);
    tauri::async_runtime::spawn(async move {
        let initial = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let changed = intent.changed.notified();
                if intent.guard() != GuardState::Waiting {
                    break;
                }
                changed.await;
            }
        })
        .await;
        if initial.is_ok() && intent.guard() == GuardState::Human {
            show(&app);
            loop {
                let changed = intent.changed.notified();
                if intent.guard() != GuardState::Human {
                    break;
                }
                changed.await;
            }
        }
        if intent.guard() == GuardState::Cancel && lifecycle.cancel(&intent) {
            emit(&app, &lifecycle);
            return;
        }
        if !lifecycle.quiesce(&intent) {
            return;
        }
        eprintln!("Momoki lifecycle: Quit quiescing");
        let bridge = app.state::<Arc<ProductBridge>>().inner().clone();
        let quiesce = bridge.clone();
        // Blocking owner/fence cleanup lives off the async deadline task.
        let native_imports = tauri::async_runtime::spawn_blocking(move || {
            tauri::async_runtime::block_on(quiesce.quiesce())
        });
        emit(&app, &lifecycle);
        let settled = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let done = intent.drained.notified();
                if intent.outcome().is_some() {
                    break;
                }
                done.await;
            }
        })
        .await;
        if settled.is_err() {
            eprintln!(
                "Momoki: cooperative Quit deadline elapsed; original outcomes remain unconfirmed"
            );
        }
        // One shared budget: waits cannot multiply by resource count. If any
        // original owner is still held, do not pretend it drained or replay it.
        let native = tokio::time::timeout(Duration::from_secs(2), async {
            let services = app.state::<Arc<RuntimeServices>>().inner().clone();
            let saves = tauri::async_runtime::spawn_blocking(move || services.saves.close());
            let storage = bridge.clone();
            let cleanup = tauri::async_runtime::spawn_blocking(move || {
                tauri::async_runtime::block_on(bridge.cleanup())
            });
            // Start every cleanup signal before waiting on any original owner.
            // A held system picker must not prevent MCP from receiving Stop.
            tokio::join!(
                async {
                    let _ = native_imports.await;
                },
                async {
                    let _ = saves.await;
                },
                async {
                    let _ = cleanup.await;
                }
            );
            let _ = tauri::async_runtime::spawn_blocking(move || storage.close_worker()).await;
        })
        .await;
        if native.is_err() {
            eprintln!(
                "Momoki: native Quit cleanup deadline elapsed; cleanup remains interrupted"
            );
        }
        lifecycle.exiting();
        eprintln!("Momoki lifecycle: Quit exiting");
        emit(&app, &lifecycle);
        app.exit(0);
    });
}

// Keeping this managed type reachable documents the actual held descriptor.
const _: fn(&Singleton) = |_| {};
