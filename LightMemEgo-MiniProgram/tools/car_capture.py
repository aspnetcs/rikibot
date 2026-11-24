#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
LightMem-Ego 小车 / 机器人摄像头采集端。

微信小程序里的 <camera> 只能读手机自带摄像头，接不了小车的视频流；
但后端是标准 HTTP multipart 接口，与客户端类型无关。本脚本让小车（树莓派、
Jetson、ROS 小车、带 USB/CSI/网络摄像头的一切 Linux 设备）直接按与
Android / iOS / 小程序 **逐字相同的字段名** 把 JPEG 帧推给同一个后端，
不需要微信、不需要 AppID、不需要域名备案。

【重要】目标是本项目已实机跑通的 Rikibot X4（Ubuntu + ROS + Orbbec Gemini，
图像话题 /camera/rgb/image_rect_color/compressed）时，**不要用本脚本**，
直接用历史工程 rikibot-x4/lightmem_bridge.py：那里已有 ROS 订阅、四麦音频、
/odom 位姿、异步问答与安全控制，且已在车上验证。本脚本只是「非 ROS 小车 /
USB 或 RTSP 摄像头」的轻量备选与本地自测工具，后端地址也要从演示的 8123
mock server 换成真实后端的 :8000。

用法：
    # 1) USB / CSI 摄像头（需 opencv-python）
    python3 tools/car_capture.py --base http://127.0.0.1:8123/api --source /dev/video0 --fps 1

    # 2) 网络摄像头 RTSP / HTTP 视频流（需 opencv-python）
    python3 tools/car_capture.py --base http://<后端IP>:8123/api --source rtsp://<小车IP>:8554/cam

    # 3) MJPEG over HTTP（纯标准库，无需 OpenCV）
    python3 tools/car_capture.py --base http://127.0.0.1:8123/api --source http://<小车IP>:8080/?action=stream

    # 4) 没有摄像头时用一个装着 .jpg 的目录做联调自测
    python3 tools/car_capture.py --base http://127.0.0.1:8123/api --source ./frames --fps 2 --duration 5

可选：--silence-audio 每秒补一段 16 kHz 单声道静音 WAV（验证音频契约）；
      --ask "现在看到了什么" 在采集结束后提问并轮询回答，跑完整闭环。

