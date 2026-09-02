import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { paths } from './paths.js'
import { atomicWrite, nowIso, sha256 } from './utils.js'
import { RadarStore } from './store.js'

type SnapshotEntry = { relativePath: string, objectHash: string, bytes: number, modifiedAt: string }

function stamp(date = new Date()): string { return date.toISOString().replace(/[:.]/g, '-') }

function taipeiPeriodTags(date = new Date()): { day: string, week: string, month: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date)
  const value = (type: string) => parts.find((item) => item.type === type)?.value || '00'
  const day = `${value('year')}-${value('month')}-${value('day')}`
  const localDate = new Date(`${day}T00:00:00Z`)
  const weekday = localDate.getUTCDay() || 7
  localDate.setUTCDate(localDate.getUTCDate() + 4 - weekday)
  const weekYear = localDate.getUTCFullYear()
  const first = new Date(Date.UTC(weekYear, 0, 1))
  const weekNumber = Math.ceil((((localDate.getTime() - first.getTime()) / 86_400_000) + 1) / 7)
  return { day, week: `${weekYear}-W${String(weekNumber).padStart(2, '0')}`, month: day.slice(0, 7) }
}

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
  const now = new Date(); const createdAt = nowIso(); const tags = taipeiPeriodTags(now); const dailyFile = path.join(versionRoot, `daily-${tags.day}.json`)
  const manifest = { schemaVersion: 1, kind, sourceDirectory, createdAt, strategy: 'content-addressed-incremental-no-delete-propagation', entries }
  await atomicWrite(dailyFile, `${JSON.stringify(manifest, null, 2)}\n`)
  const additional: string[] = []
  const weekly = path.join(versionRoot, `weekly-${tags.week}.json`)
  await atomicWrite(weekly, `${JSON.stringify(manifest, null, 2)}\n`); additional.push(weekly)
  const monthly = path.join(versionRoot, `monthly-${tags.month}.json`)
  await atomicWrite(monthly, `${JSON.stringify(manifest, null, 2)}\n`); additional.push(monthly)
  // New canonical names retain calendar periods. Legacy timestamp manifests are
  // intentionally left untouched so this migration cannot destroy old backups.
  await keepNewest(versionRoot, /^daily-\d{4}-\d{2}-\d{2}\.json$/, 7)
  await keepNewest(versionRoot, /^weekly-\d{4}-W\d{2}\.json$/, 5)
  await keepNewest(versionRoot, /^monthly-\d{4}-\d{2}\.json$/, 6)
  return { files: entries.length, dailyManifest: dailyFile, additionalManifests: additional }
}

async function keepNewest(directory: string, pattern: RegExp, keep: number): Promise<void> {
  const files = (await fsp.readdir(directory)).filter((name) => pattern.test(name)).map((name) => ({ name, time: fs.statSync(path.join(directory, name)).mtimeMs })).sort((a, b) => b.time - a.time)
  for (const file of files.slice(keep)) await fsp.rm(path.join(directory, file.name), { force: true })
}

async function backupRecoveryKeys(): Promise<Record<string, unknown>> {
  const names = ['age-identity.txt', 'age-recipient.txt', 'signing-private.pem', 'signing-public.pem', 'hmac-secret.txt']
  const hashes: Record<string, string> = {}
  for (const name of names) {
    const source = path.join(paths.keys, name)
    if (!fs.existsSync(source)) throw new Error(`密钥恢复包缺少必要文件：${name}`)
    hashes[name] = sha256(await fsp.readFile(source))
  }
  const keyRoot = path.join(paths.backupRoot, '密钥恢复包')
  const fingerprint = sha256(Buffer.from(names.map((name) => `${name}:${hashes[name]}`).join('\n'))).slice(0, 20)
  const target = path.join(keyRoot, `keyset-${fingerprint}`)
  if (fs.existsSync(target)) {
    for (const name of names) {
      const stored = path.join(target, name)
      if (!fs.existsSync(stored) || sha256(await fsp.readFile(stored)) !== hashes[name]) throw new Error('现有密钥恢复包校验失败，拒绝覆盖')
    }
    return { target, files: names.length, reused: true, fingerprint }
  }
  const staging = path.join(keyRoot, `.staging-${process.pid}-${Date.now()}`)
  await fsp.mkdir(staging, { recursive: true })
  try {
    for (const name of names) await fsp.copyFile(path.join(paths.keys, name), path.join(staging, name))
    await atomicWrite(path.join(staging, '恢复说明.txt'), '这是跨境热销商品雷达的离线恢复密钥包。请勿上传、分享或提交到 GitHub。恢复时将这些文件放回 E:\\跨境热销商品\\系统数据\\keys。\n')
    await atomicWrite(path.join(staging, 'SHA256.json'), `${JSON.stringify(hashes, null, 2)}\n`)
    await fsp.rename(staging, target)
  } finally {
    if (fs.existsSync(staging)) await fsp.rm(staging, { recursive: true, force: true })
  }
  return { target, files: names.length, reused: false, fingerprint }
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
