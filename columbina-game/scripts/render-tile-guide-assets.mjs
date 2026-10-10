import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const gameRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputDirectory = path.join(gameRoot, 'p', 'cat-cake-race', 'tile-guide')
const imageNames = ['normal', 'wall', 'pit', 'spikes', 'glue', 'spring', 'piston', 'bomb', 'checkpoint', 'finish']
const edgePath = process.env.EDGE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const profileDirectory = await mkdtemp(path.join(tmpdir(), 'cat-cake-tile-render-'))
let vite

try {
  vite = await createServer({
    configFile: path.join(gameRoot, 'vite.config.js'),
    server: { host: '127.0.0.1', port: 0, strictPort: false, open: false },
  })
  await vite.listen()
  const address = vite.httpServer.address()
  const renderUrl = `http://127.0.0.1:${address.port}/tile-guide-render.html`
  const dom = await new Promise((resolve, reject) => {
    const browser = spawn(edgePath, [
      '--headless=new',
      '--no-sandbox',
      '--enable-webgl',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--disable-background-timer-throttling',
      '--no-first-run',
      `--user-data-dir=${profileDirectory}`,
      '--virtual-time-budget=30000',
      '--dump-dom',
      renderUrl,
    ], { windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      browser.kill()
      reject(new Error(`Edge render timed out. ${stderr.slice(-2000)}`))
    }, 60_000)
    browser.stdout.setEncoding('utf8')
    browser.stderr.setEncoding('utf8')
    browser.stdout.on('data', (chunk) => { stdout += chunk })
    browser.stderr.on('data', (chunk) => { stderr += chunk })
    browser.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    browser.once('close', (code) => {
      clearTimeout(timeout)
      const match = stdout.match(/<pre id="tile-guide-assets">([\s\S]*?)<\/pre>/)
      if (code !== 0 || !match || match[1] === 'waiting') {
        reject(new Error(`Tile render page did not return images (exit ${code}). ${stderr.slice(-2000)} ${stdout.slice(-1000)}`))
        return
      }
      resolve(match[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&'))
    })
  })

  const images = JSON.parse(dom)
  const renderedImages = []
  for (const [index, name] of imageNames.entries()) {
    const encoded = images[`guide-${index}`]?.match(/^data:image\/png;base64,(.+)$/)?.[1]
    if (!encoded) throw new Error(`Missing rendered image: ${name}`)
    const image = Buffer.from(encoded, 'base64')
    if (image.length < 1000) throw new Error(`Rendered image is unexpectedly empty: ${name} (${image.length} bytes)`)
    renderedImages.push([name, image])
  }
  await mkdir(outputDirectory, { recursive: true })
  for (const [name, image] of renderedImages) {
    await writeFile(path.join(outputDirectory, `${name}.png`), image)
    process.stdout.write(`Rendered ${name}.png\n`)
  }
} finally {
  await vite?.close()
  await rm(profileDirectory, { recursive: true, force: true })
}
