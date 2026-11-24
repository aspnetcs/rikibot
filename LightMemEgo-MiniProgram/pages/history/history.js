const store = require('../../utils/store.js')
const fmt = require('../../utils/format.js')
const logger = require('../../utils/log.js')

const SOURCE_LABEL = { preset: '预设', text: '文字', voice: '语音', unknown: '其他' }

Page({
  data: {
    themeDark: false,
    entries: [],
    shown: [],
    filters: [
      { key: 'all', label: '全部' },
      { key: 'preset', label: '预设' },
      { key: 'text', label: '文字' },
      { key: 'voice', label: '语音' },
    ],
    activeFilter: 'all',
    expanded: '',
    total: 0,
  },

  onShow() {
    const app = getApp()
    this.setData({ themeDark: !!(app && app.globalData && app.globalData.themeDark) })
    this.reload()
  },

  reload() {
    const all = store.getHistory().map((e) => Object.assign({}, e, {
      timeText: fmt.formatDateTime(e.timestampMs),
      sourceLabel: SOURCE_LABEL[e.source] || e.source,
      answerPreview: e.answer.length > 90 ? e.answer.slice(0, 90) + '…' : e.answer,
      latencyText: e.latencyMs === null || e.latencyMs === undefined ? '' : fmt.formatLatency(e.latencyMs),
    }))
    this.all = all
    this.setData({ total: all.length })
    this.applyFilter()
  },

  applyFilter() {
    const f = this.data.activeFilter
    const list = f === 'all' ? this.all : this.all.filter((e) => e.source === f)
    this.setData({ shown: list, entries: this.all })
  },

  onFilterTap(e) {
    this.setData({ activeFilter: e.currentTarget.dataset.key, expanded: '' }, () => this.applyFilter())
  },

  onItemTap(e) {
    const id = e.currentTarget.dataset.id
    this.setData({ expanded: this.data.expanded === id ? '' : id })
  },

  onCopy(e) {
    const id = e.currentTarget.dataset.id
    const item = this.all.find((x) => x.id === id)
    if (!item) return
    wx.setClipboardData({ data: `Q: ${item.question}\nA: ${item.answer}` })
  },

  onDelete(e) {
    const id = e.currentTarget.dataset.id
    store.deleteHistory(id)
    this.reload()
    wx.showToast({ title: '已删除', icon: 'none' })
  },

  onClearAll() {
    wx.showModal({
      title: '清空历史',
      content: '将删除本机保存的全部问答记录，此操作不可恢复。',
      success: (r) => {
        if (!r.confirm) return
        store.clearHistory()
        logger.info('history', '清空历史记录')
        this.reload()
      },
    })
  },

  onExport() {
    const text = store.exportHistoryJSONL()
    if (!text.trim()) {
      wx.showToast({ title: '暂无记录', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: text,
      success: () => wx.showModal({
        title: '已复制 JSONL',
        content: '格式与 Android / iOS 客户端完全一致，可直接粘贴保存为 lightmem_history.jsonl。',
        showCancel: false,
      }),
    })
  },

  onImport() {
    wx.getClipboardData({
      success: (res) => {
        const n = store.importHistoryJSONL(res.data)
        logger.info('history', `导入 ${n} 条记录`)
        this.reload()
        wx.showToast({ title: `导入 ${n} 条`, icon: 'none' })
      },
      fail: () => wx.showToast({ title: '读取剪贴板失败', icon: 'none' }),
    })
  },

  onPullDownRefresh() {
    this.reload()
    wx.stopPullDownRefresh()
  },
})
