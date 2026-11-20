#!/usr/bin/env python3
"""Replay the versioned case catalog against the original Bun server.

Every case runs against a fresh copy of example/ in a temporary directory.
The real example/ is only ever read. Output: baseline.json next to this file.
"""
import http.client
import os
import shlex
import json
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
SERVER_CMD = os.environ.get("MARKVI_SERVER_CMD", "bun run server.ts {root} --port {port}")
WATCHER_CMD = os.environ.get("MARKVI_WATCHER_CMD", "bun rust/recording/watcher_probe.ts {root}")
OUTPUT = Path(os.environ.get("MARKVI_BASELINE_OUT", str(HERE / "baseline.json")))
ROOT = HERE.parents[1]
CATALOG = json.loads((HERE / "cases.json").read_text())
HOST = "127.0.0.1"


def free_port():
    with socket.socket() as s:
        s.bind((HOST, 0))
        return s.getsockname()[1]


def make_pristine(base):
    pristine = base / "pristine"
    shutil.copytree(ROOT / "example", pristine)
    (pristine / "img.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg"></svg>\n')
    (pristine / "nota.txt").write_text("texto\n")
    (pristine / ".git").mkdir()
    (pristine / ".git" / "hidden.md").write_text("# oculto\n")
    (pristine / "enlace.md").symlink_to("index.md")
    (pristine / "solo-lectura.md").write_text("original")
    (base / "outside.md").write_text("# fuera\n")
    return pristine


def materialize(pristine, work, before):
    if work.exists():
        shutil.rmtree(work)
    shutil.copytree(pristine, work, symlinks=True)
    (work / "enlace-fuera.md").symlink_to("../outside.md")
    for rel, spec in (before or {}).items():
        p = work / rel
        if "mode" in spec:
            mode = spec["mode"]
            p.chmod(int(mode, 8) if isinstance(mode, str) else mode)


def start_server(work, port, log):
    cmd = shlex.split(SERVER_CMD.format(root=str(work), port=port))
    proc = subprocess.Popen(cmd, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
    deadline = time.time() + 30
    while time.time() < deadline:
        try:
            socket.create_connection((HOST, port), 0.2).close()
            return proc
        except OSError:
            if proc.poll() is not None:
                raise RuntimeError(f"server exited: {log.read_text()[-500:]}")
            time.sleep(0.1)
    proc.terminate()
    raise RuntimeError("server did not listen within 30s")


def stop_server(proc):
    if proc.poll() is None:
        proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)


def open_request(port, method, path, headers, body):
    conn = http.client.HTTPConnection(HOST, port, timeout=15)
    all_headers = {"Host": f"{HOST}:{port}"}
    all_headers.update(headers or {})
    conn.putrequest(method, path, skip_host=True)
    for k, v in all_headers.items():
        conn.putheader(k, v)
    data = body.encode() if isinstance(body, str) else body
    if data is not None:
        conn.putheader("Content-Length", str(len(data)))
    conn.endheaders(data)
    return conn, conn.getresponse()


def send(port, method, path, headers, body):
    conn, resp = open_request(port, method, path, headers, body)
    raw = resp.read()
    out = {
        "status": resp.status,
        "headers": {k.lower(): v for k, v in resp.getheaders()},
        "body": raw.decode("utf-8", "replace"),
    }
    conn.close()
    return out


def etag_of(obs):
    return obs["headers"].get("etag")


def fs_state(work, spec):
    out = {}
    for rel, expected in spec.items():
        p = work / rel
        value = {}
        if "absent" in expected:
            value["absent"] = not (p.exists() or p.is_symlink())
        if "content" in expected:
            value["content"] = p.read_text() if p.exists() else None
        if "content_from" in expected:
            value["content"] = p.read_text() if p.exists() else None
        if "symlink_target" in expected:
            value["symlink_target"] = os.readlink(p) if p.is_symlink() else None
        if "mode" in expected:
            value["mode"] = oct(stat.S_IMODE(p.stat().st_mode))
        out[rel] = value
    return out


def dotted(obj, path):
    for part in path.split("."):
        if isinstance(obj, list) and part.isdigit():
            index = int(part)
            if index >= len(obj):
                return (False, None)
            obj = obj[index]
        elif isinstance(obj, dict) and part in obj:
            obj = obj[part]
        else:
            return (False, None)
    return (True, obj)


def check(obs, exp, work):
    failures = []
    if "status" in exp and obs["status"] != exp["status"]:
        failures.append(f"status: got {obs['status']}, want {exp['status']}")
    for k, v in exp.get("headers", {}).items():
        got = obs["headers"].get(k.lower())
        if got != v:
            failures.append(f"header {k}: got {got!r}, want {v!r}")
    body = obs["body"]
    if "body_exact" in exp and body != exp["body_exact"]:
        failures.append("body_exact mismatch")
    for needle in exp.get("body_contains", []):
        if needle not in body:
            failures.append(f"body lacks {needle!r}")
    if exp.get("etag_pattern") and not re.fullmatch(r'"[0-9a-f]+"', etag_of(obs) or ""):
        failures.append(f"etag pattern: {etag_of(obs)!r}")
    if "content_from" in exp:
        want = (ROOT / exp["content_from"]).read_text()
        if body != want:
            failures.append("content_from mismatch")
    parsed = None
    if any(k in exp for k in ("json_exact", "json_fields", "json_contains")):
        try:
            parsed = json.loads(body)
        except ValueError:
            failures.append("body is not JSON")
    if "json_exact" in exp and parsed != exp["json_exact"]:
        failures.append("json_exact mismatch")
    for path, want in exp.get("json_fields", {}).items():
        found, got = dotted(parsed, path)
        if not found or got != want:
            failures.append(f"json {path}: got {got!r}, want {want!r}")
    for needle in exp.get("json_contains", []):
        if needle not in body:
            failures.append(f"json lacks {needle!r}")
    if "fs_after" in exp:
        actual = fs_state(work, exp["fs_after"])
        for rel, want in exp["fs_after"].items():
            for key, expected in want.items():
                got = actual[rel].get(key)
                if key == "content_from":
                    expected = (ROOT / expected).read_text()
                    got = actual[rel].get("content")
                    key = "content"
                if got != expected:
                    failures.append(f"fs {rel} {key}: got {got!r}, want {expected!r}")
    return failures


def run_sse(work, port, log, exp):
    out = {"events": [], "heartbeat": False, "reconnect": False}
    writer = threading.Thread(target=lambda: (time.sleep(0.4), (work / "evento.md").write_text("# evento\n")))
    writer.start()
    conn, resp = open_request(port, "GET", "/api/events", {}, None)
    out["status"] = resp.status
    out["headers"] = {k.lower(): v for k, v in resp.getheaders()}
    conn.sock.settimeout(6)
    start = time.monotonic()
    try:
        while time.monotonic() - start < 8:
            line = resp.readline()
            if not line:
                break
            text = line.decode("utf-8", "replace").strip()
            if text:
                out["events"].append(text)
            if text.startswith("data:") and exp.get("change_event", "") in text:
                break
    except (socket.timeout, OSError):
        pass
    conn.sock.settimeout(30)
    start = time.monotonic()
    while time.monotonic() - start < 28:
        try:
            line = resp.readline()
        except (socket.timeout, OSError):
            break
        if not line:
            break
        text = line.decode("utf-8", "replace").strip()
        if text:
            out["events"].append(text)
        if text == ": ping":
            out["heartbeat"] = True
            break
    conn.close()
    writer.join(timeout=2)
    if exp.get("reconnect"):
        try:
            # Bun does not flush the SSE response headers until the first event
            # (or the 25 s heartbeat), so trigger one on the new connection.
            writer2 = threading.Thread(
                target=lambda: (time.sleep(0.4), (work / "reconnect.md").write_text("# reconexion\n"))
            )
            writer2.start()
            conn2, resp2 = open_request(port, "GET", "/api/events", {}, None)
            writer2.join(timeout=2)
            raw_headers = dict(resp2.getheaders())
            detail = {
                "status": resp2.status,
                "headers": {k.lower(): v for k, v in raw_headers.items()},
                "raw_headers": raw_headers,
            }
            out["reconnect_detail"] = detail
            out["reconnect"] = (
                detail["status"] == 200
                and detail["headers"].get("content-type") == "text/event-stream"
            )
            conn2.close()
        except OSError as exc:
            out["reconnect_detail"] = str(exc)
    failures = []
    if out["status"] != exp.get("status"):
        failures.append(f"status: {out['status']}")
    for k, v in exp.get("headers", {}).items():
        if out["headers"].get(k.lower()) != v:
            failures.append(f"header {k}")
    if not any(exp.get("change_event", "") in e and '"type":"change"' in e for e in out["events"]):
        failures.append("no change event")
    if exp.get("heartbeat") and not out["heartbeat"]:
        failures.append("no heartbeat")
    if exp.get("reconnect") and not out["reconnect"]:
        failures.append("reconnect failed")
    out["failures"] = failures
    out["raw_events"] = out.pop("events")
    return out


def run_watcher(work, exp):
    proc = subprocess.run(
        shlex.split(WATCHER_CMD.format(root=str(work))),
        cwd=ROOT, capture_output=True, text=True, timeout=20,
    )
    events = []
    for line in proc.stdout.splitlines():
        try:
            value = json.loads(line)
            if isinstance(value, list):
                events = value
        except ValueError:
            continue
    failures = []
    for want in exp.get("events_contain", []):
        if want not in events:
            failures.append(f"missing event {want}")
    # fs.watch emits the same events in different orders across runs (rename vs
    # reconcile race). Order is noise here, so the recorded list is sorted.
    return {"events": sorted(events, key=lambda e: (e["path"], e["type"])), "stderr": proc.stderr[-500:], "returncode": proc.returncode, "failures": failures}


def main():
    cases = CATALOG["cases"]
    only = sys.argv[1:]
    with tempfile.TemporaryDirectory(prefix="markvi-baseline-") as tmp:
        base = Path(tmp)
        pristine = make_pristine(base)
        work = base / "work"
        results = []
        for case in cases:
            if only and case["id"] not in only:
                continue
            port = free_port()
            materialize(pristine, work, case.get("fs_before"))
            with open(base / "server.log", "ab") as log:
                proc = start_server(work, port, log)
                try:
                    if case.get("kind") == "sse":
                        result = run_sse(work, port, log, case["expect"])
                    elif case.get("kind") == "watcher":
                        result = run_watcher(work, case["expect"])
                    else:
                        steps = case.get("steps") or [case]
                        result = {"responses": []}
                        last = None
                        prev = {}
                        for step in steps:
                            headers = dict(step.get("headers") or {})
                            for k, v in headers.items():
                                if isinstance(v, str) and v.startswith("${etag}"):
                                    headers[k] = prev.get("etag", v)
                            last = send(port, step["method"], step["path"], headers, step.get("body"))
                            result["responses"].append(last)
                            prev = {"etag": etag_of(last)}
                        result["observed"] = last
                        result["failures"] = check(last, case["expect"], work)
                        if "fs_after" in case["expect"]:
                            result["fs_after"] = fs_state(work, case["expect"]["fs_after"])
                finally:
                    stop_server(proc)
            results.append({
                "id": case["id"],
                "group": case["group"],
                "method": case.get("method") or [s["method"] for s in case.get("steps", [])],
                "path": case.get("path") or [s["path"] for s in case.get("steps", [])],
                "expect": case["expect"],
                "result": result,
                "failures": result.get("failures", []),
            })
            status = "PASS" if not result.get("failures") else "FAIL"
            print(f"{status} {case['id']}", flush=True)
    payload = {
        "schema": "markvi-baseline@1",
        "generated_by": "rust/recording/record.py",
        "catalog": "rust/recording/cases.json",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "versions": {"bun": subprocess.run(["bun", "--version"], capture_output=True, text=True).stdout.strip()},
        "fixture_source": "example (copied; never written)",
        "cases": results,
        "passed": sum(1 for r in results if not r["failures"]),
        "total": len(results),
    }
    OUTPUT.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
    print(f"\n{payload['passed']}/{payload['total']} cases passed -> {OUTPUT}")
    return 0 if payload["passed"] == payload["total"] else 1


if __name__ == "__main__":
    sys.exit(main())
