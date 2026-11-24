/**
 * Rotating diagnostics log written into wx.env.USER_DATA_PATH, matching the
 * Android / iOS clients' 512 KB rotation and `[time] [LEVEL] [tag] message`
 * line shape. Uses the *Sync FileSystemManager APIs so appending is atomic
 * from the caller's point of view (no interleaved writes on a busy stream).
 */
const config = require('./config.js')
const fmt = require('./format.js')

function filePath(name) {
  const base = (wx.env && wx.env.USER_DATA_PATH) || ''
  return `${base}/${name || config.KEYS.logFile}`
}

function fs() {
  return wx.getFileSystemManager()
}

function readText(path) {
  try {
    const r = fs().readFileSync(path, 'utf8')
    return typeof r === 'string' ? r : ''
  } catch (e) {
    return ''
  }
}

function writeText(path, text) {
  try {
    fs().writeFileSync(path, text, 'utf8')
  } catch (e) {}
}

function rotateIfNeeded(text) {
  // JS strings are UTF-16; estimate bytes conservatively at 2 bytes/char for
  // CJK content so we never exceed the intended cap.
  if (text.length * 2 < config.LOG_MAX_BYTES) return text
  const tail = text.slice(Math.floor(text.length / 2))
  writeText(filePath(config.KEYS.logFileOld), tail)
  return tail
}

function append(level, tag, message) {
  const line = `[${fmt.formatTime(Date.now())}] [${level}] [${tag}] ${message}`
  const path = filePath()
  const current = rotateIfNeeded(readText(path))
  writeText(path, current + line + '\n')
  return line
}

function info(tag, message) { return append('INFO', tag, message) }
function warn(tag, message) { return append('WARN', tag, message) }
function error(tag, message) { return append('ERROR', tag, message) }
function debug(tag, message) { return append('DEBUG', tag, message) }

function lines() {
  return readText(filePath())
    .split('\n')
    .filter((l) => l.trim())
    .reverse()
}

function clear() {
  writeText(filePath(), '')
  try { fs().unlinkSync(filePath(config.KEYS.logFileOld)) } catch (e) {}
}

function rawText() {
  return readText(filePath())
}

module.exports = { info, warn, error, debug, lines, clear, rawText, filePath }
