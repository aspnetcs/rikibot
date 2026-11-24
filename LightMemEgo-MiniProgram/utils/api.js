/**
 * HTTP client for the LightMem-Ego backend.
 *
 * Path names, request bodies and multipart field names are copied verbatim from
 * the Android `LightMemEgoApiClient` (and the iOS port), so the existing
 * `rokid_frame_audio` server needs ZERO changes. The only transport difference
 * is that wx.uploadFile takes a local temp file instead of an in-memory byte
 * array -- camera.js writes JPEGs and recorder.js writes WAVs to USER_DATA_PATH.
 */
const config = require('./config.js')
const j = require('./json.js')
const fmt = require('./format.js')

function fail(message, statusCode) {
  const e = new Error(message)
  e.statusCode = statusCode === undefined ? -1 : statusCode
  return e
}

/**
 * WeChat rejects a request BEFORE it leaves the device when the URL's host is
 * not in the mini program's 服务器域名 whitelist, and the raw errMsg
 * ("url not in domain list") reads exactly like a network fault — which sends
 * people off debugging the backend, the firewall and the LAN. Name the real
 * cause instead, so the displayed error tells you what to actually change.
 */
function transportFail(prefix, url, errMsg) {
  const raw = String((errMsg && (errMsg.errMsg || errMsg.message)) || errMsg || 'network error')
  if (/url not in domain list/i.test(raw)) {
    return fail(
      `${prefix} ${url}：域名未加入「服务器域名」白名单。` +
      '真机/体验版/试用版会在请求发出前拦截，改 IP 也不生效；' +
      '需在小程序后台添加该域名，或在开发者工具关闭域名校验后用「真机调试」打开'
    )
  }
  if (/ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_INTERNET|ERR_ADDRESS|ERR_PROXY/i.test(raw)) {
    return fail(`${prefix} ${url}：网络不可达（${raw}），检查手机与后端是否同一局域网`)
  }
  if (/timeout/i.test(raw)) {
    return fail(`${prefix} ${url}：请求超时（${raw}），后端可能未启动或防火墙拦截`)
  }
  return fail(`${prefix} ${url}: ${raw}`)
}

/**
 * Self-hosted backends (e.g. the Docker stack used by the Rikibot X4 car on
 * http://<PC-IP>:8000) do not return day_context from /rokid/stream/start,
 * while the hosted demo API does. Fall back to a local day label so the same
 * client works against both without changing the server.
 */
function fallbackDayContext(runID) {
  const d = new Date()
  const pad = (n) => (n < 10 ? '0' + n : String(n))
  return {
    day_label: 'Day 1',
    day_index: 1,
    display_day_label: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    weekday_label: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()],
    run_id: runID,
    relative_ts_base_ms: 0,
  }
}

function trimBase(url) {
  return fmt.trimBaseURL(url)
}

class APIClient {
  constructor(settings) {
    this.settings = settings || {}
    this.paths = {}
  }

  setSettings(settings) {
    this.settings = settings || {}
  }

  get baseURL() {
    return trimBase(this.settings.apiBaseURL || config.defaultSettings.apiBaseURL)
  }

  get answerTTS() {
    return !!this.settings.answerTTSEnabled
  }

  resolveURL(path) {
    return fmt.resolveURL(this.baseURL, path)
  }

  pathFor(sid, kind, fallback) {
    const p = this.paths[sid]
    return (p && p[kind]) || fallback
  }

  /* ------------------------------------------------------------- transport */

  request(path, method, body) {
    const url = this.resolveURL(path)
    const header = { Accept: 'application/json' }
    if (body !== undefined && body !== null) {
      header['Content-Type'] = 'application/json; charset=utf-8'
    }
    return new Promise((resolve, reject) => {
      wx.request({
        url,
        method: method || 'GET',
        data: body === undefined || body === null ? undefined : body,
        header,
        dataType: 'json',
        responseType: 'text',
        timeout: config.HTTP_TIMEOUT_MS,
        success: (res) => {
          const code = res.statusCode || 0
          const json = j.parseObject(res.data)
          if (code >= 200 && code < 300) {
            resolve(json)
          } else {
            const msg = j.str(json, 'message') || (typeof res.data === 'string' ? res.data : '') || `HTTP ${code}`
            reject(fail(`HTTP ${code} ${url}: ${msg}`, code))
          }
        },
        fail: (err) => reject(transportFail('请求失败', url, err)),
      })
    })
  }

