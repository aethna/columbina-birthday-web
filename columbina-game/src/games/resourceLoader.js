const IMAGE_PATTERN = /\.(avif|gif|jpe?g|png|webp)(?:\?|$)/i
const AUDIO_PATTERN = /\.(aac|flac|m4a|mp3|ogg|opus|wav|weba)(?:\?|$)/i

export const RESOURCE_TIMEOUTS = Object.freeze({
  responseHeadersMs: 30_000,
  bodyIdleMs: 20_000,
  absoluteMs: 240_000,
})

const PRIORITY = Object.freeze({ foreground: 0, background: 1 })

function abortError(reason = 'cancelled') {
  const error = typeof DOMException === 'function'
    ? new DOMException('资源加载已取消', 'AbortError')
    : Object.assign(new Error('资源加载已取消'), { name: 'AbortError' })
  error.reason = reason
  return error
}

function now() {
  return globalThis.performance?.now?.() ?? Date.now()
}

function canonicalUrl(url) {
  try { return new URL(url, globalThis.location?.href || 'https://columbina.local/').href }
  catch { return String(url) }
}

function requestKey(url, { method = 'GET', credentials = 'same-origin', mode = 'cors' } = {}) {
  return [method.toUpperCase(), credentials, mode, canonicalUrl(url)].join('\n')
}

function isDebugEnabled() {
  try { return new URLSearchParams(globalThis.location?.search || '').get('load-debug') === '1' }
  catch { return false }
}

function noop() {}

/**
 * Shared, bandwidth-aware resource scheduler. The singleton below is used by the game;
 * exporting the factory keeps timing, cancellation and ordering testable without a DOM.
 */
