import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stateDirectory = path.join(projectRoot, '运行日志', 'automation')
const stateFile = path.join(stateDirectory, 'collector-state.json')
const lockFile = path.join(stateDirectory, 'collector.lock')
const historyFile = path.join(stateDirectory, 'run-history.ndjson')
const mode = process.env.CROSS_BORDER_AUTOMATION_MODE || 'shadow'
const publicCollectionApproved = process.env.CROSS_BORDER_PUBLIC_COLLECTION_APPROVED === '1'
const publicCollectionTimeoutMs = 13 * 60_000
const publicCollectorProgressFile = path.join(stateDirectory, 'public-collector-progress.log')
const now = new Date()
const runId = `cross-${now.toISOString().replace(/[-:.TZ]/g, '')}-${process.pid}`
const intervalMinutes = 30

if (!['shadow', 'public', 'active'].includes(mode)) throw new Error('CROSS_BORDER_AUTOMATION_MODE 只能是 shadow、public 或 active')

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

async function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await fs.rename(temporary, file)
}

const maxHistoryEntries = 336

async function appendHistory(value) {
  let existing = ''
  try {
    existing = await fs.readFile(historyFile, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const entries = existing.split(/\r?\n/).filter(Boolean)
  const retained = [...entries.slice(-(maxHistoryEntries - 1)), JSON.stringify(value)]
  const temporary = `${historyFile}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temporary, `${retained.join('\n')}\n`, 'utf8')
  await fs.rename(temporary, historyFile)
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function inspectExistingLock() {
  let stat
  try {
    stat = await fs.stat(lockFile)
  } catch {
    return { state: 'unreadable' }
  }

  let metadata = null
  let metadataReadable = true
  try {
    metadata = await readJson(lockFile, null)
  } catch {
    metadataReadable = false
  }
  const startedAt = Date.parse(metadata?.startedAt ?? '')
  const pid = Number.isInteger(metadata?.pid) ? metadata.pid : null
  const ageMs = Math.max(0, Date.now() - stat.mtimeMs)
  const ageMinutes = Math.floor(ageMs / 60_000)
  const pidAlive = processIsAlive(pid)
  const timedOut = ageMs > publicCollectionTimeoutMs + 5 * 60_000
  return {
    state: metadataReadable && Number.isFinite(startedAt) ? 'valid_metadata' : 'malformed_metadata',
    ageMinutes,
    startedAt: Number.isFinite(startedAt) ? metadata.startedAt : null,
    pid,
    pidAlive,
    timedOut,
    stale: !pidAlive || timedOut,
    mode: ['shadow', 'public', 'active'].includes(metadata?.mode) ? metadata.mode : null,
  }
}

async function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockFile, 'wx')
      await handle.writeFile(JSON.stringify({ runId, pid: process.pid, startedAt: now.toISOString(), mode }))
      return handle
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const existing = await inspectExistingLock()
      if (!existing.stale || attempt > 0) return { existing }
      // The former owner is gone or exceeded its coordinator timeout. Remove only this
      // stale local lock, then retry exclusive creation; no source limits are changed.
      await fs.rm(lockFile, { force: true })
    }
  }
  return { existing: await inspectExistingLock() }
}

function parseFinalJson(stdout) {
  const text = stdout.trim()
  for (let index = text.lastIndexOf('{'); index >= 0; index = text.lastIndexOf('{', index - 1)) {
    try { return JSON.parse(text.slice(index)) } catch { }
  }
  return null
}

async function runPublicCollector() {
  const command = process.platform === 'win32' ? 'cmd.exe' : 'npm'
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm.cmd run collect']
    : ['run', 'collect']
  return await new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const child = spawn(command, args, { cwd: projectRoot, windowsHide: true, env: { ...process.env, CROSS_BORDER_AUTOMATION_MODE: 'public' } })
    const writeProgress = (chunk) => fs.appendFile(publicCollectorProgressFile, String(chunk), 'utf8').catch(() => {})
    const timer = setTimeout(() => { timedOut = true; child.kill() }, publicCollectionTimeoutMs)
    child.stdout.on('data', (chunk) => { stdout += String(chunk); writeProgress(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk); writeProgress(chunk) })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      const summary = parseFinalJson(stdout)
      resolve({ exitCode: code ?? 1, signal: signal ?? null, timedOut, summary, outputBytes: Buffer.byteLength(stdout) + Buffer.byteLength(stderr) })
    })
  })
}

async function shadowPreflight() {
  const countriesPath = path.join(projectRoot, '国家配置', 'countries.json')
  const sourcesPath = path.join(projectRoot, '来源规则', 'sources.json')
  const dbPath = path.join(projectRoot, '系统数据', '跨境热销商品雷达.db')
  try {
    const [countries, sources, db] = await Promise.all([
      readJson(countriesPath, null),
      readJson(sourcesPath, null),
      fs.stat(dbPath),
    ])
    const countryCodes = countries?.countries?.map?.((country) => country.code) || []
    const expectedCountries = ['GB', 'US', 'AU', 'CA', 'NZ', 'CH', 'IE', 'NO', 'SE', 'DK', 'FI']
    const enabledSources = sources?.automatic?.filter?.((source) => source.enabled) || []
    const countryScopeOk = countryCodes.length === expectedCountries.length && expectedCountries.every((code) => countryCodes.includes(code))
    const requestBudgetOk = sources?.network?.maxRequestsPerRun === 250
    return {
      ok: countryScopeOk && requestBudgetOk && enabledSources.length > 0 && db.size > 0,
      countryScopeOk,
      enabledSourceCount: enabledSources.length,
      requestBudgetOk,
      databaseFilePresent: db.size > 0,
      note: '影子模式只读取公开配置和数据库文件元数据；不打开数据库、不读取业务记录、不发起网络请求。',
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

async function main() {
  if (mode === 'active') {
    const result = {
      schemaVersion: 1,
      project: 'cross-border-radar',
      mode,
      runId,
      state: 'blocked_private_active_not_implemented',
      startedAt: now.toISOString(),
      privateDataAccessed: false,
      networkCollectionStarted: false,
      note: '私密主动模式尚未启用；不会读取或处理订单、成本、广告账户或其他经营私密数据。',
    }
    console.log(JSON.stringify(result))
    process.exitCode = 2
    return
  }

  await fs.mkdir(stateDirectory, { recursive: true })
  const previous = await readJson(stateFile, null)
  const lock = await acquireLock()
  if ('existing' in lock) {
    const result = { schemaVersion: 1, project: 'cross-border-radar', mode, runId, state: 'skipped_locked', startedAt: now.toISOString(), lock: lock.existing }
    console.log(JSON.stringify(result))
    return
  }

  const startedAt = Date.now()
  try {
    const previousNextEligibleAt = Date.parse(previous?.nextEligibleAt ?? '')
    if (Number.isFinite(previousNextEligibleAt) && Date.now() < previousNextEligibleAt) {
      const result = {
        schemaVersion: 1,
        project: 'cross-border-radar',
        mode,
        runId,
        state: 'skipped_not_due',
        startedAt: now.toISOString(),
        previousState: previous?.state ?? null,
        nextEligibleAt: previous.nextEligibleAt,
        privateDataAccessed: false,
        networkCollectionStarted: false,
        note: mode === 'public' ? '公开采集尚未到下次 30 分钟检查时间；本次不打开数据库、不发起网络请求。' : '影子模式尚未到下次 30 分钟检查时间；本次不读取、不联网。',
      }
      await appendHistory(result)
      console.log(JSON.stringify(result))
      return
    }

    if (mode === 'public') {
      if (!publicCollectionApproved) {
        const result = { schemaVersion: 1, project: 'cross-border-radar', mode, runId, state: 'blocked_public_collection_not_approved', startedAt: now.toISOString(), privateDataAccessed: false, networkCollectionStarted: false, note: '公开采集需要显式本机批准标志；未读取数据库或发起网络请求。' }
        await appendHistory(result)
        console.log(JSON.stringify(result))
        process.exitCode = 2
        return
      }
      const shadow = await shadowPreflight()
      if (!shadow.ok) {
        const result = { schemaVersion: 1, project: 'cross-border-radar', mode, runId, state: 'degraded', startedAt: now.toISOString(), preflight: shadow, privateDataAccessed: false, networkCollectionStarted: false, note: '公开采集预检未通过；未发起网络请求。' }
        await atomicJson(stateFile, result)
        await appendHistory(result)
        console.log(JSON.stringify(result))
        process.exitCode = 2
        return
      }
      const collection = await runPublicCollector()
      const summary = collection.summary && typeof collection.summary === 'object' ? collection.summary : null
      const result = {
        schemaVersion: 1, project: 'cross-border-radar', mode, runId,
        state: collection.exitCode !== 0 ? 'public_collection_failed' : (Array.isArray(summary?.errors) && summary.errors.length > 0 ? 'public_collection_completed_with_errors' : 'public_collection_completed'),
        startedAt: now.toISOString(), finishedAt: new Date().toISOString(), durationMs: Date.now() - startedAt,
        intervalMinutes, previousState: previous?.state ?? null, preflight: shadow,
        collection: { exitCode: collection.exitCode, timedOut: collection.timedOut, outputBytes: collection.outputBytes, events: Number(summary?.events ?? 0), errors: Array.isArray(summary?.errors) ? summary.errors.length : null, requests: summary?.requests ?? null },
        nextEligibleAt: new Date(Date.now() + intervalMinutes * 60_000).toISOString(),
        privateDataAccessed: false, networkCollectionStarted: true,
        note: '仅执行已配置的公开来源采集；不读取订单、成本、客户、广告账户、Cookie、Token 或私密导入目录。',
      }
      await atomicJson(stateFile, result)
      await appendHistory(result)
      console.log(JSON.stringify(result))
      process.exitCode = collection.exitCode === 0 ? 0 : 2
      return
    }
    const shadow = await shadowPreflight()
    const preflightOk = shadow.ok
    const executable = mode === 'shadow' && preflightOk
    const result = {
      schemaVersion: 1,
      project: 'cross-border-radar',
      mode,
      runId,
      state: executable ? 'shadow_completed' : (preflightOk ? 'blocked_active_not_implemented' : 'degraded'),
      startedAt: now.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      intervalMinutes,
      previousState: previous?.state ?? null,
      preflight: shadow,
      nextEligibleAt: new Date(Date.now() + intervalMinutes * 60_000).toISOString(),
      privateDataAccessed: false,
      networkCollectionStarted: false,
      note: mode === 'shadow'
        ? '影子模式只读取公开配置与数据库文件元数据；不打开数据库、不采集、不导入私密经营数据、不修改数据库。'
        : '主动模式尚未启用，防止在隐私闸门未通过时采集或处理私密经营数据。',
    }
    await atomicJson(stateFile, result)
    await appendHistory(result)
    console.log(JSON.stringify(result))
    process.exitCode = executable ? 0 : 2
  } finally {
    await lock.close()
    await fs.rm(lockFile, { force: true })
  }
}

await main()
