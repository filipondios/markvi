//! Núcleo puro del servidor: rutas, wiki y valores por defecto.
//! Sin Node, Bun ni DOM. Las firmas y el orden de campos siguen a los tests de `src/`.

use serde::{Deserialize, Serialize};
use serde_json::Map;

pub const HOSTNAME: &str = "127.0.0.1";
pub const SSE_HEARTBEAT_MS: u64 = 25_000;

pub const VIEW_PREFIX: &str = "/view/";
pub const FILES_PREFIX: &str = "/files/";
pub const CONFIG_URL: &str = "/api/config";
pub const TREE_URL: &str = "/api/tree";
pub const FILES_URL: &str = "/api/file";
pub const MOVE_URL: &str = "/api/move";
pub const SEARCH_URL: &str = "/api/search";
pub const BACKLINKS_URL: &str = "/api/backlinks";
pub const EVENTS_URL: &str = "/api/events";

pub fn is_case_sensitive(query: &str) -> bool {
    query != query.to_lowercase()
}

pub fn normalize_path(path: &str) -> String {
    let path = path.replace('\\', "/");
    let path = path.strip_prefix("./").unwrap_or(&path);
    path.trim_start_matches('/').to_string()
}

pub fn is_markdown_path(path: &str) -> bool {
    path.to_lowercase().ends_with(".md")
}

pub fn is_safe_path(path: &str) -> bool {
    if !is_markdown_path(path)
        || path.starts_with('/')
        || path.contains('\0')
        || path.contains('\\')
    {
        return false;
    }
    path.split('/')
        .all(|s| !s.is_empty() && s != ".." && !s.starts_with('.'))
}

/// Equivale a `encodeURIComponent`: deja A-Z a-z 0-9 - _ . ! ~ * ' ( ).
pub fn encode_uri_component(value: &str) -> String {
    let mut out = String::new();
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(byte) {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

pub fn normalize_new_path(input: &str) -> Option<String> {
    let mut path = input
        .trim()
        .strip_prefix("./")
        .unwrap_or(input.trim())
        .to_string();
    while path.contains("//") {
        path = path.replace("//", "/");
    }
    if path.is_empty() {
        return None;
    }
    if !is_markdown_path(&path) {
        path.push_str(".md");
    }
    if path.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}') {
        return None;
    }
    is_safe_path(&path).then_some(path)
}

pub fn split_path(path: &str) -> (&str, &str) {
    match path.rfind('/') {
        Some(index) => (&path[..index], &path[index + 1..]),
        None => ("", path),
    }
}

pub fn view_url(path: &str) -> String {
    let encoded = path
        .split('/')
        .map(encode_uri_component)
        .collect::<Vec<_>>()
        .join("/");
    format!("{VIEW_PREFIX}{encoded}")
}

