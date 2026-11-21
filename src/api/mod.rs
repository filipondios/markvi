//! Handlers HTTP y rutas estáticas del servidor Markvi.
//! El guard `Host`/`Origin` se aplica solo a las rutas de `createRoutes`, igual que Bun.

use crate::{
    config::{self, LoadedConfig},
    core::{hash, pure},
    fs::{self, HttpError, Locks},
    search,
    watch::SseHub,
};
use axum::{
    body::{to_bytes, Body},
    extract::{Request, State},
    http::{header, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response, Sse},
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
};
use thiserror::Error;
use tower::ServiceExt;
use tower_http::services::ServeFile;

const NO_STORE: &str = "no-store";
const MAX_QUERY: usize = 200;
const MAX_BODY: usize = 16 * 1024 * 1024;

#[derive(Debug, Error)]
pub enum ApiError {
    #[error("{0}")]
    Http(u16, String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Body(#[from] axum::Error),
}

impl ApiError {
    fn new(status: u16, message: impl Into<String>) -> Self {
        Self::Http(status, message.into())
    }
}

impl From<HttpError> for ApiError {
    fn from(error: HttpError) -> Self {
        Self::Http(error.status, error.message)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::Http(status, message) => (status, message),
            Self::Body(_) => (500, "Internal error.".to_string()),
            Self::Io(error) => match error.raw_os_error() {
                Some(2) | Some(20) => (404, "File or folder not found.".to_string()),
                Some(13) | Some(1) | Some(30) => {
                    (403, "No permission to access the file.".to_string())
                }
                Some(21) => (400, "The path is not a file.".to_string()),
                Some(17) => (
                    409,
                    "A file or folder already exists at that path.".to_string(),
                ),
                Some(28) => (507, "No space left on disk.".to_string()),
                _ => (500, "Internal error.".to_string()),
            },
        };
        json_response(status, json!({ "error": message }), NO_STORE)
    }
}

fn json_response(status: u16, value: Value, cache_control: &str) -> Response {
    Response::builder()
        .status(StatusCode::from_u16(status).unwrap())
        .header("content-type", "application/json;charset=utf-8")
        .header("cache-control", cache_control)
        .body(Body::from(value.to_string()))
        .expect("valid response")
}

fn empty_response(status: u16, etag: Option<String>) -> Response {
    let mut builder = Response::builder()
        .status(StatusCode::from_u16(status).unwrap())
        .header("cache-control", NO_STORE);
    if let Some(etag) = etag {
        builder = builder.header("etag", etag);
    }
    builder.body(Body::empty()).expect("valid response")
}

fn bytes_response(
    status: u16,
    content_type: &str,
    body: Vec<u8>,
    extra: &[(&str, &str)],
) -> Response {
    let mut builder = Response::builder()
        .status(StatusCode::from_u16(status).unwrap())
        .header("cache-control", NO_STORE)
        .header("content-type", content_type);
    for (name, value) in extra {
        builder = builder.header(*name, *value);
    }
    builder.body(Body::from(body)).expect("valid response")
}

fn text_response(
    status: u16,
    content_type: &str,
    body: String,
    etag: Option<String>,
    extra: &[(&str, &str)],
) -> Response {
    let mut builder = Response::builder()
        .status(StatusCode::from_u16(status).unwrap())
        .header("cache-control", NO_STORE)
        .header("content-type", content_type);
    if let Some(etag) = etag {
        builder = builder.header("etag", etag);
    }
    for (name, value) in extra {
        builder = builder.header(*name, *value);
    }
    builder.body(Body::from(body)).expect("valid response")
}

mod embedded {
    include!(concat!(env!("OUT_DIR"), "/frontend_assets.rs"));
}

fn embedded_file(url: &str) -> &'static [u8] {
    embedded::FILES
        .iter()
        .find(|(path, _)| *path == url)
        .map(|(_, bytes)| *bytes)
        .unwrap_or_else(|| panic!("asset no embebido: {url}"))
}

