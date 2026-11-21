//! El watcher no debe vigilar directorios ignorados, pero sí los nuevos normales.
use markvi_server::watch::{DiskEvent, DiskEventKind, FileWatcher};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};

static COUNTER: AtomicUsize = AtomicUsize::new(0);

struct Temp(PathBuf);

impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "markvi-inotify-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Número total de watches inotify de este proceso (0 fuera de Linux).
fn inotify_watches() -> usize {
    let mut total = 0;
    if let Ok(fds) = fs::read_dir("/proc/self/fdinfo") {
        for entry in fds.flatten() {
            if let Ok(text) = fs::read_to_string(entry.path()) {
                if !text.contains("inotify") {
                    continue;
                }
                for line in text.lines() {
                    if let Some(value) = line.strip_prefix("watches:") {
                        total += value.trim().parse::<usize>().unwrap_or(0);
                    }
                }
            }
        }
    }
    total
}

#[tokio::test(flavor = "multi_thread")]
async fn watcher_no_vigila_directorios_ignorados_pero_si_los_nuevos() {
    let temp = Temp::new();
    fs::write(temp.path().join("base.md"), "base").unwrap();
    for ignored in [".git", "node_modules"] {
        for index in 0..60 {
            let dir = temp.path().join(ignored).join(format!("d{index}"));
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("f.md"), "x").unwrap();
        }
    }

    let mut watcher = FileWatcher::new(temp.path());
    let mut events = watcher.subscribe();
    tokio::time::sleep(Duration::from_millis(300)).await;

    let watches = inotify_watches();
    if watches != 0 {
        assert!(
            watches <= 5,
            "watches inotify para dirs ignorados: {watches}"
        );
    }

    let sub = temp.path().join("notas");
    fs::create_dir(&sub).unwrap();
    fs::write(sub.join("a.md"), "# a\n").unwrap();
    tokio::time::sleep(Duration::from_millis(400)).await;

    let mut found = Vec::new();
    let deadline = std::time::Instant::now() + Duration::from_millis(500);
    while std::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(50), events.recv()).await {
            Ok(Ok(event)) => found.push(event),
            _ => break,
        }
    }
    assert!(
        found.contains(&DiskEvent {
            kind: DiskEventKind::Change,
            path: "notas/a.md".into()
        }),
        "el subdirectorio nuevo no notificó: {found:?}"
    );

    let watches = inotify_watches();
    if watches != 0 {
        assert!(
            watches <= 5,
            "demasiados watches tras crear notas/: {watches}"
        );
    }
    watcher.close();
}
