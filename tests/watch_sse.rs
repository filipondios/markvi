//! Watcher y SSE: eventos reales, heartbeat, reconexión, cancelación y señales.
use axum::{extract::State, response::sse::Sse, routing::get, Router};
use markvi_server::watch::{self, DiskEvent, DiskEventKind, FileWatcher, SseHub};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    path::PathBuf,
    process::{Command, Stdio},
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};

static COUNTER: AtomicUsize = AtomicUsize::new(0);

struct Temp(PathBuf);

impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "markvi-watch-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &std::path::Path {
        &self.0
    }

    fn write(&self, name: &str, body: &str) {
        std::fs::write(self.0.join(name), body).unwrap();
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn event(path: &str, kind: DiskEventKind) -> DiskEvent {
    DiskEvent {
        kind,
        path: path.to_string(),
    }
}

async fn collect(
    receiver: &mut tokio::sync::broadcast::Receiver<DiskEvent>,
    timeout_ms: u64,
) -> Vec<DiskEvent> {
    let mut out = Vec::new();
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        match tokio::time::timeout(Duration::from_millis(50), receiver.recv()).await {
            Ok(Ok(event)) => out.push(event),
            Ok(Err(_)) => break,
            Err(_) if Instant::now() >= deadline => break,
            Err(_) => {}
        }
    }
    out
}

#[tokio::test(flavor = "multi_thread")]
async fn watcher_emite_la_segunda_escritura_separada_100ms() {
    let temp = Temp::new();
    temp.write("dos.md", "v0");
    let mut watcher = FileWatcher::new(temp.path());
    let mut events = watcher.subscribe();
    tokio::time::sleep(Duration::from_millis(250)).await;
    let _ = collect(&mut events, 50).await;

    temp.write("dos.md", "v1");
    // La segunda escritura cae ~100 ms después de la primera: dentro del
    // debounce de 80 ms por ruta, pero también dentro del viejo dedupe de 150 ms.
    tokio::time::sleep(Duration::from_millis(100)).await;
    temp.write("dos.md", "v2");

    let emitted = collect(&mut events, 500).await;
    let changes = emitted
        .iter()
        .filter(|event| event.path == "dos.md" && event.kind == DiskEventKind::Change)
        .count();
    assert!(
        changes >= 2,
        "se descartó una de las escrituras: {emitted:?}"
    );
    assert!(changes <= 3, "ráfaga de duplicados: {emitted:?}");
    watcher.close();
}

#[tokio::test(flavor = "multi_thread")]
async fn watcher_create_modify_rename_remove_and_burst() {
    let temp = Temp::new();
    temp.write("inicial.md", "inicial");
    let mut watcher = FileWatcher::new(temp.path());
    let mut events = watcher.subscribe();
    tokio::time::sleep(Duration::from_millis(250)).await;

    temp.write("nuevo.md", "a");
    tokio::time::sleep(Duration::from_millis(250)).await;
    let burst = collect(&mut events, 200).await;
    assert!(
        burst.contains(&event("nuevo.md", DiskEventKind::Change)),
        "{burst:?}"
    );
    // `fs::write` no es atómico: crear y cerrar pueden llegar como dos eventos.
    let changes = burst.iter().filter(|e| e.path == "nuevo.md").count();
    assert!((1..=3).contains(&changes), "ráfaga inesperada: {burst:?}");

    temp.write("nuevo.md", "ab");
    tokio::time::sleep(Duration::from_millis(250)).await;
    let change = collect(&mut events, 200).await;
    assert_eq!(change, vec![event("nuevo.md", DiskEventKind::Change)]);

    std::fs::rename(temp.path().join("nuevo.md"), temp.path().join("movido.md")).unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let rename = collect(&mut events, 250).await;
    assert!(
        rename.contains(&event("movido.md", DiskEventKind::Change)),
        "{rename:?}"
    );
    assert!(
        rename.contains(&event("nuevo.md", DiskEventKind::Delete)),
        "{rename:?}"
    );

    std::fs::remove_file(temp.path().join("movido.md")).unwrap();
    tokio::time::sleep(Duration::from_millis(250)).await;
    let removed = collect(&mut events, 200).await;
    assert!(
        removed.contains(&event("movido.md", DiskEventKind::Delete)),
        "{removed:?}"
    );
    watcher.close();
}

