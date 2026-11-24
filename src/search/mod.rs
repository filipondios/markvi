//! Búsqueda y backlinks literales sobre Markdown.
//! El query se escapa en TS (`escapeRegExp`), así que aquí es búsqueda literal:
//! no se necesita el crate `regex`. El plegado de-case replica `/i` sin `u` de Bun.

use crate::{
    core::pure::{self, is_case_sensitive, is_markdown_path, wiki_links, WikiIndex},
    fs::{self, MarkdownEntry},
};
use futures_util::{stream, StreamExt};
use std::sync::Arc;

/// Resultado por archivo: el contrato TS usa `hits` aquí y `results` en el agregado.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct FileHits {
    pub hits: Vec<crate::core::pure::SearchHit>,
    pub truncated: bool,
}

pub const SCAN_LIMIT: usize = 200;
pub const SCAN_PER_FILE: usize = 20;
pub const SCAN_MAX_BYTES: u64 = 2 * 1024 * 1024;
pub const SCAN_CONCURRENCY: usize = 16;

const MAX_TEXT: usize = 240;
const CONTEXT_BEFORE: usize = 40;

#[derive(Clone, Debug)]
pub struct ScanOptions {
    pub limit: usize,
    pub per_file: usize,
    pub max_file_bytes: u64,
    pub concurrency: usize,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            limit: SCAN_LIMIT,
            per_file: SCAN_PER_FILE,
            max_file_bytes: SCAN_MAX_BYTES,
            concurrency: SCAN_CONCURRENCY,
        }
    }
}

/// Equivale a `String.prototype.toLowerCase()` de un solo carácter con las
/// excepciones observadas en Bun para `/i` sin bandera `u`.
fn fold(c: char) -> char {
    match c {
        'ς' => 'σ',
        'K' => 'K',
        _ => {
            let mut lower = c.to_lowercase();
            let first = lower.next().unwrap_or(c);
            if lower.next().is_none() {
                first
            } else {
                c
            }
        }
    }
}

fn split_lines(text: &str) -> Vec<&str> {
    let mut lines = Vec::new();
    let bytes = text.as_bytes();
    let mut start = 0;
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'\n' {
            let end = if index > start && bytes[index - 1] == b'\r' {
                index - 1
            } else {
                index
            };
            lines.push(&text[start..end]);
            start = index + 1;
        }
        index += 1;
    }
    lines.push(&text[start..]);
    lines
}

/// Query plegada una sola vez por búsqueda (o por llamada directa).
fn folded_query(query: &str, sensitive: bool) -> Vec<char> {
    if sensitive {
        query.chars().collect()
    } else {
        query.chars().map(fold).collect()
    }
}

fn contains_ascii_ci(text: &str, query: &str) -> bool {
    if query.is_empty() {
        return true;
    }
    let bytes = text.as_bytes();
    let needle = query.as_bytes();
    if needle.len() > bytes.len() {
        return false;
    }
    let first = needle[0];
    bytes.windows(needle.len()).any(|window| {
        window[0].eq_ignore_ascii_case(&first)
            && window
                .iter()
                .zip(needle)
                .all(|(actual, expected)| actual.eq_ignore_ascii_case(expected))
    })
}

