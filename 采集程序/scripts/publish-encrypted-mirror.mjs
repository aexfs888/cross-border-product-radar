import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDirectory, '..', '..')
const sourceDirectory = path.resolve(process.env.RADAR_SOURCE_DIR || path.join(projectRoot, '临时文件', 'cloud-output'))
const publishRoot = process.env.RADAR_PUBLISH_ROOT ? path.resolve(process.env.RADAR_PUBLISH_ROOT) : ''
const githubRunId = String(process.env.GITHUB_RUN_ID || '').trim()
const retentionDays = 14

function fail(message) {
  throw new Error(`加密镜像发布已拒绝：${message}`)
}

function safeFileName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 240 && path.basename(value) === value && !value.includes('..')
}

function safeRunId(value) {
  return /^\d{6,20}$/.test(String(value || ''))
}

function sha256(file) {
  return crypto.createHash('sha256').update(Buffer.from(file)).digest('hex')
}

function packageDirectory(root, runId) {
  const packagesRoot = path.resolve(root, 'packages')
  const target = path.resolve(packagesRoot, runId)
  if (target !== packagesRoot && !target.startsWith(`${packagesRoot}${path.sep}`)) fail('发布路径安全校验失败')
  return target
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback
    throw error
  }
}

async function writeAtomic(file, content) {
  const temp = `${file}.tmp-${process.pid}`
  await fs.writeFile(temp, content, 'utf8')
  await fs.rename(temp, file)
}

if (!publishRoot) fail('未提供 RADAR_PUBLISH_ROOT')
if (!safeRunId(githubRunId)) fail('GITHUB_RUN_ID 格式不正确')

const allNames = await fs.readdir(sourceDirectory)
const allowedNames = allNames.filter((name) => name.endsWith('.age') || name.endsWith('.manifest.json') || name.endsWith('.manifest.json.sig'))
const manifestNames = allowedNames.filter((name) => name.endsWith('.manifest.json'))
if (manifestNames.length !== 1) fail('本轮必须且只能有一份加密清单')

const manifestName = manifestNames[0]
if (!safeFileName(manifestName)) fail('清单文件名不安全')
const manifest = await readJson(path.join(sourceDirectory, manifestName), null)
if (!manifest || !safeFileName(manifest.encryptedFile)) fail('清单缺少合法的加密数据文件名')
const requiredNames = [manifest.encryptedFile, manifestName, `${manifestName}.sig`]
if (new Set(requiredNames).size !== 3 || !requiredNames.every((name) => allowedNames.includes(name) && safeFileName(name))) fail('加密包、清单或签名文件不完整')
if (allowedNames.length !== requiredNames.length) fail('云端输出目录含有未允许发布的文件')

const destination = packageDirectory(publishRoot, githubRunId)
await fs.rm(destination, { recursive: true, force: true })
await fs.mkdir(destination, { recursive: true })
const files = []
for (const name of requiredNames.sort()) {
  const source = path.join(sourceDirectory, name)
  const content = await fs.readFile(source)
  await fs.writeFile(path.join(destination, name), content)
  files.push({ name, bytes: content.length, sha256: sha256(content) })
}

const indexFile = path.join(publishRoot, 'index.json')
const previous = await readJson(indexFile, { schemaVersion: 1, packages: [] })
if (!previous || previous.schemaVersion !== 1 || !Array.isArray(previous.packages)) fail('现有加密镜像索引格式不正确')
const now = new Date()
const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000
const retained = []
for (const item of previous.packages) {
  const publishedAt = new Date(item?.publishedAt || '').getTime()
  if (!safeRunId(item?.githubRunId) || !Number.isFinite(publishedAt)) fail('现有加密镜像索引含有不安全条目')
  if (publishedAt >= cutoff && String(item.githubRunId) !== githubRunId) retained.push(item)
  if (publishedAt < cutoff) await fs.rm(packageDirectory(publishRoot, String(item.githubRunId)), { recursive: true, force: true })
}
retained.push({
  githubRunId,
  sourceRunId: String(manifest.runId || ''),
  publishedAt: now.toISOString(),
  sourceCreatedAt: String(manifest.createdAt || ''),
  eventCount: Number(manifest.eventCount || 0),
  files,
})
retained.sort((left, right) => Number(left.githubRunId) - Number(right.githubRunId))
const index = {
  schemaVersion: 1,
  kind: 'encrypted-product-radar-mirror',
  generatedAt: now.toISOString(),
  retentionDays,
  packages: retained,
}
await writeAtomic(indexFile, `${JSON.stringify(index, null, 2)}\n`)
console.log(`已发布加密镜像：运行 ${githubRunId}，文件 ${files.length} 个；未发布任何明文商品数据。`)