#[tokio::test(flavor = "multi_thread")]
async fn watcher_emits_alias_events_for_symlinks() {
    let temp = Temp::new();
    temp.write("real.md", "a");
    #[cfg(unix)]
    std::os::unix::fs::symlink("real.md", temp.path().join("alias.md")).unwrap();
    let mut watcher = FileWatcher::new(temp.path());
    let mut events = watcher.subscribe();
    tokio::time::sleep(Duration::from_millis(250)).await;

    temp.write("real.md", "b");
    tokio::time::sleep(Duration::from_millis(250)).await;
    let emitted = collect(&mut events, 200).await;
    #[cfg(unix)]
    {
        assert!(
            emitted.contains(&event("real.md", DiskEventKind::Change)),
            "{emitted:?}"
        );
        assert!(
            emitted.contains(&event("alias.md", DiskEventKind::Change)),
            "{emitted:?}"
        );
    }
    watcher.close();
}

async fn events_handler(State(hub): State<std::sync::Arc<SseHub>>) -> Sse<watch::EventStream> {
    let (receiver, cancel, guard) = hub.subscribe();
    Sse::new(hub.stream(receiver, cancel, Duration::from_millis(120), guard))
}

fn open_sse(port: u16) -> TcpStream {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    write!(
        stream,
        "GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    stream
}

fn read_until(stream: &mut TcpStream, needle: &str, timeout_ms: u64) -> String {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let mut all = String::new();
    let mut buffer = [0u8; 1024];
    while Instant::now() < deadline {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                all.push_str(&String::from_utf8_lossy(&buffer[..count]));
                if all.contains(needle) {
                    return all;
                }
            }
            Err(_) => continue,
        }
    }
    all
}

#[tokio::test(flavor = "multi_thread")]
async fn sse_streams_events_heartbeat_reconnect_and_cancel_without_blocking() {
    let temp = Temp::new();
    let mut watcher = FileWatcher::new(temp.path());
    let hub = watcher.hub();
    let app = Router::new()
        .route("/api/events", get(events_handler))
        .route("/ping", get(|| async { "pong" }))
        .with_state(hub.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    tokio::time::sleep(Duration::from_millis(100)).await;

    let mut first = tokio::task::spawn_blocking(move || open_sse(port))
        .await
        .unwrap();
    temp.write("evento.md", "# evento\n");
    let frame =
        tokio::task::spawn_blocking(move || read_until(&mut first, "\"path\":\"evento.md\"", 2000))
            .await
            .unwrap();
    assert!(
        frame.contains("data: {\"type\":\"change\",\"path\":\"evento.md\"}"),
        "{frame:?}"
    );

    let mut second = tokio::task::spawn_blocking(move || open_sse(port))
        .await
        .unwrap();
    let heartbeat = tokio::task::spawn_blocking(move || {
        let text = read_until(&mut second, ": ping", 2000);
        drop(second);
        text
    })
    .await
    .unwrap();
    assert!(heartbeat.contains(": ping"), "{heartbeat:?}");

    // Un cliente desconectado no impide que el servidor siga respondiendo.
    tokio::time::sleep(Duration::from_millis(100)).await;
    let mut ping = TcpStream::connect(("127.0.0.1", port)).unwrap();
    ping.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    write!(
        ping,
        "GET /ping HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut answer = String::new();
    let _ = ping.read_to_string(&mut answer);
    assert!(
        answer.contains("200 OK") && answer.contains("pong"),
        "{answer:?}"
    );

    hub.cancel_all();
    watcher.close();
    server.abort();
}

#[tokio::test]
async fn sse_guard_removes_cancellation_when_stream_is_dropped() {
    let temp = Temp::new();
    let mut watcher = FileWatcher::new(temp.path());
    let hub = watcher.hub();
    {
        let (_events, _cancel, _guard) = hub.subscribe();
        assert_eq!(hub.pending_cancels(), 1);
    }
    assert_eq!(hub.pending_cancels(), 0);
    hub.cancel_all();
    watcher.close();
}

#[test]
fn shutdown_signal_handles_sigterm_and_sigint() {
    let binary = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/debug/shutdown_probe");
    for signal in ["-TERM", "-INT"] {
        let mut child = Command::new(&binary)
            .stdout(Stdio::piped())
            .spawn()
            .expect("build the shutdown_probe bin with cargo test");
        let mut reader = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert_eq!(line.trim(), "ready");
        let status = Command::new("kill")
            .args([signal, &child.id().to_string()])
            .status()
            .unwrap();
        assert!(status.success());
        let mut output = String::new();
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            line.clear();
            if reader.read_line(&mut line).unwrap() == 0 {
                break;
            }
            output.push_str(&line);
            if output.contains("bye") {
                break;
            }
        }
        let _ = child.kill();
        let _ = child.wait();
        assert!(output.contains("bye"), "signal {signal}: {output:?}");
    }
}
