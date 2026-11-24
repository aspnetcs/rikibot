#!/usr/bin/env bash
# roslaunch 节点包装：只启动本地 Web 服务，不自动打开浏览器
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec python3 "$DIR/server.py"
