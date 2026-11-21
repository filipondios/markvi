//! Validación de `config.toml`. Nunca lanza:
//! lo inválido se ignora y se convierte en aviso observable en `/api/config`.

use crate::core::pure::{self, Config, LeaderBinding, Theme, VimContext, VimMapping};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize)]
pub struct LoadedConfig {
    pub config: Config,
    pub warnings: Vec<String>,
    pub path: String,
    pub exists: bool,
}

pub fn resolve_config_path(flag: Option<&Path>, env: &[(String, String)]) -> PathBuf {
    let get = |key: &str| env.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());
    if let Some(flag) = flag.filter(|value| !value.as_os_str().is_empty()) {
        return absolute_or_join(flag);
    }
    if let Some(path) = get("MARKVI_CONFIG").filter(|value| !value.is_empty()) {
        return absolute_or_join(Path::new(&path));
    }
    let base = match get("XDG_CONFIG_HOME") {
        Some(home) if Path::new(&home).is_absolute() => PathBuf::from(home),
        _ => {
            let home = get("HOME")
                .map(PathBuf::from)
                .or_else(|| {
                    #[allow(deprecated)]
                    std::env::home_dir()
                })
                .unwrap_or_else(|| {
                    eprintln!(
                        "MARKVI: HOME no definido; no se pudo resolver el directorio personal"
                    );
                    std::env::temp_dir()
                });
            home.join(".config")
        }
    };
    base.join("markvi").join("config.toml")
}

fn absolute_or_join(path: &Path) -> PathBuf {
    let given = path;
    if given.is_absolute() {
        given.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(given)
    }
}

/// `\s` de JavaScript incluye U+FEFF, que `char::is_whitespace` no contempla.
fn is_js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

fn parse_key(token: &str) -> Option<String> {
    if token.eq_ignore_ascii_case("space") {
        return Some(" ".to_string());
    }
    let chars: Vec<char> = token.chars().collect();
    (chars.len() == 1 && !token.chars().any(is_js_space)).then(|| token.to_string())
}

pub fn parse_sequence(input: &str) -> Option<Vec<String>> {
    let text = input.trim();
    if text.is_empty() {
        return None;
    }
    if text.to_lowercase() == "space" {
        return Some(vec![" ".to_string()]);
    }
    let tokens: Vec<String> = if text.chars().any(is_js_space) {
        text.split_whitespace().map(str::to_string).collect()
    } else {
        text.chars().map(|c| c.to_string()).collect()
    };
    if tokens.len() > 4 {
        return None;
    }
    tokens.iter().map(|token| parse_key(token)).collect()
}

const GENERIC_FONTS: [&str; 5] = [
    "monospace",
    "ui-monospace",
    "sans-serif",
    "serif",
    "system-ui",
];

pub fn parse_font(input: &str) -> Option<String> {
    let mut names = Vec::new();
    for raw in input.split(',') {
        let name = raw.trim();
        let name = match name.strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
            Some(inner) => inner.trim(),
            None => match name.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')) {
                Some(inner) => inner.trim(),
                None => name,
            },
        };
        if !name.is_empty() {
            names.push(name.to_string());
        }
    }
    if names.is_empty() || names.len() > 8 {
        return None;
    }
    let mut css = Vec::new();
    for name in names {
        let lower = name.to_lowercase();
        if GENERIC_FONTS.contains(&lower.as_str()) {
            css.push(lower);
        } else if name.chars().count() <= 60
            && name
                .chars()
                .all(|c| c.is_alphanumeric() || " _.-".contains(c))
        {
            css.push(format!("\"{name}\""));
        } else {
            return None;
        }
    }
    Some(css.join(", "))
}

fn table(value: &toml::Value) -> Option<&toml::Table> {
    value.as_table()
}

/// `Display` de `toml::Value` ya da el literal TOML (`"neon"`, `5`).
fn show(value: &toml::Value) -> String {
    value.to_string()
}

fn show_action(action: Option<&str>, raw: &toml::Value) -> String {
    match action {
        Some(value) => format!("\"{value}\""),
        None => show(raw),
    }
}

fn warn_unknown(warnings: &mut Vec<String>, prefix: &str, table: &toml::Table, known: &[&str]) {
    for key in table.keys() {
        if !known.contains(&key.as_str()) {
            warnings.push(format!("Unknown key \"{prefix}{key}\"."));
        }
    }
}

fn same_keys(a: &[String], b: &[String]) -> bool {
    a == b
}

fn is_prefix(shorter: &[String], longer: &[String]) -> bool {
    shorter.len() < longer.len() && shorter.iter().zip(longer).all(|(a, b)| a == b)
}

