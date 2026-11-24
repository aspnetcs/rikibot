function pad(n) {
  return n < 10 ? '0' + n : String(n)
}

function formatTime(ts) {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function formatDateTime(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${formatTime(ts)}`
}

function formatLatency(ms) {
  if (ms === null || ms === undefined || ms < 0) return '--'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

function shortID(id, head, tail) {
  if (!id) return ''
  const h = head || 8
  const t = tail || 4
  return id.length <= h + t + 2 ? id : `${id.slice(0, h)}…${id.slice(-t)}`
}

function trimBaseURL(url) {
  let s = String(url || '').trim()
  while (s.endsWith('/')) s = s.slice(0, -1)
  return s
}

/** Absolute URLs pass through; relative paths are joined onto the API base. */
function resolveURL(base, path) {
  const p = String(path || '')
  if (/^https?:\/\//i.test(p)) return p
  const b = trimBaseURL(base)
  return b + (p.startsWith('/') ? p : '/' + p)
}

/** Generate a run id similar to the Android client's UUID-ish token. */
function newRunID() {
  const t = Date.now().toString(36)
  let r = ''
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  for (let i = 0; i < 10; i++) r += chars.charAt(Math.floor(Math.random() * chars.length))
  return `wx-${t}-${r}`
}

module.exports = {
  pad,
  formatTime,
  formatDateTime,
  formatLatency,
  shortID,
  trimBaseURL,
  resolveURL,
  newRunID,
}
