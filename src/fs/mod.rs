//! Root confinement and atomic writes.

use std::{
    collections::HashMap,
    ffi::OsString,
    future::Future,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};
use tokio::{io::AsyncWriteExt, sync::Mutex};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpError {
    pub status: u16,
    pub message: String,
}

impl HttpError {
    /// Creates an HTTP error with a status and message.
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

pub type FsResult<T> = Result<T, HttpError>;

pub(crate) fn is_ignored(name: &str) -> bool {
    name.starts_with('.') || name == "node_modules"
}

fn lexical(path: &Path) -> PathBuf {
    let absolute = path.is_absolute();
    let mut parts: Vec<OsString> = Vec::new();
    for component in path.components() {
        match component {
            Component::RootDir => parts.clear(),
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop();
            }
            Component::Normal(part) => parts.push(part.to_os_string()),
            Component::Prefix(prefix) => parts.push(prefix.as_os_str().to_os_string()),
        }
    }
    let mut out = if absolute {
        PathBuf::from("/")
    } else {
        PathBuf::new()
    };
    for part in parts {
        out.push(part);
    }
    out
}

fn resolve(root: &Path, path: &str) -> PathBuf {
    let given = Path::new(path);
    let target = if given.is_absolute() {
        given.to_path_buf()
    } else {
        root.join(given)
    };
    lexical(&target)
}

/// Components of `target` below `root`, or `None` if it escapes the root.
pub fn segments_inside(root: &Path, target: &Path) -> Option<Vec<String>> {
    let root_parts: Vec<_> = root.components().collect();
    let target_parts: Vec<_> = target.components().collect();
    if target_parts.len() <= root_parts.len() || target_parts[..root_parts.len()] != root_parts[..]
    {
        return None;
    }
    Some(
        target_parts[root_parts.len()..]
            .iter()
            .map(|part| part.as_os_str().to_string_lossy().into_owned())
            .collect(),
    )
}

fn check(root: &Path, target: &Path) -> FsResult<Vec<String>> {
    let segments = segments_inside(root, target)
        .ok_or_else(|| HttpError::new(403, "Path outside the root directory."))?;
    if segments.iter().any(|part| is_ignored(part)) {
        return Err(HttpError::new(404, "File not found."));
    }
    Ok(segments)
}