  /**
   * wx.uploadFile always builds multipart/form-data. field order differs from
   * the Android client, but multipart parsing is order-independent and every
   * field name/value is identical.
   */
  upload(path, opts) {
    const url = this.resolveURL(path)
    return new Promise((resolve, reject) => {
      wx.uploadFile({
        url,
        filePath: opts.filePath,
        name: opts.fileField,
        formData: opts.fields || {},
        header: { Accept: 'application/json' },
        timeout: config.HTTP_TIMEOUT_MS,
        success: (res) => {
          const code = res.statusCode || 0
          const json = j.parseObject(res.data)
          if (code >= 200 && code < 300) {
            resolve(json)
          } else {
            const msg = j.str(json, 'message') || (typeof res.data === 'string' ? res.data : '') || `HTTP ${code}`
            reject(fail(`HTTP ${code} ${url}: ${msg}`, code))
          }
        },
        fail: (err) => reject(transportFail('上传失败', url, err)),
      })
    })
  }

  postJSON(path, body) {
    return this.request(path, 'POST', body)
  }

  getJSON(path) {
    return this.request(path, 'GET', null)
  }

  /**
   * Discover a stream that the car / glasses is already publishing.
   * Mirrors the desktop client's getActiveRokidStream(): when a session is
   * active we ATTACH to it instead of creating a second, empty session.
   * The self-hosted backend returns {active, session_id, input_mode, ...};
   * the demo/mock backend may not implement this endpoint at all.
   */
  getActiveStream() {
    const bool = (v) => v === true || v === 'true' || v === 1
    const str = (v) => (v === undefined || v === null ? '' : String(v))
    const num = (v) => {
      const n = parseInt(v, 10)
      return isNaN(n) ? 0 : n
    }
    return this.getJSON('/rokid/stream/active').then((json) => {
      const raw = json || {}
      const sid = str(raw.session_id || raw.sessionId)
      const rokid = (raw.rokid && typeof raw.rokid === 'object') ? raw.rokid : {}
      return {
        active: bool(raw.active) && !!sid,
        sessionID: sid,
        inputMode: str(raw.input_mode || raw.inputMode) || config.INPUT_MODE,
        canAsk: bool(raw.can_ask === undefined ? raw.canAsk : raw.can_ask),
        streamStatus: str(raw.stream_status || raw.status),
        framesReceived: num(rokid.frames_received === undefined ? rokid.framesReceived : rokid.frames_received),
        audioChunksReceived: num(rokid.audio_chunks_received === undefined ? rokid.audioChunksReceived : rokid.audio_chunks_received),
        statusURL: str(raw.status_url || raw.statusUrl),
        raw,
      }
    })
  }

  /* ---------------------------------------------------------- stream start */

  startStream(runID, sessionID) {
    const requested = String(sessionID || '').trim()
    const metadata = {
      source: 'rokid_glass',
      device_type: 'rokid',
      transport: 'http_frame_audio',
      sdk: config.SDK_TAG,
      timestamp_mode: 'connector_relative_ts_ms',
      run_id: runID,
      rokid_session_mode: 'single_session',
      client_platform: 'miniprogram',
    }
    const body = {
      input_mode: config.INPUT_MODE,
      chunk_duration: config.CHUNK_DURATION,
      run_id: runID,
      metadata,
    }
    if (requested) body.session_id = requested

    return this.postJSON('/rokid/stream/start', body).then((json) => {
      const result = this.parseStartResult(json, runID)
      this.paths[result.sessionID] = {
        frame: result.frameUploadPath,
        audio: result.audioUploadPath,
        status: result.statusPath,
        audioQuestion: result.audioQuestionPath,
      }
      return result
    })
  }

