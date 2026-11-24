/**
 * Local persistence.
 *
 * Settings use the SAME per-key names as Android SharedPreferences / iOS
 * UserDefaults, so behaviour (and any migrated values) lines up across clients.
 * History is kept in storage for speed, but is exported as the exact same
 * `{"entry": {...}}` JSONL format the Android client writes.
 */
const config = require('./config.js')
const j = require('./json.js')

const K = {
  api: 'api_base_url',
  carCamera: 'car_camera_url',
  tts: 'answer_tts_enabled',
  lens: 'lens_facing_front',
  theme: 'theme_mode',
  presets: 'preset_questions',
  interval: 'frame_interval_ms',
  autoPlay: 'auto_play_answer',
}

const SESSION_K = {
  id: 'last_session_id',
  display: 'last_display_day_label',
  dayIndex: 'last_day_index',
}

function get(key) {
  try {
    return wx.getStorageSync(key)
  } catch (e) {
    return ''
  }
}

function set(key, value) {
  try {
    wx.setStorageSync(key, value)
  } catch (e) {
    // Storage full or unavailable: settings are a convenience, not a hard dependency.
  }
}

function remove(key) {
  try {
    wx.removeStorageSync(key)
  } catch (e) {}
}

function ensureDefaults() {
  // No-op on first launch; getSettings() fills in defaults lazily. Kept as an
  // explicit hook so app.js has a single place to add migrations later.
  getSettings()
}

function getSettings() {
  const d = config.defaultSettings
  const api = String(get(K.api) || '').trim()
  const interval = parseInt(get(K.interval), 10)
  const rawPresets = get(K.presets)
  let presets = d.presetQuestions.slice()
  if (typeof rawPresets === 'string' && rawPresets.trim()) {
    const parsed = rawPresets.split('\n').map((s) => s.trim()).filter(Boolean)
    if (parsed.length) presets = parsed
  } else if (Array.isArray(rawPresets) && rawPresets.length) {
    presets = rawPresets.slice()
  }
  const theme = String(get(K.theme) || d.themeMode)
  const tts = get(K.tts)
  const lens = get(K.lens)
  const autoPlay = get(K.autoPlay)
  return {
    apiBaseURL: api || d.apiBaseURL,
    carCameraURL: String(get(K.carCamera) || '').trim(),
    answerTTSEnabled: typeof tts === 'boolean' ? tts : d.answerTTSEnabled,
    lensFacingFront: lens === true,
    lens: lens === true ? 'front' : 'back',
    themeMode: ['system', 'light', 'dark'].indexOf(theme) >= 0 ? theme : d.themeMode,
    frameIntervalMs: !isNaN(interval) && interval > 0 ? interval : d.frameIntervalMs,
    presetQuestions: presets,
    autoPlayAnswer: typeof autoPlay === 'boolean' ? autoPlay : d.autoPlayAnswer,
  }
}

function normalize(s) {
  const d = config.defaultSettings
  let interval = parseInt(s.frameIntervalMs, 10)
  if (isNaN(interval) || interval < 500) interval = d.frameIntervalMs
  if (interval > 10000) interval = 10000
  const presets = (s.presetQuestions || [])
    .map((q) => String(q || '').trim())
    .filter(Boolean)
    .slice(0, 8)
  return {
    apiBaseURL: String(s.apiBaseURL || '').trim() || d.apiBaseURL,
    carCameraURL: String(s.carCameraURL || '').trim(),
    answerTTSEnabled: !!s.answerTTSEnabled,
    lensFacingFront: s.lens === 'front' || s.lensFacingFront === true,
    themeMode: ['system', 'light', 'dark'].indexOf(s.themeMode) >= 0 ? s.themeMode : 'system',
    frameIntervalMs: interval,
    presetQuestions: presets.length ? presets : d.presetQuestions.slice(),
    autoPlayAnswer: s.autoPlayAnswer !== false,
  }
}

function saveSettings(s) {
  const n = normalize(s)
  set(K.api, n.apiBaseURL)
  set(K.carCamera, n.carCameraURL)
  set(K.tts, n.answerTTSEnabled)
  set(K.lens, n.lensFacingFront)
  set(K.theme, n.themeMode)
  set(K.presets, n.presetQuestions.join('\n'))
  set(K.interval, n.frameIntervalMs)
  set(K.autoPlay, n.autoPlayAnswer)
  return n
}

