const logger = require('../../utils/log.js')

const FILTERS = [
  { key: 'all', label: '全部', token: '' },
  { key: 'error', label: '错误', token: '[ERROR]' },
  { key: 'warn', label: '警告', token: '[WARN]' },
  { key: 'info', label: '信息', token: '[INFO]' },
  { key: 'network', label: '网络', token: 'upload' },
]

const MAX_RENDER = 300

Page({
  data: {
    themeDark: false,
    filters: FILTERS,
    activeFilter: 'all',
    shown: [],
    total: 0,
    path: '',
  },

  onShow() {
    const app = getApp()
    this.setData({ themeDark: !!(app && app.globalData && app.globalData.themeDark) })
    this.reload()
  },

  reload() {
    const all = logger.lines()
    const f = FILTERS.find((x) => x.key === this.data.activeFilter) || FILTERS[0]
    const matched = f.token ? all.filter((l) => l.indexOf(f.token) >= 0) : all
    this.setData({
      total: all.length,
      shown: matched.slice(0, MAX_RENDER).map((text, i) => ({
        id: i,
        text,
        tone: text.indexOf('[ERROR]') >= 0 ? 'err' : (text.indexOf('[WARN]') >= 0 ? 'warn' : ''),
      })),
      path: logger.filePath(),
    })
  },

  onFilterTap(e) {
    this.setData({ activeFilter: e.currentTarget.dataset.key }, () => this.reload())
  },

  onCopyAll() {
    const text = logger.rawText()
    if (!text.trim()) {
      wx.showToast({ title: '日志为空', icon: 'none' })
      return
    }
    wx.setClipboardData({ data: text })
  },

  onCopyLine(e) {
    const i = Number(e.currentTarget.dataset.id)
    const item = this.data.shown[i]
    if (item) wx.setClipboardData({ data: item.text })
  },

  onClear() {
    wx.showModal({
      title: '清空日志',
      content: '将清空本机诊断日志，不影响历史记录。',
      success: (r) => {
        if (r.confirm) {
          logger.clear()
          this.reload()
        }
      },
    })
  },

  onPullDownRefresh() {
    this.reload()
    wx.stopPullDownRefresh()
  },
})
