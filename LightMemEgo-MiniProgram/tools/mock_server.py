#!/usr/bin/env python3
"""
LightMem-Ego 小程序联调用后端（可选工具，不是产品服务端）。

它实现的是原 Android 客户端使用的同一套 HTTP 接口，用来在没有真实后端时
把「建会话 → 上传帧/音频 → 状态轮询 → 提问 → 拿回答 → 结束」整条链路跑通，
并顺便打印每个 multipart 请求的字段名，方便核对接口契约。

    python3 tools/mock_server.py --port 8123

然后在小程序「设置」里把 API Base URL 填成:
    http://127.0.0.1:8123/api        (开发者工具模拟器)
    http://<电脑局域网IP>:8123/api    (真机预览，需与电脑同一 Wi-Fi)

正式发布必须换成已备案的 HTTPS 域名，详见 README。
"""
import argparse
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

STATE = {"frames": 0, "audio": 0, "tasks": {}, "task_seq": 0, "questions": []}
LOCK = threading.Lock()
LOG_PATH = Path(__file__).with_name("serverlog.jsonl")
FIELDS_LOG = []


def log_request(method, path, fields=None):
    entry = {"method": method, "path": path}
    if fields is not None:
        entry["fields"] = sorted(fields)
        FIELDS_LOG.append({"path": path, "fields": sorted(fields)})
    with LOCK:
        with LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    print(f"{method} {path}" + (f"  fields={sorted(fields)}" if fields is not None else ""), flush=True)


def parse_multipart(body, content_type):
    m = re.search(r"boundary=([^;]+)", content_type or "", re.I)
    if not m:
        return {}
    boundary = m.group(1).strip('"').encode()
    fields = {}
    for part in body.split(b"--" + boundary):
        if b"Content-Disposition" not in part:
            continue
        header, _, content = part.partition(b"\r\n\r\n")
        nm = re.search(rb'name="([^"]+)"', header)
        if not nm:
            continue
        name = nm.group(1).decode("utf-8", "replace")
        fields[name] = len(content.rstrip(b"\r\n"))
    return fields


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def send_json(self, payload, code=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        n = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(n) if n else b""

    def do_POST(self):
        path = urlparse(self.path).path
        ctype = self.headers.get("Content-Type", "")
        body = self.read_body()
        fields = parse_multipart(body, ctype) if "multipart" in ctype else None
        payload = {}
        if fields is None and body:
            try:
                payload = json.loads(body.decode("utf-8"))
            except Exception:
                payload = {}
        log_request("POST", path, fields)

        if path == "/api/rokid/stream/start":
            req_sid = payload.get("session_id", "")
            sid = req_sid or "sess-demo-001"
            with LOCK:
                STATE["frames"] = 0
                STATE["audio"] = 0
            self.send_json({
                "session_id": sid,
                "stream_id": "stream-demo",
                "can_ask": False,
                "input_mode": payload.get("input_mode", "rokid_frame_audio"),
                "frame_upload_url": f"/rokid/{sid}/frame",
                "audio_upload_url": f"/rokid/{sid}/audio_chunk",
                "status_url": f"/rokid/{sid}/status",
                "audio_question_url": f"/rokid/{sid}/audio_question",
                "next_frame_index": 0,
                "next_audio_index": 0,
                "relative_ts_base_ms": 1000,
                "day_context": {
                    "day_label": "Day 1",
                    "day_index": 1,
                    "weekday_label": "Saturday",
                    "display_day_label": "2026-11-14",
                    "run_id": payload.get("run_id", "run-demo"),
                },
            })
        elif path.endswith("/frame"):
            with LOCK:
                STATE["frames"] += 1
            self.send_json({"status": "ok", "can_ask": True})
        elif path.endswith("/audio_chunk"):
            with LOCK:
                STATE["audio"] += 1
            self.send_json({"status": "ok", "can_ask": True})
        elif path.endswith("/audio_question"):
            with LOCK:
                STATE["task_seq"] += 1
                tid = f"task-{STATE['task_seq']}"
                STATE["tasks"][tid] = "voice"
            self.send_json({
                "status": "queued",
                "task_id": tid,
                "question": "what is in front of me",
            })
        elif re.match(r"^/api/ask/[^/]+$", path):
            q = payload.get("question", "")
            with LOCK:
                STATE["task_seq"] += 1
                tid = f"task-{STATE['task_seq']}"
                STATE["tasks"][tid] = q
                STATE["questions"].append(q)
            self.send_json({"status": "queued", "task_id": tid})
        elif re.match(r"^/api/stream/[^/]+/end$", path):
            self.send_json({"status": "ok"})
        else:
            self.send_json({"message": "not found"}, 404)

    def do_GET(self):
        path = urlparse(self.path).path
        log_request("GET", path)
        if path == "/api/rokid/stream/active":
            # Same contract as the self-hosted backend's /rokid/stream/active.
            # A session counts as "active from the car" once frames arrived
            # without this process having created a phone-side stream.
            with LOCK:
                frames, audio = STATE["frames"], STATE["audio"]
            active = frames > 0
            self.send_json({
                "status": "streaming" if active else "not_found",
                "active": active,
                "session_id": "sess-demo-001" if active else None,
                "input_mode": "rokid_frame_audio",
                "can_ask": active,
                "rokid": {
                    "frames_received": frames,
                    "audio_chunks_received": audio,
                } if active else {},
            })
        elif path.endswith("/status") and "/rokid/" in path:
            with LOCK:
                frames, audio = STATE["frames"], STATE["audio"]
            self.send_json({
                "stream_status": "streaming",
                "can_ask": True,
                "rokid": {
                    "frames_received": frames,
                    "audio_chunks_received": audio,
                    "latest_frame_relative_ts_ms": 1000 + frames * 1000,
                    "latest_audio_relative_ts_ms": 1000 + audio * 1000,
                },
            })
        elif path.endswith("/pipeline_state"):
            self.send_json({"short_term": {"ready": True}})
        elif path == "/api/memories/catalog":
            self.send_json({
                "total_ready_sessions": 1,
                "sessions": [{"session_id": "sess-demo-001", "status": "ready"}],
            })
        elif re.match(r"^/api/session/[^/]+/memories$", path):
            self.send_json({
                "status": "ready",
                "ready": True,
                "layers": {"M_cur": True, "M_st": True, "M_lt": True},
            })
        elif re.match(r"^/api/session/[^/]+/status$", path):
            self.send_json({"session_id": path.split("/")[3]})
        elif path.startswith("/api/query_task/"):
            tid = path.rsplit("/", 1)[-1]
            with LOCK:
                q = STATE["tasks"].get(tid, "")
            self.send_json({
                "status": "done",
                "answer": f"（模拟回答）关于「{q or '当前画面'}」：桌面上有一只杯子，左侧是一台笔记本电脑。",
                "answer_audio_url": "",
            })
        else:
            self.send_json({"message": "not found"}, 404)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8123)
    ap.add_argument("--host", default="0.0.0.0")
    args = ap.parse_args()
    LOG_PATH.write_text("", encoding="utf-8")
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"LightMem-Ego mock backend listening on http://{args.host}:{args.port}/api", flush=True)
    print("multipart field names are printed for every upload", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()
