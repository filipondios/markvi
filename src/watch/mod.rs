//! Watcher y canal SSE.
//! `notify` emite eventos de directorio; encima se mantiene el conjunto de
//! archivos conocidos, el debounce de 80 ms y los alias por symlink.

use crate::fs::{self, MarkdownEntry};
use futures_core::Stream;
use notify::{Event as NotifyEvent, RecursiveMode, Watcher};
use serde::Serialize;
use std::sync::Mutex as StdMutex;
use std::{
    collections::{HashMap, HashSet},
    convert::Infallible,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    sync::{broadcast, mpsc, oneshot, Mutex},
    time::{interval_at, Interval},
};
use tokio_stream::wrappers::BroadcastStream;

pub const DEBOUNCE_MS: u64 = 80;
/// Ventana en la que varias peticiones de reconciliación se funden en una.
const RECONCILE_COALESCE_MS: u64 = 25;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiskEventKind {
    Change,
    Delete,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DiskEvent {
    #[serde(rename = "type")]
    pub kind: DiskEventKind,
    pub path: String,
}

enum Input {
    Notify(notify::Result<NotifyEvent>),
    Init(Vec<MarkdownEntry>),
    FileTimer(String),
    DirTimer(String),
    Reconcile,
}

pub struct FileWatcher {
    hub: Arc<SseHub>,
    watcher: Arc<Mutex<Option<notify::RecommendedWatcher>>>,
    closed: Arc<AtomicBool>,
    stop: Option<oneshot::Sender<()>>,
    pending_timers: Arc<AtomicUsize>,
    reconciles: Arc<AtomicUsize>,
}

impl FileWatcher {
    pub fn new(root: &Path) -> Self {
        let (hub_tx, _) = broadcast::channel(1024);
        let (event_tx, mut event_rx) = mpsc::unbounded_channel::<Input>();
        let (stop_tx, mut stop_rx) = oneshot::channel::<()>();
        let closed = Arc::new(AtomicBool::new(false));

        let watcher_tx = event_tx.clone();
        let watcher = match notify::recommended_watcher(move |result| {
            let _ = watcher_tx.send(Input::Notify(result));
        }) {
            Ok(watcher) => Arc::new(Mutex::new(Some(watcher))),
            Err(error) => {
                // Sin live-reload, pero el servidor sigue arrancando.
                eprintln!("Could not watch the directory: {error}");
                Arc::new(Mutex::new(None))
            }
        };

        let init_root = root.to_path_buf();
        let init_events = event_tx.clone();
        tokio::spawn(async move {
            let entries = fs::list_markdown_entries(&init_root).await;
            let _ = init_events.send(Input::Init(entries));
        });

        let root = root.to_path_buf();
        let tx = hub_tx.clone();
        let flags = closed.clone();
        let loop_watcher = watcher.clone();
        let pending_timers = Arc::new(AtomicUsize::new(0));
        let loop_pending = pending_timers.clone();
        let reconciles = Arc::new(AtomicUsize::new(0));
        let loop_reconciles = reconciles.clone();
        tokio::spawn(async move {
            let mut known: HashSet<String> = HashSet::new();
            let mut aliases: HashMap<String, Vec<String>> = HashMap::new();
            let mut timers: HashMap<String, tokio::task::JoinHandle<()>> = HashMap::new();
            let mut watched: HashSet<PathBuf> = HashSet::new();
            let mut reconcile_timer: Option<tokio::task::JoinHandle<()>> = None;

            let emit = |event: DiskEvent, tx: &broadcast::Sender<DiskEvent>| {
                if flags.load(Ordering::Relaxed) {
                    return;
                }
                let _ = tx.send(event);
            };

            loop {
                let input = tokio::select! {
                    _ = &mut stop_rx => break,
                    input = event_rx.recv() => match input { Some(input) => input, None => break },
                };
                match input {
                    Input::Init(entries) => {
                        for entry in &entries {
                            known.insert(entry.path.clone());
                        }
                        index_aliases(&mut aliases, &entries);
                        watch_dirs(&loop_watcher, &root, &mut watched).await;
                    }
                    Input::Notify(result) => {
                        let event = match result {
                            Ok(event) => event,
                            Err(error) => {
                                eprintln!("File watcher: {error}");
                                continue;
                            }
                        };
                        if matches!(event.kind, notify::EventKind::Access(_)) {
                            continue;
                        }
                        for path in event.paths {
                            let path = match path.strip_prefix(&root) {
                                Ok(path) => path.to_string_lossy().replace('\\', "/"),
                                Err(_) => continue,
                            };
                            if path.split('/').any(fs::is_ignored) {
                                continue;
                            }
                            if crate::core::pure::is_markdown_path(&path) {
                                schedule(&mut timers, &loop_pending, &event_tx, path, false);
                            } else {
                                schedule(&mut timers, &loop_pending, &event_tx, path, true);
                            }
                        }
                    }
                    Input::FileTimer(path) => {
                        if timers.remove(&path).is_some() {
                            loop_pending.fetch_sub(1, Ordering::Relaxed);
                        }
                        let abs = root.join(&path);
                        if tokio::fs::symlink_metadata(&abs)
                            .await
                            .is_ok_and(|info| info.file_type().is_symlink())
                        {
                            request_reconcile(&mut reconcile_timer, &event_tx);
                        }
                        let info = tokio::fs::metadata(&abs).await.ok();
                        let kind = match info {
                            Some(info) if info.is_dir() => {
                                request_reconcile(&mut reconcile_timer, &event_tx);
                                continue;
                            }
                            Some(info) if info.is_file() => DiskEventKind::Change,
                            _ => DiskEventKind::Delete,
                        };
                        known.remove(&path);
                        if kind == DiskEventKind::Change {
                            known.insert(path.clone());
                        }
                        emit(
                            DiskEvent {
                                kind,
                                path: path.clone(),
                            },
                            &tx,
                        );
                        if let Some(alias_list) = aliases.get(&path) {
                            for alias in alias_list.clone() {
                                if known.contains(&alias) {
                                    emit(DiskEvent { kind, path: alias }, &tx);
                                }
                            }
                        }
                    }
                    Input::DirTimer(path) => {
                        if timers.remove(&path).is_some() {
                            loop_pending.fetch_sub(1, Ordering::Relaxed);
                        }
                        let abs = root.join(&path);
                        let info = tokio::fs::metadata(&abs).await.ok();
                        if info.as_ref().is_some_and(|info| info.is_file()) {
                            continue;
                        }
                        let prefix = format!("{path}/");
                        let had_children = known.iter().any(|item| item.starts_with(&prefix));
                        if info.is_none() && !had_children {
                            continue;
                        }
                        request_reconcile(&mut reconcile_timer, &event_tx);
                    }
                    Input::Reconcile => {
                        reconcile_timer = None;
                        reconcile(
                            &root,
                            &mut known,
                            &mut aliases,
                            &tx,
                            &emit,
                            &loop_watcher,
                            &mut watched,
                            &loop_reconciles,
                        )
                        .await;
                    }
                }
            }
            if let Some(timer) = reconcile_timer {
                timer.abort();
            }
            for (_, timer) in timers {
                timer.abort();
            }
            loop_pending.store(0, Ordering::Relaxed);
        });

        Self {
            hub: Arc::new(SseHub::from_sender(hub_tx)),
            watcher,
            closed,
            stop: Some(stop_tx),
            pending_timers,
            reconciles,
        }
    }

    /// Reconciliaciones completas ejecutadas (recorrido del árbol + diff de archivos).
    pub fn reconcile_count(&self) -> usize {
        self.reconciles.load(Ordering::Relaxed)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<DiskEvent> {
        self.hub.subscribe_events()
    }

    pub fn hub(&self) -> Arc<SseHub> {
        self.hub.clone()
    }

    pub fn pending_timers(&self) -> usize {
        self.pending_timers.load(Ordering::Relaxed)
    }

    pub fn close(&mut self) {
        if self.closed.swap(true, Ordering::Relaxed) {
            return;
        }
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        self.hub.cancel_all();
        if let Ok(mut watcher) = self.watcher.try_lock() {
            drop(watcher.take());
        }
    }
}

impl Drop for FileWatcher {
    fn drop(&mut self) {
        self.close();
    }
}

fn index_aliases(aliases: &mut HashMap<String, Vec<String>>, entries: &[MarkdownEntry]) {
    aliases.clear();
    for entry in entries {
        if let Some(real) = &entry.real {
            aliases
                .entry(real.clone())
                .or_default()
                .push(entry.path.clone());
        }
    }
}

fn schedule(
    timers: &mut HashMap<String, tokio::task::JoinHandle<()>>,
    pending: &AtomicUsize,
    tx: &mpsc::UnboundedSender<Input>,
    path: String,
    directory: bool,
) {
    if let Some(previous) = timers.remove(&path) {
        previous.abort();
        pending.fetch_sub(1, Ordering::Relaxed);
    }
    let tx = tx.clone();
    let key = path.clone();
    let handle = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(DEBOUNCE_MS)).await;
        let _ = tx.send(if directory {
            Input::DirTimer(path)
        } else {
            Input::FileTimer(path)
        });
    });
    pending.fetch_add(1, Ordering::Relaxed);
    timers.insert(key, handle);
}