pub fn file_url(path: &str) -> String {
    format!("{FILES_URL}?path={}", encode_uri_component(path))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    Auto,
    Light,
    Dark,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeaderBinding {
    pub keys: Vec<String>,
    pub action: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VimContext {
    Normal,
    Insert,
    Visual,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VimMapping {
    pub context: VimContext,
    pub lhs: String,
    pub rhs: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EditorOptions {
    pub number: bool,
    pub relativenumber: bool,
    pub scrolloff: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenderExtras {
    pub footnotes: bool,
    pub alerts: bool,
    pub frontmatter: bool,
    pub remoteimages: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Config {
    pub leader: String,
    pub theme: Theme,
    pub font: Option<String>,
    pub editor: EditorOptions,
    #[serde(rename = "leaderBindings")]
    pub leader_bindings: Vec<LeaderBinding>,
    #[serde(rename = "viewRemap")]
    pub view_remap: Map<String, serde_json::Value>,
    #[serde(rename = "vimMappings")]
    pub vim_mappings: Vec<VimMapping>,
    pub render: RenderExtras,
}

pub fn default_config() -> Config {
    let actions = [
        "find",
        "grep",
        "recent",
        "alternate",
        "toc",
        "backlinks",
        "close",
    ];
    Config {
        leader: " ".to_string(),
        theme: Theme::Auto,
        font: None,
        editor: EditorOptions {
            number: true,
            relativenumber: false,
            scrolloff: 0,
        },
        leader_bindings: actions
            .iter()
            .map(|action| LeaderBinding {
                keys: vec![match *action {
                    "find" => "f",
                    "grep" => "/",
                    "recent" => "r",
                    "alternate" => "a",
                    "toc" => "t",
                    "backlinks" => "b",
                    "close" => "x",
                    _ => unreachable!(),
                }
                .to_string()],
                action: (*action).to_string(),
            })
            .collect(),
        view_remap: Map::new(),
        vim_mappings: Vec::new(),
        render: RenderExtras {
            footnotes: true,
            alerts: true,
            frontmatter: true,
            remoteimages: false,
        },
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchHit {
    pub path: String,
    pub line: u32,
    pub text: String,
    /// Rangos UTF-16 `[desde, hasta)`, como en el navegador.
    pub matches: Vec<(usize, usize)>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchResults {
    pub results: Vec<SearchHit>,
    pub truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WikiRef {
    pub target: String,
    pub heading: String,
    pub alias: String,
}

fn forbidden_link_char(c: char) -> bool {
    matches!(c, '[' | ']' | '\n')
}

/// Parsea el contenido entre `[[` y `]]` con la misma gramática que el regex TS.
pub fn parse_wiki_link(inner: &str) -> Option<WikiRef> {
    if inner.chars().any(forbidden_link_char) {
        return None;
    }
    let (before_heading, alias) = inner.split_once('|').unwrap_or((inner, ""));
    let (target, heading) = before_heading
        .split_once('#')
        .unwrap_or((before_heading, ""));
    let ref_ = WikiRef {
        target: target.trim().to_string(),
        heading: heading.trim().to_string(),
        alias: alias.trim().to_string(),
    };
    if ref_.target.is_empty() && ref_.heading.is_empty() {
        None
    } else {
        Some(ref_)
    }
}

/// Todas las coincidencias `[[...]]` de un texto: (offset UTF-16, texto, referencia).
/// Escanea solo hasta el primer `[`, `]` o `\n` tras `[[`, así que es lineal.
pub fn wiki_links(text: &str) -> Vec<(usize, String, WikiRef)> {
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    let mut utf16 = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'[' && bytes.get(i + 1) == Some(&b'[') {
            let mut j = i + 2;
            let mut inner_utf16 = 0usize;
            let mut close = None;
            while j < bytes.len() {
                let c = text[j..].chars().next().expect("índice de byte válido");
                match c {
                    ']' => {
                        if bytes.get(j + 1) == Some(&b']') {
                            close = Some(j);
                        }
                        break;
                    }
                    '[' | '\n' => break,
                    _ => {
                        inner_utf16 += c.len_utf16();
                        j += c.len_utf8();
                    }
                }
            }
            if let Some(j) = close {
                let inner = &text[i + 2..j];
                if let Some(ref_) = parse_wiki_link(inner) {
                    out.push((utf16, text[i..j + 2].to_string(), ref_));
                }
                utf16 += 4 + inner_utf16;
                i = j + 2;
                continue;
            }
            // Candidato fallido: saltar directamente al carácter prohibido.
            if j > i + 2 {
                utf16 += 2 + inner_utf16;
                i = j;
                continue;
            }
        }
        let c = text[i..].chars().next().expect("índice de byte válido");
        utf16 += c.len_utf16();
        i += c.len_utf8();
    }
    out
}

pub fn wiki_label(ref_: &WikiRef) -> String {
    if !ref_.alias.is_empty() {
        return ref_.alias.clone();
    }
    if !ref_.target.is_empty() && !ref_.heading.is_empty() {
        return format!("{} > {}", ref_.target, ref_.heading);
    }
    if !ref_.target.is_empty() {
        ref_.target.clone()
    } else {
        ref_.heading.clone()
    }
}

/// Slug de título: quita lo que no sea letra, número, espacio, `_` o `-`.
pub fn heading_slug(text: &str) -> String {
    let cleaned: String = text
        .trim()
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace() || *c == '_' || *c == '-')
        .collect();
    cleaned.split_whitespace().collect::<Vec<_>>().join("-")
}

pub fn join_relative(base: &str, relative: &str) -> Option<String> {
    let combined = format!("{base}{relative}");
    let mut stack: Vec<&str> = Vec::new();
    for segment in combined.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            stack.pop()?;
            continue;
        }
        stack.push(segment);
    }
    Some(stack.join("/"))
}

fn strip_md(path: &str) -> String {
    let lower = path.to_lowercase();
    if lower.ends_with(".md") {
        path[..path.len() - 3].to_string()
    } else {
        path.to_string()
    }
}

fn directory_of(path: &str) -> &str {
    match path.rfind('/') {
        Some(index) => &path[..index + 1],
        None => "",
    }
}

fn last_segment(path: &str) -> &str {
    match path.rfind('/') {
        Some(index) => &path[index + 1..],
        None => path,
    }
}

#[derive(Clone, Debug)]
struct WikiEntry {
    file: String,
    key: String,
    depth: usize,
}

pub struct WikiIndex {
    by_name: std::collections::HashMap<String, Vec<WikiEntry>>,
}

impl WikiIndex {
    pub fn new(files: &[String]) -> Self {
        let mut by_name: std::collections::HashMap<String, Vec<WikiEntry>> =
            std::collections::HashMap::new();
        for file in files {
            let key = strip_md(file).to_lowercase();
            let name = last_segment(&key).to_string();
            let entry = WikiEntry {
                file: file.clone(),
                key,
                depth: file.split('/').count(),
            };
            by_name.entry(name).or_default().push(entry);
        }
        Self { by_name }
    }

    /// Resolución Obsidian-style; el desempate final usa orden de bytes, no ICU.
    pub fn resolve(&self, target: &str, from: &str) -> Option<String> {
        let mut raw = target.trim().replace('\\', "/");
        while raw.contains("//") {
            raw = raw.replace("//", "/");
        }
        if raw.is_empty() {
            return Some(from.to_string());
        }
        let from_dir = directory_of(from);
        let mut exact_only = false;
        if raw.starts_with('/') {
            raw = raw.trim_start_matches('/').to_string();
            exact_only = true;
        } else if raw.starts_with("./") || raw.starts_with("../") {
            raw = join_relative(from_dir, &raw)?;
            exact_only = true;
        }
        let name = strip_md(&raw).to_lowercase();
        if name.is_empty() {
            return None;
        }
        let candidates = self.by_name.get(last_segment(&name))?;
        let sibling = format!("{from_dir}{name}").to_lowercase();
        let mut best: Option<&WikiEntry> = None;
        let mut best_rank = (3usize, 3usize, usize::MAX);
        for entry in candidates {
            let exact = entry.key == name;
            if !exact && (exact_only || !entry.key.ends_with(&format!("/{name}"))) {
                continue;
            }
            let rank = (
                if !exact_only && entry.key == sibling {
                    0
                } else {
                    1
                },
                if exact { 0 } else { 1 },
                entry.depth,
            );
            let better = match (
                rank.0.cmp(&best_rank.0),
                rank.1.cmp(&best_rank.1),
                rank.2.cmp(&best_rank.2),
            ) {
                (std::cmp::Ordering::Less, _, _) => true,
                (std::cmp::Ordering::Equal, std::cmp::Ordering::Less, _) => true,
                (
                    std::cmp::Ordering::Equal,
                    std::cmp::Ordering::Equal,
                    std::cmp::Ordering::Less,
                ) => true,
                (
                    std::cmp::Ordering::Equal,
                    std::cmp::Ordering::Equal,
                    std::cmp::Ordering::Equal,
                ) => best.is_some_and(|current| entry.file < current.file),
                _ => false,
            };
            if better {
                best = Some(entry);
                best_rank = rank;
            }
        }
        best.map(|entry| entry.file.clone())
    }
}
