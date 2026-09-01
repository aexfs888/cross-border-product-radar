import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { collectSource } from '../collectors/index.js'
import { collectApprovedProductPage } from '../collectors/approved-web.js'
import { pipiadsHistoryEvents } from '../importers/pipiads-history.js'
import { publicResearchLinkEvents } from '../importers/public-research-links.js'
import { loadSourceRules } from './config.js'
import { buildDossier, writeDossierFile } from './dossier.js'
import { decryptWithAge, encryptWithAge, ensureLocalKeys, verifyFile, writeManifest } from './crypto.js'
import { paths } from './paths.js'
import { analyzeProduct } from './scoring.js'
import { RadarStore } from './store.js'
import { atomicWrite, createId, requestBudgetSnapshot, resetRequestBudget, safeJson, sha256 } from './utils.js'
import type { CollectorEvent } from './types.js'

export async function analyzeAll(store: RadarStore, options: { resetPeakForSourceId?: string } = {}): Promise<{ analyzed: number, active: number, staging: number }> {
  const safety = store.getSafetyRecords(); let analyzed = 0; let active = 0; let staging = 0
  for (const product of store.listProducts(undefined, true)) {
    const events = store.getEvents(product.id); const media = store.getMedia(product.id)
    const analysis = analyzeProduct(product, events, media, safety)
    const dossier = buildDossier(product, analysis, events, media)
    store.updateAnalysis(product, analysis, dossier, { resetPeak: Boolean(options.resetPeakForSourceId && events.some((event) => event.sourceId === options.resetPeakForSourceId)) })
    const refreshed = store.getProduct(product.id)!
    // 该函数也负责把降级到待复核区的旧档案移出正式两库，避免残留文件造成误解。
    await writeDossierFile(refreshed, dossier)
    if (refreshed.status === 'ACTIVE') active += 1
    else staging += 1
    analyzed += 1
  }
  store.audit('ANALYSIS_COMPLETE', `已分析${analyzed}个商品；正式库${active}个，待复核${staging}个`, { analyzed, active, staging })
  return { analyzed, active, staging }
}

export async function collectLocal(options: { sourceId?: string, approvedUrl?: string, countryCode?: string } = {}): Promise<Record<string, unknown>> {
  const store = new RadarStore(); const runId = store.beginRun('LOCAL', options); const events: CollectorEvent[] = []; const errors: Record<string, string>[] = []
  const startedAt = Date.now(); resetRequestBudget()
  try {
    if (options.approvedUrl) events.push(...await collectApprovedProductPage(runId, options.approvedUrl, options.countryCode))
    else {
      const sources = loadSourceRules().automatic.filter((source) => source.enabled && (!options.sourceId || source.id === options.sourceId))
      for (const source of sources) {
        if (Date.now() - startedAt > 11.5 * 60_000) { errors.push({ sourceId: source.id, error: '本轮已达到11分30秒安全截止点，留出收尾时间' }); break }
        if (store.sourceIsPaused(source.id)) { errors.push({ sourceId: source.id, error: '来源处于12小时熔断暂停期' }); continue }
        try {
          const collected = await collectSource(runId, source); events.push(...collected); store.updateSourceHealth(source.id, true, collected.length)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error); errors.push({ sourceId: source.id, error: message }); store.updateSourceHealth(source.id, false, 0, message)
        }
      }
    }
    const ingested = store.ingestEvents(events); const analysis = await analyzeAll(store); const pruned = store.pruneLowHeat(30)
    const requests = requestBudgetSnapshot()
    store.finishRun(runId, events.length, errors.length, { ingested, analysis, pruned, errors, requests })
    return { ok: errors.length === 0, runId, events: events.length, ingested, analysis, pruned, requests, errors }
  } catch (error) {
    store.finishRun(runId, events.length, errors.length + 1, { fatal: error instanceof Error ? error.message : String(error) })
    throw error
  } finally { store.close() }
}