/// Pide una reconciliación completa; las peticiones dentro de la ventana se agrupan.
fn request_reconcile(
    slot: &mut Option<tokio::task::JoinHandle<()>>,
    tx: &mpsc::UnboundedSender<Input>,
) {
    if slot.is_some() {
        return;
    }
    let tx = tx.clone();
    *slot = Some(tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(RECONCILE_COALESCE_MS)).await;
        let _ = tx.send(Input::Reconcile);
    }));
}

/// Vigila solo los directorios visibles, uno a uno (sin `Recursive` sobre el root).
/// Re-registra todos en cada pasada (idempotente en inotify): un directorio
/// borrado y recreado, o renombrado, pierde su watch en el kernel y las rutas
/// ya conocidas no bastan para saberlo. Los que ya no existen se descartan.
async fn watch_dirs(
    watcher: &Arc<Mutex<Option<notify::RecommendedWatcher>>>,
    root: &Path,
    watched: &mut HashSet<PathBuf>,
) {
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        if !seen.insert(dir.clone()) {
            continue;
        }
        {
            let mut guard = watcher.lock().await;
            if let Some(watcher) = guard.as_mut() {
                if let Err(error) = watcher.watch(&dir, RecursiveMode::NonRecursive) {
                    let vanished = matches!(error.kind, notify::ErrorKind::PathNotFound)
                        || matches!(&error.kind, notify::ErrorKind::Io(io) if io.kind() == std::io::ErrorKind::NotFound);
                    if !vanished {
                        eprintln!("Could not watch the directory: {error}");
                    }
                }
            }
        }
        let mut entries = match tokio::fs::read_dir(&dir).await {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            if !fs::is_ignored(&entry.file_name().to_string_lossy())
                && entry.file_type().await.is_ok_and(|kind| kind.is_dir())
            {
                pending.push(entry.path());
            }
        }
    }
    let stale: Vec<PathBuf> = watched.difference(&seen).cloned().collect();
    if !stale.is_empty() {
        let mut guard = watcher.lock().await;
        if let Some(watcher) = guard.as_mut() {
            for dir in stale {
                let _ = watcher.unwatch(&dir);
            }
        }
    }
    *watched = seen;
}

