//! Integración de search/backlinks sobre copias temporales (sin tocar `example/`).
use markvi_server::search::{self, ScanOptions};
use std::{
    fs::File,
    io::Write,
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
};

static COUNTER: AtomicUsize = AtomicUsize::new(0);

struct Temp(PathBuf);

impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "markvi-search-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &std::path::Path {
        &self.0
    }

    fn write(&self, relative: &str, body: &str) {
        let path = self.0.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut file = File::create(path).unwrap();
        file.write_all(body.as_bytes()).unwrap();
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn search_markdown_limits_and_exclusions() {
    let temp = Temp::new();
    temp.write("a.md", "aguja\n");
    temp.write("grande.md", &format!("{} aguja", "x".repeat(2000)));
    temp.write("sub/b.md", "otra aguja\n");
    temp.write("c.txt", "aguja\n");
    temp.write(".git/x.md", "aguja\n");
    temp.write("node_modules/x.md", "aguja\n");

    let all = search::search_markdown(temp.path(), "aguja", ScanOptions::default()).await;
    let paths: Vec<_> = all.results.iter().map(|hit| hit.path.as_str()).collect();
    assert_eq!(paths, vec!["a.md", "grande.md", "sub/b.md"]);
    assert!(!all.truncated);

    let options = ScanOptions {
        max_file_bytes: 1000,
        ..ScanOptions::default()
    };
    let small = search::search_markdown(temp.path(), "aguja", options).await;
    let paths: Vec<_> = small.results.iter().map(|hit| hit.path.as_str()).collect();
    assert_eq!(paths, vec!["a.md", "sub/b.md"]);

    let options = ScanOptions {
        limit: 1,
        ..ScanOptions::default()
    };
    let capped = search::search_markdown(temp.path(), "aguja", options).await;
    assert_eq!(capped.results.len(), 1);
    assert!(capped.truncated);

    let blank = search::search_markdown(temp.path(), "   ", ScanOptions::default()).await;
    assert!(blank.results.is_empty());
    assert!(!blank.truncated);
}

#[tokio::test]
async fn search_memory_skips_huge_files_and_stops_reading_after_limit() {
    let temp = Temp::new();
    temp.write("small.md", "needle\n");
    let huge = temp.path().join("huge.md");
    let huge_file = File::create(&huge).unwrap();
    huge_file.set_len(300 * 1024 * 1024).unwrap();

    let reads = std::sync::Arc::new(AtomicUsize::new(0));
    let reads_for_search = reads.clone();
    let options = ScanOptions {
        max_file_bytes: 2 * 1024 * 1024,
        concurrency: 1,
        ..ScanOptions::default()
    };
    let result = search::scan_markdown(
        temp.path(),
        options,
        Some(vec!["huge.md".into(), "small.md".into()]),
        move |path, text, per_file| {
            reads_for_search.fetch_add(1, Ordering::SeqCst);
            search::search_text(path, text, "needle", per_file)
        },
    )
    .await;
    assert_eq!(result.results.len(), 1);
    assert_eq!(result.results[0].path, "small.md");
    assert_eq!(
        reads.load(Ordering::SeqCst),
        1,
        "el archivo de 300 MB no debe leerse"
    );

    let reads = std::sync::Arc::new(AtomicUsize::new(0));
    let reads_for_search = reads.clone();
    let limited = search::scan_markdown(
        temp.path(),
        ScanOptions {
            limit: 1,
            concurrency: 1,
            ..ScanOptions::default()
        },
        Some(vec!["first.md".into(), "second.md".into(), "third.md".into()]),
        move |path, text, per_file| {
            reads_for_search.fetch_add(1, Ordering::SeqCst);
            search::search_text(path, text, "needle", per_file)
        },
    );
    temp.write("first.md", "needle\nneedle\n");
    temp.write("second.md", "needle\n");
    temp.write("third.md", "needle\n");
    let limited = limited.await;
    assert_eq!(limited.results.len(), 1);
    assert_eq!(
        reads.load(Ordering::SeqCst),
        1,
        "el límite debe detener el consumo del stream"
    );
}

#[tokio::test]
async fn backlinks_ignore_fences_and_deduplicate() {
    let temp = Temp::new();
    temp.write("inicio.md", "# Inicio\n");
    temp.write(
        "notas/uno.md",
        "ver [[inicio]] y [otra vez](../inicio.md)\n",
    );
    temp.write(
        "notas/dos.md",
        "```\n[[inicio]]\n```\n[texto](../inicio.md)\n",
    );
    temp.write("tres.md", "[[Inicio]]\n");

    let results = search::search_backlinks(temp.path(), "inicio.md", ScanOptions::default()).await;
    let paths: Vec<_> = results
        .results
        .iter()
        .map(|hit| hit.path.as_str())
        .collect();
    // El listado TS pone primero los archivos de la raíz y luego las subcarpetas.
    assert_eq!(paths, vec!["tres.md", "notas/dos.md", "notas/uno.md"]);
    assert!(!results.truncated);
    let uno = results
        .results
        .iter()
        .find(|hit| hit.path == "notas/uno.md")
        .unwrap();
    assert_eq!(uno.matches.len(), 2);
}
