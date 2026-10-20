//! Disposable JSON-line bridge for exercising shared TypeScript commands against
//! the actual native engine. This test-hooks executable never selects app data.
use momoki_native_storage::{
    Hooks, ProductJob, StorageWorker, full_product_store::protocol::Request,
};
use serde::Deserialize;
use std::{
    fs,
    io::{self, BufRead, Read, Write},
    path::PathBuf,
    time::Duration,
};
#[derive(Deserialize)]
#[serde(
    tag = "type",
    content = "request",
    rename_all = "camelCase",
    deny_unknown_fields
)]
enum Probe {
    Store(Request),
    Binary(BinaryInput),
    Close,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BinaryInput {
    session: momoki_native_storage::full_product_store::protocol::Session,
    action: momoki_native_storage::product_binary::BinaryRequest,
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let mode = args.next().ok_or("Expected create/open")?;
    let root = PathBuf::from(args.next().ok_or("Expected disposable absolute root")?);
    let extra = args.collect::<Vec<_>>();
    let hooks = if extra.is_empty() {
        Hooks::default()
    } else {
        if extra.len() != 6
            || extra[0] != "--pause"
            || extra[2] != "--marker"
            || extra[4] != "--release"
        {
            return Err("Expected --pause POINT --marker FILE --release FILE".into());
        }
        let point = extra[1].clone();
        let marker = PathBuf::from(&extra[3]);
        let release = PathBuf::from(&extra[5]);
        let once = std::sync::atomic::AtomicBool::new(false);
        Hooks::new(move |name| {
            if name != point || once.swap(true, std::sync::atomic::Ordering::SeqCst) {
                return Ok(());
            }
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&marker)?;
            file.write_all(name.as_bytes())?;
            file.sync_all()?;
            while !release.exists() {
                std::thread::sleep(Duration::from_millis(5));
            }
            Ok(())
        })
    };
    let worker = StorageWorker::product(
        root,
        match mode.as_str() {
            "create" => true,
            "open" => false,
            _ => return Err("Expected create/open".into()),
        },
        hooks,
    )?;
    println!("{}", serde_json::json!({"ok":true,"ready":true}));
    io::stdout().flush()?;
    let mut stdin = io::stdin().lock();
    loop {
        let mut line = Vec::new();
        let n = stdin
            .by_ref()
            .take(2 * 1024 * 1024 + 1)
            .read_until(b'\n', &mut line)?;
        if n == 0 {
            break;
        }
        if n > 2 * 1024 * 1024 {
            return Err("Bounded IPC request exceeded 2MiB serialized transport".into());
        }
        let result = serde_json::from_slice::<Probe>(&line)
            .map_err(momoki_native_storage::Error::from)
            .and_then(|r| match r {
                Probe::Store(r) => worker.run_product(ProductJob::Store(r)),
                Probe::Binary(r) => worker.run_product(ProductJob::Binary {
                    session: r.session,
                    request: r.action,
                }),
                Probe::Close => {
                    worker.close()?;
                    Ok(serde_json::json!({"closed":true}))
                }
            });
        match result {
            Ok(value) => println!("{}", serde_json::json!({"ok":true,"value":value})),
            Err(error) => println!("{}", serde_json::json!({"ok":false,"error":error})),
        };
        io::stdout().flush()?;
    }
    worker.close()?;
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
