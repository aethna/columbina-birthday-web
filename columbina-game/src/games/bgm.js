import { getPreparedAssetBlob } from './resourceLoader.js'

let audioContext
let current
let activeSource = ''
let requestId = 0
const buffers = new Map()
const volume = 0.18

function context() {
  if (typeof window === 'undefined' || !window.AudioContext) return null
  audioContext ||= new window.AudioContext()
  if (audioContext.state === 'suspended') audioContext.resume().catch(() => {})
  return audioContext
}

async function loadBuffer(source, ctx) {
  if (!buffers.has(source)) {
    buffers.set(source, (async () => {
      // The game resource scheduler retains completed BGM bytes. Reuse them here so
      // "prepared" audio does not immediately trigger a second full fetch for decode.
      const prepared = getPreparedAssetBlob(source)
      const data = prepared
        ? await prepared.arrayBuffer()
        : await fetch(source).then((response) => {
          if (!response.ok) throw new Error(`BGM 下载失败：${response.status}`)
          return response.arrayBuffer()
        })
      return ctx.decodeAudioData(data)
    })())
  }
  return buffers.get(source)
}

export async function setBgm(source) {
  const ctx = context()
  if (!ctx || (source === activeSource && current)) return
  activeSource = source
  const thisRequest = ++requestId
  try {
    const buffer = await loadBuffer(source, ctx)
    if (thisRequest !== requestId) return
    const now = ctx.currentTime
    const gain = ctx.createGain()
    const node = ctx.createBufferSource()
    node.buffer = buffer
    node.loop = true
    gain.gain.setValueAtTime(0, now)
    node.connect(gain).connect(ctx.destination)
    node.start(now)
    if (current) {
      current.gain.gain.cancelScheduledValues(now)
      current.gain.gain.setValueAtTime(current.gain.gain.value, now)
      current.gain.gain.linearRampToValueAtTime(0, now + 0.9)
      current.node.stop(now + 0.95)
    }
    gain.gain.linearRampToValueAtTime(volume, now + 0.9)
    current = { node, gain }
  } catch {}
}

/* 立即停止当前 BGM（离开页面时调用，防止 Web Audio 在 bfcache 里继续发声） */
export function stopBgm() {
  requestId += 1
  activeSource = ''
  if (!current) return
  try { current.node.stop() } catch {}
  try { current.node.disconnect() } catch {}
  try { current.gain.disconnect() } catch {}
  current = undefined
}

/* 挂起 / 恢复 AudioContext */
export function suspendBgm() {
  if (audioContext && audioContext.state === 'running') audioContext.suspend().catch(() => {})
}

export function resumeBgm() {
  if (audioContext && audioContext.state === 'suspended') audioContext.resume().catch(() => {})
}