function resetSettings() {
  Object.keys(K).forEach((k) => remove(K[k]))
  return getSettings()
}

/* ---------------------------------------------------------------- session */

function getSavedSession() {
  const id = String(get(SESSION_K.id) || '').trim()
  if (!id) return null
  return {
    sessionID: id,
    displayDayLabel: String(get(SESSION_K.display) || ''),
    dayIndex: parseInt(get(SESSION_K.dayIndex), 10) || 0,
  }
}

function saveSession(result) {
  if (!result || !result.sessionID) return
  set(SESSION_K.id, result.sessionID)
  set(SESSION_K.display, result.displayDayLabel || '')
  set(SESSION_K.dayIndex, result.dayIndex || 0)
}

function clearSession() {
  Object.keys(SESSION_K).forEach((k) => remove(SESSION_K[k]))
}

/* ---------------------------------------------------------------- history */

function uuid() {
  const t = Date.now().toString(36)
  let r = ''
  for (let i = 0; i < 8; i++) r += Math.floor(Math.random() * 16).toString(16)
  return `${t}-${r}`
}

function getHistory() {
  const raw = get(config.KEYS.history)
  const list = Array.isArray(raw) ? raw : []
  return list
    .map((e) => normalizeEntry(e))
    .filter(Boolean)
    .sort((a, b) => b.timestampMs - a.timestampMs)
}

function normalizeEntry(e) {
  if (!e || typeof e !== 'object') return null
  const question = String(e.question || '')
  const answer = String(e.answer || '')
  if (!question.trim() && !answer.trim()) return null
  return {
    id: String(e.id || uuid()),
    timestampMs: Number(e.timestampMs || e.timestamp_ms || Date.now()),
    sessionId: String(e.sessionId || e.session_id || ''),
    question,
    answer,
    source: String(e.source || 'unknown'),
    latencyMs: e.latencyMs === undefined ? null : Number(e.latencyMs),
  }
}

function addHistory(entry) {
  const e = normalizeEntry(Object.assign({ id: uuid(), timestampMs: Date.now() }, entry))
  if (!e) return null
  const list = getHistory()
  list.unshift(e)
  set(config.KEYS.history, list.slice(0, config.MAX_HISTORY))
  return e
}

function deleteHistory(id) {
  set(config.KEYS.history, getHistory().filter((e) => e.id !== id))
}

function clearHistory() {
  remove(config.KEYS.history)
}

/** Android-compatible JSONL: one `{"entry": {...}}` object per line. */
function exportHistoryJSONL() {
  return getHistory().map((e) => {
    const payload = {
      id: e.id,
      timestamp_ms: e.timestampMs,
      session_id: e.sessionId,
      question: e.question,
      answer: e.answer,
      source: e.source,
    }
    return JSON.stringify({ entry: payload })
  }).join('\n') + '\n'
}

/** Import JSONL produced by the Android / iOS clients. */
function importHistoryJSONL(text) {
  let count = 0
  String(text || '').split('\n').forEach((line) => {
    if (!line.trim()) return
    try {
      const obj = JSON.parse(line)
      const e = j.object(obj, 'entry') || obj
      if (addHistory({
        id: j.str(e, 'id'),
        timestampMs: j.int(e, 'timestamp_ms', 'timestampMs'),
        sessionId: j.str(e, 'session_id', 'sessionId'),
        question: j.str(e, 'question'),
        answer: j.str(e, 'answer'),
        source: j.str(e, 'source'),
      })) count += 1
    } catch (err) {
      // Skip malformed lines, same as the Android loader.
    }
  })
  return count
}

module.exports = {
  K,
  ensureDefaults,
  getSettings,
  normalize,
  saveSettings,
  resetSettings,
  getSavedSession,
  saveSession,
  clearSession,
  getHistory,
  addHistory,
  deleteHistory,
  clearHistory,
  exportHistoryJSONL,
  importHistoryJSONL,
}
