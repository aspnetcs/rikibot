#!/usr/bin/env bash
# LightMem-Ego · rikibot 一键启动脚本
# 用法：./start.sh      （按 Ctrl+C 停止）
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

PY="${PYTHON_BIN:-python3}"

if ! command -v "$PY" >/dev/null 2>&1; then
    echo "[错误] 找不到 python3。请先安装：sudo apt install python3"
    exit 1
fi

# 用 Python 自己解析 JSON，避免依赖 jq
read_cfg() {
    "$PY" -c "import json; c=json.load(open('config.json',encoding='utf-8')); print(c.get('$1',''))"
}

BACKEND="$(read_cfg backend_url || true)"
PORT="$(read_cfg port || true)"
OPEN_BROWSER="$(read_cfg open_browser || true)"
BROWSER_CMD="$(read_cfg browser_cmd || true)"
BROWSER_FLAGS="$(read_cfg browser_flags || true)"
[ -n "$PORT" ] || PORT=8080

echo "=================================================="
echo " LightMem-Ego · rikibot 一键启动"
echo "=================================================="
echo " 后端 API : $BACKEND"
echo " 本地端口 : $PORT"
echo

if [ ! -f "$DIR/dist/index.html" ]; then
    echo "[错误] dist/index.html 不存在，部署包不完整。"
    exit 1
fi

# 探测后端是否可达（仅提示，不阻断启动）
HOSTPORT="${BACKEND#http://}"
HOSTPORT="${HOSTPORT#https://}"
HOST="${HOSTPORT%%/*}"
HOST="${HOST%%:*}"
BACKEND_PORT="${HOSTPORT##*:}"
case "$BACKEND_PORT" in
    ''|*[!0-9]*) BACKEND_PORT=8000 ;;
esac
if "$PY" - "$HOST" "$BACKEND_PORT" <<'PYEOF' 2>/dev/null
import socket, sys
s = socket.socket(); s.settimeout(1.5)
sys.exit(0 if s.connect_ex((sys.argv[1], int(sys.argv[2]))) == 0 else 1)
PYEOF
then
    echo "[OK] 后端 $HOST:$BACKEND_PORT 可达"
else
    echo "[警告] 连不上后端 $HOST:$BACKEND_PORT"
    echo "       检查：1) 电脑上后端已启动  2) config.json 的 IP 是电脑当前 IP"
    echo "             3) 电脑和机器人在同一局域网、防火墙放行 8000"
    echo "       界面仍会启动，但问答/记忆功能不可用。"
fi
echo

# 启动本地服务
"$PY" server.py &
SERVER_PID=$!
cleanup() {
    kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# 等服务端口就绪
for i in $(seq 1 30); do
    if "$PY" - "$PORT" <<'PYEOF' 2>/dev/null
import socket, sys
s = socket.socket(); s.settimeout(0.3)
sys.exit(0 if s.connect_ex(("127.0.0.1", int(sys.argv[1]))) == 0 else 1)
PYEOF
    then
        break
    fi
    sleep 0.2
done

URL="http://localhost:${PORT}/"
echo "界面已启动: $URL"

# 在机器人本机打开浏览器。必须用 localhost，浏览器才允许摄像头/麦克风权限。
if [ "$OPEN_BROWSER" = "true" ] || [ "$OPEN_BROWSER" = "True" ]; then
    if command -v "$BROWSER_CMD" >/dev/null 2>&1; then
        echo "正在打开浏览器 ($BROWSER_CMD) ..."
        $BROWSER_CMD $BROWSER_FLAGS "$URL" >/dev/null 2>&1 &
    elif command -v xdg-open >/dev/null 2>&1; then
        echo "正在打开默认浏览器 ..."
        xdg-open "$URL" >/dev/null 2>&1 &
    else
        echo "[提示] 未找到 $BROWSER_CMD 或 xdg-open，请在机器人浏览器手动打开: $URL"
    fi
fi

echo
echo "按 Ctrl+C 停止服务"
wait "$SERVER_PID"
