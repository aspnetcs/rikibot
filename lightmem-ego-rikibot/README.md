# LightMem-Ego · rikibot 一键启动包

把原本只能在电脑浏览器里跑的 Vite + React 前端，做成 rikibot 机器人（Ubuntu + ROS，ARM 主控）上一条命令就能启动的本地 Web 应用。

## 工作原理

机器人本机跑一个**零第三方依赖**的 Python 服务（只用标准库，Jetson Nano / 树莓派无需编译任何东西）：

```
机器人浏览器  --http://localhost:8080-->  本地 server.py
                                             |-- 静态页面 -> dist/
                                             `-- /api/*  -> 剥掉 /api 前缀 -> 电脑后端 8000
```

- 后端继续留在电脑上跑，机器人只负责界面和摄像头/麦克风采集，算力压力最小。
- 代理规则严格对齐项目自带的 `docker/nginx.conf`：`/api/` 去掉前缀再转发，关闭缓冲以支持问答的流式输出。
- 前端 build 时用的是相对路径 `/api`，所以**换后端 IP 只改配置文件，不需要重新打包**。

## 包内容

```
lightmem-ego-rikibot/
├── start.sh                    # 一键启动（推荐）
├── server.py                   # 本地服务 + API 反向代理
├── config.json                 # 后端地址 / 端口 / 浏览器设置  ← 只改这个
├── install-service.sh          # 安装为 systemd 开机自启
├── lightmem-ego.service.template
├── package.xml / CMakeLists.txt / launch / scripts   # ROS1 catkin 集成（可选）
├── dist/                       # 前端构建产物
└── README.md                   # 本文件
```

## 部署三步走

### 第 1 步：传到机器人

打包好的压缩包在项目 `src/frontend/` 下，两种格式任选：`.tar.gz`（Linux 原生，保留执行权限）或 `.zip`（Windows 传到 U 盘更方便）。

```bash
# 用 scp 传（把 IP、用户名换成实际的）
scp lightmem-ego-rikibot.tar.gz rikirobot@192.168.0.50:~

# 在机器人上解压
tar -xzf ~/lightmem-ego-rikibot.tar.gz
cd ~/lightmem-ego-rikibot
chmod +x *.sh server.py scripts/*.sh
```

### 第 2 步：改后端 IP（必做）

```bash
nano config.json
```

`backend_url` 默认是 `http://192.168.0.105:8000`（项目里安卓端用过的历史地址），**必须改成你电脑当前的局域网 IP**。

Windows 上查 IP：`ipconfig`，找无线局域网适配器 IPv4 地址，例如 `192.168.1.23`，则改为：

```json
{
  "backend_url": "http://192.168.1.23:8000",
  "port": 8080,
  "open_browser": true,
  "browser_cmd": "chromium-browser",
  "browser_flags": "--kiosk --no-sandbox --disable-gpu --window-size=1280,800 --use-fake-ui-for-media-stream"
}
```

其他字段：

| 字段 | 说明 |
| :--- | :--- |
| `port` | 界面端口，默认 8080；被占用时改这里 |
| `open_browser` | 设为 `false` 则不自动开浏览器，只启动服务 |
| `browser_cmd` | 机器人上的浏览器命令，按实际改成 `chromium` / `google-chrome` / `firefox` 等；找不到时脚本会提示手动打开 |
| `browser_flags` | `--kiosk` 全屏无地址栏；`--use-fake-ui-for-media-stream` 自动允许摄像头/麦克风权限，适合演示 |

### 第 3 步：启动

```bash
./start.sh
```

脚本会先探测后端是否可达（连不上会给出提示但不阻断），然后打开浏览器。看到 `界面已启动: http://localhost:8080/` 就成功了。按 `Ctrl+C` 停止。

## 三种启动方式

**A. 直接启动（先试这个）**

```bash
./start.sh
```

**B. 开机自启（systemd）**

```bash
./install-service.sh
sudo systemctl status lightmem-ego       # 查看状态
journalctl -u lightmem-ego -f            # 看日志
sudo systemctl stop lightmem-ego         # 停止
```

脚本会自动把当前目录和运行用户写进服务文件。注意：这种方式只启动服务，不自动开浏览器——需要配套设置桌面自启浏览器打开 `http://localhost:8080`。

**C. ROS launch（ROS1 / catkin）**

目录改名后放进 catkin 工作空间：

```bash
mv ~/lightmem-ego-rikibot ~/catkin_ws/src/lightmem_ego_web
cd ~/catkin_ws && catkin_make && source devel/setup.bash
roslaunch lightmem_ego_web lightmem_ego.launch
```

launch 只启动本地服务，浏览器仍需手动打开 `http://localhost:8080`。

> ROS2 用户不需要这层封装——前端本身不是 ROS 节点，直接用 A 或 B 即可。

## 电脑端后端的准备

后端按项目原有方式启动，二选一：

```bash
# 方式一：Docker（推荐）
cd LightMem-Ego-main
cp deploy/.env.example .env    # 填好 LLM key 等配置
docker compose up --build

# 方式二：源码
cd src/backend
scripts/start_api.sh
scripts/start_online_all_workers.sh    # 另一个终端
```

启动后检查：

```bash
# 电脑上
curl http://127.0.0.1:8000/ping

# 机器人上（把 IP 换成电脑 IP）
curl http://192.168.1.23:8000/ping
```

三个前提：

1. 项目 `.env` 里 `EM2MEM_API_HOST=0.0.0.0`（默认已是），不能是 `127.0.0.1`，否则机器人连不上。
2. 电脑和机器人在同一局域网（能互相 ping 通）。
3. Windows 防火墙放行 8000 端口入站。

因为前端是通过本地服务同源代理访问后端的，浏览器不会触发跨域，所以**不用改后端的 CORS 配置**。

## 摄像头 / 麦克风权限（重要）

浏览器只在**安全上下文**下开放摄像头和麦克风，`localhost` 属于安全上下文。所以：

- 在**机器人本机**浏览器打开 `http://localhost:8080` —— 正常。
- 从电脑浏览器用 `http://<机器人IP>:8080` 远程访问 —— 摄像头会被禁用。
- 如果确实需要远程访问界面，得给服务配 HTTPS（自签证书也可），但这台机器人专机专用，没必要。

默认浏览器参数已带 `--use-fake-ui-for-media-stream`，kiosk 模式下会自动放行权限弹窗。

## 常见问题

| 现象 | 原因 | 处理 |
| :--- | :--- | :--- |
| 界面能开，问答/记忆没反应 | 后端没连上 | 看启动时的后端探测提示；确认电脑后端已启动、IP 正确、防火墙放行 |
| 页面显示 502 | 代理连不上后端 | 同上；`curl http://<电脑IP>:8000/ping` 在机器人上试一下 |
| 摄像头黑屏 / 无权限 | 不是 localhost 访问 | 在机器人本机用 `http://localhost:8080` 打开 |
| 8080 端口被占用 | rikibot 其他服务占了 | 改 `config.json` 的 `port`，例如 8088，然后访问对应端口 |
| 浏览器没自动弹出 | `browser_cmd` 命令名不对 | 改成机器人上实际存在的浏览器命令，或手动打开 |
| 机器人上找不到 python3 | 系统精简版没装 | `sudo apt install python3` |

## 前端改动后怎么更新

在 Windows 上重新构建：

```bash
cd E:/26-27-1/毕业设计/赵国涛--胡瑞祥/LightMem-Ego-main/src/frontend/online_web
npm install
npm run build
```

把新生成的 `online_web/dist/` 整个替换掉部署包里的 `dist/`，重新传到机器人即可。`config.json` 不受影响。

如果改了 `VITE_API_BASE_URL`（默认 `/api`），代理逻辑需要同步调整，不要随意改。