#[allow(clippy::too_many_arguments)]
async fn reconcile<F>(
    root: &Path,
    known: &mut HashSet<String>,
    aliases: &mut HashMap<String, Vec<String>>,
    tx: &broadcast::Sender<DiskEvent>,
    emit: &F,
    watcher: &Arc<Mutex<Option<notify::RecommendedWatcher>>>,
    watched: &mut HashSet<PathBuf>,
    counter: &AtomicUsize,
) where
    F: Fn(DiskEvent, &broadcast::Sender<DiskEvent>),
{
    counter.fetch_add(1, Ordering::Relaxed);
    watch_dirs(watcher, root, watched).await;
    let entries = fs::list_markdown_entries(root).await;
    index_aliases(aliases, &entries);
    let current: HashSet<String> = entries.iter().map(|entry| entry.path.clone()).collect();
    let mut missing: Vec<String> = known.difference(&current).cloned().collect();
    missing.sort();
    for path in missing {
        emit(
            DiskEvent {
                kind: DiskEventKind::Delete,
                path: path.clone(),
            },
            tx,
        );
    }
    let mut added: Vec<String> = current.difference(known).cloned().collect();
    added.sort();
    for path in added {
        emit(
            DiskEvent {
                kind: DiskEventKind::Change,
                path: path.clone(),
            },
            tx,
        );
    }
    *known = current;
}