type StaticFile = (&'static [u8], String, String, Option<String>);

pub struct StaticAssets {
    index: &'static [u8],
    index_etag: Option<String>,
    files: HashMap<String, StaticFile>,
    fallback_status: u16,
    fallback_body: String,
}

impl StaticAssets {
    pub fn new() -> Self {
        let manifest: Value =
            serde_json::from_str(embedded::MANIFEST).expect("valid static manifest");
        let index_etag = manifest["index"]["etag"].as_str().map(str::to_string);
        let index_file = manifest["index"]["file"].as_str().unwrap();
        let index = embedded_file(&format!("/{index_file}"));
        let mut files = HashMap::new();
        for (url, entry) in manifest["assets"].as_object().unwrap() {
            files.insert(
                url.clone(),
                (
                    embedded_file(url),
                    entry["content_type"].as_str().unwrap().to_string(),
                    entry["cache_control"].as_str().unwrap().to_string(),
                    entry["etag"].as_str().map(str::to_string),
                ),
            );
        }
        Self {
            index,
            index_etag,
            files,
            fallback_status: manifest["fallback"]["status"].as_u64().unwrap() as u16,
            fallback_body: manifest["fallback"]["body"].as_str().unwrap().to_string(),
        }
    }

    fn index_response(&self) -> Response {
        let mut builder = Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/html;charset=utf-8")
            .header("cache-control", "no-cache");
        if let Some(etag) = &self.index_etag {
            builder = builder.header("etag", etag.as_str());
        }
        builder
            .body(Body::from(self.index))
            .expect("valid response")
    }

    fn asset_response(&self, path: &str) -> Option<Response> {
        let (bytes, content_type, cache_control, etag) = self.files.get(path)?;
        let mut builder = Response::builder()
            .status(StatusCode::OK)
            .header("content-type", content_type.as_str())
            .header("cache-control", cache_control.as_str());
        if let Some(etag) = etag {
            builder = builder.header("etag", etag.as_str());
        }
        Some(builder.body(Body::from(*bytes)).expect("valid response"))
    }

    fn fallback(&self) -> Response {
        Response::builder()
            .status(StatusCode::from_u16(self.fallback_status).unwrap())
            .header("content-type", "text/plain;charset=utf-8")
            .body(Body::from(self.fallback_body.clone()))
            .expect("valid response")
    }
}

impl Default for StaticAssets {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone)]
pub struct AppState {
    pub root: Arc<PathBuf>,
    pub port: u16,
    pub config_path: Arc<PathBuf>,
    pub locks: Arc<Locks>,
    pub sse: Arc<SseHub>,
    pub assets: Arc<StaticAssets>,
    hosts: Arc<Vec<String>>,
    origins: Arc<Vec<String>>,
}

impl AppState {
    pub fn new(
        root: PathBuf,
        port: u16,
        config_path: PathBuf,
        sse: Arc<SseHub>,
        assets: StaticAssets,
    ) -> Self {
        let suffix = if port == 80 {
            String::new()
        } else {
            format!(":{port}")
        };
        let hosts = [pure::HOSTNAME, "localhost"]
            .iter()
            .map(|name| format!("{name}{suffix}"))
            .collect();
        let origins = [pure::HOSTNAME, "localhost"]
            .iter()
            .map(|name| format!("http://{name}{suffix}"))
            .collect();
        Self {
            root: Arc::new(root),
            port,
            config_path: Arc::new(config_path),
            locks: Arc::new(Locks::default()),
            sse,
            assets: Arc::new(assets),
            hosts: Arc::new(hosts),
            origins: Arc::new(origins),
        }
    }

    fn guard(&self, req: &Request) -> Result<(), ApiError> {
        let host = req
            .headers()
            .get(header::HOST)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        if !self.hosts.iter().any(|allowed| allowed == host) {
            return Err(ApiError::new(403, "Host not allowed."));
        }
        if req.method() != Method::GET && req.method() != Method::HEAD {
            if let Some(origin) = req
                .headers()
                .get(header::ORIGIN)
                .and_then(|value| value.to_str().ok())
            {
                if !self.origins.iter().any(|allowed| allowed == origin) {
                    return Err(ApiError::new(403, "Origin not allowed."));
                }
            }
        }
        Ok(())
    }
}