/// Read behavior matching `GET`: invalid bytes are replaced, not dropped.
pub async fn read_lossy(path: &Path) -> std::io::Result<String> {
    let bytes = tokio::fs::read(path).await?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Like `read_lossy`, also reporting whether bytes were replaced.
pub async fn read_text(path: &Path) -> std::io::Result<(String, bool)> {
    let bytes = tokio::fs::read(path).await?;
    Ok(match String::from_utf8(bytes) {
        Ok(text) => (text, false),
        Err(error) => (String::from_utf8_lossy(error.as_bytes()).into_owned(), true),
    })
}

/// `Ok(false)` if the file exists but is not valid UTF-8; `NotFound` is propagated.
pub async fn is_valid_utf8(path: &Path) -> std::io::Result<bool> {
    let bytes = tokio::fs::read(path).await?;
    Ok(std::str::from_utf8(&bytes).is_ok())
}

fn missing_path() -> HttpError {
    HttpError::new(400, "Missing or invalid path.")
}

fn not_found() -> HttpError {
    HttpError::new(404, "File not found.")
}

fn parent_of(path: &Path) -> PathBuf {
    path.parent().unwrap_or(Path::new("/")).to_path_buf()
}

fn name_of(path: &Path) -> OsString {
    path.file_name().unwrap_or_default().to_os_string()
}

/// Resolves an existing readable Markdown file inside the root.
pub async fn resolve_file(root: &Path, path: Option<&str>) -> FsResult<PathBuf> {
    let path = path
        .filter(|p| !p.is_empty() && !p.contains('\0'))
        .ok_or_else(missing_path)?;
    let target = resolve(root, path);
    check(root, &target)?;
    let real = tokio::fs::canonicalize(&target)
        .await
        .map_err(|_| not_found())?;
    check(root, &real)?;
    let info = tokio::fs::metadata(&real).await.map_err(|_| not_found())?;
    if !info.is_file() {
        return Err(not_found());
    }
    Ok(real)
}

/// Resolves an existing entry inside the root.
pub async fn resolve_entry(root: &Path, path: Option<&str>) -> FsResult<(PathBuf, PathBuf)> {
    let real = resolve_file(root, path).await?;
    let target = resolve(root, path.unwrap());
    let parent = tokio::fs::canonicalize(parent_of(&target))
        .await
        .map_err(|_| not_found())?;
    if parent != root {
        check(root, &parent)?;
    }
    Ok((real, parent.join(name_of(&target))))
}

/// Resolves a path that is allowed for writing.
pub async fn resolve_writable(root: &Path, path: Option<&str>) -> FsResult<PathBuf> {
    let path = path
        .filter(|p| !p.is_empty() && !p.contains('\0'))
        .ok_or_else(missing_path)?;
    let target = resolve(root, path);
    check(root, &target)?;
    let parent = tokio::fs::canonicalize(parent_of(&target))
        .await
        .map_err(|_| HttpError::new(404, "The file's folder does not exist."))?;
    if parent != root {
        check(root, &parent)?;
    }
    if let Ok(real) = tokio::fs::canonicalize(&target).await {
        check(root, &real)?;
        let info = tokio::fs::metadata(&real).await.map_err(|_| not_found())?;
        if !info.is_file() {
            return Err(not_found());
        }
        return Ok(real);
    }
    if tokio::fs::symlink_metadata(&target).await.is_ok() {
        return Err(HttpError::new(403, "Path outside the root directory."));
    }
    Ok(parent.join(name_of(&target)))
}

/// Resolves a path for a new file, rejecting existing or hidden paths.
pub async fn resolve_new(root: &Path, path: Option<&str>) -> FsResult<PathBuf> {
    let path = path
        .filter(|p| !p.is_empty() && !p.contains('\0'))
        .ok_or_else(missing_path)?;
    let target = resolve(root, path);
    let segments = segments_inside(root, &target)
        .ok_or_else(|| HttpError::new(403, "Path outside the root directory."))?;
    if segments.iter().any(|part| is_ignored(part)) {
        return Err(HttpError::new(
            400,
            "Hidden files and folders are not allowed.",
        ));
    }

    let mut ancestor = parent_of(&target);
    loop {
        if let Ok(real) = tokio::fs::canonicalize(&ancestor).await {
            if real != root {
                let inside = segments_inside(root, &real)
                    .ok_or_else(|| HttpError::new(403, "Path outside the root directory."))?;
                if inside.iter().any(|part| is_ignored(part)) {
                    return Err(HttpError::new(403, "Path outside the root directory."));
                }
            }
            break;
        }
        let parent = parent_of(&ancestor);
        if parent == ancestor {
            return Err(HttpError::new(404, "The file's folder does not exist."));
        }
        ancestor = parent;
    }
    if tokio::fs::symlink_metadata(&target).await.is_ok() {
        return Err(HttpError::new(409, "A file already exists at that path."));
    }
    Ok(target)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MarkdownEntry {
    pub path: String,
    pub real: Option<String>,
}

const MAX_LINK_HOPS: usize = 8;

struct Item {
    name: String,
    kind: Kind,
    real: PathBuf,
    link: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    File,
    Dir,
}

fn relative_string(root: &Path, real: &Path) -> String {
    real.strip_prefix(root)
        .unwrap_or(real)
        .components()
        .map(|part| part.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

pub struct Walk {
    pub entries: Vec<MarkdownEntry>,
    pub dirs: Vec<PathBuf>,
}

fn walk(real_root: &Path, root_dir: &Path, out: &mut Walk) {
    struct Frame {
        dir: PathBuf,
        prefix: String,
        chain: Vec<PathBuf>,
        hops: usize,
    }
    let mut stack = vec![Frame {
        dir: root_dir.to_path_buf(),
        prefix: String::new(),
        chain: vec![root_dir.to_path_buf()],
        hops: 0,
    }];
    let mut seen_dirs: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    while let Some(frame) = stack.pop() {
        let reader = match std::fs::read_dir(&frame.dir) {
            Ok(reader) => reader,
            Err(_) => continue,
        };
        // Only directories reached without symlinks (hops == 0) are watched.
        if frame.hops == 0 && seen_dirs.insert(frame.dir.clone()) {
            out.dirs.push(frame.dir.clone());
        }
        let mut names = Vec::new();
        for entry in reader.flatten() {
            // A non-UTF-8 name cannot be addressed through the API, so it and
            // its subtree are skipped.
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            if !is_ignored(&name) {
                names.push((name, entry));
            }
        }
        names.sort_by(|a, b| a.0.cmp(&b.0));
        let mut items = Vec::new();
        for (name, entry) in names {
            let abs = frame.dir.join(&name);
            let file_type = match entry.file_type() {
                Ok(kind) => kind,
                Err(_) => continue,
            };
            if !file_type.is_symlink() {
                let kind = if file_type.is_dir() {
                    Some(Kind::Dir)
                } else if file_type.is_file() {
                    Some(Kind::File)
                } else {
                    None
                };
                if let Some(kind) = kind {
                    items.push(Item {
                        name,
                        kind,
                        real: abs,
                        link: false,
                    });
                }
                continue;
            }
            if frame.hops >= MAX_LINK_HOPS {
                continue;
            }
            let real = match std::fs::canonicalize(&abs) {
                Ok(real) => real,
                Err(_) => continue,
            };
            let inside = match segments_inside(real_root, &real) {
                Some(parts) if !parts.iter().any(|p| is_ignored(p)) => parts,
                _ => continue,
            };
            if inside.is_empty() {
                continue;
            }
            let info = match std::fs::metadata(&real) {
                Ok(info) => info,
                Err(_) => continue,
            };
            let kind = if info.is_dir() {
                Kind::Dir
            } else if info.is_file() {
                Kind::File
            } else {
                continue;
            };
            items.push(Item {
                name,
                kind,
                real,
                link: true,
            });
        }
        let aliased = frame.hops > 0;
        for item in items.iter().filter(|item| item.kind == Kind::File) {
            if !crate::core::pure::is_markdown_path(&item.name) {
                continue;
            }
            if item.link && !crate::core::pure::is_markdown_path(&item.real.to_string_lossy()) {
                continue;
            }
            let path = format!("{}{}", frame.prefix, item.name);
            let real = relative_string(real_root, &item.real);
            if (!aliased && !item.link) || real == path {
                out.entries.push(MarkdownEntry { path, real: None });
            } else {
                out.entries.push(MarkdownEntry {
                    path,
                    real: Some(real),
                });
            }
        }
        let mut dirs: Vec<_> = items
            .into_iter()
            .filter(|item| item.kind == Kind::Dir && !frame.chain.contains(&item.real))
            .collect();
        dirs.sort_by(|a, b| a.name.cmp(&b.name));
        for item in dirs.into_iter().rev() {
            let mut next_chain = frame.chain.clone();
            next_chain.push(item.real.clone());
            stack.push(Frame {
                dir: item.real,
                prefix: format!("{}{}/", frame.prefix, item.name),
                chain: next_chain,
                hops: frame.hops + usize::from(item.link),
            });
        }
    }
}

/// Walks the tree once with `std::fs` on a blocking thread (about 8x faster
/// than an async call per entry).
pub async fn walk_tree(root: &Path) -> Walk {
    let root = root.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let real_root = std::fs::canonicalize(&root).unwrap_or(root);
        let mut out = Walk {
            entries: Vec::new(),
            dirs: Vec::new(),
        };
        walk(&real_root, &real_root, &mut out);
        out
    })
    .await
    .unwrap_or(Walk {
        entries: Vec::new(),
        dirs: Vec::new(),
    })
}

/// Lists Markdown files and real directories under the root.
pub async fn list_markdown_entries(root: &Path) -> Vec<MarkdownEntry> {
    walk_tree(root).await.entries
}

/// Lists Markdown file paths under the root.
pub async fn list_markdown(root: &Path) -> Vec<String> {
    list_markdown_entries(root)
        .await
        .into_iter()
        .map(|entry| entry.path)
        .collect()
}

/// Removes duplicate paths, keeping the first occurrence.
pub fn unique_paths(entries: &[MarkdownEntry]) -> Vec<String> {
    let direct: std::collections::HashSet<&str> = entries
        .iter()
        .filter(|e| e.real.is_none())
        .map(|e| e.path.as_str())
        .collect();
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();
    for entry in entries {
        if let Some(real) = &entry.real {
            if direct.contains(real.as_str()) || !seen.insert(real.clone()) {
                continue;
            }
        }
        result.push(entry.path.clone());
    }
    result
}

pub(crate) fn temp_path_for(target: &Path) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut seed = [0u8; 6];
    if getrandom::fill(&mut seed).is_err() {
        eprintln!("getrandom falló; usando pid + contador para el archivo temporal");
    }
    // If getrandom fails, pid + counter avoid predictable or colliding names.
    let extra = std::process::id() as u64
        ^ COUNTER
            .fetch_add(1, Ordering::Relaxed)
            .wrapping_mul(0x9e3779b97f4a7c15);
    for (index, byte) in seed.iter_mut().enumerate() {
        *byte ^= (extra >> (index * 8)) as u8;
    }
    let hex: String = seed.iter().map(|byte| format!("{byte:02x}")).collect();
    parent_of(target).join(format!(".markvi-{hex}.tmp"))
}

/// `ErrorKind` is portable; numeric codes cover Unix cases that
/// `PermissionDenied` and `Unsupported` do not represent.
fn is_permission(error: &std::io::Error) -> bool {
    if error.kind() == std::io::ErrorKind::PermissionDenied {
        return true;
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        matches!(error.raw_os_error(), Some(13 | 1))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        false
    }
}

/// Errors indicating that the filesystem does not support hard links.
pub fn hard_link_unsupported(error: &std::io::Error) -> bool {
    if matches!(
        error.kind(),
        std::io::ErrorKind::PermissionDenied
            | std::io::ErrorKind::Unsupported
            | std::io::ErrorKind::CrossesDevices
    ) {
        return true;
    }
    // EPERM, EOPNOTSUPP/ENOTSUP, ENOSYS, EXDEV; codes vary by system.
    #[cfg(target_os = "linux")]
    {
        matches!(error.raw_os_error(), Some(1 | 95 | 38 | 18))
    }
    #[cfg(target_os = "macos")]
    {
        matches!(error.raw_os_error(), Some(1 | 45 | 102 | 78 | 18))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        false
    }
}

/// Fallback direct write: on failure it leaves no partially written file.
async fn direct_create_with_cleanup<F, Fut>(target: &Path, write: F) -> std::io::Result<()>
where
    F: FnOnce(tokio::fs::File) -> Fut,
    Fut: Future<Output = std::io::Result<()>>,
{
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    // `AlreadyExists` (or any open error) gives us no ownership of the target;
    // in that case we must never try to remove it.
    let handle = options.open(target).await?;
    if let Err(error) = write(handle).await {
        let _ = tokio::fs::remove_file(target).await;
        return Err(error);
    }
    Ok(())
}

async fn create_direct(target: &Path, data: &str) -> std::io::Result<()> {
    direct_create_with_cleanup(target, |mut handle| async move {
        handle.write_all(data.as_bytes()).await?;
        handle.sync_all().await
    }).await
}

async fn write_temp(target: &Path, data: &str, mode: Option<u32>) -> std::io::Result<PathBuf> {
    let temp = temp_path_for(target);
    let result = async {
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(mode.unwrap_or(0o666));
        let mut handle = options.open(&temp).await?;
        handle.write_all(data.as_bytes()).await?;
        handle.sync_all().await?;
        drop(handle);
        #[cfg(unix)]
        if let Some(mode) = mode {
            tokio::fs::set_permissions(&temp, std::fs::Permissions::from_mode(mode)).await?;
        }
        Ok::<(), std::io::Error>(())
    }
    .await;
    match result {
        Ok(()) => Ok(temp),
        Err(error) => {
            let _ = tokio::fs::remove_file(&temp).await;
            Err(error)
        }
    }
}

async fn sync_directory(directory: &Path) {
    #[cfg(unix)]
    {
        let directory = directory.to_path_buf();
        let _ = tokio::task::spawn_blocking(move || {
            if let Ok(handle) = std::fs::File::open(directory) {
                let _ = handle.sync_all();
            }
        }).await;
    }
    #[cfg(not(unix))]
    let _ = directory;
}

/// Writes a file atomically while preserving its mode.
pub async fn write_file_atomic(target: &Path, data: &str) -> std::io::Result<()> {
    let mode = match tokio::fs::metadata(target).await {
        #[cfg(unix)]
        Ok(info) => Some(info.permissions().mode() & 0o7777),
        #[cfg(not(unix))]
        Ok(_) => None,
        Err(_) => None,
    };
    let temp = match write_temp(target, data, mode).await {
        Ok(temp) => temp,
        Err(error) if mode.is_some() && is_permission(&error) => {
            return tokio::fs::write(target, data).await;
        }
        Err(error) => return Err(error),
    };
    if let Err(error) = tokio::fs::rename(&temp, target).await {
        let _ = tokio::fs::remove_file(&temp).await;
        return Err(error);
    }
    sync_directory(parent_of(target).as_path()).await;
    Ok(())
}

/// Creates a file only if it does not already exist.
pub async fn create_file_exclusive(target: &Path, data: &str) -> std::io::Result<()> {
    let temp = write_temp(target, data, None).await?;
    let result = tokio::fs::hard_link(&temp, target).await;
    if let Err(error) = result {
        if hard_link_unsupported(&error) {
            if let Err(fallback) =
                create_direct(target, data).await
            {
                let _ = tokio::fs::remove_file(&temp).await;
                return Err(fallback);
            }
        } else {
            let _ = tokio::fs::remove_file(&temp).await;
            return Err(error);
        }
    }
    let _ = tokio::fs::remove_file(&temp).await;
    sync_directory(parent_of(target).as_path()).await;
    Ok(())
}

#[derive(Default)]
pub struct Locks {
    map: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl Locks {
    /// Number of tasks currently waiting for a file lock.
    pub fn pending_locks(&self) -> usize {
        self.map.try_lock().map(|map| map.len()).unwrap_or(0)
    }
}

/// Stable key: canonical file path (or parent path if missing), so a symlink
/// and its target share one lock.
pub async fn lock_key(path: &Path) -> String {
    let resolved = match tokio::fs::canonicalize(path).await {
        Ok(path) => path,
        Err(_) => {
            let parent = path.parent().unwrap_or(Path::new("/"));
            tokio::fs::canonicalize(parent).await
                .unwrap_or_else(|_| parent.to_path_buf())
                .join(path.file_name().unwrap_or_default())
        }
    };
    resolved.to_string_lossy().into_owned()
}

/// Runs the write in a detached task: if the HTTP handler is cancelled, the
/// write still finishes and leaves no temporary files.
pub fn spawn_write(
    target: PathBuf,
    data: String,
    exclusive: bool,
) -> tokio::task::JoinHandle<std::io::Result<()>> {
    tokio::spawn(async move {
        if exclusive {
            create_file_exclusive(&target, &data).await
        } else {
            write_file_atomic(&target, &data).await
        }
    })
}

/// Runs a task while holding the lock for `key`.
pub async fn with_file_lock<F, T>(locks: &Locks, key: &str, task: F) -> T
where
    F: Future<Output = T>,
{
    let key = key.to_string();
    let lock = {
        let mut map = locks.map.lock().await;
        map.entry(key.clone())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    };
    let guard = lock.lock().await;
    let output = task.await;
    drop(guard);
    // Map plus local flag: prune the entry when no other caller is waiting.
    if Arc::strong_count(&lock) == 2 {
        let mut map = locks.map.lock().await;
        if map
            .get(&key)
            .is_some_and(|stored| Arc::ptr_eq(stored, &lock))
        {
            map.remove(&key);
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn locks_se_podan_tras_uso_y_clave_unifica_symlink() {
        let locks = Locks::default();
        for _ in 0..5 {
            with_file_lock(&locks, "a.md", async {}).await;
        }
        assert_eq!(locks.pending_locks(), 0);

        #[cfg(unix)]
        {
            let dir = std::env::temp_dir().join(format!("markvi-lock-key-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let real = dir.join("real.md");
            let alias = dir.join("alias.md");
            std::fs::write(&real, "x").unwrap();
            std::os::unix::fs::symlink("real.md", &alias).unwrap();
            assert_eq!(lock_key(&real).await, lock_key(&alias).await);
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[tokio::test]
    async fn escritura_en_spawn_completa_si_se_cae_el_cliente() {
        let dir = std::env::temp_dir().join(format!("markvi-spawn-write-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("nota.md");

        // The handler was cancelled: drop the JoinHandle without awaiting it.
        drop(spawn_write(target.clone(), "contenido".to_string(), false));
        // Poll instead of a fixed sleep: under load the task may take longer.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !target.exists() && std::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }

        assert_eq!(std::fs::read_to_string(&target).unwrap(), "contenido");
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn lock_y_escritura_sobreviven_a_cancelacion_del_handler() {
        let dir = std::env::temp_dir().join(format!("markvi-lock-cancel-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("nota.md");
        std::fs::write(&target, "antiguo").unwrap();

        let locks = Arc::new(Locks::default());
        let key = lock_key(&target).await;
        let task_locks = locks.clone();
        let task_target = target.clone();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (continue_tx, continue_rx) = tokio::sync::oneshot::channel();

        // This task owns the critical section once the HTTP handler is gone.
        let handler_task = tokio::spawn(async move {
            with_file_lock(&task_locks, &key, async move {
                let _ = started_tx.send(());
                let _ = continue_rx.await;
                tokio::fs::write(&task_target, "nuevo").await.unwrap();
            }).await;
        });
        started_rx.await.unwrap();
        drop(handler_task); // the handler was cancelled

        let second_locks = locks.clone();
        let second_target = target.clone();
        let second_key = lock_key(&target).await;
        let second_put = tokio::spawn(async move {
            with_file_lock(&second_locks, &second_key, async move {
                let current = tokio::fs::read_to_string(&second_target).await.unwrap();
                // Equivalent to If-Match against the previous ETag/content.
                assert_ne!(current, "antiguo");
                current
            }).await
        });

        continue_tx.send(()).unwrap();
        assert_eq!(second_put.await.unwrap(), "nuevo");
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn fallo_en_el_fallback_no_deja_archivo_parcial() {
        let dir = std::env::temp_dir().join(format!("markvi-fs-fallback-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("creado.md");

        let result: std::io::Result<()> = direct_create_with_cleanup(&target, |mut handle| async move {
            use tokio::io::AsyncWriteExt;
            handle.write_all(b"parcial").await?;
            Err(std::io::Error::other("fallo simulado tras escribir"))
        }).await;

        assert!(result.is_err());
        assert!(!target.exists(), "quedó el archivo parcial");

        std::fs::write(&target, "ajeno").unwrap();
        let result = direct_create_with_cleanup(&target, |_handle| async {
            Ok(())
        }).await;
        assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "ajeno");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
