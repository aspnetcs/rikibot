const store = require('./utils/store.js')
const logger = require('./utils/log.js')
const config = require('./utils/config.js')

App({
  globalData: {
    // Incremented whenever settings are saved, so pages can refresh cheaply.
    settingsVersion: 0,
    themeDark: false,
  },

  onLaunch() {
    store.ensureDefaults()
    logger.info('app', '小程序启动')
    this.applyTheme()
    if (wx.onThemeChange) {
      wx.onThemeChange((res) => {
        if (store.getSettings().themeMode === 'system') {
          this.applyTheme(res.theme === 'dark')
        }
      })
    }
  },

  onShow() {
    logger.info('app', '回到前台')
  },

  /**
   * iOS / Android both suspend camera + microphone when a mini program goes to
   * the background. End the stream explicitly so the backend does not keep a
   * half-open session. Page-level onHide is NOT used here: switching tabs also
   * fires onHide, and that must not stop an active session.
   */
  onHide() {
    logger.info('app', '切到后台，结束采集')
    const pages = getCurrentPages() || []
    const sessionPage = pages.find((p) => p.route === 'pages/session/session')
    if (sessionPage && typeof sessionPage.onAppBackground === 'function') {
      sessionPage.onAppBackground()
    }
  },

  applyTheme(forcedDark) {
    const s = store.getSettings()
    let dark = false
    if (typeof forcedDark === 'boolean') {
      dark = forcedDark
    } else if (s.themeMode === 'dark') {
      dark = true
    } else if (s.themeMode === 'light') {
      dark = false
    } else if (wx.getSystemInfoSync) {
      dark = wx.getSystemInfoSync().theme === 'dark'
    }
    this.globalData.themeDark = dark
    if (wx.setNavigationBarColor) {
      wx.setNavigationBarColor({
        frontColor: dark ? '#ffffff' : '#ffffff',
        backgroundColor: dark ? '#101113' : '#101113',
      })
    }
  },

  bumpSettings() {
    this.globalData.settingsVersion += 1
    this.applyTheme()
  },

  /** Keys kept in sync with Android SharedPreferences / iOS UserDefaults. */
  defaultSettings() {
    return config.defaultSettings
  },
})
