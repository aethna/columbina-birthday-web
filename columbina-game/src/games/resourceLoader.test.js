import { describe, expect, it } from 'vitest'
import { createResourceLoader } from './resourceLoader.js'

const encoder = new TextEncoder()

function response(text = 'ok') {
  const bytes = encoder.encode(text)
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-length': String(bytes.byteLength), 'content-type': 'application/octet-stream' }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject })
  return { promise, resolve, reject }
}

describe('资源下载调度器', () => {
  it('在同级 FIFO 的前提下，让前台等待项先于后台等待项获得槽位', async () => {
    const hold = deferred()
    const calls = []
    const loader = createResourceLoader({
      maxActiveDownloads: 1,
      fetchImpl(url) {
        calls.push(new URL(url).pathname)
        return url.endsWith('/hold.bin') ? hold.promise : Promise.resolve(response(url))
      },
    })

    const current = loader.requestAsset('https://assets.example/hold.bin', { priority: 'foreground' })
    const background = loader.requestAsset('https://assets.example/background.bin', { priority: 'background' })
    const foreground = loader.requestAsset('https://assets.example/foreground.bin', { priority: 'foreground' })
    hold.resolve(response('hold'))

    await Promise.all([current, foreground, background])
    expect(calls).toEqual(['/hold.bin', '/foreground.bin', '/background.bin'])
  })

  it('前台进入时可中止纯后台在途请求并立即释放槽位', async () => {
    const backgroundGate = deferred()
    const calls = []
    const loader = createResourceLoader({
      maxActiveDownloads: 1,
      fetchImpl(url, options) {
        calls.push(new URL(url).pathname)
        if (url.endsWith('/background.bin')) {
          return Promise.race([
            backgroundGate.promise,
            new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })),
          ])
        }
        return Promise.resolve(response('foreground'))
      },
    })

    const background = loader.requestAsset('https://assets.example/background.bin', { priority: 'background' })
    const foreground = loader.requestAsset('https://assets.example/foreground.bin', { priority: 'foreground' })

    await expect(background).rejects.toMatchObject({ name: 'AbortError', reason: 'preempted-by-foreground' })
    await expect(foreground).resolves.toMatchObject({ cacheSource: 'fetch-cache-or-network' })
    expect(calls).toEqual(['/background.bin', '/foreground.bin'])
    expect(loader.getSnapshot()).toMatchObject({ activeDownloads: 0, waitingDownloads: 0 })
  })

  it('共享进行中的同 URL 任务；取消一个消费者不会中止另一个消费者', async () => {
    const gate = deferred()
    const calls = []
    const backgroundController = new AbortController()
    const loader = createResourceLoader({
      fetchImpl(url, options) {
        calls.push({ url, signal: options.signal })
        return gate.promise
      },
    })

    const background = loader.requestAsset('https://assets.example/shared.bin', {
      group: 'background',
      priority: 'background',
      signal: backgroundController.signal,
    })
    const foreground = loader.requestAsset('https://assets.example/shared.bin', {
      group: 'foreground',
      priority: 'foreground',
    })
    backgroundController.abort()
    gate.resolve(response('shared'))

    await expect(background).rejects.toMatchObject({ name: 'AbortError', reason: 'cancelled' })
    await expect(foreground).resolves.toMatchObject({ cacheSource: 'fetch-cache-or-network' })
    expect(calls).toHaveLength(1)
    expect(calls[0].signal.aborted).toBe(false)
  })

  it('响应体无进展超时会释放槽位，后续资源可以开始', async () => {
    const calls = []
    const loader = createResourceLoader({
      maxActiveDownloads: 1,
      timeouts: { responseHeadersMs: 100, bodyIdleMs: 8, absoluteMs: 100 },
      fetchImpl(url, options) {
        calls.push(new URL(url).pathname)
        if (!url.endsWith('/stuck.bin')) return Promise.resolve(response('next'))
        const reader = {
          read: () => new Promise((_, reject) => {
            options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
          }),
          cancel: () => Promise.resolve(),
          releaseLock() {},
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          body: { getReader: () => reader },
        })
      },
    })

    const stuck = loader.requestAsset('https://assets.example/stuck.bin', { priority: 'foreground' })
    const next = loader.requestAsset('https://assets.example/next.bin', { priority: 'foreground' })

    await expect(stuck).rejects.toMatchObject({ name: 'AbortError', reason: 'body-idle-timeout' })
    await expect(next).resolves.toMatchObject({ cacheSource: 'fetch-cache-or-network' })
    expect(calls).toEqual(['/stuck.bin', '/next.bin'])
    expect(loader.getSnapshot()).toMatchObject({ activeDownloads: 0, waitingDownloads: 0 })
  })

  it('诊断记录规范 URL，但不会改写传给 fetch 的资源 URL', async () => {
    const calls = []
    const events = []
    const loader = createResourceLoader({
      debug: true,
      diagnostics: (event) => events.push(event),
      fetchImpl(url) {
        calls.push(url)
        return Promise.resolve(response())
      },
    })

    await loader.loadAssetGroup(['https://assets.example/stable.bin'], { group: 'flightCore' })
    expect(calls).toEqual(['https://assets.example/stable.bin'])
    expect(events.some((event) => event.canonicalUrl === 'https://assets.example/stable.bin')).toBe(true)
  })
})
