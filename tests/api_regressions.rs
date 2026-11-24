//! HTTP API regressions against temporary copies of the notes directory.
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
/// Serializes fixture creation so parallel tests cannot pick the same free port.
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

    /// Returns headers and body without decoding the body as UTF-8.
    fn request_bytes(&self, path: &str) -> (String, Vec<u8>) {
        self.request_response(format!(
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
            self.port
        ))
    }

    fn request_response(&self, request: impl AsRef<str>) -> (String, Vec<u8>) {
        let mut stream = TcpStream::connect(("127.0.0.1", self.port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        write!(stream, "{}", request.as_ref()).unwrap();
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
fn guard_y_fallback_no_cambian_con_el_middleware() {
    let fixture = Fixture::new();
    let bad_host = fixture
        .request("GET /api/tree HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n");
    assert!(bad_host.contains("403 Forbidden"), "{bad_host:?}");
    assert!(bad_host.contains("Host not allowed."), "{bad_host:?}");

    let bad_origin = fixture.request(
        "POST /api/file?path=index.md HTTP/1.1\r\nHost: 127.0.0.1:PORT\r\nOrigin: http://evil.example\r\nContent-Length: 1\r\nConnection: close\r\n\r\nx"
            .replace("PORT", &fixture.port.to_string()),
    );
    assert!(bad_origin.contains("403 Forbidden"), "{bad_origin:?}");
    assert!(bad_origin.contains("Origin not allowed."), "{bad_origin:?}");

    let fallback = fixture.request(
        "POST /no-existe HTTP/1.1\r\nHost: 127.0.0.1:PORT\r\nConnection: close\r\n\r\n"
            .replace("PORT", &fixture.port.to_string()),
    );
    assert!(fallback.contains("404 Not Found"), "{fallback:?}");
    assert!(!fallback.to_lowercase().contains("allow:"), "{fallback:?}");
}

#[test]
fn move_por_http_mueve_y_rechaza_destino_existente() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("origen.md"), "contenido").unwrap();
    let body = r#"{"from":"origen.md","to":"destino.md"}"#;
    let answer = fixture.request(format!(
        "POST /api/move HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        fixture.port,
        body.len()
    ));
    assert!(answer.contains("204 No Content"), "{answer:?}");
    assert_eq!(
        fs::read_to_string(fixture.root.join("destino.md")).unwrap(),
        "contenido"
    );
    assert!(!fixture.root.join("origen.md").exists());

    let body = r#"{"from":"index.md","to":"destino.md"}"#;
    let answer = fixture.request(format!(
        "POST /api/move HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        fixture.port,
        body.len()
    ));
    assert!(answer.contains("409 Conflict"), "{answer:?}");
    assert_eq!(
        fs::read_to_string(fixture.root.join("destino.md")).unwrap(),
        "contenido"
    );
    assert!(fixture.root.join("index.md").exists());
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
            "PUT /api/file?path=nota.md&force=1 HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nIf-Match: {etag}\r\nContent-Length: 5\r\nConnection: close\r\n\r\nnuevo",
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
fn cuerpo_mayor_que_16mib_da_413() {
    let fixture = Fixture::new();
    let body = "x".repeat(16 * 1024 * 1024 + 1);
    let answer = fixture.request(format!(
        "PUT /api/file?path=index.md HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        fixture.port,
        body.len()
    ));
    assert!(answer.contains("413"), "{answer:?}");
    assert_eq!(
        fs::read_to_string(fixture.root.join("index.md")).unwrap(),
        "# indice\n"
    );
}

#[test]
fn multimedia_sirve_range_y_head_con_cabeceras_de_seguridad() {
    let fixture = Fixture::new();
    let bytes: Vec<u8> = (0..100).collect();
    fs::write(fixture.root.join("video.mp4"), &bytes).unwrap();

    let request = format!(
        "GET /files/video.mp4 HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nRange: bytes=0-9\r\nConnection: close\r\n\r\n",
        fixture.port
    );
    let (headers, body) = fixture.request_response(request);
    assert!(headers.contains("206"), "{headers:?}");
    assert!(
        headers.to_lowercase().contains("content-type: video/mp4"),
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
    assert_eq!(body, bytes[..10]);

    let request = format!(
        "HEAD /files/video.mp4 HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
        fixture.port
    );
    let (headers, body) = fixture.request_response(request);
    assert!(headers.contains("200 OK"), "{headers:?}");
    assert!(
        headers.to_lowercase().contains("content-type: video/mp4"),
        "{headers:?}"
    );
    assert!(body.is_empty());
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

    // Send every request before reading responses so the server handles them
    // concurrently on the same file with the same ETag.
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

fn get_request(fixture: &Fixture, path: &str) -> String {
    fixture.request(format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
        fixture.port
    ))
}

#[test]
fn mas_codificado_se_conserva_en_query() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("c++ notes.md"), "# cpp\n").unwrap();
    fs::write(fixture.root.join("a b.md"), "# ab\n").unwrap();
    fs::write(fixture.root.join("otra.md"), "solo c++ aqui\n").unwrap();

    let get = get_request(&fixture, "/api/file?path=c%2B%2B%20notes.md");
    assert!(get.contains("200 OK"), "{get:?}");

    let plus = get_request(&fixture, "/api/file?path=a+b.md");
    assert!(plus.contains("200 OK"), "{plus:?}");

    let search = get_request(&fixture, "/api/search?q=c%2B%2B");
    assert!(search.contains("otra.md"), "{search:?}");

    // A badly encoded unrelated parameter does not affect the requested one...
    let other = get_request(&fixture, "/api/file?x=%zz&path=index.md");
    assert!(other.contains("200 OK"), "{other:?}");
    // ...but an invalid parameter of interest still yields 400.
    let bad = get_request(&fixture, "/api/file?path=%zz");
    assert!(bad.contains("400 Bad Request"), "{bad:?}");
}

#[test]
fn guardar_no_utf8_exige_force_y_no_toca_el_disco() {
    let fixture = Fixture::new();
    let original = b"palabra \xE9\n";
    fs::write(fixture.root.join("latin.md"), original).unwrap();
    let put = |query: &str| {
        fixture.request(format!(
            "PUT /api/file?path=latin.md{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Length: 5\r\nConnection: close\r\n\r\nnuevo",
            fixture.port
        ))
    };

    let denied = put("");
    assert!(denied.contains("409"), "{denied:?}");
    assert!(denied.contains("not-utf8"), "{denied:?}");
    assert_eq!(fs::read(fixture.root.join("latin.md")).unwrap(), original);

    let get = get_request(&fixture, "/api/file?path=latin.md");
    assert!(get.contains("200 OK"), "{get:?}");
    assert!(get.to_lowercase().contains("x-markvi-lossy: 1"), "{get:?}");

    let forced = put("&force=1");
    assert!(forced.contains("204"), "{forced:?}");
    assert_eq!(fs::read(fixture.root.join("latin.md")).unwrap(), b"nuevo");

    // Valid UTF-8: no lossy header and no forced save.
    let ok = fixture.request(format!(
        "PUT /api/file?path=index.md HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi",
        fixture.port
    ));
    assert!(ok.contains("204"), "{ok:?}");
    let get = get_request(&fixture, "/api/file?path=index.md");
    assert!(!get.to_lowercase().contains("x-markvi-lossy"), "{get:?}");
}

#[test]
fn files_sirve_range_head_y_cabeceras_para_cualquier_tipo() {
    let fixture = Fixture::new();
    let bytes: Vec<u8> = (0..100).collect();
    fs::write(fixture.root.join("clip.mov"), &bytes).unwrap();
    fs::write(fixture.root.join("img.png"), &bytes).unwrap();

    for name in ["clip.mov", "img.png"] {
        let (headers, body) = fixture.request_response(format!(
            "GET /files/{name} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nRange: bytes=0-9\r\nConnection: close\r\n\r\n",
            fixture.port
        ));
        let lower = headers.to_lowercase();
        assert!(headers.contains("206"), "{name}: {headers:?}");
        assert!(
            lower.contains("content-range: bytes 0-9/100"),
            "{headers:?}"
        );
        assert!(
            lower.contains("content-security-policy: sandbox"),
            "{headers:?}"
        );
        assert!(
            lower.contains("x-content-type-options: nosniff"),
            "{headers:?}"
        );
        assert!(lower.contains("cache-control: no-store"), "{headers:?}");
        assert_eq!(body, bytes[..10], "{name}");

        let (headers, body) = fixture.request_response(format!(
            "HEAD /files/{name} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
            fixture.port
        ));
        assert!(headers.contains("200 OK"), "{name}: {headers:?}");
        assert!(body.is_empty());
    }
    let (headers, body) = fixture.request_bytes("/files/img.png");
    assert!(
        headers.to_lowercase().contains("content-type: image/png"),
        "{headers:?}"
    );
    assert_eq!(body, bytes);
    let (headers, _) = fixture.request_bytes("/files/index.md");
    assert!(
        headers
            .to_lowercase()
            .contains("content-type: text/markdown"),
        "{headers:?}"
    );
}

#[test]
fn put_create_sobre_archivo_existente_da_409_y_no_lo_pisa() {
    let fixture = Fixture::new();
    let put = |path: &str, query: &str| {
        fixture.request(format!(
            "PUT /api/file?path={path}{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Length: 5\r\nConnection: close\r\n\r\nnuevo",
            fixture.port
        ))
    };
    let existing = put("index.md", "&create=1");
    assert!(existing.contains("409"), "{existing:?}");
    assert_eq!(
        fs::read_to_string(fixture.root.join("index.md")).unwrap(),
        "# indice\n"
    );

    let created = put("fresco.md", "&create=1");
    assert!(created.contains("204"), "{created:?}");
    assert_eq!(
        fs::read_to_string(fixture.root.join("fresco.md")).unwrap(),
        "nuevo"
    );
}

#[test]
fn estaticos_responden_304_con_if_none_match() {
    let fixture = Fixture::new();
    let first = get_request(&fixture, "/");
    assert!(first.contains("200 OK"), "{first:?}");
    let etag = first
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .starts_with("etag:")
                .then(|| line.split_once(':').unwrap().1.trim().to_string())
        })
        .expect("index sin ETag");
    let conditional = |etag: &str| {
        fixture.request(format!(
            "GET / HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nIf-None-Match: {etag}\r\nConnection: close\r\n\r\n",
            fixture.port
        ))
    };
    let cached = conditional(&etag);
    assert!(cached.contains("304 Not Modified"), "{cached:?}");
    assert!(
        cached.to_lowercase().contains("cache-control:"),
        "{cached:?}"
    );
    assert!(!cached.contains("<!doctype"), "304 con cuerpo");
    let other = conditional("\"otro\"");
    assert!(other.contains("200 OK"), "{other:?}");
    let weak = conditional(&format!("W/{etag}, \"x\""));
    assert!(weak.contains("304"), "{weak:?}");
}

/// Sends a request with a binary body and returns the response as text.
fn send_with_body(fixture: &Fixture, head: &str, body: &[u8]) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", fixture.port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    write!(
        stream,
        "{head} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        fixture.port,
        body.len()
    )
    .unwrap();
    stream.write_all(body).unwrap();
    let mut answer = Vec::new();
    let _ = stream.read_to_end(&mut answer);
    String::from_utf8_lossy(&answer).into_owned()
}

#[test]
fn cuerpo_no_utf8_da_400_y_no_toca_el_disco() {
    let fixture = Fixture::new();
    let original = fs::read(fixture.root.join("index.md")).unwrap();

    let put = send_with_body(&fixture, "PUT /api/file?path=index.md", b"hola \xff\xfe");
    assert!(put.contains("400"), "{put:?}");
    assert!(put.contains("not valid UTF-8"), "{put:?}");
    assert_eq!(fs::read(fixture.root.join("index.md")).unwrap(), original);

    let post = send_with_body(&fixture, "POST /api/file?path=nuevo.md", b"\xff");
    assert!(post.contains("400"), "{post:?}");
    assert!(!fixture.root.join("nuevo.md").exists());
}
