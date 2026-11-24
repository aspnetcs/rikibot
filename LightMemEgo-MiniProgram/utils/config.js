/**
 * Compile-time defaults. Mirrors Android `LightMemEgoConfig` / iOS `LightMemConfig`
 * so the wire format stays identical across all three clients.
 */
const INPUT_MODE = 'rokid_frame_audio'
const CHUNK_DURATION = 1
const CLIENT_SOURCE = 'glasses'
const SDK_TAG = 'wechat_miniprogram_camera2d'

const AUDIO_SAMPLE_RATE = 16000
const AUDIO_CHANNELS = 1
const AUDIO_BITS = 16
/** 16 kHz * 16 bit * 1 channel = 32 000 bytes per second. */
const PCM_BYTES_PER_SEC = (AUDIO_SAMPLE_RATE * AUDIO_BITS * AUDIO_CHANNELS) / 8
const AUDIO_CHUNK_MS = 1000

const FRAME_CAPTURE_SIZE = 'medium'
const JPEG_QUALITY = 0.75

const STATUS_POLL_MS = 2000
const QUERY_POLL_INTERVAL_MS = 900
const QUERY_POLL_TIMEOUT_MS = 600000
const HTTP_TIMEOUT_MS = 120000
const VOICE_QUESTION_MAX_MS = 15000

const MAX_HISTORY = 500
const LOG_MAX_BYTES = 512 * 1024

const KEYS = {
  settings: 'lightmem_ego_settings',
  session: 'lightmem_ego_session',
  history: 'lightmem_ego_history',
  logFile: 'lightmem_ego_diagnostics.log',
  logFileOld: 'lightmem_ego_diagnostics.old.log',
}

const PRESET_QUESTIONS = [
  'What is in the current scene?',
  'What just happened',
  'What did they just say?',
  'Summarize everything so far.',
]

const defaultSettings = {
  /** Upstream demo server. Kept for reference only: a published build cannot
   *  reach it without it being whitelisted in 服务器域名, and it is not the
   *  Rikibot X4 backend. Switch back to this line only when the mini program
   *  has an ICP-filed HTTPS domain registered for it.
   *  apiBaseURL: 'https://lightmem-ego.zjukg.cn/api',
   *
   * Local backend (Docker stack on the PC, port 8000, no /api suffix). A fresh
   * development build starts here so the app is usable on first launch; change
   * it in 设置 if the PC's LAN address moves. Must match the `--backend` the car
   * bridge publishes to. */
  apiBaseURL: 'http://10.41.222.192:8000',
  /** Optional direct link to the car's own HTTP service (tools/car_http_server.py
   *  in rikibot-x4), e.g. http://192.168.137.181:8080 — picture only, no memory. */
  carCameraURL: '',
  frameIntervalMs: 1000,
  lens: 'back',
  themeMode: 'system',
  autoPlayAnswer: true,
  answerTTSEnabled: false,
  presetQuestions: PRESET_QUESTIONS.slice(),
}

module.exports = {
  INPUT_MODE,
  CHUNK_DURATION,
  CLIENT_SOURCE,
  SDK_TAG,
  AUDIO_SAMPLE_RATE,
  AUDIO_CHANNELS,
  AUDIO_BITS,
  PCM_BYTES_PER_SEC,
  AUDIO_CHUNK_MS,
  FRAME_CAPTURE_SIZE,
  JPEG_QUALITY,
  STATUS_POLL_MS,
  QUERY_POLL_INTERVAL_MS,
  QUERY_POLL_TIMEOUT_MS,
  HTTP_TIMEOUT_MS,
  VOICE_QUESTION_MAX_MS,
  MAX_HISTORY,
  LOG_MAX_BYTES,
  KEYS,
  PRESET_QUESTIONS,
  defaultSettings,
}
