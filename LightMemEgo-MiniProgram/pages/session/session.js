const config = require('../../utils/config.js')
const store = require('../../utils/store.js')
const fmt = require('../../utils/format.js')
const logger = require('../../utils/log.js')
const { APIClient } = require('../../utils/api.js')
const { CameraService } = require('../../services/camera.js')
const { RecorderService } = require('../../services/recorder.js')

const INITIAL = {
  themeDark: false,
  cameraGranted: false,
  recordGranted: false,
  cameraReady: false,
  cameraError: '',
  running: false,
  starting: false,
  carMode: false,
  carCameraInput: '',
  carCameraURL: '',
  carShot: 0,
  carCameraError: '',
  stopping: false,
  status: 'idle',
  statusTone: '',
  sessionId: '',
  dayLabel: '',
  dayIndex: 0,
  displayDayLabel: '',
  runId: '',
  canAsk: false,
  memoryReady: false,
  memoryProbe: '',
  streamStatus: '',
  frameUploadedCount: 0,
  audioUploadedCount: 0,
  framesReceived: 0,
  audioChunksReceived: 0,
  answer: '',
  answerLatencyText: '--',
  answerAudioUrl: '',
  asking: false,
  questionText: '',
  voiceRecording: false,
  voiceStatus: '',
  voiceQuestionText: '',
  quickQuestions: [],
  resumeAvailable: false,
  resumeLabel: '',
  lens: 'back',
  frameIntervalMs: 1000,
  networkError: '',
  apiBaseLabel: '',
}

