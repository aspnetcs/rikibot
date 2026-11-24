/**
 * Tolerant JSON helpers, equivalent to Android's `firstNonBlankString`,
 * `firstIntOrNull` / `optBoolean`; and iOS's `JSONMap`.
 *
 * The backend mixes snake_case and camelCase and occasionally returns numbers
 * as strings, so every read goes through these helpers.
 */

function isMeaningful(value) {
  if (value === null || value === undefined) return false
  const s = String(value).trim()
  return s !== '' && s.toLowerCase() !== 'null' && s.toLowerCase() !== 'none'
}

function str(obj) {
  if (!obj || typeof obj !== 'object') return ''
  // arguments after obj are candidate key names
  for (let i = 1; i < arguments.length; i++) {
    const v = obj[arguments[i]]
    if (typeof v === 'string' && isMeaningful(v)) return v.trim()
    if (typeof v === 'number' && isFinite(v)) return String(v)
  }
  return ''
}

function int(obj) {
  if (!obj || typeof obj !== 'object') return null
  for (let i = 1; i < arguments.length; i++) {
    const v = obj[arguments[i]]
    if (v === null || v === undefined) continue
    const n = typeof v === 'number' ? v : parseInt(String(v).trim(), 10)
    if (!isNaN(n) && isFinite(n)) return Math.trunc(n)
  }
  return null
}

function bool(obj, name, fallback) {
  if (!obj || typeof obj !== 'object') return fallback === true
  const v = obj[name]
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    if (s === 'true' || s === '1' || s === 'yes') return true
    if (s === 'false' || s === '0' || s === 'no' || s === '') return false
  }
  return fallback === true
}

function object(obj, name) {
  if (!obj || typeof obj !== 'object') return null
  const v = obj[name]
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null
}

/** wx.request may hand back a JSON string instead of a parsed object. */
function parseObject(data) {
  if (!data) return {}
  if (typeof data === 'string') {
    const t = data.trim()
    if (!t) return {}
    try {
      const v = JSON.parse(t)
      return v && typeof v === 'object' ? v : {}
    } catch (e) {
      return {}
    }
  }
  if (typeof data === 'object' && !Array.isArray(data)) return data
  return {}
}

function extractAnswer(json) {
  const direct = str(json, 'answer', 'final_answer', 'response', 'text')
  if (direct) return direct
  const result = object(json, 'result')
  return result ? str(result, 'answer') : ''
}

function extractAnswerAudioURL(json) {
  const direct = str(json, 'answer_audio_url', 'answerAudioUrl')
  if (direct) return direct
  const result = object(json, 'result')
  return result ? str(result, 'answer_audio_url', 'answerAudioUrl') : ''
}

module.exports = {
  isMeaningful,
  str,
  int,
  bool,
  object,
  parseObject,
  extractAnswer,
  extractAnswerAudioURL,
}
