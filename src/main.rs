//! Binario de Markvi: CLI, servidor HTTP y apagado ordenado.
use axum::Router;
use clap::Parser;
use markvi_server::{
    api, config,
    watch::{self, FileWatcher},
};
use std::{net::SocketAddr, path::PathBuf};

#[derive(Parser)]
#[command(name = "markvi", disable_version_flag = true)]
struct Args {
    /// Directorio a servir
    directory: PathBuf,
    /// Puerto de escucha
    #[arg(short, long, default_value_t = 3000, value_parser = clap::value_parser!(u16).range(1..))]
    port: u16,
    /// Archivo de configuración
    #[arg(short, long)]
    config: Option<PathBuf>,
}

fn fail(message: &str) -> ! {
    eprintln!("Error: {message}\nUsage: markvi <directory> [--port <port>] [--config <file>]");
    std::process::exit(1);
}

async fn shutdown(mut watcher: FileWatcher, signal: impl std::future::Future<Output = ()>) {
    signal.await;
    watcher.close();
}

#[tokio::main]
async fn main() {
    let args = Args::parse();
    // Antes de abrir el puerto: una señal temprana debe apagar de forma ordenada.
    let signal = watch::install_shutdown_signals();
    let metadata = match tokio::fs::metadata(&args.directory).await {
        Ok(metadata) => metadata,
        Err(_) => fail(&format!(
            "path does not exist: {}",
            args.directory.display()
        )),
    };
    if !metadata.is_dir() {
        fail(&format!(
            "path is not a directory: {}",
            args.directory.display()
        ));
    }
    let root = match tokio::fs::canonicalize(&args.directory).await {
        Ok(root) => root,
        Err(error) => fail(&error.to_string()),
    };

    // `vars()` entra en pánico si alguna variable no es UTF-8.
    let env: Vec<(String, String)> = std::env::vars_os()
        .map(|(key, value)| {
            (
                key.to_string_lossy().into_owned(),
                value.to_string_lossy().into_owned(),
            )
        })
        .collect();
    let config_path = config::resolve_config_path(args.config.as_deref(), &env);

    let watcher = FileWatcher::new(&root);
    let sse = watcher.hub();
    let state = api::AppState::new(
        root.clone(),
        args.port,
        config_path.clone(),
        sse,
        api::StaticAssets::new(),
    );
    let shutdown_watcher = watcher;
    let app: Router = api::router(state);

    let addr: SocketAddr = api::bind_addr(args.port);
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => listener,
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => fail(&format!(
            "port {} is already in use. Try --port.",
            args.port
        )),
        Err(error) => fail(&error.to_string()),
    };

    println!("markvi serving {}", root.display());
    println!("http://127.0.0.1:{}/", args.port);
    let loaded = config::load_config(&config_path).await;
    println!(
        "config: {}{}",
        if config_path.as_os_str().is_empty() {
            "(none)".into()
        } else {
            config_path.display().to_string()
        },
        if loaded.exists {
            ""
        } else {
            " (not found, using defaults)"
        }
    );
    for warning in &loaded.warnings {
        println!("  warning: {warning}");
    }

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown(shutdown_watcher, signal))
        .await
        .expect("server failed");
}