/// Rangos UTF-16 de las coincidencias literales no solapadas de `query` en `line`.
fn literal_ranges(
    line: &str,
    query: &str,
    folded: &[char],
    sensitive: bool,
) -> Vec<(usize, usize)> {
    if folded.is_empty() {
        return Vec::new();
    }
    // Prefiltro por línea: evita materializar caracteres y offsets si no hay match.
    if sensitive {
        if !line.contains(query) {
            return Vec::new();
        }
    } else if query.is_ascii() && !contains_ascii_ci(line, query) {
        return Vec::new();
    }
    // ASCII: byte offset == UTF-16 offset, sin char_indices ni Vec<char>.
    if line.is_ascii() && query.is_ascii() {
        if sensitive {
            return line
                .match_indices(query)
                .map(|(at, matched)| (at, at + matched.len()))
                .collect();
        }
        let bytes = line.as_bytes();
        let needle = query.as_bytes();
        let mut ranges = Vec::new();
        let mut at = 0;
        while at + needle.len() <= bytes.len() {
            if bytes[at..at + needle.len()]
                .iter()
                .zip(needle)
                .all(|(actual, expected)| actual.eq_ignore_ascii_case(expected))
            {
                ranges.push((at, at + needle.len()));
                at += needle.len();
            } else {
                at += 1;
            }
        }
        return ranges;
    }

    let chars: Vec<char> = line.chars().collect();
    // Plegar una sola vez por línea, no en cada posición candidata.
    let folded_line: Vec<char> = chars
        .iter()
        .copied()
        .map(|character| if sensitive { character } else { fold(character) })
        .collect();
    let mut offsets = Vec::with_capacity(chars.len() + 1);
    let mut cursor = 0;
    for c in &chars {
        offsets.push(cursor);
        cursor += c.len_utf16();
    }
    offsets.push(cursor);

    let mut ranges = Vec::new();
    let mut at = 0;
    while at + folded.len() <= chars.len() {
        let matches = &folded_line[at..at + folded.len()] == folded;
        if matches {
            ranges.push((offsets[at], offsets[at + folded.len()]));
            at += folded.len();
        } else {
            at += 1;
        }
    }
    ranges
}

/// Recorta la línea como JS `buildHit`: índices y longitudes en unidades UTF-16.
pub fn build_hit(
    path: &str,
    line: usize,
    raw: &str,
    ranges: &[(usize, usize)],
) -> crate::core::pure::SearchHit {
    let units: Vec<u16> = raw.encode_utf16().collect();
    let trimmed_start = raw.trim_start();
    let lead = units.len() - pure::utf16_len(trimmed_start);
    let trimmed_end = raw.trim_end();
    let mut start = lead;
    let mut end = pure::utf16_len(trimmed_end);
    let mut cut_end = false;

    if end - start > MAX_TEXT {
        start = start.max(ranges[0].0.saturating_sub(CONTEXT_BEFORE));
        if end - start > MAX_TEXT {
            end = start + MAX_TEXT;
            cut_end = true;
        }
    }
    let prefix = start > lead;
    let mut text = String::new();
    if prefix {
        text.push('…');
    }
    text.push_str(&String::from_utf16_lossy(&units[start..end]));
    if cut_end {
        text.push('…');
    }
    let shift = usize::from(prefix) as isize - start as isize;
    let matches = ranges
        .iter()
        .filter(|(from, to)| *to > start && *from < end)
        .map(|(from, to)| {
            (
                (*from).max(start) as isize + shift,
                (*to).min(end) as isize + shift,
            )
        })
        .filter(|(from, to)| *from >= 0 && *to >= 0)
        .map(|(from, to)| (from as usize, to as usize))
        .collect();

    crate::core::pure::SearchHit {
        path: path.to_string(),
        line: line as u32,
        text,
        matches,
    }
}

pub fn search_text(path: &str, text: &str, query: &str, per_file: usize) -> FileHits {
    let sensitive = is_case_sensitive(query);
    let folded = folded_query(query, sensitive);
    search_text_prepared(path, text, query, per_file, sensitive, &folded)
}

/// Misma búsqueda, con `sensitive` y la query plegada calculados una sola vez.
fn search_text_prepared(
    path: &str,
    text: &str,
    query: &str,
    per_file: usize,
    sensitive: bool,
    folded: &[char],
) -> FileHits {
    let empty = || FileHits {
        hits: Vec::new(),
        truncated: false,
    };
    if folded.is_empty() {
        return empty();
    }
    // Prefiltro: sin candidato no hay que dividir el texto en líneas.
    if sensitive {
        if !text.contains(query) {
            return empty();
        }
    } else if query.is_ascii() && !contains_ascii_ci(text, query) {
        return empty();
    }

    let mut hits = Vec::new();
    let mut truncated = false;
    for (index, line) in split_lines(text).iter().enumerate() {
        let ranges = literal_ranges(line, query, folded, sensitive);
        if ranges.is_empty() {
            continue;
        }
        if hits.len() >= per_file {
            truncated = true;
            break;
        }
        hits.push(build_hit(path, index + 1, line, &ranges));
    }
    FileHits { hits, truncated }
}

