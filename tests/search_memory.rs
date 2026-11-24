//! Memory regression: a line with 10,000 links must not be cloned 10,000 times.
//! Dedicated binary so VmHWM is not mixed with other tests in the process.
use markvi_server::{core::pure::WikiIndex, search};

/// Peak RSS in kB; 0 outside Linux.
fn peak_kb() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|status| {
            status
                .lines()
                .find(|line| line.starts_with("VmHWM:"))
                .and_then(|line| line.split_whitespace().nth(1))
                .and_then(|value| value.parse().ok())
        })
        .unwrap_or(0)
}

#[test]
fn diez_mil_enlaces_en_una_linea_no_explosionan() {
    let mut line = String::with_capacity(60_000);
    for _ in 0..10_000 {
        line.push_str("[[a]]");
    }
    while line.len() < 60_000 {
        line.push('x');
    }
    let source = format!("{line}\n");
    let index = WikiIndex::new(&["a.md".to_string()]);

    let before = peak_kb();
    let hits = search::find_backlinks(&source, "b.md", "a.md", &index, 20);
    let after = peak_kb();

    assert_eq!(hits.hits.len(), 1);
    assert!(!hits.truncated);
    if before != 0 && after != 0 {
        let growth = after.saturating_sub(before);
        assert!(
            growth < 50 * 1024,
            "pico de RSS: {growth} kB (antes {before} kB)"
        );
    }
}