fn query_param(req: &Request, key: &str) -> Option<String> {
    let query = req.uri().query()?;
    for pair in query.split('&') {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        let decoded_name = percent_decode(name).ok()?.replace('+', " ");
        if decoded_name == key {
            return Some(percent_decode(value).ok()?.replace('+', " "));
        }
    }
    None
}

fn too_large() -> ApiError {
    ApiError::new(413, "Payload too large.")
}

async fn body_string(req: Request) -> Result<String, ApiError> {
    let bytes = to_bytes(req.into_body(), MAX_BODY)
        .await
        .map_err(|_| too_large())?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

async fn markdown_file(state: &AppState, path: Option<String>) -> Result<PathBuf, ApiError> {
    let file = fs::resolve_file(&state.root, path.as_deref()).await?;
    if !pure::is_markdown_path(&file.to_string_lossy()) {
        return Err(ApiError::new(400, "Only .md files are supported."));
    }
    Ok(file)
}

async fn body_json(req: Request) -> Result<Value, ApiError> {
    let bytes = to_bytes(req.into_body(), MAX_BODY)
        .await
        .map_err(|_| too_large())?;
    Ok(serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

// ---- handlers -------------------------------------------------------------

pub async fn tree_get(State(state): State<AppState>, _req: Request) -> Result<Response, ApiError> {
    let files = fs::list_markdown(&state.root).await;
    Ok(json_response(200, json!({ "files": files }), NO_STORE))
}

pub async fn config_get(
    State(state): State<AppState>,
    _req: Request,
) -> Result<Response, ApiError> {
    let loaded: LoadedConfig = config::load_config(&state.config_path).await;
    Ok(json_response(
        200,
        serde_json::to_value(loaded).unwrap(),
        NO_STORE,
    ))
}

pub async fn search_get(State(state): State<AppState>, req: Request) -> Result<Response, ApiError> {
    let query = query_param(&req, "q").unwrap_or_default();
    let query = query.trim();
    if query.chars().count() > MAX_QUERY {
        return Err(ApiError::new(400, "The query is too long."));
    }
    let results = search::search_markdown(&state.root, query, search::ScanOptions::default()).await;
    Ok(json_response(
        200,
        serde_json::to_value(results).unwrap(),
        NO_STORE,
    ))
}

pub async fn backlinks_get(
    State(state): State<AppState>,
    req: Request,
) -> Result<Response, ApiError> {
    markdown_file(&state, query_param(&req, "path")).await?;
    let path = query_param(&req, "path").unwrap_or_default();
    let target = search::posix_normalize(&pure::normalize_path(&path));
    let results =
        search::search_backlinks(&state.root, &target, search::ScanOptions::default()).await;
    Ok(json_response(
        200,
        serde_json::to_value(results).unwrap(),
        NO_STORE,
    ))
}

pub async fn file_get(State(state): State<AppState>, req: Request) -> Result<Response, ApiError> {
    let file = markdown_file(&state, query_param(&req, "path")).await?;
    let content = fs::read_lossy(&file).await?;
    let etag = hash::etag(&content);
    Ok(text_response(
        200,
        "text/plain; charset=utf-8",
        content,
        Some(etag),
        &[],
    ))
}

pub async fn file_put(State(state): State<AppState>, req: Request) -> Result<Response, ApiError> {
    let create = query_param(&req, "create").as_deref() == Some("1");
    let file = if create {
        let file = fs::resolve_writable(&state.root, query_param(&req, "path").as_deref()).await?;
        if !pure::is_markdown_path(&file.to_string_lossy()) {
            return Err(ApiError::new(400, "Only .md files are supported."));
        }
        file
    } else {
        markdown_file(&state, query_param(&req, "path")).await?
    };
    let if_match = state.guard_header(&axum::http::header::IF_MATCH, &req);
    let body = body_string(req).await?;

    let write_target = file.clone();
    let write_body = body.clone();
    let result = fs::with_file_lock(&state.locks, &fs::lock_key(&file), async {
        if let Some(if_match) = if_match {
            let current = match fs::read_lossy(&file).await {
                Ok(text) => text,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Err(ApiError::new(404, "File not found."));
                }
                Err(error) => return Err(error.into()),
            };
            let etag = hash::etag(&current);
            if if_match != "*" && if_match != etag {
                return Ok(Some(json_response(
                    409,
                    json!({ "error": "The file changed on disk.", "etag": etag }),
                    NO_STORE,
                )));
            }
        } else if !create && tokio::fs::metadata(&file).await.is_err() {
            return Err(ApiError::new(404, "File not found."));
        }
        fs::spawn_write(write_target, write_body, false)
            .await
            .map_err(|_| ApiError::new(500, "Internal error."))??;
        Ok(None)
    })
    .await?;
    Ok(result.unwrap_or_else(|| empty_response(204, Some(hash::etag(&body)))))
}

pub async fn file_post(State(state): State<AppState>, req: Request) -> Result<Response, ApiError> {
    let path = query_param(&req, "path");
    let path = path.as_deref().unwrap_or("");
    if path.is_empty() || !pure::is_markdown_path(path) {
        return Err(ApiError::new(400, "Only .md files are supported."));
    }
    let file = fs::resolve_new(&state.root, Some(path)).await?;
    let body = body_string(req).await?;
    if let Some(parent) = file.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let write_target = file.clone();
    let write_body = body.clone();
    fs::with_file_lock(&state.locks, &fs::lock_key(&file), async {
        fs::spawn_write(write_target, write_body, true)
            .await
            .map_err(|_| ApiError::new(500, "Internal error."))??;
        Ok(empty_response(201, Some(hash::etag(&body))))
    })
    .await
}

pub async fn file_delete(
    State(state): State<AppState>,
    req: Request,
) -> Result<Response, ApiError> {
    let (real, entry) =
        fs::resolve_entry(&state.root, query_param(&req, "path").as_deref()).await?;
    if !pure::is_markdown_path(&real.to_string_lossy()) {
        return Err(ApiError::new(400, "Only .md files are supported."));
    }
    let if_match = state.guard_header(&axum::http::header::IF_MATCH, &req);
    fs::with_file_lock(&state.locks, &fs::lock_key(&real), async {
        if let Some(if_match) = if_match {
            if if_match != "*" {
                let content = fs::read_lossy(&real).await?;
                let etag = hash::etag(&content);
                if if_match != etag {
                    return Ok(json_response(
                        409,
                        json!({ "error": "The file changed on disk.", "etag": etag }),
                        NO_STORE,
                    ));
                }
            }
        }
        tokio::fs::remove_file(&entry).await?;
        Ok(empty_response(204, None))
    })
    .await
}

/// Mueve `entry` a `target` con el candado ya tomado. `real` es el destino del
/// enlace cuando `entry` es un symlink (solo Unix).
async fn move_into(real: &Path, entry: &Path, target: &Path) -> Result<(), ApiError> {
    // `resolve_new` ocurrió antes del candado: el destino puede haberse creado.
    match tokio::fs::symlink_metadata(target).await {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
        Ok(_) => {
            return Err(ApiError::new(
                409,
                "A file or folder already exists at that path.",
            ))
        }
    }

    #[cfg(unix)]
    {
        let metadata = tokio::fs::symlink_metadata(entry).await?;
        if metadata.file_type().is_symlink() {
            let link = relative_path(target.parent().unwrap_or(Path::new("/")), real);
            tokio::fs::symlink(link, target).await?;
            tokio::fs::remove_file(entry).await?;
            return Ok(());
        }
    }
    #[cfg(not(unix))]
    let _ = real;

    // Para archivos regulares, enlace + borrado: nunca un rename sobre un
    // destino aparecido entre la comprobación y la escritura.
    match tokio::fs::hard_link(entry, target).await {
        Ok(()) => tokio::fs::remove_file(entry).await?,
        Err(error) if matches!(error.raw_os_error(), Some(1 | 18 | 38 | 95)) => {
            // Sistema sin enlaces duros: comportamiento anterior.
            tokio::fs::rename(entry, target).await?;
        }
        Err(error) if error.raw_os_error() == Some(17) => {
            return Err(ApiError::new(
                409,
                "A file or folder already exists at that path.",
            ));
        }
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

pub async fn move_post(State(state): State<AppState>, req: Request) -> Result<Response, ApiError> {
    let payload = body_json(req).await?;
    let from = payload.get("from").and_then(Value::as_str);
    let to = payload.get("to").and_then(Value::as_str);
    let (Some(from), Some(to)) = (from, to) else {
        return Err(ApiError::new(400, "Missing or invalid path."));
    };
    if !pure::is_markdown_path(from) || !pure::is_markdown_path(to) {
        return Err(ApiError::new(400, "Only .md files are supported."));
    }
    let (real, entry) = fs::resolve_entry(&state.root, Some(from)).await?;
    let target = fs::resolve_new(&state.root, Some(to)).await?;
    if let Some(parent) = target.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    // Desviación A-019: bloquear también el destino para dos moves concurrentes.
    let mut keys = [fs::lock_key(&real), fs::lock_key(&target)];
    keys.sort();
    let locks_first = state.locks.clone();
    let locks_second = state.locks.clone();
    let first = keys[0].clone();
    let second = keys[1].clone();
    fs::with_file_lock(&locks_first, &first, async move {
        fs::with_file_lock(&locks_second, &second, async move {
            move_into(&real, &entry, &target).await?;
            Ok(empty_response(204, None))
        })
        .await
    })
    .await
}

pub async fn events_get(
    State(state): State<AppState>,
    _req: Request,
) -> Result<Response, ApiError> {
    let (receiver, cancel, guard) = state.sse.subscribe();
    let stream = state.sse.stream(
        receiver,
        cancel,
        std::time::Duration::from_millis(pure::SSE_HEARTBEAT_MS),
        guard,
    );
    let mut response = Sse::new(stream).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static(NO_STORE));
    response
        .headers_mut()
        .insert("x-accel-buffering", HeaderValue::from_static("no"));
    Ok(response)
}

async fn files_dispatch(State(state): State<AppState>, req: Request) -> Result<Response, ApiError> {
    if matches!(req.method(), &Method::GET | &Method::HEAD) {
        raw_get(State(state), req).await
    } else {
        Ok(state.assets.fallback())
    }
}

pub async fn raw_get(State(state): State<AppState>, req: Request) -> Result<Response, ApiError> {
    let encoded = req
        .uri()
        .path()
        .strip_prefix("/files/")
        .unwrap_or(req.uri().path());
    let decoded = percent_decode(encoded)?;
    let file = fs::resolve_file(&state.root, Some(&decoded)).await?;
    let content_type = mime_for(&file);
    if serves_with_range(&file) {
        let response = ServeFile::new(&file)
            .oneshot(req)
            .await
            .expect("ServeFile es infalible");
        let mut response = response.map(Body::new);
        let headers = response.headers_mut();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_str(content_type).expect("MIME válido"),
        );
        headers.insert(
            "content-security-policy",
            HeaderValue::from_static("sandbox"),
        );
        headers.insert(
            "x-content-type-options",
            HeaderValue::from_static("nosniff"),
        );
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(NO_STORE));
        return Ok(response);
    }
    let body = tokio::fs::read(&file).await?;
    Ok(bytes_response(
        200,
        content_type,
        body,
        &[
            ("content-security-policy", "sandbox"),
            ("x-content-type-options", "nosniff"),
        ],
    ))
}

pub async fn index_get(State(state): State<AppState>) -> Response {
    state.assets.index_response()
}

pub async fn asset_get(State(state): State<AppState>, req: Request) -> Response {
    state
        .assets
        .asset_response(req.uri().path())
        .unwrap_or_else(|| state.assets.fallback())
}

fn relative_path(from: &Path, to: &Path) -> PathBuf {
    let from_parts: Vec<_> = from.components().collect();
    let to_parts: Vec<_> = to.components().collect();
    let common = from_parts
        .iter()
        .zip(&to_parts)
        .take_while(|(a, b)| a == b)
        .count();
    let mut out = PathBuf::new();
    for _ in common..from_parts.len() {
        out.push("..");
    }
    for part in &to_parts[common..] {
        out.push(part.as_os_str());
    }
    out
}

/// Tipos binarios grandes: `ServeFile` aporta Range y HEAD.
fn serves_with_range(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("")
            .to_lowercase()
            .as_str(),
        "webp" | "avif" | "mp4" | "webm" | "mp3" | "ogg" | "pdf"
    )
}

fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "md" => "text/markdown",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "css" => "text/css",
        "js" => "text/javascript",
        "woff2" => "font/woff2",
        "html" => "text/html",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "pdf" => "application/pdf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "txt" => "text/plain",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
}

fn percent_decode(value: &str) -> Result<String, ApiError> {
    pure::percent_decode(value).ok_or_else(|| ApiError::new(400, "Missing or invalid path."))
}

impl AppState {
    fn guard_header(&self, name: &header::HeaderName, req: &Request) -> Option<String> {
        req.headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
    }
}

/// Un único handler para `/api/*`: así no hay `405` de axum ni cabecera `Allow`
/// añadida; el original devuelve 404 del `fetch()` para métodos no definidos.
async fn api_dispatch(State(state): State<AppState>, req: Request) -> Result<Response, ApiError> {
    let path = req.uri().path().to_string();
    let method = req.method().clone();
    match (path.as_str(), method) {
        (pure::TREE_URL, Method::GET) => tree_get(State(state), req).await,
        (pure::FILES_URL, Method::GET) => file_get(State(state), req).await,
        (pure::FILES_URL, Method::PUT) => file_put(State(state), req).await,
        (pure::FILES_URL, Method::POST) => file_post(State(state), req).await,
        (pure::FILES_URL, Method::DELETE) => file_delete(State(state), req).await,
        (pure::MOVE_URL, Method::POST) => move_post(State(state), req).await,
        (pure::CONFIG_URL, Method::GET) => config_get(State(state), req).await,
        (pure::SEARCH_URL, Method::GET) => search_get(State(state), req).await,
        (pure::BACKLINKS_URL, Method::GET) => backlinks_get(State(state), req).await,
        (pure::EVENTS_URL, Method::GET) => events_get(State(state), req).await,
        _ => Ok(state.assets.fallback()),
    }
}