依赖：Python 3 标准库即可跑模式 3/4；模式 1/2 需要 `pip install opencv-python`。
"""

import argparse
import json
import os
import re
import struct
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# 与 utils/config.js、utils/api.js 保持一致
INPUT_MODE = 'rokid_frame_audio'
CLIENT_SOURCE = 'glasses'
SAMPLE_RATE = 16000
CHANNELS = 1
PCM_BYTES_PER_SEC = 32000
AUDIO_CHUNK_MS = 1000
SDK_TAG = 'car_capture_py'


# --------------------------------------------------------------------- HTTP
def resolve(base, path):
    if path.startswith('http://') or path.startswith('https://'):
        return path
    return base.rstrip('/') + '/' + str(path).lstrip('/')


def http_json(url, method='GET', body=None, timeout=30):
    data = None
    headers = {'Accept': 'application/json'}
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode('utf-8')
        headers['Content-Type'] = 'application/json; charset=utf-8'
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode('utf-8', 'replace')
    return json.loads(raw) if raw.strip() else {}


def http_multipart(url, file_field, filename, mime, content, fields, timeout=30):
    """手写 multipart/form-data，字段名与 wx.uploadFile 的 formData 完全一致。"""
    boundary = '----LightMemCarBoundary' + os.urandom(8).hex()
    parts = []
    for key, value in fields.items():
        parts.append(
            ('--%s\r\nContent-Disposition: form-data; name="%s"\r\n\r\n%s\r\n'
             % (boundary, key, value)).encode('utf-8')
        )
    parts.append(
        ('--%s\r\nContent-Disposition: form-data; name="%s"; filename="%s"\r\n'
         'Content-Type: %s\r\n\r\n' % (boundary, file_field, filename, mime)).encode('utf-8')
    )
    parts.append(content)
    parts.append(('\r\n--%s--\r\n' % boundary).encode('utf-8'))
    payload = b''.join(parts)
    req = urllib.request.Request(
        url, data=payload,
        headers={'Content-Type': 'multipart/form-data; boundary=%s' % boundary,
                 'Accept': 'application/json'},
        method='POST',
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode('utf-8', 'replace')
    return json.loads(raw) if raw.strip() else {}


# ---------------------------------------------------------------- frame utils
def jpeg_size(data):
    """从 JPEG SOF 标记读出 (width, height)，不需要 Pillow / OpenCV。"""
    i = 2
    n = len(data)
    while i + 9 < n:
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        length = struct.unpack('>H', data[i + 2:i + 4])[0]
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            h, w = struct.unpack('>HH', data[i + 5:i + 9])
            return w, h
        i += 2 + length
    return None, None


def silence_wav():
    """44 字节 WAV 头 + 1 秒 16 kHz 单声道 16-bit 静音 PCM，与 utils/wav.js 同格式。"""
    pcm = b'\x00' * PCM_BYTES_PER_SEC
    byte_rate = SAMPLE_RATE * CHANNELS * 2
    block_align = CHANNELS * 2
    header = b'RIFF' + struct.pack('<I', 36 + len(pcm)) + b'WAVE'
    header += b'fmt ' + struct.pack('<IHHIIHH', 16, 1, CHANNELS,
                                    SAMPLE_RATE, byte_rate, block_align, 16)
    header += b'data' + struct.pack('<I', len(pcm))
    return header + pcm


# -------------------------------------------------------------- frame sources
class ImageDirSource:
    """把目录里的 .jpg 循环当视频源，用于没有摄像头时的联调自测。"""

    def __init__(self, path):
        self.files = sorted(
            p for p in Path(path).iterdir()
            if p.suffix.lower() in ('.jpg', '.jpeg')
        )
        if not self.files:
            raise RuntimeError('目录里没有 .jpg 文件: %s' % path)
        self.i = 0

    def next_jpeg(self):
        data = self.files[self.i % len(self.files)].read_bytes()
        self.i += 1
        w, h = jpeg_size(data)
        if not w:
            raise RuntimeError('无法解析 JPEG 尺寸: %s' % self.files[self.i - 1])
        return data, w, h

    def close(self):
        pass

    def describe(self):
        return '图片目录(%d 张)' % len(self.files)


class OpenCvSource:
    """USB / CSI (/dev/video0) 或 RTSP / HTTP 视频流。"""

    def __init__(self, source, width, height, quality):
        try:
            import cv2
        except ImportError:
            raise RuntimeError('该视频源需要 opencv-python: pip install opencv-python')
        self.cv2 = cv2
        self.cap = cv2.VideoCapture(source if source.startswith(('rtsp://', 'http://', 'https://')) else int(source) if source.isdigit() else source)
        if not self.cap.isOpened():
            raise RuntimeError('打不开摄像头: %s' % source)
        if width:
            self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        if height:
            self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        self.quality = quality

    def next_jpeg(self):
        ok, frame = self.cap.read()
        if not ok or frame is None:
            raise RuntimeError('读取摄像头帧失败')
        ok, buf = self.cv2.imencode('.jpg', frame,
                                    [int(self.cv2.IMWRITE_JPEG_QUALITY), self.quality])
        if not ok:
            raise RuntimeError('JPEG 编码失败')
        h, w = frame.shape[:2]
        return buf.tobytes(), w, h

    def close(self):
        self.cap.release()

    def describe(self):
        return 'OpenCV 摄像头'


class MjpegSource:
    """MJPEG over HTTP (multipart/x-mixed-replace)，纯标准库，适合 mjpg-streamer。"""

    def __init__(self, url, timeout=10):
        self.url = url
        self.resp = urllib.request.urlopen(url, timeout=timeout)
        ctype = self.resp.headers.get('Content-Type', '')
        m = re.search(r'boundary=(?:"([^"]+)"|([^;\s]+))', ctype, re.I)
        if not m:
            raise RuntimeError('该地址不是 MJPEG 流（缺少 boundary）: %s' % ctype)
        b = m.group(1) or m.group(2)
        self.boundary = b.encode() if b.startswith('--') else b'--' + b.encode()
        self.buf = b''
        self.first = True

    def _read_more(self):
        chunk = self.resp.read(4096)
        if not chunk:
            raise RuntimeError('MJPEG 流已断开')
        self.buf += chunk

    def next_jpeg(self):
        while True:
            idx = self.buf.find(self.boundary)
            if idx < 0:
                self._read_more()
                continue
            self.buf = self.buf[idx + len(self.boundary):]
            while True:
                head_end = self.buf.find(b'\r\n\r\n')
                if head_end >= 0:
                    break
                if len(self.buf) > 65536:
                    raise RuntimeError('MJPEG 头部异常')
                self._read_more()
            header = self.buf[:head_end]
            self.buf = self.buf[head_end + 4:]
            if b'image/jpeg' not in header and not self.first:
                continue
            while True:
                end = self.buf.find(b'\r\n' + self.boundary)
                if end >= 0:
                    break
                self._read_more()
            data = self.buf[:end]
            self.buf = self.buf[end + 2:]
            self.first = False
            if data[:2] != b'\xff\xd8':
                continue
            w, h = jpeg_size(data)
            return data, w or 0, h or 0

    def close(self):
        try:
            self.resp.close()
        except Exception:
            pass

    def describe(self):
        return 'MJPEG HTTP 流'


def make_source(args):
    s = args.source
    if s.startswith('http://') or s.startswith('https://'):
        if args.mjpeg:
            return MjpegSource(s)
        try:
            return OpenCvSource(s, args.width, args.height, args.quality)
        except RuntimeError as e:
            if 'opencv-python' in str(e):
                print('[提示] 未装 OpenCV，自动改用纯标准库 MJPEG 解析', file=sys.stderr)
                return MjpegSource(s)
            raise
    if Path(s).is_dir():
        return ImageDirSource(s)
    return OpenCvSource(s, args.width, args.height, args.quality)


# ------------------------------------------------------------------- session
def run(args):
    base = args.base.rstrip('/')
    run_id = 'car-%s-%s' % (int(time.time() * 1000), os.urandom(3).hex())

    body = {
        'input_mode': INPUT_MODE,
        'chunk_duration': 1,
        'run_id': run_id,
        'metadata': {
            'source': 'rokid_glass',
            'device_type': 'rokid',
            'transport': 'http_frame_audio',
            'sdk': SDK_TAG,
            'timestamp_mode': 'connector_relative_ts_ms',
            'run_id': run_id,
            'rokid_session_mode': 'single_session',
            'client_platform': 'car',   # 信息性字段，后端路由不看它
        },
    }
    if args.session_id:
        body['session_id'] = args.session_id

    print('[1/4] 建会话 ->', resolve(base, '/rokid/stream/start'))
    start = http_json(resolve(base, '/rokid/stream/start'), 'POST', body)
    sid = start.get('session_id', '')
    if not sid:
        raise RuntimeError('后端没返回 session_id: %s' % start)
    frame_path = start.get('frame_upload_url') or '/rokid/%s/frame' % sid
    audio_path = start.get('audio_upload_url') or '/rokid/%s/audio_chunk' % sid
    status_path = start.get('status_url') or '/rokid/%s/status' % sid
    frame_index = int(start.get('next_frame_index') or 0)
    audio_index = int(start.get('next_audio_index') or 0)
    ts_base = int(start.get('relative_ts_base_ms') or 0)
    day = (start.get('day_context') or {}).get('display_day_label', '')
    print('      session_id=%s  day=%s  next_frame=%d' % (sid, day, frame_index))

    src = make_source(args)
    print('[2/4] 视频源:', src.describe(), ' 目标帧率: %.2f fps' % args.fps)

    started = time.time()
    t0 = started
    last_audio_at = 0.0
    sent = 0
    interval = 1.0 / args.fps if args.fps > 0 else 1.0
    stopped_by_user = False

    try:
        while True:
            if args.duration and time.time() - started >= args.duration:
                break
            loop_at = time.time()
            try:
                jpeg, w, h = src.next_jpeg()
            except KeyboardInterrupt:
                raise
            except Exception as e:
                print('[warn] 取帧失败: %s' % e, file=sys.stderr)
                time.sleep(min(interval, 0.5))
                continue

            elapsed_ms = int((time.time() - t0) * 1000)
            fields = {
                'frame_index': str(frame_index),
                'relative_ts_ms': str(ts_base + elapsed_ms),
                'client_ts_ms': str(int(time.time() * 1000)),
                'format': 'jpg',
                'source': 'rokid_sdk_video',
                'width': str(w),
                'height': str(h),
            }
            try:
                http_multipart(resolve(base, frame_path), 'frame', 'frame.jpg',
                               'image/jpeg', jpeg, fields, timeout=args.timeout)
                frame_index += 1
                sent += 1
            except Exception as e:
                print('[warn] 帧上传失败: %s' % e, file=sys.stderr)

            if args.silence_audio and time.time() - last_audio_at >= 1.0:
                afields = {
                    'audio_index': str(audio_index),
                    'relative_ts_ms': str(ts_base + elapsed_ms),
                    'client_ts_ms': str(int(time.time() * 1000)),
                    'duration_ms': str(AUDIO_CHUNK_MS),
                    'format': 'wav',
                    'sample_rate': str(SAMPLE_RATE),
                    'channels': str(CHANNELS),
                    'source': 'rokid_sdk_audio',
                }
                try:
                    http_multipart(resolve(base, audio_path), 'audio', 'audio.wav',
                                   'audio/wav', silence_wav(), afields, timeout=args.timeout)
                    audio_index += 1
                except Exception as e:
                    print('[warn] 音频上传失败: %s' % e, file=sys.stderr)
                last_audio_at = time.time()

            if args.status_every and sent % args.status_every == 0:
                try:
                    st = http_json(resolve(base, status_path), timeout=args.timeout)
                    rokid = st.get('rokid') or {}
                    print('      后端已收帧=%s 音频=%s can_ask=%s' % (
                        rokid.get('frames_received'), rokid.get('audio_chunks_received'),
                        st.get('can_ask')))
                except Exception as e:
                    print('[warn] 状态查询失败: %s' % e, file=sys.stderr)

            time.sleep(max(0, interval - (time.time() - loop_at)))
    except KeyboardInterrupt:
        stopped_by_user = True
        print('\n[ctrl-c] 停止采集')
    finally:
        src.close()

    print('[3/4] 共上传 %d 帧 (index 到 %d)' % (sent, frame_index))

    if args.ask:
        ask_body = {
            'question': args.ask, 'mode': 'async', 'retrieval_mode': 'auto',
            'memory_mode': 'auto', 'top_k': 5, 'use_current': True,
            'use_image_evidence': 'auto', 'max_image_evidence': 6,
            'debug_router': False, 'use_interaction_cache': True,
            'answer_tts': False, 'client_source': CLIENT_SOURCE,
            'input_method': 'text',
        }
        try:
            task = http_json(resolve(base, '/ask/%s' % sid), 'POST', ask_body)
            tid = task.get('task_id') or task.get('taskId') or ''
            if tid:
                for _ in range(10):
                    time.sleep(0.9)
                    r = http_json(resolve(base, '/query_task/%s' % tid))
                    if r.get('status') == 'done' or r.get('answer'):
                        print('[问答] Q: %s\n       A: %s' % (args.ask, r.get('answer')))
                        break
        except Exception as e:
            print('[warn] 提问失败: %s' % e, file=sys.stderr)

    print('[4/4] 结束会话')
    try:
        http_json(resolve(base, '/stream/%s/end' % sid), 'POST',
                  {'close_open_event': True, 'force_accept': True})
        print('完成。')
    except Exception as e:
        print('[warn] end 请求失败: %s' % e, file=sys.stderr)

    return 0 if not stopped_by_user else 0


def main():
    ap = argparse.ArgumentParser(description='LightMem-Ego 小车摄像头采集端')
    ap.add_argument('--base', default='http://127.0.0.1:8123/api', help='API Base URL')
    ap.add_argument('--source', default='/dev/video0', help='/dev/videoX、rtsp://、http:// 或 .jpg 目录')
    ap.add_argument('--fps', type=float, default=1.0, help='上传帧率，默认 1（与小程序一致）')
    ap.add_argument('--duration', type=float, default=0, help='运行时长秒数，0=一直跑')
    ap.add_argument('--width', type=int, default=640)
    ap.add_argument('--height', type=int, default=480)
    ap.add_argument('--quality', type=int, default=75)
    ap.add_argument('--timeout', type=int, default=30)
    ap.add_argument('--status-every', type=int, default=5, help='每 N 帧查一次后端状态，0=不查')
    ap.add_argument('--session-id', default='', help='续接已有会话')
    ap.add_argument('--silence-audio', action='store_true', help='每秒补一段静音 WAV，验证音频契约')
    ap.add_argument('--ask', default='', help='采集结束后提问并轮询回答')
    ap.add_argument('--mjpeg', action='store_true', help='强制按 MJPEG over HTTP 解析（纯标准库）')
    args = ap.parse_args()
    try:
        return run(args)
    except KeyboardInterrupt:
        return 0
    except Exception as e:
        print('[错误] %s' % e, file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
