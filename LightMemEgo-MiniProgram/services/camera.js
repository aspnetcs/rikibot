/**
 * Camera frame capture -> JPEG temp file.
 *
 * Mini programs expose raw RGBA frames via `CameraContext.onCameraFrame` (the
 * <camera> component must declare `frame-size`). There is no RGBA->JPEG encoder
 * API, so we paint the frame onto an off-screen Canvas 2D node and call
 * wx.canvasToTempFilePath({fileType:'jpg'}).
 *
 * Two guards are essential:
 *   1. onCameraFrame fires at ~30 fps; only one frame per `frameIntervalMs` is
 *      processed, everything else is dropped immediately.
 *   2. A `busy` lock prevents a second encode while canvasToTempFilePath is
 *      still pending (its frame data buffer is reused by WeChat).
 */
const config = require('../utils/config.js')

class CameraService {
  constructor(page) {
    this.page = page
    this.canvas = null
    this.ctx = null
    this.context = null
    this.listener = null
    this.running = false
    this.busy = false
    this.lastAt = 0
    this.intervalMs = config.defaultSettings.frameIntervalMs
    this.onJpeg = null
    this.onError = null
    this.frameSeq = 0
  }

  /** Resolve the hidden Canvas 2D node. Must run after the page is rendered. */
  attachCanvas() {
    return new Promise((resolve, reject) => {
      const query = wx.createSelectorQuery().in(this.page)
      query.select('#frameCanvas').fields({ node: true, size: true }).exec((res) => {
        const node = res && res[0] && res[0].node
        if (!node) {
          reject(new Error('未找到离屏 Canvas 节点'))
          return
        }
        this.canvas = node
        this.ctx = node.getContext('2d')
        if (!this.ctx) {
          reject(new Error('Canvas 2D 上下文不可用'))
          return
        }
        resolve(node)
      })
    })
  }

  /** Called from the <camera> component's bindinitdone. */
  start(opts) {
    this.intervalMs = opts.frameIntervalMs || config.defaultSettings.frameIntervalMs
    this.onJpeg = opts.onJpeg || null
    this.onError = opts.onError || null
    this.running = true
    this.busy = false
    this.lastAt = 0

    if (this.listener && this.context) {
      this.listener.start({})
      return
    }
    this.context = wx.createCameraContext()
    this.listener = this.context.onCameraFrame((frame) => this.handleFrame(frame))
    this.listener.start({
      success: () => {},
      fail: (err) => this.report(`帧监听启动失败: ${(err && err.errMsg) || 'unknown'}`),
    })
  }

  stop() {
    this.running = false
    this.busy = false
    if (this.listener) {
      try { this.listener.stop({}) } catch (e) {}
    }
  }

  setIntervalMs(ms) {
    this.intervalMs = ms || config.defaultSettings.frameIntervalMs
  }

  report(message) {
    if (this.onError) this.onError(message)
  }

  handleFrame(frame) {
    if (!this.running || this.busy || !frame || !frame.data) return
    const now = Date.now()
    if (this.lastAt && now - this.lastAt < this.intervalMs) return
    if (!this.canvas || !this.ctx) return

    const w = frame.width | 0
    const h = frame.height | 0
    if (w <= 0 || h <= 0) return
    // Copy synchronously: WeChat reuses the frame buffer after the callback.
    const pixels = this.extractPixels(frame, w, h)
    if (!pixels) return

    this.lastAt = now
    this.busy = true
    const capturedAt = now

    try {
      // `canvas.createImageData` is the reliable path: ctx.createImageData has
      // known issues on WeChat 8.0.37 for Android.
      const makeImageData = this.canvas.createImageData
        ? () => this.canvas.createImageData(w, h)
        : () => this.ctx.createImageData(w, h)
      const img = makeImageData()
      img.data.set(pixels)

      // Setting width/height clears the canvas, so do it before putImageData.
      this.canvas.width = w
      this.canvas.height = h
      this.ctx.putImageData(img, 0, 0)

      wx.canvasToTempFilePath({
        canvas: this.canvas,
        x: 0,
        y: 0,
        width: w,
        height: h,
        destWidth: w,
        destHeight: h,
        fileType: 'jpg',
        quality: config.JPEG_QUALITY,
        success: (res) => {
          this.frameSeq += 1
          if (this.onJpeg && this.running) {
            this.onJpeg({
              filePath: res.tempFilePath,
              width: w,
              height: h,
              capturedAt,
              seq: this.frameSeq,
            })
          }
        },
        fail: (err) => this.report(`JPEG 编码失败: ${(err && err.errMsg) || 'unknown'}`),
        complete: () => { this.busy = false },
      })
    } catch (e) {
      this.busy = false
      this.report(`帧处理异常: ${e.message || e}`)
    }
  }

  /**
   * Normalise the RGBA buffer to exactly w*h*4 bytes.
   * Some Android builds align each row to a wider stride, so the raw buffer is
   * larger than width*height*4; copying it verbatim would skew the image.
   */
  extractPixels(frame, w, h) {
    const src = frame.data instanceof Uint8ClampedArray
      ? frame.data
      : new Uint8ClampedArray(frame.data)
    const needed = w * h * 4
    if (src.length < needed) return null
    const dst = new Uint8ClampedArray(needed)
    const rowBytes = Math.floor(src.length / h)
    if (rowBytes === w * 4) {
      dst.set(src.subarray(0, needed))
    } else if (rowBytes > w * 4) {
      for (let y = 0; y < h; y++) {
        const from = y * rowBytes
        dst.set(src.subarray(from, from + w * 4), y * w * 4)
      }
    } else {
      return null
    }
    return dst
  }
}

module.exports = { CameraService }