export function createResourceLoader({
  maxActiveDownloads = 2,
  fetchImpl = (...args) => fetch(...args),
  timeouts = RESOURCE_TIMEOUTS,
  diagnostics = null,
  debug = isDebugEnabled(),
  clock = now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const preparedAssets = new Set()
  const preparedResponses = new Map()
  const jobs = new Map()
  const waiting = []
  const active = new Set()
  let sequence = 0
  let promotedSequence = 0
  let backgroundPaused = false

  function snapshot() {
    return {
      activeDownloads: active.size,
      waitingDownloads: waiting.length,
      preparedAssets: preparedAssets.size,
    }
  }

  function jobPriority(job) {
    return [...job.consumers].some((consumer) => consumer.priority() === 'foreground')
      ? 'foreground'
      : 'background'
  }

  function publish(type, job, extra = {}) {
    if (!debug && !diagnostics) return
    const detail = {
      type,
      originalUrl: job?.originalUrl,
      canonicalUrl: job?.url,
      resourceGroups: job ? [...new Set([...job.consumers].map((consumer) => consumer.group).filter(Boolean))] : [],
      priority: job ? jobPriority(job) : undefined,
      state: job?.state,
      queueWaitMs: job?.startedAt && job.queueStartedAt ? Math.round(job.startedAt - job.queueStartedAt) : 0,
      responseHeaderMs: job?.responseAt && job.requestedAt ? Math.round(job.responseAt - job.requestedAt) : null,
      bytesReceived: job?.bytesReceived || 0,
      totalBytes: job?.totalBytes ?? null,
      lastProgressAt: job?.lastProgressAt ?? null,
      cacheSource: job?.cacheSource,
      reason: job?.reason,
      ...snapshot(),
      ...extra,
    }
    diagnostics?.(detail)
    if (!debug || typeof window === 'undefined') return
    const events = window.__COLUMBINA_LOAD_EVENTS__ ||= []
    events.push({ at: Date.now(), ...detail })
    if (events.length > 500) events.splice(0, events.length - 500)
    window.dispatchEvent(new CustomEvent('columbina:asset-load', { detail }))
  }

  function notify(job, type = 'asset:status') {
    const progress = {
      type,
      url: job.url,
      originalUrl: job.originalUrl,
      state: job.state,
      priority: jobPriority(job),
      bytesReceived: job.bytesReceived,
      totalBytes: job.totalBytes,
      cacheSource: job.cacheSource,
      queueWaitMs: job.startedAt && job.queueStartedAt ? Math.round(job.startedAt - job.queueStartedAt) : 0,
      responseHeaderMs: job.responseAt && job.requestedAt ? Math.round(job.responseAt - job.requestedAt) : null,
      reason: job.reason,
      ...snapshot(),
    }
    job.consumers.forEach((consumer) => {
      try { consumer.onUpdate(progress) } catch {}
    })
    publish(type, job)
  }

  function removeWaiting(job) {
    const index = waiting.indexOf(job)
    if (index >= 0) waiting.splice(index, 1)
  }

  function sortWaiting() {
    waiting.sort((left, right) => {
      const priorityDelta = PRIORITY[jobPriority(left)] - PRIORITY[jobPriority(right)]
      return priorityDelta || left.order - right.order
    })
  }

  function preemptForForeground() {
    if (active.size < maxActiveDownloads) return
    const candidate = [...active]
      .filter((job) => jobPriority(job) === 'background')
      .sort((left, right) => right.startedAt - left.startedAt)[0]
    if (candidate) candidate.controller.abort('preempted-by-foreground')
  }

  function pump() {
    sortWaiting()
    while (active.size < maxActiveDownloads && waiting.length) {
      const job = waiting.shift()
      if (!job.consumers.size) {
        jobs.delete(job.key)
        continue
      }
      if (backgroundPaused && jobPriority(job) === 'background') {
        waiting.push(job)
        return
      }
      start(job)
      sortWaiting()
    }
  }

  function settleConsumer(consumer, method, value) {
    if (consumer.settled) return
    consumer.settled = true
    consumer.signal?.removeEventListener('abort', consumer.abort)
    consumer[method](value)
  }

  function detachConsumer(job, consumer, reason = 'cancelled') {
    if (!job.consumers.delete(consumer)) return
    settleConsumer(consumer, 'reject', abortError(reason))
    if (job.consumers.size) {
      if (job.state === 'queued') sortWaiting()
      return
    }
    if (job.state === 'queued') {
      removeWaiting(job)
      job.state = 'cancelled'
      job.reason = reason
      publish('asset:cancelled', job)
      jobs.delete(job.key)
      pump()
    } else if (active.has(job)) {
      job.controller.abort(reason === 'cancelled' ? 'orphaned' : reason)
    }
  }

  function attachConsumer(job, options) {
    return new Promise((resolve, reject) => {
      const consumer = {
        group: options.group || '',
        priority: () => (typeof options.priority === 'function' ? options.priority() : options.priority) === 'foreground' ? 'foreground' : 'background',
        onUpdate: options.onUpdate || noop,
        signal: options.signal,
        resolve,
        reject,
        settled: false,
        abort: null,
      }
      consumer.abort = () => detachConsumer(job, consumer)
      if (consumer.signal?.aborted) {
        settleConsumer(consumer, 'reject', abortError('cancelled'))
        return
      }
      job.consumers.add(consumer)
      consumer.signal?.addEventListener('abort', consumer.abort, { once: true })
      if (job.state === 'queued' && consumer.priority() === 'foreground') {
        job.order = -++promotedSequence
        preemptForForeground()
        sortWaiting()
      } else if (consumer.priority() === 'foreground') {
        preemptForForeground()
      }
      notify(job, job.state === 'queued' ? 'asset:queued' : 'asset:join-existing')
      pump()
    })
  }

  async function readBody(response, job) {
    const contentLength = Number(response.headers?.get?.('content-length'))
    job.totalBytes = Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : null
    if (!response.body?.getReader) {
      const blob = await response.blob()
      job.bytesReceived = blob.size
      job.lastProgressAt = clock()
      notify(job, 'asset:body-complete')
      return blob
    }

    const reader = response.body.getReader()
    const chunks = []
    let idleTimer = 0
    const cancelReader = () => { reader.cancel?.().catch?.(() => {}) }
    job.controller.signal.addEventListener('abort', cancelReader, { once: true })
    const refreshIdleTimeout = () => {
      clearTimer(idleTimer)
      idleTimer = setTimer(() => job.controller.abort('body-idle-timeout'), timeouts.bodyIdleMs)
    }
    try {
      while (true) {
        refreshIdleTimeout()
        const { done, value } = await reader.read()
        clearTimer(idleTimer)
        if (done) break
        if (value?.byteLength) {
          chunks.push(value)
          job.bytesReceived += value.byteLength
          job.lastProgressAt = clock()
          notify(job, 'asset:body-progress')
        }
      }
      job.lastProgressAt ||= clock()
      notify(job, 'asset:body-complete')
      return new Blob(chunks, { type: response.headers?.get?.('content-type') || '' })
    } finally {
      clearTimer(idleTimer)
      job.controller.signal.removeEventListener('abort', cancelReader)
      reader.releaseLock?.()
    }
  }

  function raceAbort(promise, signal) {
    if (signal.aborted) return Promise.reject(abortError(signal.reason || 'cancelled'))
    return new Promise((resolve, reject) => {
      const abort = () => reject(abortError(signal.reason || 'cancelled'))
      signal.addEventListener('abort', abort, { once: true })
      Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
  }

  async function decodeImage(blob, job) {
    if (typeof Image === 'undefined') return
    const objectUrl = URL.createObjectURL(blob)
    const image = new Image()
    const clearImage = () => { image.src = '' }
    job.controller.signal.addEventListener('abort', clearImage, { once: true })
    try {
      image.src = objectUrl
      const decoded = image.decode
        ? image.decode()
        : new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject })
      await raceAbort(decoded, job.controller.signal)
    } finally {
      job.controller.signal.removeEventListener('abort', clearImage)
      URL.revokeObjectURL(objectUrl)
    }
  }

  async function start(job) {
    active.add(job)
    job.startedAt = clock()
    job.requestedAt = job.startedAt
    job.state = 'requesting'
    // fetch() is intentionally the authority here; preparedAssets is a separate
    // in-memory result and must not be reported as an HTTP cache hit.
    job.cacheSource = 'fetch-cache-or-network'
    notify(job, 'asset:request')
    let headerTimer = setTimer(() => job.controller.abort('response-header-timeout'), timeouts.responseHeadersMs)
    const absoluteTimer = setTimer(() => job.controller.abort('absolute-timeout'), timeouts.absoluteMs)
    try {
      const response = await fetchImpl(job.url, {
        method: job.method,
        credentials: job.credentials,
        mode: job.mode,
        cache: 'force-cache',
        signal: job.controller.signal,
      })
      job.responseAt = clock()
      clearTimer(headerTimer)
      headerTimer = 0
      if (!response.ok) throw new Error(`资源下载失败：${response.status}`)
      job.state = 'downloading'
      notify(job, 'asset:response')
      const blob = await readBody(response, job)
      if (IMAGE_PATTERN.test(job.url)) {
        job.state = 'decoding'
        notify(job, 'asset:decode')
        await decodeImage(blob, job)
      }
      if (AUDIO_PATTERN.test(job.url)) preparedResponses.set(job.key, blob)
      preparedAssets.add(job.key)
      job.state = 'complete'
      notify(job, 'asset:complete')
      job.consumers.forEach((consumer) => settleConsumer(consumer, 'resolve', {
        url: job.url,
        cacheSource: job.cacheSource,
      }))
    } catch (error) {
      const reason = job.controller.signal.aborted ? job.controller.signal.reason || 'cancelled' : undefined
      job.reason = reason
      job.state = job.controller.signal.aborted ? 'cancelled' : 'failed'
      notify(job, job.state === 'cancelled' ? 'asset:cancelled' : 'asset:error')
      const failure = job.controller.signal.aborted ? abortError(reason) : error
      job.consumers.forEach((consumer) => settleConsumer(consumer, 'reject', failure))
    } finally {
      clearTimer(headerTimer)
      clearTimer(absoluteTimer)
      active.delete(job)
      jobs.delete(job.key)
      pump()
    }
  }

  function requestAsset(url, options = {}) {
    const request = {
      method: options.method || 'GET',
      credentials: options.credentials || 'same-origin',
      mode: options.mode || 'cors',
    }
    const key = requestKey(url, request)
    if (preparedAssets.has(key)) {
      const progress = {
        type: 'asset:prepared-hit',
        url: canonicalUrl(url),
        originalUrl: url,
        state: 'complete',
        priority: (typeof options.priority === 'function' ? options.priority() : options.priority) === 'foreground' ? 'foreground' : 'background',
        bytesReceived: preparedResponses.get(key)?.size || 0,
        totalBytes: preparedResponses.get(key)?.size || null,
        cacheSource: 'prepared-memory',
        ...snapshot(),
      }
      try { options.onUpdate?.(progress) } catch {}
      return Promise.resolve({ url: progress.url, cacheSource: progress.cacheSource })
    }

    let job = jobs.get(key)
    if (!job) {
      job = {
        key,
        originalUrl: url,
        url: canonicalUrl(url),
        ...request,
        consumers: new Set(),
        controller: new AbortController(),
        state: 'queued',
        order: ++sequence,
        queueStartedAt: clock(),
        startedAt: 0,
        requestedAt: 0,
        responseAt: 0,
        bytesReceived: 0,
        totalBytes: null,
        lastProgressAt: null,
        cacheSource: null,
        reason: null,
      }
      jobs.set(key, job)
      waiting.push(job)
    }
    return attachConsumer(job, options)
  }

  async function loadAssetGroup(urls, { signal, onProgress, concurrency = 1, group = '', priority = 'foreground' } = {}) {
    const queue = [...new Set(urls)]
    const total = queue.length
    let completed = 0
    let latest = { state: 'queued', bytesReceived: 0, totalBytes: null }
    const report = (event = latest) => {
      latest = event
      onProgress?.({ completed, total, ...event })
    }
    report()
    async function worker() {
      while (queue.length) {
        if (signal?.aborted) throw abortError('cancelled')
        const url = queue.shift()
        await requestAsset(url, {
          signal,
          group,
          priority,
          onUpdate: report,
        })
        completed += 1
        report({ ...latest, state: 'complete' })
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, total || 1)) }, worker))
  }

  function setGroupPriority(group, priority) {
    let promoted = false
    jobs.forEach((job) => {
      const matches = [...job.consumers].some((consumer) => consumer.group === group)
      if (!matches) return
      if (priority === 'foreground') {
        job.order = -++promotedSequence
        promoted = true
      }
      notify(job, 'asset:priority')
    })
    if (promoted) preemptForForeground()
    sortWaiting()
    pump()
  }

  function setBackgroundPaused(paused) {
    backgroundPaused = Boolean(paused)
    if (!backgroundPaused) pump()
  }

  function cancelAll(reason = 'cancelled') {
    waiting.splice(0).forEach((job) => {
      job.reason = reason
      job.state = 'cancelled'
      job.consumers.forEach((consumer) => settleConsumer(consumer, 'reject', abortError(reason)))
      jobs.delete(job.key)
    })
    active.forEach((job) => job.controller.abort(reason))
  }

  return {
    loadAssetGroup,
    requestAsset,
    setGroupPriority,
    setBackgroundPaused,
    cancelAll,
    getSnapshot: snapshot,
    getPreparedAssetBlob(url, options = {}) { return preparedResponses.get(requestKey(url, options)) || null },
  }
}

const resourceLoader = createResourceLoader()

export const loadAssetGroup = (...args) => resourceLoader.loadAssetGroup(...args)
export const promoteAssetGroup = (group) => resourceLoader.setGroupPriority(group, 'foreground')
export const demoteAssetGroup = (group) => resourceLoader.setGroupPriority(group, 'background')
export const setBackgroundDownloadsPaused = (paused) => resourceLoader.setBackgroundPaused(paused)
export const cancelAllResourceLoads = (reason) => resourceLoader.cancelAll(reason)
export const getPreparedAssetBlob = (url, options) => resourceLoader.getPreparedAssetBlob(url, options)
