import { cp, mkdir, rm, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(projectRoot, 'columbina-venue', 'dist')
const destination = path.join(projectRoot, 'public', 'venue')

try {
  await stat(source)
} catch {
  throw new Error(`会场构建目录不存在：${source}`)
}

// dist 是会场工程的完整发布目录。同步前移除旧目录，避免内容哈希变化后
// 已失效的 JS、CSS 和图片长期累积为多个副本。
await rm(destination, { recursive: true, force: true })
await mkdir(destination, { recursive: true })
await cp(source, destination, { recursive: true, force: true })

// 状态.html 是工程内部开发状态页，不随公开站点上线。
await rm(path.join(destination, '状态.html'), { force: true })

console.log('已将 columbina-venue/dist 同步到 public/venue')
