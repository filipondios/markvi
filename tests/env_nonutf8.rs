//! El binario arranca aunque alguna variable de entorno no sea UTF-8.
#[cfg(unix)]
#[test]
fn arranca_con_variable_de_entorno_no_utf8() {
    use std::{
        ffi::OsStr,
        io::{BufRead, BufReader},
        os::unix::ffi::OsStrExt,
        process::{Command, Stdio},
    };
    let root = std::env::temp_dir().join(format!("markvi-env-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let port = {
        let socket = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        socket.local_addr().unwrap().port()
    };
    let mut child = Command::new(env!("CARGO_BIN_EXE_markvi"))
        .arg(&root)
        .arg("--port")
        .arg(port.to_string())
        .env("BAD", OsStr::from_bytes(b"\xff\xfe"))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut first = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut first)
        .unwrap();
    let _ = child.kill();
    let status = child.wait().unwrap();
    let _ = std::fs::remove_dir_all(&root);
    assert!(
        first.starts_with("markvi serving"),
        "salida inesperada: {first:?} ({status})"
    );
}
