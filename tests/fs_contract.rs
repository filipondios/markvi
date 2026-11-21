//! Contratos de filesystem y configuración del producto.
//! Todo corre sobre directorios temporales; `example/` nunca se escribe.
use markvi_server::{
    config,
    core::pure,
    fs::{self, HttpError},
};
use std::{
    fs::File,
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicUsize, Ordering},
};

static COUNTER: AtomicUsize = AtomicUsize::new(0);

struct Temp(PathBuf);

impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "markvi-fs-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn write(&self, relative: &str, body: &str) -> PathBuf {
        let path = self.0.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut file = File::create(&path).unwrap();
        file.write_all(body.as_bytes()).unwrap();
        path
    }

    fn link(&self, relative: &str, target: &str) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, self.0.join(relative)).unwrap();
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn err(result: Result<PathBuf, HttpError>) -> (u16, String) {
    match result {
        Ok(_) => (200, String::new()),
        Err(HttpError { status, message }) => (status, message),
    }
}

#[tokio::test]
async fn list_markdown_ignores_hidden_and_escaping_symlinks() {
    let temp = Temp::new();
    temp.write("a.MD", "a");
    temp.write("b.md", "b");
    temp.write("sub/d.md", "d");
    temp.write(".oculta.md", "x");
    temp.write("node_modules/x.md", "x");
    temp.link("enlace.md", "/etc/passwd");
    temp.link("roto.md", "no-existe");
    let mut listed = fs::list_markdown(temp.path()).await;
    listed.sort();
    assert_eq!(listed, vec!["a.MD", "b.md", "sub/d.md"]);
}

#[tokio::test]
async fn resolve_file_traversal_and_hidden() {
    let temp = Temp::new();
    temp.write("c.txt", "c");
    temp.write("sub/c.md", "c");
    temp.write(".oculta.md", "x");
    temp.write("node_modules/n.md", "x");
    temp.link("enlace.md", "/etc/passwd");
    let root = temp.path();

    assert_eq!(
        fs::resolve_file(root, Some("sub/../c.txt")).await.unwrap(),
        root.join("c.txt").canonicalize().unwrap()
    );
    for path in [
        "../secreto.md",
        "sub/../../secreto.md",
        "/etc/passwd",
        "enlace.md",
        ".",
    ] {
        assert_eq!(
            err(fs::resolve_file(root, Some(path)).await).0,
            403,
            "{path}"
        );
    }
    for path in [".oculta.md", "node_modules/n.md", "nada.md", "sub"] {
        assert_eq!(
            err(fs::resolve_file(root, Some(path)).await).0,
            404,
            "{path}"
        );
    }
    assert_eq!(err(fs::resolve_file(root, None).await).0, 400);
    assert_eq!(err(fs::resolve_file(root, Some("a\0b.md")).await).0, 400);
}

#[tokio::test]
async fn resolve_writable_allows_missing_file_but_not_escaping_parent() {
    let temp = Temp::new();
    temp.write("sub/nuevo.md", "x");
    temp.write(".oculta.md", "x");
    temp.link("enlace.md", "/etc/passwd");
    temp.link("roto.md", "no-existe");
    let root = temp.path();

    assert_eq!(
        fs::resolve_writable(root, Some("otra.md")).await.unwrap(),
        root.join("otra.md")
    );
    for path in ["../x.md", "/etc/x.md", "enlace.md", "roto.md"] {
        assert_eq!(
            err(fs::resolve_writable(root, Some(path)).await).0,
            403,
            "{path}"
        );
    }
    for path in [".oculta.md", "nada/x.md", "sub"] {
        assert_eq!(
            err(fs::resolve_writable(root, Some(path)).await).0,
            404,
            "{path}"
        );
    }
}

