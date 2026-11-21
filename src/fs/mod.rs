//! Confinamiento al root y escrituras atómicas. Espejo de `src/files.ts` y `src/atomic.ts`.
//! Diseño de seguridad: rust/fs/SECURITY-DESIGN.md (revisado, sin hallazgos altos).

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
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

pub type FsResult<T> = Result<T, HttpError>;

fn ignored(name: &str) -> bool {
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

/// Componentes de `target` por debajo de `root`, o `None` si no está dentro.
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
    if segments.iter().any(|part| ignored(part)) {
        return Err(HttpError::new(404, "File not found."));
    }
    Ok(segments)
}

/// Lectura coherente con `GET`: bytes inválidos se sustituyen, no se omiten.
pub async fn read_lossy(path: &Path) -> std::io::Result<String> {
    let bytes = tokio::fs::read(path).await?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
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

pub async fn resolve_new(root: &Path, path: Option<&str>) -> FsResult<PathBuf> {
    let path = path
        .filter(|p| !p.is_empty() && !p.contains('\0'))
        .ok_or_else(missing_path)?;
    let target = resolve(root, path);
    let segments = segments_inside(root, &target)
        .ok_or_else(|| HttpError::new(403, "Path outside the root directory."))?;
    if segments.iter().any(|part| ignored(part)) {
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
                if inside.iter().any(|part| ignored(part)) {
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

async fn walk(real_root: &Path, root_dir: &Path, out: &mut Vec<MarkdownEntry>) {
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
    while let Some(frame) = stack.pop() {
        let mut entries = match tokio::fs::read_dir(&frame.dir).await {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        let mut names = Vec::new();
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !ignored(&name) {
                names.push((name, entry));
            }
        }
        names.sort_by(|a, b| a.0.cmp(&b.0));
        let mut items = Vec::new();
        for (name, entry) in names {
            let abs = frame.dir.join(&name);
            let file_type = match entry.file_type().await {
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
            let real = match tokio::fs::canonicalize(&abs).await {
                Ok(real) => real,
                Err(_) => continue,
            };
            let inside = match segments_inside(real_root, &real) {
                Some(parts) if !parts.iter().any(|p| ignored(p)) => parts,
                _ => continue,
            };
            if inside.is_empty() {
                continue;
            }
            let info = match tokio::fs::metadata(&real).await {
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
                out.push(MarkdownEntry { path, real: None });
            } else {
                out.push(MarkdownEntry {
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

pub async fn list_markdown_entries(root: &Path) -> Vec<MarkdownEntry> {
    let real_root = tokio::fs::canonicalize(root)
        .await
        .unwrap_or_else(|_| root.to_path_buf());
    let mut out = Vec::new();
    walk(&real_root, &real_root, &mut out).await;
    out
}

pub async fn list_markdown(root: &Path) -> Vec<String> {
    list_markdown_entries(root)
        .await
        .into_iter()
        .map(|entry| entry.path)
        .collect()
}

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

fn temp_path_for(target: &Path) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut seed = [0u8; 6];
    if let Ok(mut file) = std::fs::File::open("/dev/urandom") {
        use std::io::Read;
        let _ = file.read_exact(&mut seed);
    }
    // Si urandom falla, pid + contador evitan nombres predecibles y colisiones.
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

/// Los `ErrorKind` son portables; el código numérico queda como respaldo en
/// Unix, donde `PermissionDenied` y `Unsupported` no cubren todos los casos.
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

fn hard_link_unsupported(error: &std::io::Error) -> bool {
    if matches!(
        error.kind(),
        std::io::ErrorKind::PermissionDenied
            | std::io::ErrorKind::Unsupported
            | std::io::ErrorKind::CrossesDevices
    ) {
        return true;
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        matches!(error.raw_os_error(), Some(1 | 95 | 38 | 18))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        false
    }
}

/// Escritura directa de respaldo: si falla, no deja un archivo a medias.
async fn direct_create_with_cleanup<Fut>(target: &Path, write: Fut) -> std::io::Result<()>
where
    Fut: Future<Output = std::io::Result<()>>,
{
    if let Err(error) = write.await {
        let _ = tokio::fs::remove_file(target).await;
        return Err(error);
    }
    Ok(())
}

async fn create_direct(target: &Path, data: &str) -> std::io::Result<()> {
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    let mut handle = options.open(target).await?;
    handle.write_all(data.as_bytes()).await?;
    handle.sync_all().await
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
        if let Ok(handle) = std::fs::File::open(directory) {
            let _ = handle.sync_all();
        }
    }
    #[cfg(not(unix))]
    let _ = directory;
}

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

pub async fn create_file_exclusive(target: &Path, data: &str) -> std::io::Result<()> {
    let temp = write_temp(target, data, None).await?;
    let result = tokio::fs::hard_link(&temp, target).await;
    if let Err(error) = result {
        if hard_link_unsupported(&error) {
            if let Err(fallback) =
                direct_create_with_cleanup(target, create_direct(target, data)).await
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

pub async fn with_file_lock<F, T>(locks: &Locks, key: &str, task: F) -> T
where
    F: Future<Output = T>,
{
    let lock = {
        let mut map = locks.map.lock().await;
        map.entry(key.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    };
    let _guard = lock.lock().await;
    task.await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn fallo_en_el_fallback_no_deja_archivo_parcial() {
        let dir = std::env::temp_dir().join(format!("markvi-fs-fallback-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("creado.md");

        let result: std::io::Result<()> = direct_create_with_cleanup(&target, async {
            std::fs::write(&target, "parcial")?;
            Err(std::io::Error::other("fallo simulado tras escribir"))
        })
        .await;

        assert!(result.is_err());
        assert!(!target.exists(), "quedó el archivo parcial");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