fn empty_hits() -> FileHits {
    FileHits {
        hits: Vec::new(),
        truncated: false,
    }
}

/// Escanea los archivos Markdown visibles aplicando `search_file`.
pub async fn scan_markdown<F>(
    root: &std::path::Path,
    options: ScanOptions,
    files: Option<Vec<String>>,
    search_file: F,
) -> crate::core::pure::SearchResults
where
    F: Fn(&str, &str, usize) -> FileHits + Send + Sync + 'static,
{
    let all_files = match files {
        Some(files) => files,
        None => fs::unique_paths(&fs::list_markdown_entries(root).await),
    };
    let ScanOptions {
        limit,
        per_file,
        max_file_bytes,
        concurrency,
    } = options;
    let concurrency = concurrency.max(1);
    let root = root.to_path_buf();
    let search_file = Arc::new(search_file);

    let tasks = all_files.into_iter().map(|path| {
        let root = root.clone();
        let search_file = Arc::clone(&search_file);
        async move {
            let file = root.join(&path);
            // El metadata evita abrir/leer archivos obviamente demasiado grandes.
            match tokio::fs::metadata(&file).await {
                Ok(metadata) if metadata.len() <= max_file_bytes => {}
                _ => return empty_hits(),
            }
            tokio::task::spawn_blocking(move || {
                use std::io::Read;
                let opened = std::fs::File::open(&file);
                let mut handle = match opened {
                    Ok(handle) => handle,
                    Err(_) => return empty_hits(),
                };
                let mut bytes = Vec::new();
                if handle
                    .by_ref()
                    .take(max_file_bytes.saturating_add(1))
                    .read_to_end(&mut bytes)
                    .is_err()
                    || bytes.len() as u64 > max_file_bytes
                {
                    return empty_hits();
                }
                let text = String::from_utf8_lossy(&bytes);
                search_file(&path, text.as_ref(), per_file)
            })
            .await
            .unwrap_or_else(|_| empty_hits())
        }
    });

    // `buffered` conserva el orden de entrada; al alcanzar el límite se deja
    // de consumir el stream y se cancelan las lecturas que aún estén pendientes.
    let mut pending = stream::iter(tasks).buffered(concurrency);
    let mut results = Vec::new();
    let mut full = false;
    let mut capped = false;
    while let Some(entry) = pending.next().await {
        capped |= entry.truncated;
        for hit in entry.hits {
            if results.len() >= limit {
                full = true;
                break;
            }
            results.push(hit);
        }
        if full {
            break;
        }
    }
    crate::core::pure::SearchResults {
        results,
        truncated: full || capped,
    }
}

