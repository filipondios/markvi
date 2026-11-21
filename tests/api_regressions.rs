//! Regresiones de API HTTP sobre copias temporales del directorio de notas.
use std::{
    fs,
    io::{Read, Write},
    net::TcpStream,
    path::PathBuf,
    process::{Command, Stdio},
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};

static COUNTER: AtomicUsize = AtomicUsize::new(0);
/// Evita que dos fixtures elijan el mismo puerto libre al crearlos en paralelo.
static PORT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

struct Fixture {
    root: PathBuf,
    child: std::process::Child,
    port: u16,
}

impl Fixture {
    fn new() -> Self {
        let _port_guard = PORT_LOCK.lock().unwrap();
        let root = std::env::temp_dir().join(format!(
            "markvi-api-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("index.md"), "# indice\n").unwrap();
        fs::write(root.join("config.toml"), "theme = 'dark'\n").unwrap();
        fs::write(root.join("note with space.md"), "# espacio\n").unwrap();

        let port = {
            let socket = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = socket.local_addr().unwrap().port();
            drop(socket);
            port
        };
        let binary = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/debug/markvi");
        let child = Command::new(binary)
            .arg(&root)
            .arg("--port")
            .arg(port.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if TcpStream::connect(("127.0.0.1", port)).is_ok() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Self { root, child, port }
    }

    fn wait_exit(&mut self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if let Ok(Some(_)) = self.child.try_wait() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    fn request(&self, request: impl AsRef<str>) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", self.port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        write!(stream, "{}", request.as_ref()).unwrap();
        let mut answer = String::new();
        let _ = stream.read_to_string(&mut answer);
        answer
    }

    /// Devuelve (cabeceras, cuerpo) sin pasar el cuerpo por UTF-8.
    fn request_bytes(&self, path: &str) -> (String, Vec<u8>) {
        let mut stream = TcpStream::connect(("127.0.0.1", self.port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        write!(
            stream,
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
            self.port
        )
        .unwrap();
        let mut answer = Vec::new();
        let _ = stream.read_to_end(&mut answer);
        let split = answer
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .expect("respuesta HTTP sin fin de cabeceras");
        (
            String::from_utf8_lossy(&answer[..split]).into_owned(),
            answer[split + 4..].to_vec(),
        )
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn archivo_no_utf8_es_lossy_en_get_put_ifmatch_y_busqueda() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("nota.md"), b"palabra \xE9\n").unwrap();

    let get = fixture.request(
        "GET /api/file?path=nota.md HTTP/1.1\r\nHost: 127.0.0.1:PORT\r\nConnection: close\r\n\r\n"
            .replace("PORT", &fixture.port.to_string()),
    );
    assert!(get.contains("200 OK"), "{get:?}");
    let etag = get
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .starts_with("etag:")
                .then(|| line.split_once(':').unwrap().1.trim().to_string())
        })
        .expect("GET sin ETag");

    let search = fixture.request(
        "GET /api/search?q=palabra HTTP/1.1\r\nHost: 127.0.0.1:PORT\r\nConnection: close\r\n\r\n"
            .replace("PORT", &fixture.port.to_string()),
    );
    assert!(
        search.contains("nota.md"),
        "la búsqueda omitió el archivo: {search:?}"
    );

    let put = fixture.request(
        format!(
            "PUT /api/file?path=nota.md HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nIf-Match: {etag}\r\nContent-Length: 5\r\nConnection: close\r\n\r\nnuevo",
            fixture.port
        ),
    );
    assert!(
        put.contains("204 No Content"),
        "PUT If-Match falló: {put:?}"
    );
}

#[test]
fn files_sirve_binarios_byte_a_byte_y_markdown_sigue_intacto() {
    let fixture = Fixture::new();
    let png = [0x89, 0xFF, 0x00, 0x02, 0xC3, 0x28];
    fs::write(fixture.root.join("blob.png"), png).unwrap();

    let (headers, body) = fixture.request_bytes("/files/blob.png");
    assert!(headers.contains("200 OK"), "{headers:?}");
    assert_eq!(body, png, "el PNG salió corrupto");
    assert!(
        headers.to_lowercase().contains("content-type: image/png"),
        "{headers:?}"
    );
    assert!(
        headers
            .to_lowercase()
            .contains("content-security-policy: sandbox"),
        "{headers:?}"
    );
    assert!(
        headers
            .to_lowercase()
            .contains("x-content-type-options: nosniff"),
        "{headers:?}"
    );

    let (_, md) = fixture.request_bytes("/files/index.md");
    assert_eq!(md, b"# indice\n");
}

#[test]
fn backlinks_responde_200_con_enlace_porcentaje_multibyte() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("source.md"), "[x](%aé.md)\n").unwrap();
    let answer = fixture.request(
        "GET /api/backlinks?path=index.md HTTP/1.1\r\nHost: 127.0.0.1:PORT\r\nConnection: close\r\n\r\n"
            .replace("PORT", &fixture.port.to_string()),
    );
    assert!(
        answer.contains("200 OK"),
        "respuesta inesperada: {answer:?}"
    );
}

#[test]
fn rejects_delete_of_non_markdown_files() {
    let fixture = Fixture::new();
    let answer = fixture.request(
        "DELETE /api/file?path=config.toml HTTP/1.1\r\nHost: 127.0.0.1:PORT\r\nConnection: close\r\n\r\n"
            .replace("PORT", &fixture.port.to_string()),
    );
    assert!(answer.contains("400 Bad Request"), "{answer:?}");
    assert!(
        answer.contains("Only .md files are supported."),
        "{answer:?}"
    );
    assert!(fixture.root.join("config.toml").exists());
}

#[test]
fn invalid_percent_escape_and_plus_in_query() {
    let fixture = Fixture::new();
    let bad = fixture.request(
        "GET /files/%ZZ.md HTTP/1.1\r\nHost: 127.0.0.1:PORT\r\nConnection: close\r\n\r\n"
            .replace("PORT", &fixture.port.to_string()),
    );
    assert!(bad.contains("400 Bad Request"), "{bad:?}");

    let plus = fixture.request(
        "GET /api/file?path=note+with+space.md HTTP/1.1\r\nHost: 127.0.0.1:PORT\r\nConnection: close\r\n\r\n"
            .replace("PORT", &fixture.port.to_string()),
    );
    assert!(plus.contains("200 OK"), "{plus:?}");

    let method = fixture.request(
        "POST /files/index.md HTTP/1.1\r\nHost: 127.0.0.1:PORT\r\nConnection: close\r\n\r\n"
            .replace("PORT", &fixture.port.to_string()),
    );
    assert!(
        method.contains("404 Not Found") && !method.to_lowercase().contains("allow:"),
        "{method:?}"
    );
}

#[test]
fn conflicting_if_match_writes_have_one_winner() {
    let fixture = Fixture::new();
    let current = fixture.request(
        "GET /api/file?path=index.md HTTP/1.1\r\nHost: 127.0.0.1:PORT\r\nConnection: close\r\n\r\n"
            .replace("PORT", &fixture.port.to_string()),
    );
    let etag = current
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("etag")
                .then(|| value.trim().to_string())
        })
        .expect("ETag en GET /api/file");

    // Se envían todas las peticiones antes de leerlas para que el servidor las
    // procese en paralelo sobre el mismo archivo y con el mismo ETag.
    let mut streams = Vec::new();
    for i in 0..20 {
        let mut stream = TcpStream::connect(("127.0.0.1", fixture.port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let body = format!("escritor {i}\n");
        write!(
            stream,
            "PUT /api/file?path=index.md HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nIf-Match: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            fixture.port,
            etag,
            body.len(),
            body
        )
        .unwrap();
        streams.push(stream);
    }
    let mut statuses = Vec::new();
    for mut stream in streams {
        let mut answer = String::new();
        stream.read_to_string(&mut answer).unwrap();
        let status = answer.lines().next().unwrap_or("").to_string();
        statuses.push(status);
    }
    let ok = statuses
        .iter()
        .filter(|s| s.contains("204 No Content"))
        .count();
    let conflicts = statuses
        .iter()
        .filter(|s| s.contains("409 Conflict"))
        .count();
    assert_eq!(ok, 1, "debe ganar una sola escritura: {statuses:?}");
    assert_eq!(conflicts, 19, "el resto debe recibir 409: {statuses:?}");
}

#[test]
fn sigterm_closes_server_with_sse_client_open() {
    let mut fixture = Fixture::new();
    let mut stream = TcpStream::connect(("127.0.0.1", fixture.port)).unwrap();
    write!(
        stream,
        "GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n",
        fixture.port
    )
    .unwrap();
    let status = Command::new("kill")
        .args(["-TERM", &fixture.child.id().to_string()])
        .status()
        .unwrap();
    assert!(status.success());
    let exited = fixture.wait_exit(Duration::from_secs(5));
    let _ = stream.shutdown(std::net::Shutdown::Both);
    assert!(exited, "el servidor no cerró con un cliente SSE abierto");
}
