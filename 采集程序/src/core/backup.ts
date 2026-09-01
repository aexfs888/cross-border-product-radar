import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { paths } from './paths.js'
import { atomicWrite, nowIso, sha256 } from './utils.js'
import { RadarStore } from './store.js'

type SnapshotEntry = { relativePath: string, objectHash: string, bytes: number, modifiedAt: string }

function stamp(date = new Date()): string { return date.toISOString().replace(/[:.]/g, '-') }

async function filesUnder(directory: string): Promise<string[]> {
  if (!fs.existsSync(directory)) return []
  const result: string[] = []
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await filesUnder(full))
    else if (entry.isFile()) result.push(full)
  }
  return result
}

async function incrementalSnapshot(sourceDirectory: string, targetDirectory: string, kind: string): Promise<Record<string, unknown>> {
  const objectRoot = path.join(targetDirectory, 'objects')
  const versionRoot = path.join(targetDirectory, 'versions')
  await fsp.mkdir(objectRoot, { recursive: true }); await fsp.mkdir(versionRoot, { recursive: true })
  const entries: SnapshotEntry[] = []
  for (const sourceFile of await filesUnder(sourceDirectory)) {
    const bytes = await fsp.readFile(sourceFile); const hash = sha256(bytes)
    const suffix = path.extname(sourceFile) || '.bin'; const objectDir = path.join(objectRoot, hash.slice(0, 2)); const objectFile = path.join(objectDir, `${hash}${suffix}`)
    await fsp.mkdir(objectDir, { recursive: true })
    if (!fs.existsSync(objectFile)) await fsp.copyFile(sourceFile, objectFile)
    const stats = await fsp.stat(sourceFile)
    entries.push({ relativePath: path.relative(sourceDirectory, sourceFile), objectHash: hash, bytes: stats.size, modifiedAt: stats.mtime.toISOString() })
  }
  const now = new Date(); const createdAt = nowIso(); const dailyFile = path.join(versionRoot, `daily-${stamp(now)}.json`)
  const manifest = { schemaVersion: 1, kind, sourceDirectory, createdAt, strategy: 'content-addressed-incremental-no-delete-propagation', entries }
  await atomicWrite(dailyFile, `${JSON.stringify(manifest, null, 2)}\n`)
  const additional: string[] = []
  const weekTag = `${now.getUTCFullYear()}-W${String(isoWeek(now)).padStart(2, '0')}`
  const weekly = path.join(versionRoot, `weekly-${weekTag}.json`)
  if (!fs.existsSync(weekly)) { await atomicWrite(weekly, `${JSON.stringify(manifest, null, 2)}\n`); additional.push(weekly) }
  const monthTag = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  const monthly = path.join(versionRoot, `monthly-${monthTag}.json`)
  if (!fs.existsSync(monthly)) { await atomicWrite(monthly, `${JSON.stringify(manifest, null, 2)}\n`); additional.push(monthly) }
  await keepNewest(versionRoot, /^daily-.*\.json$/, 7); await keepNewest(versionRoot, /^weekly-.*\.json$/, 5); await keepNewest(versionRoot, /^monthly-.*\.json$/, 6)
  return { files: entries.length, dailyManifest: dailyFile, additionalManifests: additional }
}

function isoWeek(date: Date): number {
  const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const day = copy.getUTCDay() || 7; copy.setUTCDate(copy.getUTCDate() + 4 - day)
  const first = new Date(Date.UTC(copy.getUTCFullYear(), 0, 1))
  return Math.ceil((((copy.getTime() - first.getTime()) / 86_400_000) + 1) / 7)
}

async function keepNewest(directory: string, pattern: RegExp, keep: number): Promise<void> {
  const files = (await fsp.readdir(directory)).filter((name) => pattern.test(name)).map((name) => ({ name, time: fs.statSync(path.join(directory, name)).mtimeMs })).sort((a, b) => b.time - a.time)
  for (const file of files.slice(keep)) await fsp.rm(path.join(directory, file.name), { force: true })
}

async function backupRecoveryKeys(): Promise<Record<string, unknown>> {
  const target = path.join(paths.backupRoot, '密钥恢复包', stamp())
  await fsp.mkdir(target, { recursive: true })
  const names = ['age-identity.txt', 'age-recipient.txt', 'signing-private.pem', 'signing-public.pem', 'hmac-secret.txt']
  const hashes: Record<string, string> = {}
  for (const name of names) {
    const source = path.join(paths.keys, name)
    if (!fs.existsSync(source)) continue
    const destination = path.join(target, name); await fsp.copyFile(source, destination); hashes[name] = sha256(await fsp.readFile(destination))
  }
  await atomicWrite(path.join(target, '恢复说明.txt'), '这是跨境热销商品雷达的离线恢复密钥包。请勿上传、分享或提交到 GitHub。恢复时将这些文件放回 E:\\跨境热销商品\\系统数据\\keys。\n')
  await atomicWrite(path.join(target, 'SHA256.json'), `${JSON.stringify(hashes, null, 2)}\n`)
  return { target, files: Object.keys(hashes).length }
}

export async function createFullBackup(): Promise<Record<string, unknown>> {
  const store = new RadarStore()
  let database: Record<string, unknown>
  try { database = store.createBackup() } finally { store.close() }
  const reusable = await incrementalSnapshot(paths.reusable, path.join(paths.backupRoot, '可复用商品备份'), 'REUSABLE_DOSSIERS')
  const nonReusable = await incrementalSnapshot(paths.nonReusable, path.join(paths.backupRoot, '不可复用商品备份'), 'HIGH_HEAT_NON_REUSABLE_DOSSIERS')
  const evidence = await incrementalSnapshot(path.join(paths.inbox, 'processed'), path.join(paths.backupRoot, '证据备份'), 'ENCRYPTED_CLOUD_EVIDENCE')
  const keys = await backupRecoveryKeys()
  const record = { createdAt: nowIso(), database, reusable, nonReusable, evidence, keys }
  const recoveryLog = path.join(paths.backupRoot, '恢复记录', `backup-${stamp()}.json`)
  await atomicWrite(recoveryLog, `${JSON.stringify(record, null, 2)}\n`)
  return { ...record, recoveryLog }
}
