# LightMem-Ego · 微信小程序版

把 `ai_glass_app`（Rokid AI 眼镜的 Android 客户端）移植成**微信小程序**：扫码/点开即用，不用 Xcode、不用签名、不用装 App。界面、会话流程、接口契约、本地历史与日志都与 Android / iOS 版对齐，采集端换成手机微信里的摄像头与麦克风。

> 这一版**只做微信小程序**。另外交付的 `LightMemEgo-iOS/` 是独立工程，与本项目互不影响。

---

## 快速开始

1. 安装 [微信开发者工具（稳定版）](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)，「导入项目」选择本目录 `LightMemEgo-MiniProgram`。
2. AppID 可以先选「测试号 / 不使用 AppID」（工程里预填了 `touristappid`）；真机预览和上传发布**必须换成自己的 AppID**。
3. 打开「详情 → 本地设置」，勾选 **「不校验合法域名、web-view（域名）、TLS 版本以及 HTTPS 证书」**。
4. 点「编译」。界面会直接出来；首次点「开始采集」会弹摄像头 + 麦克风授权，允许即可。

> 默认后端是源码作者的演示地址 `https://lightmem-ego.zjukg.cn/api`。想本地跑通完整链路，用下面的模拟后端。

### 本地联调（推荐先跑一遍）

```bash
python3 tools/mock_server.py --port 8123
```

它实现的是原 Android 客户端那套 HTTP 接口，会把每个上传请求的 multipart 字段名打印出来。在小程序「设置」里把 API Base URL 改成：

| 场景 | 地址 | 说明 |
| :--- | :--- | :--- |
| 开发者工具模拟器 | `http://127.0.0.1:8123/api` | 需勾选「不校验合法域名」 |
| 真机预览（同一 Wi-Fi） | `http://<电脑局域网IP>:8123/api` | 官方允许局域网非本机 IP 通信；真机调试模式下更易跑通 |
| 正式发布 | `https://<已备案域名>/api` | 见下一节 |

模拟后端不依赖任何第三方包，`serverlog.jsonl` 会记录所有请求。

### 接入 Rikibot X4 小车（已有实机工程）

小车侧**早已有一套实机跑通的桥接**，不在本仓库：
`C:/Users/Lenovo/WorkBuddy/2026-11-11-12-45-53/rikibot-x4/lightmem_bridge.py`。
它订阅 ROS 话题 `/camera/rgb/image_rect_color/compressed`（Orbbec Gemini，640×480@30Hz，
CompressedImage 本身即 JPEG、无需 cv_bridge），以 1 FPS POST 到 `/rokid/{sid}/frame`，
并带四麦音频、`/odom` 位姿旁路、异步问答与安全控制。车上是 Ubuntu + ROS、Python 3.6.9，
没有 curl（用 `wget -qO-`）、没有 tmux（用 `nohup`）。

所以本工程（手机小程序）**既不需要也无法接管小车摄像头**，它要做的是接入同一个后端：

| 项 | 值 |
| :--- | :--- |
| 真实后端 | PC 上 Docker 的 `http://192.168.137.1:8000`（小车 `192.168.137.181`，PC 在热点/ICS 网段的地址；WLAN 的 10.41.x 小车到不了） |
| 小程序设置 | 「API Base URL」填上面这个地址（**不带 `/api`**；`8123` 只是本地 mock server，不能填成真实后端） |
| 前提 | Docker Desktop 已启动、Windows 防火墙 `LightMem Backend 8000` 入站规则已放行、手机与 PC 同网段可达 |
| 会话 | 小车桥接启动时会建会话；手机要针对该会话提问，需复用同一个 `session_id` |

**兼容性**：自建 Docker 后端的 `/rokid/stream/start` **不返回 `day_context`**（演示 API 会返回），
原版小程序会因此直接抛错。`utils/api.js` 已加本地降级填充，两个后端都能建会话；其余接口
（`/rokid/{sid}/frame`、`/rokid/{sid}/status`、`/ask/{sid}`、`/query_task/{tid}`、`/stream/{sid}/end`）
字段名一致。注意局域网 IP 只能用于开发者工具 / 真机调试（勾选「不校验合法域名」），
正式发布仍需已备案的 HTTPS 域名。

**手机小程序接入小车会话**（与桌面端「小车模式」同一套逻辑）：

会话页的「接入小车」按钮先 `GET /rokid/stream/active`，对应桌面前端的 `getActiveRokidStream()`：

- `active=true` → 直接 attach 返回的 `session_id`，状态显示 `car attached`；手机只轮询 `/rokid/{sid}/status` 并用 `/ask/{sid}` 提问，**不启动手机摄像头/麦克风、不上传帧**，状态栏直接显示后端已收到的帧数。
- `active=false` → 提示「小车未开始采集」，**不新建空会话**（桌面端新建空会话会黑屏）。
- 点「断开」或切后台都**不会**调 `/stream/{sid}/end`，小车继续采集，手机只是观察者。

