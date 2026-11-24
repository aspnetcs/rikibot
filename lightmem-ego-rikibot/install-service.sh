#!/usr/bin/env bash
# 把 LightMem-Ego 注册为 systemd 服务（开机自启）
# 用法：chmod +x install-service.sh && ./install-service.sh
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USER_NAME="$(whoami)"

echo "安装目录: $DIR"
echo "运行用户: $USER_NAME"

TMP="/tmp/lightmem-ego.service.$$"
sed -e "s|__INSTALL_DIR__|$DIR|g" -e "s|__SERVICE_USER__|$USER_NAME|g" \
    "$DIR/lightmem-ego.service.template" > "$TMP"

sudo cp "$TMP" /etc/systemd/system/lightmem-ego.service
rm -f "$TMP"

sudo systemctl daemon-reload
sudo systemctl enable lightmem-ego.service
sudo systemctl restart lightmem-ego.service

echo
echo "已安装并启动。常用命令："
echo "  查看状态: sudo systemctl status lightmem-ego"
echo "  查看日志: journalctl -u lightmem-ego -f"
echo "  停止服务: sudo systemctl stop lightmem-ego"
echo "  卸载服务: sudo systemctl disable --now lightmem-ego && sudo rm /etc/systemd/system/lightmem-ego.service"