  parseStartResult(json, runID) {
    const sid = j.str(json, 'session_id')
    const day = j.object(json, 'day_context') || j.object(json, 'dayContext') || fallbackDayContext(runID)
    const dayLabel = j.str(day, 'day_label', 'dayLabel')
    const dayIndex = j.int(day, 'day_index', 'dayIndex', 'index')
    const displayDayLabel = j.str(day, 'display_day_label', 'displayDayLabel', 'date', 'date_label', 'dateLabel')
    if (!dayLabel) throw fail('day_context missing day_label')
    if (dayIndex === null) throw fail('day_context missing day_index')
    if (!displayDayLabel) throw fail('day_context missing display_day_label')

    const firstInt = (o, a, b) => {
      const v = j.int(o, a, b)
      return v === null ? null : v
    }
    const nextFrameIndex = firstInt(json, 'next_frame_index', 'nextFrameIndex') !== null
      ? firstInt(json, 'next_frame_index', 'nextFrameIndex')
      : (j.int(day, 'next_frame_index', 'nextFrameIndex') || 0)
    const nextAudioIndex = firstInt(json, 'next_audio_index', 'nextAudioIndex') !== null
      ? firstInt(json, 'next_audio_index', 'nextAudioIndex')
      : (j.int(day, 'next_audio_index', 'nextAudioIndex') || 0)
    const relativeTsBaseMs = firstInt(json, 'relative_ts_base_ms', 'relativeTsBaseMs') !== null
      ? firstInt(json, 'relative_ts_base_ms', 'relativeTsBaseMs')
      : (j.int(day, 'relative_ts_base_ms', 'relativeTsBaseMs') || 0)

    return {
      sessionID: sid,
      dayLabel,
      dayIndex,
      displayDayLabel,
      weekdayLabel: j.str(day, 'weekday_label', 'weekdayLabel'),
      runID: j.str(day, 'run_id') || runID,
      streamID: j.str(json, 'stream_id'),
      canAsk: j.bool(json, 'can_ask', false),
      inputMode: j.str(json, 'input_mode') || config.INPUT_MODE,
      frameUploadPath: j.str(json, 'frame_upload_url') || `/rokid/${sid}/frame`,
      audioUploadPath: j.str(json, 'audio_upload_url') || `/rokid/${sid}/audio_chunk`,
      statusPath: j.str(json, 'status_url') || `/rokid/${sid}/status`,
      audioQuestionPath: j.str(json, 'audio_question_url') || `/rokid/${sid}/audio_question`,
      nextFrameIndex: Math.max(0, nextFrameIndex),
      nextAudioIndex: Math.max(0, nextAudioIndex),
      relativeTsBaseMs: Math.max(0, relativeTsBaseMs),
    }
  }

  endStream(sid) {
    return this.postJSON(`/stream/${sid}/end`, {
      close_open_event: true,
      force_accept: true,
    })
  }

  sessionState(sid) {
    return this.getJSON(`/session/${sid}/status`)
  }

  /* --------------------------------------------------------------- uploads */

  uploadFrame(sid, opts) {
    const path = this.pathFor(sid, 'frame', `/rokid/${sid}/frame`)
    const fields = {
      frame_index: String(opts.frameIndex),
      relative_ts_ms: String(opts.relativeTsMs),
      client_ts_ms: String(Date.now()),
      format: 'jpg',
      source: 'rokid_sdk_video',
      width: String(opts.width),
      height: String(opts.height),
    }
    return this.upload(path, {
      filePath: opts.filePath,
      fileField: 'frame',
      fields,
    }).then((json) => ({
      status: j.str(json, 'status'),
      canAsk: j.bool(json, 'can_ask', false) || j.bool(json, 'mcur_ready', false),
    }))
  }

  uploadAudioChunk(sid, opts) {
    const path = this.pathFor(sid, 'audio', `/rokid/${sid}/audio_chunk`)
    const fields = {
      audio_index: String(opts.audioIndex),
      relative_ts_ms: String(opts.relativeTsMs),
      client_ts_ms: String(Date.now()),
      duration_ms: String(opts.durationMs),
      format: 'wav',
      sample_rate: String(config.AUDIO_SAMPLE_RATE),
      channels: String(config.AUDIO_CHANNELS),
      source: 'rokid_sdk_audio',
    }
    return this.upload(path, {
      filePath: opts.filePath,
      fileField: 'audio',
      fields,
    }).then((json) => ({
      status: j.str(json, 'status'),
      canAsk: j.bool(json, 'can_ask', false),
    }))
  }

  /* ---------------------------------------------------------------- status */

  memoryReady(sid) {
    return this.getJSON(`/session/${sid}/pipeline_state`)
      .then((json) => {
        const st = j.object(json, 'short_term')
        return st ? j.bool(st, 'ready', false) : false
      })
      .catch(() => false)
  }