export async function importPipiadsHistory(inputPath: string): Promise<Record<string, unknown>> {
  const store = new RadarStore(); const runId = store.beginRun('OFFLINE_HISTORY', { inputPath }); let eventCount = 0
  try {
    const imported = await pipiadsHistoryEvents(inputPath, runId); eventCount = imported.events.length
    const ingested = store.ingestEvents(imported.events); const clearedCategories = store.clearUnverifiedHistoricalCategories('pipiads-offline-history-20260822'); const analysis = await analyzeAll(store); const pruned = store.pruneLowHeat(30)
    const result = { ok: true, runId, selected: imported.selected, skipped: imported.skipped, sourceHash: imported.sourceHash, ingested, clearedCategories, analysis, pruned }
    store.finishRun(runId, eventCount, 0, result); store.audit('OFFLINE_PIPIADS_HISTORY_IMPORTED', `已导入${imported.selected}条高潜力实体商品历史广告线索`, { ...result, note: '只作研究代理，不代表销量或利润；未访问 Pipiads 网页' })
    return result
  } catch (error) {
    store.finishRun(runId, eventCount, 1, { fatal: error instanceof Error ? error.message : String(error) })
    throw error
  } finally { store.close() }
}

export async function purgeSourceEvents(sourceId: string, reason: string): Promise<Record<string, unknown>> {
  const store = new RadarStore()
  try {
    const removed = store.removeSourceEvents(sourceId, reason)
    const analysis = await analyzeAll(store)
    const pruned = store.pruneLowHeat(30)
    return { ok: true, sourceId, removed, analysis, pruned }
  } finally { store.close() }
}

export async function importPublicResearchLinks(inputPath = paths.publicResearchLinks): Promise<Record<string, unknown>> {
  const store = new RadarStore(); const runId = store.beginRun('MANUAL_PUBLIC_LINKS', { inputPath }); let eventCount = 0
  try {
    const imported = await publicResearchLinkEvents(inputPath, runId); eventCount = imported.events.length
    const ingested = store.ingestEvents(imported.events); const analysis = await analyzeAll(store); const pruned = store.pruneLowHeat(30)
    const source = safeJson<{ note?: string, items?: Array<{ originalName?: string, label?: string, url?: string, matchStatus?: string, note?: string }> }>(await fsp.readFile(inputPath, 'utf8'), {})
    const indexPath = path.join(paths.nonReusable, '商品公开研究链接清单.md')
    const markdownLabel = (value: string) => value.replace(/[\\[\]]/g, (character) => `\\${character}`)
    const rows = (source.items || []).map((item) => `- [${markdownLabel(item.originalName || '未命名商品')}｜${markdownLabel(item.label || '公开研究链接')}](${item.url || ''})  \n  匹配状态：\`${item.matchStatus || '未知'}\`；限制：${item.note || '未知'}`)
    await atomicWrite(indexPath, `# 商品公开研究链接清单\n\n${source.note || '链接只供研究，不能替代身份、授权、供应、销量、功效或合规核验。'}\n\n${rows.join('\n\n')}\n`)
    const result = { ok: true, runId, links: imported.events.length, sourceHash: imported.sourceHash, ingested, analysis, pruned, indexPath }
    store.finishRun(runId, eventCount, 0, result); store.audit('PUBLIC_RESEARCH_LINKS_IMPORTED', `已写入${imported.events.length}条人工核对的公开研究链接`, { ...result, note: '链接仅作研究入口；匹配等级与限制会在报表显示，不能作为复用资格或销量证明' })
    return result
  } catch (error) {
    store.finishRun(runId, eventCount, 1, { fatal: error instanceof Error ? error.message : String(error) })
    throw error
  } finally { store.close() }
}

