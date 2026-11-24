//! Mover y borrar siguen hasta el final aunque el cliente corte la petición.
use axum::{
    body::Body,
    extract::State,
    http::{Method, Request},
};
use markvi_server::{
    api::{self, AppState, StaticAssets},
    fs,
    watch::FileWatcher,
};
use std::{path::PathBuf, time::Duration};

fn setup(name: &str) -> (PathBuf, AppState, FileWatcher) {
    let root = std::env::temp_dir().join(format!("markvi-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("a.md"), "a").unwrap();
    let root = std::fs::canonicalize(&root).unwrap();
    let watcher = FileWatcher::new(&root);
    let state = AppState::new(root.clone(), 3000, PathBuf::new(), watcher.hub(), StaticAssets::new());
    (root, state, watcher)
}

/// Retiene el candado de `file` hasta que se envíe por el canal devuelto.
async fn hold_lock(state: &AppState, file: PathBuf) -> tokio::sync::oneshot::Sender<()> {
    let (release, wait) = tokio::sync::oneshot::channel::<()>();
    let locks = state.locks.clone();
    tokio::spawn(async move {
        let key = fs::lock_key(&file).await;
        fs::with_file_lock(&locks, &key, async move {
            let _ = wait.await;
        })
        .await;
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    release
}

#[tokio::test]
async fn move_post_cancelado_se_completa() {
    let (root, state, _watcher) = setup("cancel-move");
    let release = hold_lock(&state, root.join("a.md")).await;
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/move")
        .body(Body::from(r#"{"from":"a.md","to":"nuevo/b.md"}"#))
        .unwrap();
    // El cliente corta mientras el movimiento espera el candado.
    let cut = tokio::time::timeout(Duration::from_millis(100), api::move_post(State(state), req)).await;
    assert!(cut.is_err(), "debía seguir esperando el candado");
    let _ = release.send(());
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!root.join("a.md").exists(), "el origen debía moverse");
    assert!(root.join("nuevo/b.md").exists(), "el destino debía existir");
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn file_delete_cancelado_se_completa() {
    let (root, state, _watcher) = setup("cancel-delete");
    let release = hold_lock(&state, root.join("a.md")).await;
    let req = Request::builder()
        .method(Method::DELETE)
        .uri("/api/file?path=a.md")
        .body(Body::empty())
        .unwrap();
    let cut = tokio::time::timeout(Duration::from_millis(100), api::file_delete(State(state), req)).await;
    assert!(cut.is_err(), "debía seguir esperando el candado");
    let _ = release.send(());
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!root.join("a.md").exists(), "el borrado debía completarse");
    let _ = std::fs::remove_dir_all(&root);
}