前提是小程序「设置 → API Base URL」与小车桥接 `--backend` 填的是同一个后端。演示 API 没有 `/rokid/stream/active` 时会提示连接失败，属正常；本地 `tools/mock_server.py` 已实现该端点（收到过帧即 `active=true`），可直接自测。

**直连小车画面（可选，只取画面）**

记忆必须走 PC 后端，但「看车的实时画面」可以绕过后端直接连车：

1. 车端跑 `rikibot-x4/car_http_server.py`（零依赖；Orbbec 的 `CompressedImage.data` 本身就是 JPEG，不需要 cv_bridge、不需要 OpenCV）：
   ```bash
   python3 car_http_server.py --port 8080
   # 无 ROS 时本地自测：--mock ./frames
   ```
2. 会话页「小车画面直连」填 `http://<小车IP>:8080`（例 `http://192.168.137.181:8080`），点「应用」。
3. 接入小车会话后，预览区用 `<image src="/frame.jpg?t=时间戳">` 约 0.8 fps 轮询车端最新帧。

车端端点：`/frame.jpg`（单帧）、`/stream.mjpg`（浏览器可直接看）、`/health`。该服务**只读画面**，不接收控制指令、不发布任何 ROS 消息。

注意：这只在「手机与小车同一局域网 + 开发版勾选不校验合法域名」时可用；正式发布的小程序不能访问 `http://` 局域网 IP，届时仍需走备案域名。

**记忆测试（三问，逐层验证）**

会话页的「记忆测试」卡片对应 `rikibot-x4/CLIENT_MEMORY_PLAN.md` 的三问脚本：

| 顺序 | 一键问题 | 验证的记忆层 | 判定标准 |
| :--- | :--- | :--- | :--- |
| ① | 我现在看到了什么？ | `M_cur` 当前场景 | 描述现场真实物体——这还不是记忆 |
| ② | 刚才半分钟里，画面中出现过什么？ | `M_st` 30 秒事件锚 + 时间戳证据 | 能说出**此刻已不在画面里**的物体，才算记忆生效 |
| ③ | 再早一点，你在这张桌子上还看到过什么？ | `M_lt` 长期事件图谱 | 依赖 `/memories` 就绪，否则只走当前帧/证据路径 |

「检查记忆状态」探测 `GET /session/{sid}/memories` 与 `GET /memories/catalog`：就绪时显示可浏览的会话数；返回 503 `memory_component_lagging` 时显示「组件仍在构建，问答不受影响」。这是历史演示最容易被问倒的点——**记忆问答可用 ≠ 记忆浏览/图谱可用**，`catalog` 为 0 时不要打开记忆浏览页，也不要对外说「长期记忆已完整就绪」。

`tools/car_capture.py` 只是**非 ROS 小车**的轻量备选（USB / CSI / RTSP / MJPEG over HTTP），
逐字复刻 `uploadFrame` / `uploadAudioChunk` 的 multipart 字段，适合没有 ROS 的设备或本地自测：

```bash
python3 tools/car_capture.py --base http://127.0.0.1:8123/api --source ./frames --fps 2 --duration 5
python3 tools/car_capture.py --base http://192.168.137.1:8000 --source /dev/video0 --fps 1
```

---

## 发布前的硬性门槛

微信小程序对网络和隐私采集的管控比原生 App 严格，这几项不做，真机预览或审核会直接失败：

| 事项 | 要求 |
| :--- | :--- |
| AppID | 换成自己的小程序 AppID |
| 服务器域名 | 小程序后台 →「开发管理 → 开发设置 → 服务器域名」，把后端域名分别加进 **request 合法域名** 和 **uploadFile 合法域名** |
| 协议与备案 | 只能 `https://` / `wss://`，域名必须**完成 ICP 备案**，证书须为受信任 CA 签发（自签不行） |
| 地址形式 | 不能用 IP、不能用 `localhost`、不能用非标端口（配置后端口严格匹配） |
| 隐私协议 | 在「账号设置 → 服务内容声明 → 用户隐私保护指引」或提审时的信息填写页补充**《小程序用户隐私保护指引》**，声明收集「摄像头」「麦克风」「图片/音视频」；隐私协议为空或与调用的隐私接口不符会被拦截 |
| 类目 | 选择与音视频/工具采集相匹配的服务类目 |

