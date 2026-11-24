//! Watcher: directories created, recreated or renamed after startup must keep
//! reporting changes inside them, and reconciliations are coalesced.
use markvi_server::watch::{DiskEvent, DiskEventKind, FileWatcher};
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};
use tokio::sync::broadcast::Receiver;

static COUNTER: AtomicUsize = AtomicUsize::new(0);

struct Temp(PathBuf);

impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "markvi-watch-dirs-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn change(path: &str) -> DiskEvent {
    DiskEvent {
        kind: DiskEventKind::Change,
        path: path.to_string(),
    }
}

fn append(path: &Path, text: &str) {
    let mut file = std::fs::OpenOptions::new().append(true).open(path).unwrap();
    file.write_all(text.as_bytes()).unwrap();
}

/// Collects events until `quiet_ms` without activity (or `max_ms` total).
async fn collect(receiver: &mut Receiver<DiskEvent>, quiet_ms: u64, max_ms: u64) -> Vec<DiskEvent> {
    let mut out = Vec::new();
    let deadline = Instant::now() + Duration::from_millis(max_ms);
    while Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(quiet_ms), receiver.recv()).await {
            Ok(Ok(event)) => out.push(event),
            Ok(Err(_)) => continue,
            Err(_) => break,
        }
    }
    out
}

/// Skips startup and drains pending events; anything after that is new.
async fn settle(receiver: &mut Receiver<DiskEvent>) {
    tokio::time::sleep(Duration::from_millis(400)).await;
    collect(receiver, 300, 3000).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn directorio_nuevo_notifica_cambios_posteriores_dentro() {
    let temp = Temp::new();
    let mut watcher = FileWatcher::new(temp.path());
    let mut events = watcher.subscribe();
    settle(&mut events).await;

    std::fs::create_dir(temp.path().join("nuevo")).unwrap();
    std::fs::write(temp.path().join("nuevo/n.md"), "n\n").unwrap();
    settle(&mut events).await;

    // Only the actual write can produce this event: `reconcile`'s diff
    // already knows about `nuevo/n.md`.
    append(&temp.path().join("nuevo/n.md"), "m\n");
    let seen = collect(&mut events, 300, 3000).await;
    assert!(
        seen.contains(&change("nuevo/n.md")),
        "no se vigila el directorio creado tras el arranque: {seen:?}"
    );
    watcher.close();
}

#[tokio::test(flavor = "multi_thread")]
async fn directorio_recreado_en_la_misma_ventana_sigue_vigilado() {
    let temp = Temp::new();
    std::fs::create_dir(temp.path().join("sub")).unwrap();
    std::fs::write(temp.path().join("sub/a.md"), "a\n").unwrap();
    let mut watcher = FileWatcher::new(temp.path());
    let mut events = watcher.subscribe();
    settle(&mut events).await;

    // Delete and recreate inside the debounce window: the kernel drops the old
    // watch while the path still exists when reconciliation runs.
    std::fs::remove_dir_all(temp.path().join("sub")).unwrap();
    std::fs::create_dir(temp.path().join("sub")).unwrap();
    std::fs::write(temp.path().join("sub/a.md"), "y\n").unwrap();
    settle(&mut events).await;

    append(&temp.path().join("sub/a.md"), "z\n");
    let seen = collect(&mut events, 300, 3000).await;
    assert!(
        seen.contains(&change("sub/a.md")),
        "el directorio recreado dejó de vigilarse: {seen:?}"
    );
    watcher.close();
}

#[tokio::test(flavor = "multi_thread")]
async fn directorio_renombrado_notifica_con_la_ruta_nueva() {
    let temp = Temp::new();
    std::fs::create_dir(temp.path().join("sub")).unwrap();
    std::fs::write(temp.path().join("sub/a.md"), "a\n").unwrap();
    let mut watcher = FileWatcher::new(temp.path());
    let mut events = watcher.subscribe();
    settle(&mut events).await;

    std::fs::rename(temp.path().join("sub"), temp.path().join("sub2")).unwrap();
    settle(&mut events).await;

    append(&temp.path().join("sub2/a.md"), "w\n");
    let seen = collect(&mut events, 300, 3000).await;
    assert!(
        seen.contains(&change("sub2/a.md")),
        "tras renombrar el directorio no llegó el cambio con la ruta nueva: {seen:?}"
    );
    assert!(
        !seen.contains(&change("sub/a.md")),
        "evento con la ruta antigua: {seen:?}"
    );
    watcher.close();
}

#[tokio::test(flavor = "multi_thread")]
async fn muchos_directorios_nuevos_se_reconcilian_en_pocas_pasadas() {
    let temp = Temp::new();
    let mut watcher = FileWatcher::new(temp.path());
    let mut events = watcher.subscribe();
    settle(&mut events).await;
    let before = watcher.reconcile_count();

    for index in 0..30 {
        let dir = temp.path().join(format!("d{index}"));
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("f.md"), "x\n").unwrap();
    }
    let seen = collect(&mut events, 400, 5000).await;

    for index in 0..30 {
        assert!(
            seen.contains(&change(&format!("d{index}/f.md"))),
            "falta el evento de d{index}/f.md"
        );
    }
    let runs = watcher.reconcile_count() - before;
    assert!(
        runs <= 3,
        "{runs} reconciliaciones completas para 30 directorios: deberían agruparse"
    );
    watcher.close();
}
