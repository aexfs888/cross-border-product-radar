import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stateDirectory = path.join(projectRoot, '运行日志', 'automation')
const stateFile = path.join(stateDirectory, 'collector-state.json')
const lockFile = path.join(stateDirectory, 'collector.lock')
const historyFile = path.join(stateDirectory, 'run-history.ndjson')
const mode = process.env.CROSS_BORDER_AUTOMATION_MODE || 'shadow'
const now = new Date()
const runId = `cross-${now.toISOString().replace(/[-:.TZ]/g, '')}-${process.pid}`
const intervalMinutes = 30

if (!['shadow', 'active'].includes(mode)) throw new Error('CROSS_BORDER_AUTOMATION_MODE 只能是 shadow 或 active')

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

async function appendHistory(value) {
  await fs.appendFile(historyFile, `${JSON.stringify(value)}\n`, 'utf8')
}

async function acquireLock() {
  try {
    const handle = await fs.open(lockFile, 'wx')
    await handle.writeFile(JSON.stringify({ runId, pid: process.pid, startedAt: now.toISOString(), mode }))
    return handle
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    return { existing: await readJson(lockFile, { state: 'unknown' }) }
  }
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
  await fs.mkdir(stateDirectory, { recursive: true })
  if (mode === 'active') {
    const result = {
      schemaVersion: 1,
      project: 'cross-border-radar',
      mode,
      runId,
      state: 'blocked_active_not_implemented',
      startedAt: now.toISOString(),
      privateDataAccessed: false,
      networkCollectionStarted: false,
      note: '主动模式尚未启用，防止在隐私闸门未通过时采集或处理私密经营数据。',
    }
    await appendHistory(result)
    console.log(JSON.stringify(result))
    process.exitCode = 2
    return
  }

  const previous = await readJson(stateFile, null)
  const lock = await acquireLock()
  if ('existing' in lock) {
    const result = { schemaVersion: 1, project: 'cross-border-radar', mode, runId, state: 'skipped_locked', startedAt: now.toISOString(), lock: lock.existing }
    await appendHistory(result)
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
        note: '影子模式尚未到下次 30 分钟检查时间；本次不读取配置、不打开数据库、不发起网络请求。',
      }
      await appendHistory(result)
      console.log(JSON.stringify(result))
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