#[tokio::test]
async fn resolve_new_checks_hidden_and_existing() {
    let temp = Temp::new();
    temp.write("existe.md", "x");
    temp.write("sub/.cache/x.md", "x");
    temp.link("enlace-fuera", "/etc");
    temp.link("enlace-dentro", "sub");
    temp.link("roto", "no-existe");
    let root = temp.path();

    for path in [
        "nuevo.md",
        "sub/nuevo.md",
        "a/b/c/nuevo.md",
        "enlace-dentro/n.md",
    ] {
        assert!(fs::resolve_new(root, Some(path)).await.is_ok(), "{path}");
    }
    for path in ["existe.md", "sub", "roto"] {
        assert_eq!(
            err(fs::resolve_new(root, Some(path)).await).0,
            409,
            "{path}"
        );
    }
    for path in [".oculto.md", "sub/.cache/x.md", "node_modules/x.md"] {
        assert_eq!(
            err(fs::resolve_new(root, Some(path)).await).0,
            400,
            "{path}"
        );
    }
    for path in ["../x.md", "/etc/x.md", "enlace-fuera/n.md"] {
        assert_eq!(
            err(fs::resolve_new(root, Some(path)).await).0,
            403,
            "{path}"
        );
    }
}

#[tokio::test]
async fn symlink_entries_and_unique_paths() {
    let temp = Temp::new();
    temp.write("real.md", "# Destino\n");
    temp.write("realdir/a.md", "a");
    temp.link("link.md", "real.md");
    temp.link("linkdir", "realdir");
    temp.link("txtlink.md", "datos.txt");
    temp.write("datos.txt", "x");
    let root = temp.path();

    let entries = fs::list_markdown_entries(root).await;
    let mut paths: Vec<_> = entries.iter().map(|entry| entry.path.as_str()).collect();
    paths.sort();
    assert_eq!(
        paths,
        vec!["link.md", "linkdir/a.md", "real.md", "realdir/a.md"]
    );
    let link = entries
        .iter()
        .find(|entry| entry.path == "link.md")
        .unwrap();
    assert_eq!(link.real.as_deref(), Some("real.md"));
    assert_eq!(
        fs::unique_paths(&entries),
        vec!["real.md".to_string(), "realdir/a.md".to_string()]
    );

    let (real, entry) = fs::resolve_entry(root, Some("link.md")).await.unwrap();
    assert_eq!(real, root.join("real.md").canonicalize().unwrap());
    assert_eq!(entry, root.join("link.md"));
}

#[tokio::test]
async fn atomic_write_preserves_mode_and_leaves_no_temp() {
    let temp = Temp::new();
    let target = temp.write("nota.md", "uno\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for mode in [0o600, 0o640, 0o664, 0o755] {
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(mode)).unwrap();
            fs::write_file_atomic(&target, "dos\ncon ñ y 😀\n")
                .await
                .unwrap();
            let info = std::fs::metadata(&target).unwrap();
            assert_eq!(info.permissions().mode() & 0o7777, mode);
            assert_eq!(
                std::fs::read_to_string(&target).unwrap(),
                "dos\ncon ñ y 😀\n"
            );
        }
    }
    let leftovers: Vec<_> = std::fs::read_dir(temp.path())
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty());
}

#[tokio::test]
async fn atomic_write_failure_keeps_original_and_chmod_0444_succeeds() {
    let temp = Temp::new();
    let target = temp.write("nota.md", "original");
    let directory_as_target = temp.path().join("sub");
    std::fs::create_dir(&directory_as_target).unwrap();
    assert!(fs::write_file_atomic(&directory_as_target, "x")
        .await
        .is_err());
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "original");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o444)).unwrap();
        fs::write_file_atomic(&target, "editado").await.unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "editado");
        let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o7777;
        assert_eq!(mode, 0o444);
    }
}

