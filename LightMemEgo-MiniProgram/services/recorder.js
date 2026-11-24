/**
 * Continuous 16 kHz mono PCM capture from RecorderManager.
 *
 * `onFrameRecorded` only fires when `frameSize` is set and the format is PCM.
 * Frames are accumulated into exactly 1-second (32 000 byte) blocks, wrapped in
 * a standard 44-byte WAV header, written to USER_DATA_PATH, then handed to the
 * page as a temp file for wx.uploadFile.
 *
 * The same recorder instance also serves voice questions: `startQuestion()`
 * pauses the streaming upload, captures a single utterance, and
 * `stopQuestion()` emits one WAV and resumes streaming if a session is active.
 */
const config = require('../utils/config.js')
const wav = require('../utils/wav.js')

const TARGET_BYTES = Math.round((config.PCM_BYTES_PER_SEC * config.AUDIO_CHUNK_MS) / 1000)

function fs() {
  return wx.getFileSystemManager()
}

class RecorderService {
  constructor() {
    this.rec = null
    this.mode = 'idle' // idle | stream | question
    this.wantRunning = false
    this.intentionalStop = false
    this.chunks = []
    this.bytes = 0
    this.seq = 0
    this.startedAt = 0
    this.questionStartedAt = 0
    this.onChunk = null
    this.onQuestion = null
    this.onError = null
    this.onState = null
    this.bound = false
  }

  bind() {
    if (this.bound) return
    this.rec = wx.getRecorderManager()
    this.rec.onFrameRecorded((res) => this.handleFrame(res))
    this.rec.onStart(() => {
      if (this.onState) this.onState(true)
    })
    this.rec.onStop(() => this.handleStop())
    this.rec.onError((err) => {
      this.report(`录音错误: ${(err && err.errMsg) || 'unknown'}`)
      this.wantRunning = false
      this.mode = 'idle'
      if (this.onState) this.onState(false)
    })
    const self = this
    if (this.rec.onInterruptionBegin) {
      this.rec.onInterruptionBegin(() => this.report('录音被系统打断（来电/微信语音）'))
    }
    if (this.rec.onInterruptionEnd) {
      // WeChat pauses recording on interruption; it will not resume by itself.
      this.rec.onInterruptionEnd(() => {
        self.report('录音中断结束，恢复采集')
        if (self.wantRunning && self.mode === 'stream') {
          self.intentionalStop = true
          try { self.rec.stop() } catch (e) {}
          setTimeout(() => {
            if (self.wantRunning && self.mode === 'stream') self.rawStart()
          }, 300)
        }
      })
    }
    this.bound = true
  }

  report(message) {
    if (this.onError) this.onError(message)
  }

  options() {
    return {
      duration: 600000,
      sampleRate: config.AUDIO_SAMPLE_RATE,
      numberOfChannels: config.AUDIO_CHANNELS,
      encodeBitRate: 48000,
      format: 'PCM',
      frameSize: 16, // KB; required for onFrameRecorded
    }
  }

  rawStart() {
    this.intentionalStop = false
    try {
      this.rec.start(this.options())
    } catch (e) {
      this.report(`录音启动失败: ${e.message || e}`)
    }
  }

  /* ------------------------------------------------------------- streaming */

  startStreaming(opts) {
    this.bind()
    this.onChunk = (opts && opts.onChunk) || null
    this.onQuestion = (opts && opts.onQuestion) || null
    this.onError = (opts && opts.onError) || null
    this.onState = (opts && opts.onState) || null
    this.resetBuffer()
    this.mode = 'stream'
    this.wantRunning = true
    this.startedAt = Date.now()
    this.rawStart()
  }

  stopStreaming() {
    this.wantRunning = false
    this.mode = 'idle'
    this.intentionalStop = true
    this.resetBuffer()
    if (this.rec) {
      try { this.rec.stop() } catch (e) {}
    }
  }

  /* -------------------------------------------------------- voice question */

  startQuestion() {
    this.bind()
    this.intentionalStop = true
    if (this.rec) {
      try { this.rec.stop() } catch (e) {}
    }
    this.resetBuffer()
    this.mode = 'question'
    this.questionStartedAt = Date.now()
    this.intentionalStop = false
    this.rawStart()
  }

  stopQuestion() {
    const durationMs = Math.max(200, Date.now() - this.questionStartedAt)
    this.intentionalStop = true
    if (this.rec) {
      try { this.rec.stop() } catch (e) {}
    }
    const path = this.flushWav()
    if (path && this.onQuestion) this.onQuestion({ filePath: path, durationMs })
    this.resetBuffer()

    // Resume the ambient stream if a session is still running.
    if (this.wantRunning) {
      this.mode = 'stream'
      this.startedAt = Date.now()
      const self = this
      setTimeout(() => {
        if (self.wantRunning && self.mode === 'stream') self.rawStart()
      }, 250)
    } else {
      this.mode = 'idle'
    }
  }

  /* ---------------------------------------------------------------- buffer */

  resetBuffer() {
    this.chunks = []
    this.bytes = 0
  }

  handleFrame(res) {
    if (this.mode === 'idle') return
    const buffer = res && res.frameBuffer
    if (!buffer || !buffer.byteLength) return
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
    this.chunks.push(bytes)
    this.bytes += bytes.length
    if (this.mode === 'stream') {
      while (this.bytes >= TARGET_BYTES) {
        this.emitChunk(TARGET_BYTES)
      }
    }
  }

  /** Pull exactly n bytes out of the accumulated queue (may split a frame). */
  take(n) {
    const out = new Uint8Array(n)
    let offset = 0
    while (offset < n && this.chunks.length) {
      const head = this.chunks[0]
      const need = n - offset
      if (head.length <= need) {
        out.set(head, offset)
        offset += head.length
        this.chunks.shift()
      } else {
        out.set(head.subarray(0, need), offset)
        this.chunks[0] = head.subarray(need)
        offset = n
      }
    }
    this.bytes -= offset
    return out
  }

  writeWav(pcm) {
    const buffer = wav.pcmToWav(pcm, config.AUDIO_SAMPLE_RATE, config.AUDIO_CHANNELS, config.AUDIO_BITS)
    const base = (wx.env && wx.env.USER_DATA_PATH) || ''
    this.seq += 1
    const path = `${base}/lm_audio_${this.seq}.wav`
    try {
      // data is an ArrayBuffer -> no encoding argument.
      fs().writeFileSync(path, buffer)
    } catch (e) {
      this.report(`WAV 写入失败: ${e.message || e}`)
      return null
    }
    // Keep 30 recent files; older ones are safe to remove once uploaded.
    const stale = this.seq - 30
    if (stale > 0) {
      try { fs().unlinkSync(`${base}/lm_audio_${stale}.wav`) } catch (e) {}
    }
    return path
  }

  emitChunk(n) {
    const pcm = this.take(n)
    const path = this.writeWav(pcm)
    if (!path || !this.onChunk) return
    this.onChunk({
      filePath: path,
      durationMs: Math.round((n / config.PCM_BYTES_PER_SEC) * 1000),
    })
  }

  /** Emit whatever is left, even shorter than one second. */
  flushWav() {
    if (this.bytes <= 0) return null
    const pcm = this.take(this.bytes)
    return this.writeWav(pcm)
  }

  handleStop() {
    if (this.intentionalStop) return
    // `duration` expired: restart so ambient capture stays continuous.
    if (this.wantRunning && this.mode === 'stream') {
      const self = this
      setTimeout(() => {
        if (self.wantRunning && self.mode === 'stream') self.rawStart()
      }, 150)
    }
  }
}

module.exports = { RecorderService, TARGET_BYTES }