/// Difusor de eventos y registro de cancelación de los streams SSE.
pub struct SseHub {
    events: broadcast::Sender<DiskEvent>,
    cancels: StdMutex<std::collections::HashMap<u64, oneshot::Sender<()>>>,
    /// Tras `cancel_all`, las suscripciones nuevas nacen ya canceladas.
    closed: std::sync::atomic::AtomicBool,
    next_id: std::sync::atomic::AtomicU64,
}

/// Elimina su registro de cancelación cuando el stream SSE se suelta.
pub struct CancelGuard {
    hub: Arc<SseHub>,
    id: u64,
}

impl Drop for CancelGuard {
    fn drop(&mut self) {
        if let Ok(mut cancels) = self.hub.cancels.lock() {
            cancels.remove(&self.id);
        }
    }
}

impl SseHub {
    fn from_sender(events: broadcast::Sender<DiskEvent>) -> Self {
        Self {
            events,
            cancels: StdMutex::new(std::collections::HashMap::new()),
            closed: std::sync::atomic::AtomicBool::new(false),
            next_id: std::sync::atomic::AtomicU64::new(0),
        }
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<DiskEvent> {
        self.events.subscribe()
    }

    pub fn subscribe(
        self: &Arc<Self>,
    ) -> (
        broadcast::Receiver<DiskEvent>,
        oneshot::Receiver<()>,
        CancelGuard,
    ) {
        let receiver = self.events.subscribe();
        let (tx, rx) = oneshot::channel();
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut cancels) = self.cancels.lock() {
            if self.closed.load(Ordering::Acquire) {
                // Llegó tras el cierre: sin esto el stream nunca terminaría y
                // el apagado ordenado esperaría al cliente indefinidamente.
                let _ = tx.send(());
            } else {
                cancels.insert(id, tx);
            }
        }
        (
            receiver,
            rx,
            CancelGuard {
                hub: self.clone(),
                id,
            },
        )
    }

    pub fn cancel_all(&self) {
        if let Ok(mut cancels) = self.cancels.lock() {
            self.closed.store(true, Ordering::Release);
            for (_, cancel) in cancels.drain() {
                let _ = cancel.send(());
            }
        }
    }

    pub fn pending_cancels(&self) -> usize {
        self.cancels
            .lock()
            .map(|cancels| cancels.len())
            .unwrap_or(0)
    }

    pub fn stream(
        &self,
        receiver: broadcast::Receiver<DiskEvent>,
        cancel: oneshot::Receiver<()>,
        heartbeat: Duration,
        guard: CancelGuard,
    ) -> EventStream {
        EventStream {
            events: BroadcastStream::new(receiver),
            heartbeat: interval_at(tokio::time::Instant::now() + heartbeat, heartbeat),
            cancel,
            _guard: guard,
        }
    }
}

/// Stream manual: combina eventos, heartbeat `: ping` y cancelación sin dependencias extra.
pub struct EventStream {
    events: BroadcastStream<DiskEvent>,
    heartbeat: Interval,
    cancel: oneshot::Receiver<()>,
    _guard: CancelGuard,
}

impl Stream for EventStream {
    type Item = Result<axum::response::sse::Event, Infallible>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        use axum::response::sse::Event;