#[tokio::test]
async fn exclusive_create_and_lock_queue() {
    let temp = Temp::new();
    let target = temp.path().join("creado.md");
    fs::create_file_exclusive(&target, "# hola\n")
        .await
        .unwrap();
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "# hola\n");
    assert!(fs::create_file_exclusive(&target, "otro").await.is_err());
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "# hola\n");

    let locks = fs::Locks::default();
    let order = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    for label in ["a", "b", "c"] {
        let order = order.clone();
        fs::with_file_lock(&locks, "clave", async move {
            order.lock().unwrap().push(label);
        })
        .await;
    }
    assert_eq!(*order.lock().unwrap(), vec!["a", "b", "c"]);
}

#[test]
fn config_warnings_son_legibles() {
    let text = "theme = 'neon'\n[keymap.leader]\nf = 'bogus'\n[keymap.view]\nJ = 5\n";
    let (_, warnings) = config::parse_config(Some(text));
    let joined = warnings.join(" | ");
    assert!(joined.contains("\"neon\""), "{joined}");
    assert!(joined.contains("\"bogus\""), "{joined}");
    assert!(joined.contains("5"), "{joined}");
    assert!(!joined.contains("String("), "{joined}");
    assert!(!joined.contains("Some("), "{joined}");
    assert!(!joined.contains("Integer("), "{joined}");
}

#[test]
fn config_defaults_validation_and_path_precedence() {
    let (config, warnings) = config::parse_config(None);
    assert_eq!(config, pure::default_config());
    assert!(warnings.is_empty());
    assert_eq!(config.leader_bindings.len(), 7);
    assert!(!config.render.remoteimages);

    let (config, warnings) = config::parse_config(Some("[render]\nfootnotes = 'no'\nblur = 1\n"));
    assert_eq!(warnings.len(), 2);
    assert!(warnings[0].contains("render.footnotes"));
    assert!(warnings[1].contains("render.blur"));
    assert!(config.render.footnotes);

    let (config, warnings) = config::parse_config(Some("theme = 'dark'\nleader = 'j'\n"));
    assert_eq!(config.theme, pure::Theme::Dark);
    assert_eq!(config.leader, " ");
    assert_eq!(warnings.len(), 1);

    assert_eq!(
        config::parse_sequence("g t"),
        Some(vec!["g".into(), "t".into()])
    );
    assert_eq!(config::parse_sequence("abcde"), None);
    assert_eq!(config::parse_sequence("\u{feff}"), None);

    // `TS .length` cuenta UTF-16, no bytes: 40 CJK deben caber en el límite 64.
    let lhs = "日".repeat(40);
    let rhs = "語".repeat(40);
    let text = format!("[keymap.normal]\n\"{lhs}\" = \"{rhs}\"\n");
    let (config, warnings) = config::parse_config(Some(&text));
    assert!(warnings.is_empty(), "{warnings:?}");
    assert_eq!(config.vim_mappings.len(), 1);
    assert_eq!(
        config::parse_font("JetBrains Mono, monospace").as_deref(),
        Some("\"JetBrains Mono\", monospace")
    );

    let env = vec![
        ("HOME".into(), "/home/u".into()),
        ("XDG_CONFIG_HOME".into(), "relativa".into()),
    ];
    assert_eq!(
        config::resolve_config_path(None, &env),
        PathBuf::from("/home/u/.config/markvi/config.toml")
    );
    assert_eq!(
        config::resolve_config_path(Some("/tmp/x.toml"), &env),
        PathBuf::from("/tmp/x.toml")
    );
    assert_eq!(
        config::resolve_config_path(Some(""), &env),
        PathBuf::from("/home/u/.config/markvi/config.toml")
    );
}

#[tokio::test]
async fn unreadable_config_is_not_reported_as_missing() {
    let temp = Temp::new();
    let missing = config::load_config(&temp.path().join("no.toml")).await;
    assert!(!missing.exists);
    assert!(missing.warnings.is_empty());

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = temp.write("config.toml", "theme = 'dark'\n");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        let loaded = config::load_config(&path).await;
        assert!(loaded.exists);
        assert_eq!(loaded.warnings.len(), 1);
        assert!(loaded.warnings[0].starts_with("Could not read the file:"));
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    }
}