官方文档：[网络与服务器域名](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html) · [用户隐私保护](https://developers.weixin.qq.com/miniprogram/dev/framework/user-privacy/)

---

## 功能对照

| 功能 | Android 眼镜版 | 小程序版 |
| :--- | :--- | :--- |
| 四个 Tab：会话 / 历史 / 日志 / 设置 | ✅ | ✅ 一致 |
| 摄像头预览 + 逐帧上传 JPEG | ✅ | ✅ `onCameraFrame` → Canvas 2D → JPG |
| 麦克风连续采集 1 秒 WAV 分片 | ✅ | ✅ 16 kHz 单声道 PCM → WAV |
| 开始 / 停止 / 续上次会话 | ✅ | ✅ 一致 |
| 状态轮询（可提问 / 记忆就绪 / 收发计数） | ✅ | ✅ 一致 |
| 预设问题 / 文字提问 / 语音提问 | ✅ | ✅ 一致 |
| 异步问答轮询 + 回答延迟统计 | ✅ | ✅ 一致 |
| 播放后端返回的回答音频 | ✅ | ✅ `InnerAudioContext` |
| 本地 TTS 朗读 | ✅ | ➖ 小程序无系统 TTS，只能播后端音频 |
| 历史 JSONL（最多 500 条） | ✅ | ✅ 导出/导入同格式，可与三端互读 |
| 诊断日志（512 KB 轮转） | ✅ | ✅ 同格式 |
| 设置（后端地址 / 帧率 / 镜头 / 主题 / 预设问题） | ✅ | ✅ 键名沿用 |
| 8 通道麦克风阵列下混 | ✅ | ➖ 手机单声道直传 |
| 后台 / 锁屏持续采集 | ➖ | ❌ 系统限制，切后台自动结束会话 |
| 眼镜触控板 / 实体键 | ✅ | ➖ 屏幕按钮替代 |

---

## 实现要点与踩过的坑

| 环节 | 做法 |
| :--- | :--- |
| 帧回调 | `<camera frame-size="medium">`，必须在 `bindinitdone` 之后调用 `listener.start()`；切后台微信会自动暂停回调 |
| RGBA → JPEG | 帧数据是 `ArrayBuffer` RGBA，画到离屏 Canvas 2D 再 `wx.canvasToTempFilePath({fileType:'jpg'})`。**用 `canvas.createImageData`，不要用 `ctx.createImageData`**（微信 8.0.37 安卓有已知问题） |
| stride 对齐 | 部分安卓机型每行有填充字节，`extractPixels()` 逐行去 padding，否则图像错位 |
| 性能 | `onCameraFrame` 约 30 fps，按 `frameIntervalMs` 丢弃绝大多数帧 + `busy` 锁防止并发编码，避免卡死 |
| Canvas 不能 `hidden` | 用 `position:fixed; left:-10000px` 移出视口，否则 `create bitmap failed` |
| 录音分片 | `RecorderManager` 设 `format:'PCM'`、`sampleRate:16000`、`numberOfChannels:1`、`frameSize:16` 才会触发 `onFrameRecorded`；累积满 32 000 字节包一个 44 字节 WAV 头 |
| 录音续期 | `duration` 到期会自动 stop，在 `onStop` 里自动重启；手动停止用 `intentionalStop` 区分 |
| 上传 | `wx.uploadFile` 只能传本地临时文件路径，所以帧导出 JPG、音频写 `USER_DATA_PATH/*.wav` 再传 |
| 后台处理 | 用 **App 级 `onHide`** 结束会话，不用页面级 `onHide`（切 Tab 也会触发，会误停会话） |
| 隐私弹窗 | 基础库支持时调用 `wx.getPrivacySetting` / `wx.requirePrivacyAuthorize`，低版本自动跳过 |

参考：[CameraContext.onCameraFrame](https://developers.weixin.qq.com/miniprogram/dev/api/media/camera/CameraContext.onCameraFrame.html) · [wx.canvasToTempFilePath](https://developers.weixin.qq.com/miniprogram/dev/api/canvas/wx.canvasToTempFilePath.html) · [RecorderManager](https://developers.weixin.qq.com/miniprogram/dev/api/media/recorder/RecorderManager.html) · [Rokid 社区：小程序获取实时帧并存临时文件](https://openrokid.csdn.net/6acf22423d0de04db9d2db63.html)

---

## 接口契约：后端零改动

**这里和我之前的预估不同，往省事的方向改了。** 我原本判断小程序流式上传需要把后端改成 WebSocket，实际实现时发现：`wx.uploadFile` 能直接传本地临时文件，帧可以导出 JPG、音频可以写 WAV，multipart 的**字段名和取值逐字复刻 Android**，因此现有的 `rokid_frame_audio` HTTP 接口**一行都不用改**——Android、iOS、小程序三端共用同一套服务端，也省掉了你部署 WSS 的麻烦。

| 方法 | 路径 | 用途 |
| :--- | :--- | :--- |
| POST | `/rokid/stream/start` | 新建或续接会话，返回 `day_context` 与各上传 URL |
| POST | `/rokid/{sid}/frame` | 上传 JPEG：`frame`, `frame_index`, `relative_ts_ms`, `client_ts_ms`, `format`, `source`, `width`, `height` |
| POST | `/rokid/{sid}/audio_chunk` | 上传 1 秒 WAV：`audio`, `audio_index`, `relative_ts_ms`, `client_ts_ms`, `duration_ms`, `format`, `sample_rate`, `channels`, `source` |
| GET | `/rokid/{sid}/status` | 流状态、后端收到的帧/音频数 |
| GET | `/session/{sid}/status` | 会话是否存在 |
| GET | `/session/{sid}/pipeline_state` | `short_term.ready` → 记忆就绪 |
| POST | `/ask/{sid}` | 文字 / 预设问题（异步任务） |
| POST | `/rokid/{sid}/audio_question` | 语音提问 WAV，返回识别文本与 `task_id` |
| GET | `/query_task/{task_id}` | 轮询回答 |
| POST | `/stream/{sid}/end` | 结束会话 |

`input_mode` 仍是 `rokid_frame_audio`，`client_source` 仍是 `glasses`，`metadata` 只多加了 `client_platform: "miniprogram"` 和 `sdk` 标识（信息性字段，不影响路由）。

> 如果以后确实想要更省请求的流式通道：改造点是新增一个 `wss://` 端点，把 `audio_chunk`/`frame` 改成二进制帧 + JSON 元数据，并保留现有 HTTP 接口给另外两端。当前版本没做，因为对现有后端零改动更划算。

---

## 验收情况

在 Linux 上用 Node 打桩微信 API + Python 模拟后端跑了 **12 项自检，全部通过**：

- WAV 头与长度、宽容 JSON 解析、URL 拼接、设置持久化（键名/归一化）
- 历史 CRUD 与 **Android 同格式 JSONL 导出/导入**、会话记忆、日志轮转
- 录音分片（8 帧 × 8 KB → 2 个 1 秒 WAV）、相机节流（30 fps 回调只产出 1 帧）、stride 去填充
- **端到端**：建会话 → 上传帧/音频 → 状态轮询 → 文字提问拿回答 → 语音提问 → 结束会话
- **接口契约**：JSON 请求体字段集合、三个 multipart 请求的字段名集合，与 Android 源码逐字比对一致

另外校验了：全部 JS 语法、全部 JSON、全部 `require` 路径、WXML 标签配对、WXSS 括号、TabBar 图标与页面文件齐全、所有事件绑定都有对应处理函数。

**未验证**（此环境跑不了微信开发者工具，需要你在真机上确认）：`onCameraFrame` 各机型的帧率/尺寸、`RecorderManager` 在 iOS 上的 PCM 分片行为、Canvas 2D 导出 JPG 的实际耗时、隐私弹窗与审核流程。建议真机跑一遍后先看「日志」页，那里会记录帧编码、上传失败和录音错误。

---

## 已知限制

1. **切后台 / 锁屏立即停止采集**，这是微信与手机系统的限制，代码里主动结束会话以免后端留半开连接。
2. **域名备案是发布前最耗时的一步**（通常 7–20 个工作日），开发阶段靠「不校验合法域名」绕过。
3. 语音提问期间会暂停环境音流上传（同一个 RecorderManager 不能同时录两路），结束后自动恢复。
4. `wx.uploadFile` 的 `formData` 只接受字符串，数字和布尔都已转成字符串，与 Android 一致。
5. 帧编码是 CPU 密集操作，低端机建议把「上传帧率」调到每 2–3 秒。

---

## 目录结构

```
LightMemEgo-MiniProgram/
├── app.js / app.json / app.wxss      # 全局逻辑、TabBar、主题
├── project.config.json               # 开发者工具项目配置（urlCheck 已关）
├── sitemap.json
├── pages/
│   ├── session/                      # 预览 + 采集 + 提问 + 回答
│   ├── history/                      # 历史、筛选、JSONL 导入导出
│   ├── logs/                         # 诊断日志、筛选、复制
│   └── settings/                     # 后端、帧率、镜头、主题、预设问题
├── services/
│   ├── camera.js                     # onCameraFrame → RGBA → JPEG
│   └── recorder.js                   # PCM 分片 → WAV / 语音提问录音
├── utils/
│   ├── api.js                        # 全部 HTTP 接口（multipart 字段对齐 Android）
│   ├── config.js / json.js / format.js
│   ├── wav.js                        # 44 字节 WAV 头
│   ├── store.js                      # 设置 / 会话记忆 / 历史
│   └── log.js                        # 512 KB 轮转日志
├── assets/tab/                       # 8 个 TabBar 图标
└── tools/mock_server.py              # 可选：本地联调后端
```