pub async fn search_markdown(
    root: &std::path::Path,
    query: &str,
    options: ScanOptions,
) -> crate::core::pure::SearchResults {
    let needle = query.trim().to_string();
    if needle.is_empty() {
        return crate::core::pure::SearchResults {
            results: Vec::new(),
            truncated: false,
        };
    }
    let sensitive = is_case_sensitive(&needle);
    let folded = Arc::new(folded_query(&needle, sensitive));
    scan_markdown(root, options, None, move |path, text, per_file| {
        search_text_prepared(path, text, &needle, per_file, sensitive, folded.as_slice())
    })
    .await
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct FoundLink {
    line: usize,
    range: (usize, usize),
    kind: LinkKind,
    target: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkKind {
    Wiki,
    Markdown,
}

fn may_have_links(line: &str) -> bool {
    line.contains("[[") || contains_ascii_ci(line, ".md")
}

/// Sustituye por espacios el código en línea, conservando longitudes UTF-16.
///
/// El cierre válido de una apertura de `ticks` acentos graves es la primera
/// tirada posterior con longitud `>= ticks` (la regex TS exige que el
/// delimitador no tenga más acentos graves a continuación). Las tiradas se
/// calculan en una pasada; `min_failed` recuerda la menor apertura sin cierre,
/// porque cualquier apertura mayor tampoco lo tendrá. Sin esto, cada apertura
/// sin cierre reescaneaba hasta el final de la línea (cuadrático).
fn mask_inline_code(line: &str) -> String {
    let tick = b'`' as u16;
    let units: Vec<u16> = line.encode_utf16().collect();
    let mut runs: Vec<(usize, usize)> = Vec::new();
    let mut at = 0;
    while at < units.len() {
        if units[at] == tick {
            let start = at;
            while at < units.len() && units[at] == tick {
                at += 1;
            }
            runs.push((start, at - start));
        } else {
            at += 1;
        }
    }
    let mut masked = units;
    let mut min_failed = usize::MAX;
    let mut index = 0;
    while index < runs.len() {
        let (start, ticks) = runs[index];
        if ticks >= min_failed {
            index += 1;
            continue;
        }
        match runs[index + 1..].iter().position(|&(_, len)| len >= ticks) {
            Some(offset) => {
                let close = index + 1 + offset;
                let end = runs[close].0 + runs[close].1;
                for unit in &mut masked[start..end] {
                    *unit = b' ' as u16;
                }
                index = close + 1;
            }
            None => {
                min_failed = ticks;
                index += 1;
            }
        }
    }
    String::from_utf16_lossy(&masked)
}

fn markdown_links(line: &str) -> Vec<((usize, usize), String)> {
    let mut out = Vec::new();
    let units: Vec<u16> = line.encode_utf16().collect();
    // Para cada posición, índice del siguiente `]` o salto de línea. Se calcula
    // en una pasada y evita volver a recorrer el sufijo por cada `[`.
    let mut next_close = vec![units.len(); units.len() + 1];
    let mut next = units.len();
    for index in (0..units.len()).rev() {
        if units[index] == b']' as u16 || units[index] == b'\n' as u16 {
            next = index;
        }
        next_close[index] = next;
    }
    let mut at = 0;
    while at < units.len() {
        if units[at] != b'[' as u16 {
            at += 1;
            continue;
        }
        // Descarta imágenes `![...]` y busca `](...)`.
        if at > 0 && units[at - 1] == b'!' as u16 {
            at += 1;
            continue;
        }
        if at + 1 >= units.len() {
            break;
        }
        let close_bracket = next_close[at + 1];
        if close_bracket == units.len() {
            break;
        }
        if units[close_bracket] != b']' as u16 {
            break;
        }
        if close_bracket + 1 >= units.len() || units[close_bracket + 1] != b'(' as u16 {
            at += 1;
            continue;
        }
        let mut cursor = close_bracket + 2;
        while cursor < units.len() && units[cursor] == b' ' as u16 {
            cursor += 1;
        }
        let start = cursor;
        if cursor < units.len() && units[cursor] == b'<' as u16 {
            cursor += 1;
            while cursor < units.len()
                && units[cursor] != b'>' as u16
                && units[cursor] != b'\n' as u16
            {
                cursor += 1;
            }
            if cursor < units.len() && units[cursor] == b'>' as u16 {
                cursor += 1;
            }
        } else {
            while cursor < units.len()
                && units[cursor] != b')' as u16
                && units[cursor] != b' ' as u16
                && units[cursor] != b'\n' as u16
            {
                cursor += 1;
            }
        }
        let destination_end = cursor;
        while cursor < units.len() && units[cursor] != b')' as u16 && units[cursor] != b'\n' as u16
        {
            cursor += 1;
        }
        if cursor >= units.len() || units[cursor] != b')' as u16 {
            at += 1;
            continue;
        }
        let target = String::from_utf16_lossy(&units[start..destination_end])
            .trim_start_matches('<')
            .trim_end_matches('>')
            .to_string();
        out.push(((at, cursor + 1), target));
        at = cursor + 1;
    }
    out
}

pub fn extract_links(source: &str) -> Vec<FoundLink> {
    let mut links = Vec::new();
    let mut fence: Option<(char, usize)> = None;
    for (index, raw) in split_lines(source).iter().enumerate() {
        let trimmed = raw.trim_start_matches(' ');
        let symbol = trimmed.chars().next();
        let marker = if trimmed.len() <= raw.len()
            && raw.len() - trimmed.len() <= 3
            && (symbol == Some('`') || symbol == Some('~'))
        {
            let ticks = trimmed.chars().take_while(|c| Some(*c) == symbol).count();
            if ticks >= 3 {
                let rest = trimmed[ticks..].trim();
                // CommonMark: el info-string de una valla de backticks no puede
                // contener backticks; esa línea es texto normal.
                if symbol == Some('`') && rest.contains('`') {
                    None
                } else {
                    Some((symbol.unwrap(), ticks, rest))
                }
            } else {
                None
            }
        } else {
            None
        };
        if let Some((symbol, ticks, rest)) = marker {
            if let Some((open_symbol, open_ticks)) = fence {
                if symbol == open_symbol && ticks >= open_ticks && rest.is_empty() {
                    fence = None;
                }
                continue;
            }
            fence = Some((symbol, ticks));
            continue;
        }
        if fence.is_some() || !may_have_links(raw) {
            continue;
        }
        let text = mask_inline_code(raw);
        for (start, full, ref_) in wiki_links(&text) {
            links.push(FoundLink {
                line: index + 1,
                range: (start, start + pure::utf16_len(&full)),
                kind: LinkKind::Wiki,
                target: ref_.target,
            });
        }
        for (range, target) in markdown_links(&text) {
            links.push(FoundLink {
                line: index + 1,
                range,
                kind: LinkKind::Markdown,
                target,
            });
        }
    }
    links
}

pub fn posix_normalize(path: &str) -> String {
    let mut stack: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if stack.last().is_some_and(|last| *last != "..") {
                    stack.pop();
                } else {
                    stack.push("..");
                }
            }
            other => stack.push(other),
        }
    }
    stack.join("/")
}

