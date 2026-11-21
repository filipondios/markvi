//! Regresión: `wiki_links` debe ser lineal aunque haya muchos candidatos fallidos.
use markvi_server::core::pure::wiki_links;
use std::time::Instant;

#[test]
fn wiki_links_no_cuadratico_con_600kb() {
    for pattern in ["[[a ", "[[a]] "] {
        let mut text = String::with_capacity(600_000);
        while text.len() < 600_000 {
            text.push_str(pattern);
        }
        let start = Instant::now();
        let links = wiki_links(&text);
        let elapsed = start.elapsed();
        assert!(
            elapsed.as_millis() < 100,
            "{pattern:?} tardó {elapsed:?} ({} enlaces)",
            links.len()
        );
    }
}

#[test]
fn wiki_links_conserva_offsets_utf16_con_multibyte() {
    let links = wiki_links("é [[Ä]] y 😀[[B]]");
    assert_eq!(
        links
            .iter()
            .map(|(offset, _, _)| *offset)
            .collect::<Vec<_>>(),
        vec![2, 12]
    );
    assert_eq!(links[0].2.target, "Ä");
    assert_eq!(links[1].2.target, "B");
}