        if Pin::new(&mut self.cancel).poll(cx).is_ready() {
            return Poll::Ready(None);
        }
        match Pin::new(&mut self.events).poll_next(cx) {
            Poll::Ready(Some(Ok(event))) => {
                let json = serde_json::to_string(&event).expect("serializable event");
                return Poll::Ready(Some(Ok(Event::default().data(json))));
            }
            Poll::Ready(Some(Err(
                tokio_stream::wrappers::errors::BroadcastStreamRecvError::Lagged(_),
            ))) => {
                // El cliente perdió eventos: avisar para que reconsulte el estado,
                // pero mantener la conexión abierta.
                return Poll::Ready(Some(Ok(Event::default().event("resync").data("{}"))));
            }
            Poll::Ready(None) => return Poll::Ready(None),
            Poll::Pending => {}
        }
        match self.heartbeat.poll_tick(cx) {
            Poll::Ready(_) => Poll::Ready(Some(Ok(Event::default().comment("ping")))),
            Poll::Pending => Poll::Pending,
        }
    }
}

/// Señales de apagado compartidas por el servidor real y la sonda de tests.
/// Registra los manejadores de SIGINT/SIGTERM **ya** y devuelve el futuro que espera
/// a cualquiera de ellos. Llamarla antes de anunciar que el servidor está listo evita
/// que una señal temprana mate el proceso con la acción por defecto, sin apagado ordenado.
pub fn install_shutdown_signals() -> impl std::future::Future<Output = ()> + Send + 'static {
    #[cfg(unix)]
    let (interrupt, terminate) = {
        use tokio::signal::unix::{signal, SignalKind};
        (
            signal(SignalKind::interrupt()).ok(),
            signal(SignalKind::terminate()).ok(),
        )
    };
    async move {
        #[cfg(unix)]
        {
            async fn wait(signal: Option<tokio::signal::unix::Signal>) {
                match signal {
                    Some(mut signal) => {
                        signal.recv().await;
                    }
                    None => std::future::pending::<()>().await,
                }
            }
            tokio::select! {
                _ = wait(interrupt) => {},
                _ = wait(terminate) => {},
            }
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
        }
    }
}

pub async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signals) => {
                signals.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::to_bytes,
        response::{sse::Sse, IntoResponse},
    };
    use futures_util::StreamExt;

    #[tokio::test]
    async fn timers_vuelven_a_cero_tras_el_reposo() {
        let temp = std::env::temp_dir().join(format!("markvi-timers-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp);
        std::fs::create_dir_all(&temp).unwrap();
        let mut watcher = FileWatcher::new(&temp);
        let _events = watcher.subscribe();
        tokio::time::sleep(Duration::from_millis(50)).await;
        std::fs::write(temp.join("a.md"), "a").unwrap();
        std::fs::create_dir(temp.join("sub")).unwrap();
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(watcher.pending_timers(), 0);
        watcher.close();
        let _ = std::fs::remove_dir_all(&temp);
    }

    async fn render(event: axum::response::sse::Event) -> String {
        let stream = futures_util::stream::once(async move { Ok::<_, Infallible>(event) });
        let response = Sse::new(stream).into_response();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    #[tokio::test]
    async fn lagged_emite_resync_y_el_stream_sigue_abierto() {
        let (tx, _) = broadcast::channel::<DiskEvent>(2);
        let hub = std::sync::Arc::new(SseHub::from_sender(tx.clone()));
        let (receiver, cancel, guard) = hub.subscribe();
        let mut stream = Box::pin(hub.stream(receiver, cancel, Duration::from_secs(3600), guard));

        for index in 0..6 {
            let _ = tx.send(DiskEvent {
                kind: DiskEventKind::Change,
                path: format!("{index}.md"),
            });
        }

        let first = stream
            .next()
            .await
            .expect("stream cerrado")
            .expect("evento");
        let rendered = render(first).await;
        assert!(
            rendered.contains("event: resync\ndata: {}\n\n"),
            "{rendered:?}"
        );

        // El stream sigue abierto y entrega los eventos que quedaron en el buffer.
        let mut saw_normal = false;
        for _ in 0..8 {
            let event = stream
                .next()
                .await
                .expect("stream cerrado tras resync")
                .expect("evento");
            let rendered = render(event).await;
            if !rendered.contains("event: resync") {
                assert!(rendered.contains("data:"), "{rendered:?}");
                saw_normal = true;
                break;
            }
        }
        assert!(saw_normal, "el stream solo emitía resync");
    }
}