export async function collectCloud(): Promise<Record<string, unknown>> {
  const runId = createId('cloudrun'); const events: CollectorEvent[] = []; const errors: Record<string, string>[] = []
  const startedAt = Date.now(); resetRequestBudget()
  const sources = loadSourceRules().automatic.filter((source) => source.enabled)
  for (const source of sources) {
    if (Date.now() - startedAt > 11.5 * 60_000) { errors.push({ sourceId: source.id, error: '本轮已达到11分30秒安全截止点，留出加密收尾时间' }); break }
    try { events.push(...await collectSource(runId, source)) }
    catch (error) { errors.push({ sourceId: source.id, error: error instanceof Error ? error.message : String(error) }) }
  }
  const outputDir = path.join(paths.temp, 'cloud-output'); await fsp.mkdir(outputDir, { recursive: true })
  const plainPath = path.join(outputDir, `${runId}.jsonl`); const encryptedPath = `${plainPath}.age`; const manifestPath = path.join(outputDir, `${runId}.manifest.json`)
  await atomicWrite(plainPath, events.map((event) => JSON.stringify(event)).join('\n') + '\n')
  const recipient = process.env.AGE_RECIPIENT || (fs.existsSync(path.join(paths.keys, 'age-recipient.txt')) ? fs.readFileSync(path.join(paths.keys, 'age-recipient.txt'), 'utf8').trim() : '')
  if (!recipient) { await fsp.rm(plainPath, { force: true }); throw new Error('缺少 AGE_RECIPIENT；云端严禁上传明文') }
  try { encryptWithAge(plainPath, encryptedPath, recipient) } finally { await fsp.rm(plainPath, { force: true }) }
  const manifest = await writeManifest(manifestPath, encryptedPath, events.length, runId)
  return { ok: errors.length === 0, runId, events: events.length, requests: requestBudgetSnapshot(), errors, encryptedPath, manifestPath, manifest }
}

export async function syncInbox(): Promise<Record<string, unknown>> {
  const keys = ensureLocalKeys(); const store = new RadarStore(); let files = 0; let eventsCount = 0; const errors: string[] = []
  try {
    const manifests = (await fsp.readdir(paths.inbox)).filter((name) => name.endsWith('.manifest.json'))
    for (const name of manifests) {
      const manifestPath = path.join(paths.inbox, name); const signaturePath = `${manifestPath}.sig`
      let plainPath = ''
      try {
        if (!fs.existsSync(signaturePath) || !verifyFile(manifestPath, fs.readFileSync(signaturePath, 'utf8').trim())) throw new Error('清单签名无效')
        const manifest = safeJson<Record<string, any>>(fs.readFileSync(manifestPath, 'utf8'), {})
        const encryptedPath = path.join(paths.inbox, String(manifest.encryptedFile)); if (!fs.existsSync(encryptedPath)) throw new Error('加密数据文件缺失')
        if (sha256(fs.readFileSync(encryptedPath)) !== String(manifest.sha256 || '')) throw new Error('加密数据文件 SHA-256 与清单不一致')
        plainPath = path.join(paths.temp, `${manifest.runId}.sync.jsonl`); decryptWithAge(encryptedPath, plainPath, keys.identityFile)
        const events = fs.readFileSync(plainPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as CollectorEvent)
        if (events.length !== Number(manifest.eventCount)) throw new Error('解密后的事件数量与签名清单不一致')
        if (events.some((event) => event.schemaVersion !== '1.0' || !event.eventId || !event.rawHash)) throw new Error('解密包包含无效事件格式')
        store.ingestEvents(events); eventsCount += events.length; files += 1
        const processedDir = path.join(paths.inbox, 'processed'); await fsp.mkdir(processedDir, { recursive: true })
        for (const item of [manifestPath, signaturePath, encryptedPath]) await fsp.rename(item, path.join(processedDir, path.basename(item)))
      } catch (error) { errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`) }
      finally { if (plainPath) await fsp.rm(plainPath, { force: true }) }
    }
    const analysis = await analyzeAll(store); const pruned = store.pruneLowHeat(30)
    store.audit('CLOUD_SYNC_COMPLETE', `同步${files}个加密包、${eventsCount}条事件`, { files, eventsCount, errors, analysis, pruned })
    return { ok: errors.length === 0, files, events: eventsCount, errors, analysis, pruned }
  } finally { store.close() }
}

export async function writeHealthSnapshot(): Promise<string> {
  const store = new RadarStore(); try { const output = path.join(paths.logs, `health-${new Date().toISOString().slice(0, 10)}.json`); await atomicWrite(output, `${JSON.stringify(store.dashboard(), null, 2)}\n`); return output } finally { store.close() }
}

export function initializeProject(): Record<string, unknown> {
  const keys = ensureLocalKeys(); const store = new RadarStore()
  try { const integrity = store.integrityCheck(false); store.audit('PROJECT_INITIALIZED', '项目数据库和密钥已初始化', { integrity }); return { ok: integrity === 'ok', integrity, recipient: keys.recipient, dbPath: store.dbPath } }
  finally { store.close() }
}