fn apply_leader(config: &mut Config, value: Option<&toml::Value>, warnings: &mut Vec<String>) {
    let Some(table) = value.and_then(table) else {
        return;
    };
    let bindings = &mut config.leader_bindings;
    let mut user_defined: Vec<LeaderBinding> = Vec::new();
    for (sequence, raw) in table {
        let Some(keys) = parse_sequence(sequence) else {
            warnings.push(format!("keymap.leader: invalid key sequence {sequence:?}."));
            continue;
        };
        let action = raw.as_str();
        if action == Some("none") || action == Some("") {
            if let Some(index) = bindings.iter().position(|b| same_keys(&b.keys, &keys)) {
                bindings.remove(index);
            }
            continue;
        }
        let valid = action.is_some_and(|value| {
            [
                "find",
                "grep",
                "recent",
                "alternate",
                "toc",
                "backlinks",
                "close",
            ]
            .contains(&value)
                || (value.starts_with(':')
                    && !value[1..].trim().is_empty()
                    && value.encode_utf16().count() <= 200)
        });
        if !valid {
            warnings.push(format!(
                "keymap.leader.{sequence}: unknown action {}. Use find, grep, recent, alternate, toc, backlinks, close, \"none\" or an ex command such as \":e diary.md\".",
                show_action(action, raw)
            ));
            continue;
        }
        let binding = LeaderBinding {
            keys,
            action: action.unwrap().to_string(),
        };
        if let Some(index) = bindings
            .iter()
            .position(|b| same_keys(&b.keys, &binding.keys))
        {
            bindings[index] = binding.clone();
        } else {
            bindings.push(binding.clone());
        }
        user_defined.push(binding);
    }
    for binding in bindings.clone() {
        let blocker_keys = bindings
            .iter()
            .find(|other| is_prefix(&other.keys, &binding.keys))
            .map(|blocker| blocker.keys.join(" "));
        if let Some(blocker_keys) = blocker_keys {
            if let Some(index) = bindings
                .iter()
                .position(|b| same_keys(&b.keys, &binding.keys))
            {
                bindings.remove(index);
            }
            if user_defined.contains(&binding) {
                warnings.push(format!(
                    "keymap.leader: \"{}\" is ignored because \"{blocker_keys}\" is already bound. Unbind it with \"{blocker_keys}\" = \"none\".",
                    binding.keys.join(" ")
                ));
            }
        }
    }
}

fn apply_view_remap(config: &mut Config, value: Option<&toml::Value>, warnings: &mut Vec<String>) {
    let Some(table) = value.and_then(table) else {
        return;
    };
    for (from, raw) in table {
        let source = parse_key(from);
        let target = raw.as_str().and_then(parse_key);
        if source.is_none()
            || target.is_none()
            || source.as_deref() == Some(" ")
            || target.as_deref() == Some(" ")
        {
            warnings.push(format!(
                "keymap.view: {from:?} = {} must map one key to another key.",
                show(raw)
            ));
            continue;
        }
        if source != target {
            config.view_remap.insert(source.unwrap(), target.unwrap());
        }
    }
}

fn apply_vim(
    config: &mut Config,
    context: VimContext,
    value: Option<&toml::Value>,
    warnings: &mut Vec<String>,
) {
    let Some(table) = value.and_then(table) else {
        return;
    };
    let name = match context {
        VimContext::Normal => "normal",
        VimContext::Insert => "insert",
        VimContext::Visual => "visual",
    };
    for (lhs, raw) in table {
        let rhs = raw.as_str();
        if lhs.is_empty()
            || lhs.encode_utf16().count() > 64
            || rhs.is_none_or(|rhs| rhs.is_empty() || rhs.encode_utf16().count() > 64)
        {
            warnings.push(format!(
                "keymap.{name}: {lhs:?} = {} is not a valid mapping.",
                show(raw)
            ));
            continue;
        }
        config.vim_mappings.push(VimMapping {
            context,
            lhs: lhs.clone(),
            rhs: rhs.unwrap().to_string(),
        });
    }
}

