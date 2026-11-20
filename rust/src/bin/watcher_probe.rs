//! Sonda equivalente a rust/recording/watcher_probe.ts, sobre el watcher Rust.
use markvi_server::watch::FileWatcher;
use std::path::PathBuf;

#[tokio::main]
async fn main() {
    let root = PathBuf::from(std::env::args().nth(1).expect("missing fixture directory"));
    let mut watcher = FileWatcher::new(&root);
    let mut events = watcher.subscribe();
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    tokio::fs::write(root.join("watch-a.md"), "# a\n")
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    tokio::fs::rename(root.join("watch-a.md"), root.join("watch-b.md"))
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    tokio::fs::remove_file(root.join("watch-b.md"))
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    let mut found = Vec::new();
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(300);
    while std::time::Instant::now() < deadline {
        match tokio::time::timeout(std::time::Duration::from_millis(50), events.recv()).await {
            Ok(Ok(event)) => found.push(event),
            _ => break,
        }
    }
    println!("{}", serde_json::to_string(&found).unwrap());
    watcher.close();
}
