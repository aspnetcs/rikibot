const store = require('../../utils/store.js')
const fmt = require('../../utils/format.js')
const logger = require('../../utils/log.js')

const FRAME_OPTIONS = [
  { value: 1000, label: '每 1 秒' },
  { value: 2000, label: '每 2 秒' },
  { value: 3000, label: '每 3 秒' },
  { value: 5000, label: '每 5 秒' },
]
const LENS_OPTIONS = [
  { value: 'back', label: '后置（第一视角）' },
  { value: 'front', label: '前置' },
]
const THEME_OPTIONS = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
]

Page({
  data: {
    themeDark: false,
    frameLabels: FRAME_OPTIONS.map((o) => o.label),
    lensLabels: LENS_OPTIONS.map((o) => o.label),
    themeLabels: THEME_OPTIONS.map((o) => o.label),
    frameIndex: 0,
    lensIndex: 0,
    themeIndex: 0,
    apiBaseURL: '',
    presetsText: '',
    autoPlayAnswer: true,
    answerTTSEnabled: false,
    savedSession: '',
    testResult: '',
    storageInfo: '',
  },

  onShow() {
    const app = getApp()
    this.setData({ themeDark: !!(app && app.globalData && app.globalData.themeDark) })
    this.loadForm()
  },

  loadForm() {
    const s = store.getSettings()
    const saved = store.getSavedSession()
    let infoText = ''
    try {
      const info = wx.getStorageInfoSync()
      infoText = `${info.currentSize} KB / ${info.limitSize} KB`
    } catch (e) {}
    this.setData({
      apiBaseURL: s.apiBaseURL,
      frameIndex: this.indexOf(FRAME_OPTIONS, s.frameIntervalMs),
      lensIndex: this.indexOf(LENS_OPTIONS, s.lens),
      themeIndex: this.indexOf(THEME_OPTIONS, s.themeMode),
      presetsText: s.presetQuestions.join('\n'),
      autoPlayAnswer: s.autoPlayAnswer,
      answerTTSEnabled: s.answerTTSEnabled,
      savedSession: saved ? fmt.shortID(saved.sessionID, 10, 6) : '',
      storageInfo: infoText,
    })
  },

  indexOf(options, value) {
    const i = options.findIndex((o) => o.value === value)
    return i < 0 ? 0 : i
  },

  onApiInput(e) { this.setData({ apiBaseURL: e.detail.value }) },
  onPresetsInput(e) { this.setData({ presetsText: e.detail.value }) },
  onFrameChange(e) { this.setData({ frameIndex: Number(e.detail.value) }) },
  onLensChange(e) { this.setData({ lensIndex: Number(e.detail.value) }) },
  onThemeChange(e) { this.setData({ themeIndex: Number(e.detail.value) }) },
  onAutoPlay(e) { this.setData({ autoPlayAnswer: e.detail.value }) },
  onTTS(e) { this.setData({ answerTTSEnabled: e.detail.value }) },

  buildForm() {
    return {
      apiBaseURL: this.data.apiBaseURL,
      frameIntervalMs: FRAME_OPTIONS[this.data.frameIndex].value,
      lens: LENS_OPTIONS[this.data.lensIndex].value,
      themeMode: THEME_OPTIONS[this.data.themeIndex].value,
      presetQuestions: String(this.data.presetsText || '').split('\n'),
      autoPlayAnswer: this.data.autoPlayAnswer,
      answerTTSEnabled: this.data.answerTTSEnabled,
    }
  },

  onSave() {
    const n = store.saveSettings(this.buildForm())
    const app = getApp()
    if (app && app.bumpSettings) app.bumpSettings()
    logger.info('settings', `保存设置 base=${n.apiBaseURL} interval=${n.frameIntervalMs}`)
    this.setData({
      apiBaseURL: n.apiBaseURL,
      presetsText: n.presetQuestions.join('\n'),
      themeDark: !!(app && app.globalData && app.globalData.themeDark),
    })
    wx.showToast({ title: '已保存', icon: 'success' })
  },

  onReset() {
    wx.showModal({
      title: '恢复默认',
      content: '会重置后端地址、帧率、镜头、主题与预设问题。',
      success: (r) => {
        if (!r.confirm) return
        const n = store.resetSettings()
        const app = getApp()
        if (app && app.bumpSettings) app.bumpSettings()
        this.loadForm()
        wx.showToast({ title: `已恢复（${n.apiBaseURL}）`, icon: 'none' })
      },
    })
  },

  onTestConnection() {
    const base = fmt.trimBaseURL(this.data.apiBaseURL)
    if (!base) {
      this.setData({ testResult: '请先填写后端地址' })
      return
    }
    this.setData({ testResult: '测试中…' })
    wx.request({
      url: `${base}/session/__probe__/status`,
      method: 'GET',
      timeout: 8000,
      success: (res) => {
        // Any HTTP response (including 404) proves the host is reachable.
        this.setData({ testResult: `后端可达（HTTP ${res.statusCode}），域名与服务正常` })
      },
      fail: (err) => {
        const raw = (err && err.errMsg) || 'unknown'
        this.setData({
          testResult: /url not in domain list/i.test(raw)
            ? '域名未加入「服务器域名」白名单：真机/体验版/试用版会在请求发出前拦截，需在小程序后台配置，或用开发者工具「不校验合法域名」+ 真机调试'
            : `不可达：${raw}`,
        })
      },
    })
  },

  onClearSession() {
    store.clearSession()
    this.setData({ savedSession: '' })
    wx.showToast({ title: '已清除', icon: 'none' })
  },

  onCopyBase() {
    wx.setClipboardData({ data: this.data.apiBaseURL })
  },
})