fn decode_percent(path: &str) -> String {
    pure::percent_decode(path).unwrap_or_else(|| path.to_string())
}

pub fn markdown_target(destination: &str, from: &str) -> Option<String> {
    if destination.is_empty() || destination.starts_with('#') || destination.starts_with("//") {
        return None;
    }
    if let Some(colon) = destination.find(':') {
        let prefix = &destination[..colon];
        if prefix
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic())
            && prefix
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c))
        {
            return None;
        }
    }
    let without_fragment = destination.split(['#', '?']).next().unwrap_or("");
    let decoded = decode_percent(without_fragment);
    if !is_markdown_path(&decoded) {
        return None;
    }
    let resolved = if let Some(rest) = decoded.strip_prefix('/') {
        posix_normalize(rest)
    } else {
        let dir = from.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("");
        posix_normalize(&format!("{dir}/{decoded}"))
    };
    (!resolved.starts_with("..")).then_some(resolved)
}

pub fn find_backlinks(
    source: &str,
    from: &str,
    to: &str,
    index: &WikiIndex,
    per_file: usize,
) -> FileHits {
    let mut empty = FileHits {
        hits: Vec::new(),
        truncated: false,
    };
    if from == to || !may_have_links(source) {
        return empty;
    }
    let mut by_line: std::collections::BTreeMap<usize, Vec<(usize, usize)>> =
        std::collections::BTreeMap::new();
    for link in extract_links(source) {
        let resolved = match link.kind {
            LinkKind::Wiki => index.resolve(&link.target, from),
            LinkKind::Markdown => markdown_target(&link.target, from),
        };
        if resolved.as_deref() != Some(to) {
            continue;
        }
        by_line.entry(link.line).or_default().push(link.range);
    }
    let lines = split_lines(source);
    let mut hits = Vec::new();
    for (line, ranges) in by_line {
        if hits.len() >= per_file {
            empty.truncated = true;
            break;
        }
        let Some(raw) = lines.get(line - 1) else {
            continue;
        };
        hits.push(build_hit(from, line, raw, &ranges));
    }
    empty.hits = hits;
    empty
}

