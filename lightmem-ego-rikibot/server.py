#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
LightMem-Ego 本地服务（rikibot 一键启动包）
================================================
零第三方依赖，只用 Python 标准库。行为对齐项目自带 docker/nginx.conf：

  * /api/*  -> 反向代理到 config.json 的 backend_url，自动剥掉 /api 前缀
  * 其它路径 -> dist/ 静态文件，SPA 路由刷新回退 index.html
  * 支持大文件上传（视频帧 / 音频块）与流式响应（问答 token 流）
  * 后端不可达时返回 502，并在控制台给出提示
"""
import http.client
import json
import mimetypes
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DIST_DIR = os.path.join(BASE_DIR, "dist")
CONFIG_FILE = os.path.join(BASE_DIR, "config.json")

# hop-by-hop 头不能透传；Accept-Encoding 去掉以免拿到压缩体后无法正确转发
HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade", "accept-encoding",
}
# 用 chunked 转发，因此这两个头必须丢弃，其余（含 Content-Encoding）原样透传
SKIP_RESPONSE_HEADERS = {"connection", "keep-alive", "transfer-encoding", "content-length"}


def load_config():
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception as exc:
        print("[配置错误] 无法读取 %s: %s" % (CONFIG_FILE, exc))
        sys.exit(1)
    backend = str(cfg.get("backend_url", "")).strip().rstrip("/")
    if not backend:
        print("[配置错误] backend_url 不能为空")
        sys.exit(1)
    if not backend.startswith(("http://", "https://")):
        backend = "http://" + backend
    cfg["backend_url"] = backend
    try:
        cfg["port"] = int(cfg.get("port", 8080))
    except (TypeError, ValueError):
        cfg["port"] = 8080
    return cfg


CONFIG = load_config()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "LightMemEgoRikibot/1.0"

    def _send_bytes(self, status, body, content_type, cache=False):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "public, max-age=604800" if cache else "no-cache")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _proxy(self):
        parts = urlsplit(self.path)
        path, query = parts.path, parts.query

        # 与 nginx 的 `proxy_pass http://backend-api:8000/;` 一致：剥掉 /api 前缀
        if path == "/api":
            upstream_path = "/"
        elif path.startswith("/api/"):
            upstream_path = path[len("/api"):]
        else:
            upstream_path = path
        if query:
            upstream_path = "%s?%s" % (upstream_path, query)

        backend = urlsplit(CONFIG["backend_url"])
        host = backend.hostname
        port = backend.port or (443 if backend.scheme == "https" else 80)
        base_prefix = backend.path.rstrip("/")
        # 兼容 backend_url 带子路径的情况，例如 http://192.168.0.105:8000/em2mem
        if base_prefix and base_prefix != "/":
            upstream_path = (base_prefix + "/" if upstream_path == "/" else base_prefix + upstream_path)

        method = self.command.upper()
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length > 0 else None

        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP_BY_HOP}
        headers["Host"] = host if port in (80, 443) else "%s:%d" % (host, port)
        headers["X-Real-IP"] = self.client_address[0]
        headers["X-Forwarded-For"] = self.client_address[0]
        headers["X-Forwarded-Proto"] = "http"

        conn_cls = http.client.HTTPSConnection if backend.scheme == "https" else http.client.HTTPConnection
        conn = None
        try:
            conn = conn_cls(host, port, timeout=300)
            conn.request(method, upstream_path, body=body, headers=headers)
            resp = conn.getresponse()

            self.send_response(resp.status, resp.reason)
            for key, value in resp.getheaders():
                if key.lower() not in SKIP_RESPONSE_HEADERS:
                    self.send_header(key, value)
            # chunked 转发：无需预先知道长度，天然支持流式问答输出
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()

            if method != "HEAD":
                while True:
                    chunk = resp.read(8192)
                    if not chunk:
                        break
                    self.wfile.write(b"%X\r\n" % len(chunk) + chunk + b"\r\n")
                self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except Exception as exc:
            msg = ("后端不可达或代理失败: %s" % exc).encode("utf-8")
            try:
                self._send_bytes(502, msg, "text/plain; charset=utf-8")
            except Exception:
                pass
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass

    def _serve_static(self):
        rel = unquote(urlsplit(self.path).path).lstrip("/")
        if not rel:
            rel = "index.html"
        full = os.path.normpath(os.path.join(DIST_DIR, rel.replace("/", os.sep)))
        # 防目录穿越
        if not (full == DIST_DIR or full.startswith(DIST_DIR + os.sep)):
            self._send_bytes(403, b"Forbidden", "text/plain; charset=utf-8")
            return
        if os.path.isdir(full):
            full = os.path.join(full, "index.html")
        if not os.path.isfile(full):
            full = os.path.join(DIST_DIR, "index.html")  # SPA fallback
        if not os.path.isfile(full):
            self._send_bytes(404, b"dist/index.html not found", "text/plain; charset=utf-8")
            return
        content_type = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in ("application/javascript", "application/json"):
            content_type += "; charset=utf-8"
        with open(full, "rb") as f:
            body = f.read()
        is_asset = full.endswith((".js", ".css", ".png", ".woff2", ".svg", ".ico", ".jpg", ".webp"))
        self._send_bytes(200, body, content_type, cache=is_asset)

    def _route(self):
        try:
            if self.path == "/api" or self.path.startswith("/api/"):
                self._proxy()
            elif self.path in ("/health", "/_health"):
                self._send_bytes(200, b'{"status":"ok"}', "application/json; charset=utf-8")
            else:
                self._serve_static()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            try:
                self._send_bytes(500, str(exc).encode("utf-8"), "text/plain; charset=utf-8")
            except Exception:
                pass

    do_GET = _route
    do_POST = _route
    do_PUT = _route
    do_DELETE = _route
    do_PATCH = _route
    do_HEAD = _route
    do_OPTIONS = _route

    def log_message(self, fmt, *args):
        stamp = time.strftime("%Y-%m-%d %H:%M:%S")
        sys.stderr.write("%s [client] %s %s\n" % (stamp, self.address_string(), fmt % args))


def main():
    if not os.path.isdir(DIST_DIR):
        print("[错误] 找不到静态目录: %s" % DIST_DIR)
        sys.exit(1)
    port = CONFIG["port"]
    httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    httpd.daemon_threads = True
    print("=" * 56)
    print(" LightMem-Ego · rikibot 一键启动包")
    print("=" * 56)
    print(" 界面地址 : http://localhost:%d" % port)
    print(" 后端地址 : %s" % CONFIG["backend_url"])
    print(" 静态目录 : %s" % DIST_DIR)
    print(" 按 Ctrl+C 停止")
    print("=" * 56)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
