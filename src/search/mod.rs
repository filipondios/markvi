//! Búsqueda y backlinks. Espejo de `src/search.ts` y `src/backlinks.ts`.
//! El query se escapa en TS (`escapeRegExp`), así que aquí es búsqueda literal:
//! no se necesita el crate `regex`. El plegado de-case replica `/i` sin `u` de Bun.

use crate::{
    core::pure::{is_case_sensitive, is_markdown_path, wiki_links, WikiIndex, WikiRef},
    fs::{self, MarkdownEntry},
};
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

fn utf16_len(text: &str) -> usize {
    text.chars().map(|c| c.len_utf16()).sum()
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

fn equal_at(chars: &[char], at: usize, query: &[char], sensitive: bool) -> bool {
    if at + query.len() > chars.len() {
        return false;
    }
    query.iter().enumerate().all(|(offset, expected)| {
        let actual = chars[at + offset];
        if sensitive {
            actual == *expected
        } else {
            fold(actual) == fold(*expected)
        }
    })
}

/// Rangos UTF-16 de las coincidencias literales no solapadas de `query` en `line`.
fn literal_ranges(line: &str, query: &str, sensitive: bool) -> Vec<(usize, usize)> {
    let query_chars: Vec<char> = query.chars().collect();
    let chars: Vec<char> = line.chars().collect();
    let mut offsets = Vec::with_capacity(chars.len() + 1);
    let mut cursor = 0;
    for c in &chars {
        offsets.push(cursor);
        cursor += c.len_utf16();
    }
    offsets.push(cursor);

    let mut ranges = Vec::new();
    let mut at = 0;
    while at + query_chars.len() <= chars.len() {
        if equal_at(&chars, at, &query_chars, sensitive) {
            ranges.push((offsets[at], offsets[at + query_chars.len()]));
            at += query_chars.len();
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
    let lead = units.len() - utf16_len(trimmed_start);
    let trimmed_end = raw.trim_end();
    let mut start = lead;
    let mut end = utf16_len(trimmed_end);
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
    let mut hits = Vec::new();
    let mut truncated = false;
    for (index, line) in split_lines(text).iter().enumerate() {
        let ranges = literal_ranges(line, query, sensitive);
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

/// Escanea los archivos Markdown visibles aplicando `search_file`.
pub async fn scan_markdown<F>(
    root: &std::path::Path,
    options: ScanOptions,
    files: Option<Vec<String>>,
    search_file: F,
) -> crate::core::pure::SearchResults
where
    F: Fn(&str, &str, usize) -> FileHits,
{
    let all_files = match files {
        Some(files) => files,
        None => fs::unique_paths(&fs::list_markdown_entries(root).await),
    };
    let mut results = Vec::new();
    let mut full = false;
    let mut capped = false;
    for path in all_files {
        if full {
            break;
        }
        let file = root.join(&path);
        let metadata = match tokio::fs::metadata(&file).await {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if metadata.len() > options.max_file_bytes {
            continue;
        }
        let text = match tokio::fs::read_to_string(&file).await {
            Ok(text) => text,
            Err(_) => continue,
        };
        let found = search_file(&path, &text, options.per_file);
        for hit in found.hits {
            if results.len() >= options.limit {
                full = true;
                break;
            }
            results.push(hit);
        }
        capped |= found.truncated;
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
    let needle = query.trim();
    if needle.is_empty() {
        return crate::core::pure::SearchResults {
            results: Vec::new(),
            truncated: false,
        };
    }
    scan_markdown(root, options, None, |path, text, per_file| {
        search_text(path, text, needle, per_file)
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
    line.contains("[[") || line.to_lowercase().contains(".md")
}

/// Sustituye por espacios el código en línea, conservando longitudes UTF-16.
fn mask_inline_code(line: &str) -> String {
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

fn markdown_links(line: &str) -> Vec<((usize, usize), String)> {
    let mut out = Vec::new();
    let units: Vec<u16> = line.encode_utf16().collect();
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
        let Some(close_bracket) = units[at + 1..]
            .iter()
            .position(|u| *u == b']' as u16 || *u == b'\n' as u16)
            .map(|index| at + 1 + index)
        else {
            break;
        };
        if units[close_bracket] != b']' as u16
            || close_bracket + 1 >= units.len()
            || units[close_bracket + 1] != b'(' as u16
        {
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
        let marker = if trimmed.len() <= raw.len() && raw.len() - trimmed.len() <= 3 {
            let ticks = trimmed
                .chars()
                .take_while(|c| *c == '`' || *c == '~')
                .count();
            let symbol = trimmed.chars().next();
            if (symbol == Some('`') || symbol == Some('~')) && ticks >= 3 {
                Some((symbol.unwrap(), ticks, trimmed[ticks..].trim()))
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
        for (start, full) in wiki_links(&text) {
            if let Some(ref_) = parse_ref(&full) {
                links.push(FoundLink {
                    line: index + 1,
                    range: (start, start + utf16_len(&full)),
                    kind: LinkKind::Wiki,
                    target: ref_.target,
                });
            }
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

fn parse_ref(full: &str) -> Option<WikiRef> {
    let inner = full.strip_prefix("[[")?.strip_suffix("]]")?;
    crate::core::pure::parse_wiki_link(inner)
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

fn hex_val(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn decode_percent(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let decoded = if bytes[index] == b'%' && index + 2 < bytes.len() {
            hex_val(bytes[index + 1])
                .zip(hex_val(bytes[index + 2]))
                .map(|(high, low)| (high << 4) | low)
        } else {
            None
        };
        match decoded {
            Some(byte) => {
                out.push(byte);
                index += 3;
            }
            None => {
                out.push(bytes[index]);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
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
    scan_markdown(root, options, Some(files), |path, text, per_file| {
        find_backlinks(text, path, target, &index, per_file)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::decode_percent;

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
}
