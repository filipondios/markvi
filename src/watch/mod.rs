//! Watcher y canal SSE. Espejo de `src/watch.ts` y `events()` de `src/api.ts`.
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
    path::Path,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
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
pub const SSE_HEARTBEAT_MS: u64 = 25_000;

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
}

pub struct FileWatcher {
    hub: Arc<SseHub>,
    watcher: Arc<Mutex<Option<notify::RecommendedWatcher>>>,
    closed: Arc<AtomicBool>,
    stop: Option<oneshot::Sender<()>>,
}

impl FileWatcher {
    pub fn new(root: &Path) -> Self {
        let (hub_tx, _) = broadcast::channel(1024);
        let (event_tx, mut event_rx) = mpsc::unbounded_channel::<Input>();
        let (stop_tx, mut stop_rx) = oneshot::channel::<()>();
        let closed = Arc::new(AtomicBool::new(false));

        let watcher_tx = event_tx.clone();
        let mut watcher = notify::recommended_watcher(move |result| {
            let _ = watcher_tx.send(Input::Notify(result));
        })
        .expect("recommended watcher");
        if let Err(error) = watcher.watch(root, RecursiveMode::Recursive) {
            eprintln!("Could not watch the directory: {error}");
        }
        let watcher = Arc::new(Mutex::new(Some(watcher)));

        let init_root = root.to_path_buf();
        let init_tx = hub_tx.clone();
        let init_events = event_tx.clone();
        tokio::spawn(async move {
            let entries = fs::list_markdown_entries(&init_root).await;
            let _ = init_events.send(Input::Init(entries));
            let _ = init_tx; // el hub se comparte desde el constructor
        });

        let root = root.to_path_buf();
        let tx = hub_tx.clone();
        let flags = closed.clone();
        tokio::spawn(async move {
            let mut known: HashSet<String> = HashSet::new();
            let mut aliases: HashMap<String, Vec<String>> = HashMap::new();
            let mut timers: HashMap<String, tokio::task::JoinHandle<()>> = HashMap::new();

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
                    }
                    Input::Notify(result) => {
                        let event = match result {
                            Ok(event) => event,
                            Err(error) => {
                                eprintln!("File watcher: {error}");
                                continue;
                            }
                        };
                        for path in event.paths {
                            let path = match path.strip_prefix(&root) {
                                Ok(path) => path.to_string_lossy().replace('\\', "/"),
                                Err(_) => continue,
                            };
                            if path.split('/').any(fs_ignored) {
                                continue;
                            }
                            if crate::core::pure::is_markdown_path(&path) {
                                schedule(&mut timers, &event_tx, path, false);
                            } else {
                                schedule(&mut timers, &event_tx, path, true);
                            }
                        }
                    }
                    Input::FileTimer(path) => {
                        let abs = root.join(&path);
                        if tokio::fs::symlink_metadata(&abs)
                            .await
                            .is_ok_and(|info| info.file_type().is_symlink())
                        {
                            reconcile(&root, &mut known, &mut aliases, &tx, &emit).await;
                        }
                        let info = tokio::fs::metadata(&abs).await.ok();
                        let kind = match info {
                            Some(info) if info.is_dir() => {
                                reconcile(&root, &mut known, &mut aliases, &tx, &emit).await;
                                continue;
                            }
                            Some(info) if info.is_file() => DiskEventKind::Change,
                            _ => DiskEventKind::Delete,
                        };
                        known.retain(|item| item != &path);
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
                        let abs = root.join(&path);
                        let info = tokio::fs::metadata(&abs).await.ok();
                        if info.as_ref().is_some_and(|info| info.is_file()) {
                            continue;
                        }
                        let had_children = known
                            .iter()
                            .any(|item| item.starts_with(&format!("{path}/")));
                        if info.is_none() && !had_children {
                            continue;
                        }
                        reconcile(&root, &mut known, &mut aliases, &tx, &emit).await;
                    }
                }
            }
            for (_, timer) in timers {
                timer.abort();
            }
        });

        Self {
            hub: Arc::new(SseHub::from_sender(hub_tx)),
            watcher,
            closed,
            stop: Some(stop_tx),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<DiskEvent> {
        self.hub.subscribe_events()
    }

    pub fn hub(&self) -> Arc<SseHub> {
        self.hub.clone()
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

fn fs_ignored(name: &str) -> bool {
    name.starts_with('.') || name == "node_modules"
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
    tx: &mpsc::UnboundedSender<Input>,
    path: String,
    directory: bool,
) {
    if let Some(previous) = timers.remove(&path) {
        previous.abort();
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
    timers.insert(key, handle);
}

async fn reconcile<F>(
    root: &Path,
    known: &mut HashSet<String>,
    aliases: &mut HashMap<String, Vec<String>>,
    tx: &broadcast::Sender<DiskEvent>,
    emit: &F,
) where
    F: Fn(DiskEvent, &broadcast::Sender<DiskEvent>),
{
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
            cancels.insert(id, tx);
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
