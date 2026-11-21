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

async fn shutdown(mut watcher: FileWatcher) {
    watch::shutdown_signal().await;
    watcher.close();
}

#[tokio::main]
async fn main() {
    let args = Args::parse();
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

    let env: Vec<(String, String)> = std::env::vars().collect();
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
        config_path.display(),
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
        .with_graceful_shutdown(shutdown(shutdown_watcher))
        .await
        .expect("server failed");
}
