//! Rendimiento de los recorridos de árbol con muchos directorios (solo release).
use markvi_server::{fs, watch::FileWatcher};
use std::time::{Duration, Instant};

fn make_vault(dirs: usize, name: &str) -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!("markvi-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    for index in 0..dirs {
        let dir = root.join(format!("g{}/d{index}", index % 20));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.md"), "x").unwrap();
    }
    root
}

#[tokio::test(flavor = "multi_thread")]
#[cfg_attr(debug_assertions, ignore = "umbral de tiempo solo en release")]
async fn listar_4000_directorios_es_rapido() {
    let root = make_vault(4000, "walk-perf");
    // Calentamiento de la caché de directorios.
    let _ = fs::list_markdown_entries(&root).await;
    let start = Instant::now();
    let entries = fs::list_markdown_entries(&root).await;
    let elapsed = start.elapsed();
    assert_eq!(entries.len(), 4000);
    assert!(
        elapsed < Duration::from_millis(60),
        "listar 4000 directorios tardó {elapsed:?}"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test(flavor = "multi_thread")]
#[cfg_attr(debug_assertions, ignore = "umbral de tiempo solo en release")]
async fn directorio_nuevo_se_notifica_en_menos_de_450ms_con_4000_directorios() {
    let root = make_vault(4000, "watch-perf");
    let mut watcher = FileWatcher::new(&root);
    let mut events = watcher.subscribe();
    tokio::time::sleep(Duration::from_millis(1500)).await;
    while events.try_recv().is_ok() {}

    let start = Instant::now();
    std::fs::create_dir(root.join("g0/nuevo")).unwrap();
    std::fs::write(root.join("g0/nuevo/n.md"), "n").unwrap();
    let mut latency = None;
    while start.elapsed() < Duration::from_secs(5) {
        if let Ok(Ok(_)) = tokio::time::timeout(Duration::from_millis(20), events.recv()).await {
            latency = Some(start.elapsed());
            break;
        }
    }
    let latency = latency.expect("no llegó el evento del directorio nuevo");
    assert!(
        latency < Duration::from_millis(450),
        "latencia de {latency:?} con 4000 directorios"
    );
    watcher.close();
    let _ = std::fs::remove_dir_all(&root);
}
