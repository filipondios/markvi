//! Performance regression: a no-match search over ~94 MB must stay fast.
use markvi_server::search::{search_markdown, ScanOptions};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
    time::Instant,
};

static COUNTER: AtomicUsize = AtomicUsize::new(0);

struct Temp(PathBuf);

impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "markvi-search-perf-{}-{}",
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

#[tokio::test(flavor = "multi_thread")]
#[cfg_attr(debug_assertions, ignore = "umbral de tiempo solo en release")]
async fn busqueda_sin_resultados_en_94mb_es_rapida() {
    let temp = Temp::new();
    let body = "a".repeat(23_500);
    for index in 0..4000 {
        fs::write(
            temp.path().join(format!("{index:04}.md")),
            format!("# nota {index}\n{body}\n"),
        )
        .unwrap();
    }

    let start = Instant::now();
    let results = search_markdown(temp.path(), "zzz_no_existe_zzz", ScanOptions::default()).await;
    let elapsed = start.elapsed();

    assert!(results.results.is_empty());
    assert!(
        elapsed.as_millis() < 500,
        "la búsqueda tardó {elapsed:?} en ~94 MB"
    );
}