pub async fn search_backlinks(
    root: &std::path::Path,
    target: &str,
    options: ScanOptions,
) -> crate::core::pure::SearchResults {
    let entries: Vec<MarkdownEntry> = fs::list_markdown_entries(root).await;
    let index = Arc::new(WikiIndex::new(
        &entries
            .iter()
            .map(|entry| entry.path.clone())
            .collect::<Vec<_>>(),
    ));
    let files = fs::unique_paths(&entries);
    let target = target.to_string();
    scan_markdown(root, options, Some(files), move |path, text, per_file| {
        find_backlinks(text, path, &target, index.as_ref(), per_file)
    })
    .await
}

#[cfg(test)]
mod tests {
    fn mask_inline_code_reference(line: &str) -> String {
        let units: Vec<u16> = line.encode_utf16().collect();
        let mut masked = units.clone();
        let mut cursor = 0;
        while cursor < units.len() {
            if units[cursor] != b'`' as u16 {
                cursor += 1;
                continue;
            }
            let mut ticks = 1;
            while cursor + ticks < units.len() && units[cursor + ticks] == b'`' as u16 {
                ticks += 1;
            }
            // La regex TS exige que el delimitador de cierre no tenga más acentos graves.
            let mut end = cursor + ticks;
            let mut found = None;
            while end + ticks <= units.len() {
                if units[end..end + ticks].iter().all(|u| *u == b'`' as u16)
                    && (end + ticks >= units.len() || units[end + ticks] != b'`' as u16)
                {
                    found = Some(end + ticks);
                    break;
                }
                end += 1;
            }
            if let Some(close) = found {
                for unit in masked.iter_mut().take(close).skip(cursor) {
                    *unit = b' ' as u16;
                }
                cursor = close;
            } else {
                cursor += ticks;
            }
        }
        String::from_utf16_lossy(&masked)
    }

    fn lcg(seed: &mut u64) -> u64 {
        *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        *seed >> 33
    }

    #[test]
    fn mask_inline_code_equivale_a_la_referencia() {
        let mut seed = 42;
        let alphabet = ['`', '`', '`', 'a', ' ', '[', 'é', '😀'];
        for _ in 0..2000 {
            let len = (lcg(&mut seed) % 60) as usize;
            let line: String = (0..len)
                .map(|_| alphabet[(lcg(&mut seed) % alphabet.len() as u64) as usize])
                .collect();
            assert_eq!(
                mask_inline_code(&line),
                mask_inline_code_reference(&line),
                "{line:?}"
            );
        }
    }

    #[test]
    #[cfg_attr(debug_assertions, ignore = "umbral de tiempo solo en release")]
    fn mask_inline_code_adversarial_es_lineal() {
        let mut line = String::from("[[");
        for ticks in (1..=1900).rev() {
            line.push_str(&"`".repeat(ticks));
            line.push(' ');
        }
        assert!(line.len() > 1_800_000);
        let start = std::time::Instant::now();
        let _ = mask_inline_code(&line);
        assert!(start.elapsed() < std::time::Duration::from_millis(200), "{:?}", start.elapsed());
    }
    use super::{decode_percent, mask_inline_code};

    #[test]
    fn decode_percent_no_panica_con_multibyte_y_deja_literal_invalido() {
        // %aé corta un carácter UTF-8: antes hacía panic en el slice &str.
        assert_eq!(decode_percent("%aé.md"), "%aé.md");
        assert_eq!(decode_percent("%41"), "A");
        assert_eq!(decode_percent("%+4"), "%+4");
        assert_eq!(decode_percent("%"), "%");
    }

    #[test]
    fn found_link_no_clona_la_linea_completa() {
        assert!(
            std::mem::size_of::<super::FoundLink>() <= 64,
            "FoundLink sigue guardando una copia de la línea por enlace"
        );
    }

    #[test]
    fn markdown_links_lineal_en_corchetes_sin_destino() {
        let line = format!("{}]", "[".repeat(100_000));
        let start = std::time::Instant::now();
        assert!(super::markdown_links(&line).is_empty());
        assert!(
            start.elapsed() < std::time::Duration::from_millis(100),
            "markdown_links tardó {:?} con 100k corchetes",
            start.elapsed()
        );
    }
}
