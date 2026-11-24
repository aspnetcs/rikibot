/**
 * Minimal WAV muxer. Byte-for-byte identical to the Android / iOS clients:
 * 44-byte RIFF header + raw 16 kHz mono 16-bit little-endian PCM.
 */
const HEADER_BYTES = 44

function concat(chunks, totalBytes) {
  const out = new Uint8Array(totalBytes)
  let offset = 0
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i] instanceof Uint8Array ? chunks[i] : new Uint8Array(chunks[i])
    out.set(c, offset)
    offset += c.length
  }
  return out
}

function pcmToWav(pcm, sampleRate, channels, bits) {
  const sr = sampleRate || 16000
  const ch = channels || 1
  const bps = bits || 16
  const data = pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm)
  const byteRate = (sr * ch * bps) / 8
  const blockAlign = (ch * bps) / 8

  const buffer = new ArrayBuffer(HEADER_BYTES + data.length)
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)

  function ascii(offset, text) {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i) & 0xff
  }

  ascii(0, 'RIFF')
  view.setUint32(4, 36 + data.length, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, ch, true)
  view.setUint32(24, sr, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bps, true)
  ascii(36, 'data')
  view.setUint32(40, data.length, true)
  bytes.set(data, HEADER_BYTES)
  return buffer
}

/** Verify a buffer we produced/loaded is a plausible WAV file. */
function isWav(buffer) {
  if (!buffer || buffer.byteLength < HEADER_BYTES) return false
  const b = new Uint8Array(buffer)
  return b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45
}

module.exports = { HEADER_BYTES, concat, pcmToWav, isWav }