  /**
   * Long-term memory readiness probe (browse / graph only).
   * The self-hosted backend serves GET /session/{sid}/memories and
   * GET /memories/catalog. Both can legitimately answer 503
   * `memory_component_lagging` while incremental components rebuild —
   * /ask keeps working in that state, so this is diagnostic, never a gate.
   */
  memoryStatus(sid) {
    const num = (v) => {
      const n = parseInt(v, 10)
      return isNaN(n) ? 0 : n
    }
    const str = (v) => (v === undefined || v === null ? '' : String(v))
    const out = { sessionReady: false, sessionState: '', readySessions: 0 }
    const sessionCall = this.getJSON(`/session/${sid}/memories`)
      .then((json) => {
        out.sessionReady = json.ready === true || str(json.status) === 'ready'
        out.sessionState = str(json.status) || (out.sessionReady ? 'ready' : 'unknown')
      })
      .catch((e) => {
        out.sessionState = e.statusCode === 503 ? 'memory_component_lagging' : (e.message || 'unavailable')
      })
    const catalogCall = this.getJSON('/memories/catalog')
      .then((json) => { out.readySessions = num(json.total_ready_sessions) })
      .catch(() => {})
    return Promise.all([sessionCall, catalogCall]).then(() => out)
  }

  streamStatus(sid) {
    const path = this.pathFor(sid, 'status', `/rokid/${sid}/status`)
    return Promise.all([this.getJSON(path), this.memoryReady(sid)]).then((values) => {
      const json = values[0]
      const rokid = j.object(json, 'rokid') || {}
      return {
        streamStatus: j.str(json, 'stream_status', 'status'),
        canAsk: j.bool(json, 'can_ask', false),
        memoryReady: values[1],
        framesReceived: j.int(rokid, 'frames_received') || 0,
        audioChunksReceived: j.int(rokid, 'audio_chunks_received') || 0,
        latestFrameTsMs: j.int(rokid, 'latest_frame_relative_ts_ms'),
        latestAudioTsMs: j.int(rokid, 'latest_audio_relative_ts_ms'),
      }
    })
  }

  /* -------------------------------------------------------------- questions */

  askQuestion(sid, question, inputMethod) {
    const body = {
      question,
      mode: 'async',
      retrieval_mode: 'auto',
      memory_mode: 'auto',
      top_k: 5,
      use_current: true,
      use_image_evidence: 'auto',
      max_image_evidence: 6,
      debug_router: false,
      use_interaction_cache: true,
      answer_tts: this.answerTTS,
      client_source: config.CLIENT_SOURCE,
      input_method: inputMethod || 'preset',
    }
    return this.postJSON(`/ask/${sid}`, body).then((json) => ({
      status: j.str(json, 'status'),
      queued: j.str(json, 'status') === 'queued' || !!j.str(json, 'task_id', 'taskId'),
      taskID: j.str(json, 'task_id', 'taskId'),
      answer: j.extractAnswer(json),
      answerAudioURL: j.extractAnswerAudioURL(json),
    }))
  }

  askAudioQuestion(sid, filePath, durationMs) {
    const path = this.pathFor(sid, 'audioQuestion', `/rokid/${sid}/audio_question`)
    const tts = String(this.answerTTS)
    const fields = {
      duration_ms: String(durationMs),
      format: 'wav',
      sample_rate: String(config.AUDIO_SAMPLE_RATE),
      channels: String(config.AUDIO_CHANNELS),
      mode: 'async',
      retrieval_mode: 'auto',
      memory_mode: 'auto',
      top_k: '5',
      use_current: 'true',
      use_image_evidence: 'auto',
      max_image_evidence: '6',
      debug_router: 'false',
      use_interaction_cache: 'true',
      answer_tts: tts,
      client_source: config.CLIENT_SOURCE,
      input_method: 'voice',
    }
    return this.upload(path, { filePath, fileField: 'audio', fields }).then((json) => ({
      status: j.str(json, 'status'),
      question: j.str(json, 'question', 'transcript', 'text'),
      queued: j.str(json, 'status') === 'queued' || !!j.str(json, 'task_id', 'taskId'),
      taskID: j.str(json, 'task_id', 'taskId'),
      answer: j.extractAnswer(json),
      answerAudioURL: j.extractAnswerAudioURL(json),
      message: j.str(json, 'message'),
    }))
  }

  queryTask(taskID) {
    return this.getJSON(`/query_task/${taskID}`).then((json) => {
      const status = j.str(json, 'status').toLowerCase() || 'queued'
      return {
        status,
        done: status === 'done',
        answer: j.extractAnswer(json),
        answerAudioURL: j.extractAnswerAudioURL(json),
        message: j.str(json, 'message'),
      }
    })
  }
}

module.exports = { APIClient, fail }
