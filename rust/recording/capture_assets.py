#!/usr/bin/env python3
"""Freeze the static output Bun serves into rust/assets/ + manifest.json.

Read-only against example/. Run from the repository root.
"""
import http.client
import json
import re
import shutil
import socket
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parents[1] / "assets"
HOST = "127.0.0.1"


def free_port():
    with socket.socket() as s:
        s.bind((HOST, 0))
        return s.getsockname()[1]


def get(port, path):
    conn = http.client.HTTPConnection(HOST, port, timeout=30)
    conn.request("GET", path, headers={"Host": f"{HOST}:{port}"})
    resp = conn.getresponse()
    body = resp.read()
    out = {
        "status": resp.status,
        "headers": {k.lower(): v for k, v in resp.getheaders()},
        "body": body,
    }
    conn.close()
    return out


def main():
    port = free_port()
    with tempfile.TemporaryDirectory(prefix="markvi-assets-") as tmp:
        log = open(Path(tmp) / "server.log", "wb")
        proc = subprocess.Popen(
            ["bun", "run", "server.ts", str(ROOT / "example"), "--port", str(port)],
            cwd=ROOT, stdout=log, stderr=subprocess.STDOUT,
        )
        try:
            for _ in range(100):
                try:
                    socket.create_connection((HOST, port), 0.2).close()
                    break
                except OSError:
                    if proc.poll() is not None:
                        raise RuntimeError("Bun server exited before listening")
                    time.sleep(0.1)
            index = get(port, "/")
            if index["status"] != 200:
                raise RuntimeError(f"GET / -> {index['status']}")
            refs = []
            for path in re.findall(r'(?:src|href)="(/[^"]+)"', index["body"].decode()):
                if path != "/" and path not in refs:
                    refs.append(path)
            if OUT.exists():
                shutil.rmtree(OUT)
            OUT.mkdir(parents=True)
            (OUT / "index.html").write_bytes(index["body"])
            manifest = {
                "schema": "markvi-static-manifest@1",
                "captured_from": "bun run server.ts ./example",
                "index": {
                    "file": "index.html",
                    "content_type": index["headers"]["content-type"],
                    "cache_control": index["headers"]["cache-control"],
                    "etag": index["headers"].get("etag"),
                },
                "assets": {},
                "fallback": {"status": 404, "body": "Not found"},
            }
            for path in refs:
                resp = get(port, path)
                if resp["status"] != 200:
                    raise RuntimeError(f"GET {path} -> {resp['status']}")
                name = path.rsplit("/", 1)[-1]
                (OUT / name).write_bytes(resp["body"])
                manifest["assets"][path] = {
                    "file": name,
                    "content_type": resp["headers"]["content-type"],
                    "cache_control": resp["headers"]["cache-control"],
                    "etag": resp["headers"].get("etag"),
                }
            (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
            print(f"captured {len(refs)} assets + index.html into {OUT}")
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)
            log.close()


if __name__ == "__main__":
    main()