pub fn validate_config(raw: &toml::Table) -> (Config, Vec<String>) {
    let mut config = pure::default_config();
    let mut warnings = Vec::new();

    warn_unknown(
        &mut warnings,
        "",
        raw,
        &["leader", "theme", "font", "editor", "keymap", "render"],
    );

    if let Some(value) = raw.get("leader") {
        let key = value.as_str().and_then(parse_key);
        let letter_or_digit = key.as_ref().is_some_and(|key| {
            key.chars().count() == 1 && key.chars().next().is_some_and(char::is_alphanumeric)
        });
        match key.filter(|_| !letter_or_digit) {
            None => warnings.push(format!(
                "\"leader\" must be \"space\" or a single symbol such as \",\" (got {}).",
                show(value)
            )),
            Some(key) => config.leader = key,
        }
    }
    if let Some(value) = raw.get("theme") {
        match value.as_str() {
            Some("auto") => config.theme = Theme::Auto,
            Some("light") => config.theme = Theme::Light,
            Some("dark") => config.theme = Theme::Dark,
            _ => warnings.push(format!(
                "\"theme\" must be \"auto\", \"light\" or \"dark\" (got {}).",
                show(value)
            )),
        }
    }
    if let Some(value) = raw.get("font") {
        match value.as_str().and_then(parse_font) {
            Some(font) => config.font = Some(font),
            None => warnings.push(
                "\"font\" must be a list of font names such as \"JetBrains Mono, monospace\"."
                    .to_string(),
            ),
        }
    }
    if let Some(value) = raw.get("editor") {
        match table(value) {
            None => warnings.push("\"editor\" must be a table.".to_string()),
            Some(editor) => {
                for (key, raw) in editor {
                    match key.as_str() {
                        "number" | "relativenumber" => match raw.as_bool() {
                            Some(value) if key == "number" => config.editor.number = value,
                            Some(value) => config.editor.relativenumber = value,
                            None => {
                                warnings.push(format!("\"editor.{key}\" must be true or false."))
                            }
                        },
                        "scrolloff" => match raw.as_integer() {
                            Some(value) if (0..=50).contains(&value) => {
                                config.editor.scrolloff = value as u32
                            }
                            _ => warnings.push(
                                "\"editor.scrolloff\" must be an integer between 0 and 50."
                                    .to_string(),
                            ),
                        },
                        _ => warnings.push(format!("Unknown key \"editor.{key}\".")),
                    }
                }
            }
        }
    }
    if let Some(value) = raw.get("render") {
        match table(value) {
            None => warnings.push("\"render\" must be a table.".to_string()),
            Some(render) => {
                for (key, raw) in render {
                    let slot: Option<&mut bool> = match key.as_str() {
                        "footnotes" => Some(&mut config.render.footnotes),
                        "alerts" => Some(&mut config.render.alerts),
                        "frontmatter" => Some(&mut config.render.frontmatter),
                        "remoteimages" => Some(&mut config.render.remoteimages),
                        _ => None,
                    };
                    match (slot, raw.as_bool()) {
                        (Some(slot), Some(value)) => *slot = value,
                        (Some(_), None) => {
                            warnings.push(format!("\"render.{key}\" must be true or false."))
                        }
                        (None, _) => warnings.push(format!("Unknown key \"render.{key}\".")),
                    }
                }
            }
        }
    }

    if let Some(value) = raw.get("keymap") {
        match table(value) {
            None => warnings.push("\"keymap\" must be a table.".to_string()),
            Some(keymap) => {
                for (name, value) in keymap {
                    if !["leader", "view", "normal", "insert", "visual"].contains(&name.as_str()) {
                        warnings.push(format!("Unknown section \"keymap.{name}\"."));
                    } else if table(value).is_none() {
                        warnings.push(format!("\"keymap.{name}\" must be a table."));
                    }
                }
                apply_leader(&mut config, keymap.get("leader"), &mut warnings);
                apply_view_remap(&mut config, keymap.get("view"), &mut warnings);
                apply_vim(
                    &mut config,
                    VimContext::Normal,
                    keymap.get("normal"),
                    &mut warnings,
                );
                apply_vim(
                    &mut config,
                    VimContext::Insert,
                    keymap.get("insert"),
                    &mut warnings,
                );
                apply_vim(
                    &mut config,
                    VimContext::Visual,
                    keymap.get("visual"),
                    &mut warnings,
                );
            }
        }
    }

    (config, warnings)
}

pub fn parse_config(text: Option<&str>) -> (Config, Vec<String>) {
    let Some(text) = text else {
        return (pure::default_config(), Vec::new());
    };
    if text.trim().is_empty() {
        return (pure::default_config(), Vec::new());
    }
    match toml::from_str::<toml::Table>(text) {
        Ok(raw) => validate_config(&raw),
        Err(error) => (
            pure::default_config(),
            vec![format!("Syntax error: {}", error.message())],
        ),
    }
}

pub async fn load_config(path: &Path) -> LoadedConfig {
    let path_string = path.to_string_lossy().into_owned();
    // Distinguir "no existe" de "existe pero no se puede leer" es observable.
    let exists = tokio::fs::try_exists(path).await.unwrap_or(true);
    if !exists {
        return LoadedConfig {
            config: pure::default_config(),
            warnings: Vec::new(),
            path: path_string,
            exists: false,
        };
    }
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(error) => {
            return LoadedConfig {
                config: pure::default_config(),
                warnings: vec![format!("Could not read the file: {error}")],
                path: path_string,
                exists: true,
            }
        }
    };
    let text = match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(error) => {
            return LoadedConfig {
                config: pure::default_config(),
                warnings: vec![format!("Could not read the file: {error}")],
                path: path_string,
                exists: true,
            }
        }
    };
    let (config, warnings) = parse_config(Some(&text));
    LoadedConfig {
        config,
        warnings,
        path: path_string,
        exists: true,
    }
}