async fn guard_middleware(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Result<Response, ApiError> {
    state.guard(&req)?;
    Ok(next.run(req).await)
}

pub fn router(state: AppState) -> axum::Router {
    use axum::routing::{any, get};

    let guarded = axum::Router::new()
        .route("/files/{*path}", any(files_dispatch))
        .route("/api/{*path}", any(api_dispatch))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            guard_middleware,
        ));

    axum::Router::new()
        .route("/", get(index_get))
        .route("/view/{*path}", get(index_get))
        .merge(guarded)
        .fallback(asset_get)
        .with_state(state)
}

pub fn bind_addr(port: u16) -> SocketAddr {
    SocketAddr::new(pure::HOSTNAME.parse().expect("HOSTNAME válido"), port)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    struct Temp(PathBuf);

    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "markvi-move-{}-{}",
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
    }

    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn status(error: ApiError) -> u16 {
        match error {
            ApiError::Http(status, _) => status,
            other => panic!("error inesperado: {other:?}"),
        }
    }

    #[tokio::test]
    async fn move_no_sobrescribe_un_destino_que_aparece_bajo_el_candado() {
        let dir = Temp::new();
        let source = dir.path().join("a.md");
        let target = dir.path().join("b.md");
        std::fs::write(&source, "origen").unwrap();
        std::fs::write(&target, "destino").unwrap();

        let error = move_into(&source, &source, &target).await.unwrap_err();
        assert_eq!(status(error), 409);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "destino");
        assert_eq!(std::fs::read_to_string(&source).unwrap(), "origen");
    }

    #[tokio::test]
    async fn mueve_archivo_normal_y_enlace() {
        let dir = Temp::new();
        let source = dir.path().join("a.md");
        let target = dir.path().join("b.md");
        std::fs::write(&source, "contenido").unwrap();
        move_into(&source, &source, &target).await.unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "contenido");
        assert!(!source.exists());

        #[cfg(unix)]
        {
            let real = dir.path().join("real.md");
            let alias = dir.path().join("alias.md");
            let target = dir.path().join("movido.md");
            std::fs::write(&real, "# Destino\n").unwrap();
            std::os::unix::fs::symlink("real.md", &alias).unwrap();
            move_into(&real, &alias, &target).await.unwrap();
            assert_eq!(std::fs::read_to_string(&target).unwrap(), "# Destino\n");
            assert!(std::fs::symlink_metadata(&target)
                .unwrap()
                .file_type()
                .is_symlink());
            assert!(!alias.exists());
            assert!(real.exists());
        }
    }

    #[test]
    fn config_json_byte_a_byte() {
        let raw: toml::Table =
            toml::from_str("theme = 'dark'\n[keymap.view]\nJ = 'j'\nK = 'k'\n").unwrap();
        let (config, warnings) = config::validate_config(&raw);
        let loaded = LoadedConfig {
            config,
            warnings,
            path: "/tmp/markvi-config.toml".to_string(),
            exists: true,
        };
        assert_eq!(
            serde_json::to_string(&loaded).unwrap(),
            r#"{"config":{"leader":" ","theme":"dark","font":null,"editor":{"number":true,"relativenumber":false,"scrolloff":0},"leaderBindings":[{"keys":["f"],"action":"find"},{"keys":["/"],"action":"grep"},{"keys":["r"],"action":"recent"},{"keys":["a"],"action":"alternate"},{"keys":["t"],"action":"toc"},{"keys":["b"],"action":"backlinks"},{"keys":["x"],"action":"close"}],"viewRemap":{"J":"j","K":"k"},"vimMappings":[],"render":{"footnotes":true,"alerts":true,"frontmatter":true,"remoteimages":false}},"warnings":[],"path":"/tmp/markvi-config.toml","exists":true}"#
        );
    }

    #[test]
    fn mime_por_extension() {
        let casos = [
            ("a.webp", "image/webp"),
            ("a.avif", "image/avif"),
            ("a.ico", "image/x-icon"),
            ("a.pdf", "application/pdf"),
            ("a.mp4", "video/mp4"),
            ("a.webm", "video/webm"),
            ("a.mp3", "audio/mpeg"),
            ("a.ogg", "audio/ogg"),
            ("a.txt", "text/plain"),
            ("a.json", "application/json"),
        ];
        for (name, expected) in casos {
            assert_eq!(mime_for(Path::new(name)), expected, "{name}");
        }
    }

    fn header(response: &Response, name: &str) -> String {
        response
            .headers()
            .get(name)
            .expect("falta la cabecera")
            .to_str()
            .unwrap()
            .to_string()
    }

    #[tokio::test]
    async fn embedded_assets_keep_contract() {
        let assets = StaticAssets::new();
        let index = assets.index_response();
        assert_eq!(index.status(), StatusCode::OK);
        assert_eq!(header(&index, "content-type"), "text/html;charset=utf-8");
        assert_eq!(header(&index, "cache-control"), "no-cache");
        assert_eq!(header(&index, "etag"), "\"5d2079dee36213ca\"");
        let body = to_bytes(index.into_body(), usize::MAX).await.unwrap();
        assert!(body.starts_with(b"<!doctype html>"));
        assert!(body.windows(6).any(|w| w == b"chunk-"));

        let manifest: Value = serde_json::from_str(embedded::MANIFEST).unwrap();
        assert_eq!(manifest["assets"].as_object().unwrap().len(), 5);
        for (url, entry) in manifest["assets"].as_object().unwrap() {
            let response = assets
                .asset_response(url)
                .unwrap_or_else(|| panic!("{url} no embebido"));
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                header(&response, "content-type"),
                entry["content_type"].as_str().unwrap()
            );
            assert_eq!(
                header(&response, "cache-control"),
                entry["cache_control"].as_str().unwrap()
            );
            assert_eq!(header(&response, "etag"), entry["etag"].as_str().unwrap());
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            assert!(!body.is_empty(), "{url} vacío");
        }

        assert!(assets.asset_response("/no-existe.js").is_none());
        let fallback = assets.fallback();
        assert_eq!(fallback.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            header(&fallback, "content-type"),
            "text/plain;charset=utf-8"
        );
        let body = to_bytes(fallback.into_body(), usize::MAX).await.unwrap();
        assert_eq!(body.as_ref(), b"Not found");
    }
}