Page({
  data: Object.assign({}, INITIAL),

  onLoad() {
    this.app = getApp()
    this.client = new APIClient(store.getSettings())
    this.camera = new CameraService(this)
    this.recorder = new RecorderService()
    this.statusTimer = null
    this.taskTimer = null
    this.voiceTimer = null
    this.frameUploading = false
    this.audioUploading = false
    this.uploadFailures = 0
    this.sessionStartAt = 0
    this.relativeTsBaseMs = 0
    this.frameIndex = 0
    this.audioIndex = 0
    this.settingsVersion = -1
    this.applySettings()
    this.refreshPermissions()
    this.checkPrivacy()
    logger.info('session', '页面加载')
  },

  onReady() {
    this.camera.attachCanvas()
      .then(() => logger.info('camera', '离屏 Canvas 已就绪'))
      .catch((e) => {
        logger.error('camera', `Canvas 不可用: ${e.message}`)
        this.setData({ cameraError: e.message })
      })
  },

  onShow() {
    const app = getApp()
    if (app && app.globalData && app.globalData.settingsVersion !== this.settingsVersion) {
      this.applySettings()
    }
    this.refreshPermissions()
  },

  onUnload() {
    this.teardown()
  },

  onAppBackground() {
    // Car mode is view-only: never tear down the session the car is publishing.
    if (this.data.running && !this.data.carMode) this.stopStreaming('切到后台，已结束采集')
  },

  teardown() {
    if (this.statusTimer) clearInterval(this.statusTimer)
    if (this.taskTimer) clearTimeout(this.taskTimer)
    if (this.voiceTimer) clearTimeout(this.voiceTimer)
    this.statusTimer = null
    this.taskTimer = null
    this.voiceTimer = null
    this.camera.stop()
    this.recorder.stopStreaming()
    this.stopCarPreview()
    if (this.audioCtx) {
      try { this.audioCtx.destroy() } catch (e) {}
      this.audioCtx = null
    }
  },

  /* ------------------------------------------------------------- settings */

  applySettings() {
    const s = store.getSettings()
    const app = getApp()
    this.settingsVersion = app && app.globalData ? app.globalData.settingsVersion : 0
    const dark = !!(app && app.globalData && app.globalData.themeDark)
    this.client.setSettings(s)
    this.camera.setIntervalMs(s.frameIntervalMs)
    const saved = store.getSavedSession()
    this.setData({
      themeDark: dark,
      lens: s.lens,
      frameIntervalMs: s.frameIntervalMs,
      quickQuestions: s.presetQuestions.slice(0, 4),
      resumeAvailable: !!saved,
      resumeLabel: saved ? fmt.shortID(saved.sessionID, 8, 4) : '',
      carCameraURL: String(s.carCameraURL || '').replace(/\/+$/, ''),
      carCameraInput: String(s.carCameraURL || ''),
      // Surfaced in the status card: "which backend am I actually hitting" is
      // the first question whenever a request fails, and the answer is not
      // visible anywhere else on this page.
      apiBaseLabel: fmt.trimBaseURL(s.apiBaseURL || config.defaultSettings.apiBaseURL).replace(/^https?:\/\//, ''),
    })
  },

  /* ---------------------------------------------------------- permissions */

  checkPrivacy() {
    if (!wx.getPrivacySetting || !wx.requirePrivacyAuthorize) return
    wx.getPrivacySetting({
      success: (res) => {
        if (res && res.needAuthorization) {
          wx.requirePrivacyAuthorize({
            fail: () => logger.warn('privacy', '用户未同意隐私协议'),
          })
        }
      },
      fail: () => {},
    })
  },

  refreshPermissions() {
    if (!wx.getSetting) return
    wx.getSetting({
      success: (res) => {
        const a = (res && res.authSetting) || {}
        this.setData({
          cameraGranted: a['scope.camera'] === true,
          recordGranted: a['scope.record'] === true,
        })
      },
      fail: () => {},
    })
  },

  requestPermissions() {
    const need = []
    if (!this.data.cameraGranted) need.push('scope.camera')
    if (!this.data.recordGranted) need.push('scope.record')
    if (!need.length) {
      wx.showToast({ title: '权限已开启', icon: 'none' })
      return
    }
    const next = (index) => {
      if (index >= need.length) {
        this.refreshPermissions()
        return
      }
      wx.authorize({
        scope: need[index],
        success: () => next(index + 1),
        fail: () => {
          wx.showModal({
            title: '需要授权',
            content: '请在「设置」中允许使用摄像头和麦克风，否则无法采集第一视角画面与声音。',
            confirmText: '去设置',
            success: (r) => {
              if (r.confirm && wx.openSetting) wx.openSetting({ success: () => this.refreshPermissions() })
            },
          })
        },
      })
    }
    next(0)
  },

  onCameraInitDone() {
    this.setData({ cameraReady: true })
    logger.info('camera', 'camera 组件初始化完成')
  },

  onCameraError(e) {
    const msg = (e && e.detail && e.detail.errMsg) || '摄像头打开失败'
    this.setData({ cameraError: msg })
    logger.error('camera', msg)
  },

  /* -------------------------------------------------------------- session */

  async startStreaming(resume, opts) {
    const carMode = !!(opts && opts.carMode)
    if (this.data.running || this.data.starting) return
    if (!carMode) {
      if (!this.data.cameraGranted || !this.data.recordGranted) {
        wx.showToast({ title: '请先开启相机与麦克风权限', icon: 'none' })
        this.requestPermissions()
        return
      }
      if (!this.data.cameraReady) {
        wx.showToast({ title: '摄像头正在初始化', icon: 'none' })
        return
      }
    }
    const saved = resume ? store.getSavedSession() : null
    const runID = fmt.newRunID()
    this.setData({ starting: true, status: carMode ? 'attaching' : 'connecting', statusTone: 'warn', networkError: '' })
    logger.info('session', carMode ? '接入小车会话' : `开始会话 resume=${!!saved}`)

    try {
      let result
      if (carMode) {
        const active = await this.client.getActiveStream()
        if (!active.active || !active.sessionID) {
          this.setData({ starting: false, running: false, status: 'no active car session', statusTone: 'warn' })
          wx.showToast({ title: '小车未开始采集', icon: 'none' })
          return
        }
        result = {
          sessionID: active.sessionID,
          dayLabel: 'Day 1',
          dayIndex: 1,
          displayDayLabel: fmt.formatDateTime(Date.now()).slice(0, 10),
          weekdayLabel: '',
          runID,
          streamID: '',
          canAsk: active.canAsk,
          inputMode: active.inputMode,
          frameUploadPath: `/rokid/${active.sessionID}/frame`,
          audioUploadPath: `/rokid/${active.sessionID}/audio_chunk`,
          statusPath: active.statusURL || `/rokid/${active.sessionID}/status`,
          audioQuestionPath: `/rokid/${active.sessionID}/audio_question`,
          nextFrameIndex: 0,
          nextAudioIndex: 0,
          relativeTsBaseMs: 0,
          framesReceived: active.framesReceived,
          audioChunksReceived: active.audioChunksReceived,
        }
        logger.info('stream', `接入小车会话 ${fmt.shortID(active.sessionID)} 后端已收 ${active.framesReceived} 帧`)
      } else {
        result = await this.client.startStream(runID, saved ? saved.sessionID : '')
        store.saveSession(result)
      }
      this.sessionStartAt = Date.now()
      this.relativeTsBaseMs = result.relativeTsBaseMs
      this.frameIndex = result.nextFrameIndex
      this.audioIndex = result.nextAudioIndex
      this.uploadFailures = 0
      this.frameUploading = false
      this.audioUploading = false

      this.setData({
        starting: false,
        running: true,
        status: carMode ? 'car attached' : 'streaming',
        statusTone: 'ok',
        sessionId: result.sessionID,
        dayLabel: result.dayLabel,
        dayIndex: result.dayIndex,
        displayDayLabel: result.displayDayLabel,
        runId: result.runID,
        canAsk: result.canAsk,
        carMode,
        resumeAvailable: carMode ? this.data.resumeAvailable : true,
        resumeLabel: fmt.shortID(result.sessionID, 8, 4),
        frameUploadedCount: 0,
        audioUploadedCount: 0,
        framesReceived: carMode ? result.framesReceived : 0,
        audioChunksReceived: carMode ? result.audioChunksReceived : 0,
        answer: '',
        answerLatencyText: '--',
        answerAudioUrl: '',
      })
      logger.info('stream', `会话 ${fmt.shortID(result.sessionID)} day=${result.dayLabel} nextFrame=${result.nextFrameIndex} nextAudio=${result.nextAudioIndex}`)

      // Car mode only watches: the car owns the camera/mic and the frame upload.
      if (!carMode) {
        this.camera.start({
          frameIntervalMs: this.data.frameIntervalMs,
          onJpeg: (frame) => this.onFrame(frame),
          onError: (msg) => this.onCaptureError('camera', msg),
        })
        this.recorder.startStreaming({
          onChunk: (chunk) => this.onAudioChunk(chunk),
          onError: (msg) => this.onCaptureError('audio', msg),
        })
      }
      this.startStatusPolling()
      if (carMode) this.startCarPreview()
    } catch (err) {
      this.setData({
        starting: false,
        running: false,
        status: 'connection failed',
        statusTone: 'err',
        networkError: err.message || String(err),
      })
      logger.error('stream', `开始失败: ${err.message || err}`)
      wx.showToast({ title: '连接后端失败', icon: 'none' })
    }
  },

  stopStreaming(reason) {
    const sid = this.data.sessionId
    const carMode = this.data.carMode
    this.teardown()
    // Reset UI first: endStream can be slow and must not block a new session.
    this.setData(Object.assign({}, INITIAL, {
      themeDark: this.data.themeDark,
      cameraGranted: this.data.cameraGranted,
      recordGranted: this.data.recordGranted,
      cameraReady: this.data.cameraReady,
      quickQuestions: this.data.quickQuestions,
      resumeAvailable: !!store.getSavedSession(),
      resumeLabel: this.data.resumeLabel,
      lens: this.data.lens,
      frameIntervalMs: this.data.frameIntervalMs,
      status: reason || 'stopped',
      statusTone: reason ? 'warn' : '',
    }))
    logger.info('stream', carMode ? `断开小车会话 ${fmt.shortID(sid)}（不结束车上采集）` : `结束会话 ${fmt.shortID(sid)}`)
    // Attaching must never end the car's session: it keeps publishing after we leave.
    if (sid && !carMode) {
      this.client.endStream(sid).catch((e) => logger.warn('stream', `end 请求失败: ${e.message || e}`))
    }
  },

  onStart() { this.startStreaming(false) },
  onStop() { this.stopStreaming() },
  onResume() { this.startStreaming(true) },
  onAttachCar() { return this.startStreaming(false, { carMode: true }) },

  /* ------------------------------------------- car direct preview (picture) */

  onCarCameraInput(e) {
    this.setData({ carCameraInput: e.detail.value })
  },

  onSaveCarCamera() {
    const raw = String(this.data.carCameraInput || '').trim()
    const url = raw.replace(/\/+$/, '')
    const s = store.getSettings()
    s.carCameraURL = url
    store.saveSettings(s)
    this.setData({ carCameraURL: url, carCameraError: '', carShot: Date.now() })
    if (this.data.carMode) this.startCarPreview()
    wx.showToast({ title: url ? '小车画面地址已保存' : '已清空', icon: 'none' })
  },

  onCarPreviewError() {
    if (this.data.carCameraError) return
    this.setData({ carCameraError: '画面加载失败：确认手机与小车同网段、车端服务已启动、端口未被拦' })
  },

  /** Poll the car's own /frame.jpg — picture only, memory still goes through the backend. */
  startCarPreview() {
    this.stopCarPreview()
    if (!this.data.carCameraURL) return
    const tick = () => {
      if (!this.data.running || !this.data.carMode) return
      this.setData({ carShot: Date.now() })
    }
    tick()
    this.carTimer = setInterval(tick, 1200)
  },

  stopCarPreview() {
    if (this.carTimer) clearInterval(this.carTimer)
    this.carTimer = null
  },

  startStatusPolling() {
    if (this.statusTimer) clearInterval(this.statusTimer)
    const poll = () => {
      const sid = this.data.sessionId
      if (!sid || !this.data.running) return
      this.client.streamStatus(sid).then((s) => {
        if (!this.data.running) return
        this.setData({
          canAsk: s.canAsk || this.data.canAsk,
          memoryReady: s.memoryReady,
          streamStatus: s.streamStatus,
          framesReceived: s.framesReceived,
          audioChunksReceived: s.audioChunksReceived,
        })
      }).catch((e) => logger.warn('status', e.message || e))
    }
    this.statusTimer = setInterval(poll, config.STATUS_POLL_MS)
    setTimeout(poll, 600)
  },

  relativeTs() {
    return Math.max(0, this.relativeTsBaseMs + (Date.now() - this.sessionStartAt))
  },

  onFrame(frame) {
    const sid = this.data.sessionId
    if (!this.data.running || !sid || this.frameUploading) return
    this.frameUploading = true
    const index = this.frameIndex
    this.client.uploadFrame(sid, {
      filePath: frame.filePath,
      frameIndex: index,
      relativeTsMs: this.relativeTs(),
      width: frame.width,
      height: frame.height,
    }).then((r) => {
      if (!this.data.running) return
      this.frameIndex = index + 1
      this.uploadFailures = 0
      this.setData({
        frameUploadedCount: this.data.frameUploadedCount + 1,
        canAsk: r.canAsk || this.data.canAsk,
        networkError: '',
      })
    }).catch((e) => this.onUploadFailure('frame', e))
      .then(() => { this.frameUploading = false })
  },

  onAudioChunk(chunk) {
    const sid = this.data.sessionId
    if (!this.data.running || !sid || this.audioUploading) return
    this.audioUploading = true
    const index = this.audioIndex
    this.client.uploadAudioChunk(sid, {
      filePath: chunk.filePath,
      audioIndex: index,
      relativeTsMs: this.relativeTs(),
      durationMs: chunk.durationMs,
    }).then((r) => {
      if (!this.data.running) return
      this.audioIndex = index + 1
      this.uploadFailures = 0
      this.setData({
        audioUploadedCount: this.data.audioUploadedCount + 1,
        canAsk: r.canAsk || this.data.canAsk,
        networkError: '',
      })
    }).catch((e) => this.onUploadFailure('audio', e))
      .then(() => { this.audioUploading = false })
  },

  onUploadFailure(kind, err) {
    this.uploadFailures += 1
    const msg = err.message || String(err)
    logger.warn('upload', `${kind} 失败(${this.uploadFailures}): ${msg}`)
    if (this.uploadFailures === 3) {
      this.setData({ networkError: msg, statusTone: 'err' })
      wx.showToast({ title: '后端连接异常', icon: 'none' })
    }
  },

  onCaptureError(kind, msg) {
    logger.error(kind, msg)
    if (kind === 'camera') this.setData({ cameraError: msg })
  },

  /* ------------------------------------------------------------ questions */

  onQuestionInput(e) {
    this.setData({ questionText: e.detail.value })
  },

  onPresetTap(e) {
    const index = Number(e.currentTarget.dataset.index)
    const q = this.data.quickQuestions[index]
    if (q) this.submitAsk(q, 'preset')
  },

  /** Layered memory probe: M_cur -> M_st -> M_lt, same session. */
  onMemoryAsk(e) {
    const q = String((e && e.currentTarget && e.currentTarget.dataset.q) || '').trim()
    if (q) this.submitAsk(q, 'preset')
  },

  onProbeMemory() {
    const sid = this.data.sessionId
    if (!sid) {
      wx.showToast({ title: '请先开始采集或接入小车', icon: 'none' })
      return
    }
    this.setData({ memoryProbe: '查询中…' })
    // The 503 path can take several seconds while the backend probes its
    // incremental components, so never leave the label stuck on 查询中.
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 9000))
    Promise.race([this.client.memoryStatus(sid), timeout]).then((s) => {
      let text
      if (!s) {
        text = '查询超时（后端记忆组件响应较慢），问答仍可用'
      } else if (s.sessionReady) {
        text = `本会话记忆就绪 · 库内可浏览 ${s.readySessions} 个会话`
      } else if (s.sessionState === 'memory_component_lagging') {
        text = `本会话长期记忆仍在构建（503）· 库内已就绪 ${s.readySessions} 个`
      } else {
        text = `记忆状态：${s.sessionState || '未知'} · 库内已就绪 ${s.readySessions} 个`
      }
      this.setData({ memoryProbe: text })
      logger.info('memory', text)
    }).catch((e) => {
      this.setData({ memoryProbe: `查询失败：${e.message || e}` })
    })
  },

  onAskText() {
    const q = String(this.data.questionText || '').trim()
    if (!q) {
      wx.showToast({ title: '请输入问题', icon: 'none' })
      return
    }
    this.submitAsk(q, 'text')
    this.setData({ questionText: '' })
  },

  requireSession() {
    if (!this.data.running || !this.data.sessionId) {
      wx.showToast({ title: '请先开始采集或接入小车', icon: 'none' })
      return false
    }
    if (!this.data.canAsk) {
      // The backend queues questions even before memory is warm. Let the user
      // try rather than blocking them indefinitely on a slow/empty stream.
      wx.showToast({ title: '记忆尚未就绪，回答可能较慢', icon: 'none' })
    }
    if (this.data.asking) {
      wx.showToast({ title: '上一个问题还在处理', icon: 'none' })
      return false
    }
    return true
  },

  async submitAsk(question, source) {
    if (!this.requireSession()) return
    const startedAt = Date.now()
    this.setData({ asking: true, answer: '', answerLatencyText: '--', answerAudioUrl: '' })
    logger.info('ask', `[${source}] ${question}`)
    try {
      const r = await this.client.askQuestion(this.data.sessionId, question, source)
      if (r.answer) {
        this.finishAsk(question, source, r.answer, r.answerAudioURL, startedAt)
      } else if (r.taskID) {
        this.pollTask(r.taskID, question, source, startedAt, 0)
      } else {
        throw new Error('后端未返回 task_id')
      }
    } catch (e) {
      this.setData({ asking: false, answer: `提问失败：${e.message || e}` })
      logger.error('ask', e.message || e)
    }
  },

  pollTask(taskID, question, source, startedAt, failures) {
    if (this.taskTimer) clearTimeout(this.taskTimer)
    if (Date.now() - startedAt > config.QUERY_POLL_TIMEOUT_MS) {
      this.setData({ asking: false, answer: '回答超时' })
      return
    }
    this.taskTimer = setTimeout(() => {
      if (!this.data.running) {
        this.setData({ asking: false })
        return
      }
      this.client.queryTask(taskID).then((r) => {
        if (r.done || r.answer) {
          this.finishAsk(question, source, r.answer, r.answerAudioURL, startedAt)
        } else if (r.status === 'error' || r.status === 'failed') {
          this.setData({ asking: false, answer: `回答失败：${r.message || r.status}` })
        } else {
          this.pollTask(taskID, question, source, startedAt, 0)
        }
      }).catch((e) => {
        const n = failures + 1
        if (n >= 3) {
          this.setData({ asking: false, answer: `轮询失败：${e.message || e}` })
        } else {
          this.pollTask(taskID, question, source, startedAt, n)
        }
      })
    }, config.QUERY_POLL_INTERVAL_MS)
  },

  finishAsk(question, source, answer, audioURL, startedAt) {
    const latency = Date.now() - startedAt
    this.setData({
      asking: false,
      answer: answer || '（后端未返回回答文本）',
      answerLatencyText: fmt.formatLatency(latency),
      answerAudioUrl: audioURL || '',
    })
    store.addHistory({
      sessionId: this.data.sessionId,
      question,
      answer,
      source,
      latencyMs: latency,
    })
    logger.info('answer', `延迟 ${fmt.formatLatency(latency)} 长度 ${String(answer || '').length}`)
    if (audioURL && store.getSettings().autoPlayAnswer) this.playAnswer()
  },

  /* ------------------------------------------------------- voice question */

  onVoiceTap() {
    if (this.data.voiceRecording) {
      this.stopVoiceQuestion()
      return
    }
    if (!this.requireSession()) return
    if (this.voiceTimer) clearTimeout(this.voiceTimer)
    this.setData({ voiceRecording: true, voiceStatus: '录音中，点击结束', voiceQuestionText: '' })
    this.recorder.onQuestion = (q) => this.onVoiceQuestionReady(q)
    this.recorder.startQuestion()
    this.voiceTimer = setTimeout(() => {
      if (this.data.voiceRecording) this.stopVoiceQuestion()
    }, config.VOICE_QUESTION_MAX_MS)
  },

  stopVoiceQuestion() {
    if (this.voiceTimer) clearTimeout(this.voiceTimer)
    this.voiceTimer = null
    this.setData({ voiceRecording: false, voiceStatus: '识别中…' })
    this.recorder.stopQuestion()
  },

  async onVoiceQuestionReady(q) {
    if (!this.data.running || !this.data.sessionId) {
      this.setData({ voiceStatus: '' })
      return
    }
    const startedAt = Date.now()
    this.setData({ asking: true, answer: '', answerLatencyText: '--' })
    try {
      const r = await this.client.askAudioQuestion(this.data.sessionId, q.filePath, q.durationMs)
      const question = r.question || '（语音提问）'
      this.setData({ voiceQuestionText: question, voiceStatus: '' })
      logger.info('voice', `识别: ${question}`)
      if (r.answer) {
        this.finishAsk(question, 'voice', r.answer, r.answerAudioURL, startedAt)
      } else if (r.taskID) {
        this.pollTask(r.taskID, question, 'voice', startedAt, 0)
      } else {
        throw new Error(r.message || '语音提问未返回 task_id')
      }
    } catch (e) {
      this.setData({ asking: false, voiceStatus: '', answer: `语音提问失败：${e.message || e}` })
      logger.error('voice', e.message || e)
    }
  },

  /* -------------------------------------------------------- audio playback */

  playAnswer() {
    const raw = this.data.answerAudioUrl
    if (!raw) {
      wx.showToast({ title: '本次回答没有音频', icon: 'none' })
      return
    }
    const url = this.client.resolveURL(raw)
    if (this.audioCtx) this.audioCtx.destroy()
    const ctx = wx.createInnerAudioContext()
    ctx.obeyMuteSwitch = false
    ctx.src = url
    ctx.onError((e) => logger.warn('audio', `播放失败: ${e.errMsg || 'unknown'}`))
    ctx.play()
    this.audioCtx = ctx
  },

  onPlayAnswer() { this.playAnswer() },

  /* ------------------------------------------------------------ utilities */

  onClearSession() {
    store.clearSession()
    this.setData({ resumeAvailable: false, resumeLabel: '' })
    wx.showToast({ title: '已清除会话记忆', icon: 'none' })
  },

  onCopySession() {
    if (!this.data.sessionId) return
    wx.setClipboardData({ data: this.data.sessionId })
  },

  onGoSettings() {
    wx.switchTab({ url: '/pages/settings/settings' })
  },
})
