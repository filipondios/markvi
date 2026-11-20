#!/usr/bin/env python3
"""Compare the Rust static smoke server against the original Bun server.

Run from the repository root after `cargo build --manifest-path rust/Cargo.toml`.
Starts both servers on free ports; reads the paths from rust/assets/manifest.json.
"""
import hashlib
import http.client
import json
import socket
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HOST = "127.0.0.1"


def free_port():
    with socket.socket() as s:
        s.bind((HOST, 0))
        return s.getsockname()[1]


def get(port, path):
    conn = http.client.HTTPConnection(HOST, port, timeout=15)
    conn.request("GET", path, headers={"Host": f"{HOST}:{port}"})
    resp = conn.getresponse()
    body = resp.read()
    headers = {k.lower(): v for k, v in resp.getheaders()}
    for volatile in ("date", "server", "connection", "content-length", "transfer-encoding"):
        headers.pop(volatile, None)
    conn.close()
    return {
        "status": resp.status,
        "headers": headers,
        "sha256_16": hashlib.sha256(body).hexdigest()[:16],
        "bytes": len(body),
    }


def wait_ready(port):
    for _ in range(100):
        try:
            socket.create_connection((HOST, port), 0.2).close()
            return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError(f"port {port} never listened")


def main():
    manifest = json.loads((ROOT / "rust/assets/manifest.json").read_text())
    ports = (free_port(), free_port())
    rust = subprocess.Popen(
        [str(ROOT / "rust/target/debug/markvi"), "--port", str(ports[0])],
        cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
    )
    with tempfile.TemporaryDirectory(prefix="markvi-smoke-") as tmp:
        log = open(Path(tmp) / "bun.log", "wb")
        bun = subprocess.Popen(
            ["bun", "run", "server.ts", "example", "--port", str(ports[1])],
            cwd=ROOT, stdout=log, stderr=subprocess.STDOUT,
        )
        try:
            for port in ports:
                wait_ready(port)
            paths = ["/", "/view/index.md", *manifest["assets"].keys(), "/no-existe"]
            matched = 0
            for path in paths:
                original = get(ports[1], path)
                ported = get(ports[0], path)
                same = original == ported
                matched += same
                print(("OK  " if same else "DIFF"), path)
                if not same:
                    print("  rust:", ported)
                    print("  bun :", original)
            print(f"{matched}/{len(paths)} responses identical")
            return 0 if matched == len(paths) else 1
        finally:
            bun.terminate()
            try:
                bun.wait(timeout=5)
            except subprocess.TimeoutExpired:
                bun.kill()
                bun.wait(timeout=5)
            log.close()
            rust.terminate()
            rust.wait(timeout=5)


if __name__ == "__main__":
    raise SystemExit(main())
