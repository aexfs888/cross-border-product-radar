import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { paths, ensureProjectDirectories } from './paths.js'
import { ageBand, createId, naturalKey, nowIso, safeJson, sha256 } from './utils.js'
import type { CollectorEvent, ProductAnalysis, ProductRecord, ReuseBucket } from './types.js'

function sqlString(value: string): string { return value.replaceAll("'", "''") }

function taipeiBackupTags(date = new Date()): { day: string, week: string, month: string } {
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

function copyFileAtomic(source: string, target: string): void {
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  fs.copyFileSync(source, temporary)
  fs.renameSync(temporary, target)
}

export class RadarStore {
  readonly db: DatabaseSync
  readonly dbPath: string

  constructor(options: { memory?: boolean, dbPath?: string } = {}) {
    ensureProjectDirectories()
    this.dbPath = options.memory ? ':memory:' : options.dbPath || paths.db
    this.db = new DatabaseSync(this.dbPath)
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;')
    this.migrate()
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, mode TEXT NOT NULL, status TEXT NOT NULL,
        started_at TEXT NOT NULL, completed_at TEXT, event_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0, meta_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY, natural_key TEXT NOT NULL UNIQUE,
        original_name TEXT NOT NULL, zh_name TEXT, brand TEXT, model TEXT, gtin TEXT, mpn TEXT, category TEXT,
        description_zh TEXT, specs_json TEXT NOT NULL DEFAULT '{}', variants_json TEXT NOT NULL DEFAULT '[]',
        use_cases_json TEXT NOT NULL DEFAULT '[]', target_users_json TEXT NOT NULL DEFAULT '[]',
        unsuitable_scenarios_json TEXT NOT NULL DEFAULT '[]', features_json TEXT NOT NULL DEFAULT '[]', supplier_json TEXT NOT NULL DEFAULT '{}',
        first_evidence_at TEXT NOT NULL, trend_start_at TEXT, system_first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
        trend_age_band TEXT NOT NULL DEFAULT '0–7天', lifecycle TEXT NOT NULL DEFAULT 'NEW',
        research_heat_score REAL NOT NULL DEFAULT 0, peak_heat_score REAL NOT NULL DEFAULT 0,
        commercial_score REAL NOT NULL DEFAULT 0, completeness REAL NOT NULL DEFAULT 0, confidence REAL NOT NULL DEFAULT 0,
        reuse_bucket TEXT NOT NULL DEFAULT 'NON_REUSABLE' CHECK(reuse_bucket IN ('REUSABLE','NON_REUSABLE')),
        commercial_grade TEXT NOT NULL DEFAULT 'RESEARCH_ONLY', rights_status TEXT NOT NULL DEFAULT 'UNKNOWN',
        risk_flags_json TEXT NOT NULL DEFAULT '[]', research_reason TEXT NOT NULL DEFAULT '', restriction_reason TEXT NOT NULL DEFAULT '',
        missing_requirements_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'STAGING' CHECK(status IN ('STAGING','ACTIVE','PRUNED')),
        dossier_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_products_bucket_score ON products(reuse_bucket,status,research_heat_score DESC);
      CREATE TABLE IF NOT EXISTS raw_events (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, source_id TEXT NOT NULL, source_family TEXT NOT NULL,
        source_url TEXT NOT NULL, country_code TEXT NOT NULL, event_type TEXT NOT NULL,
        observed_at TEXT NOT NULL, published_at TEXT, raw_hash TEXT NOT NULL,
        product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
        event_json TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(source_id,raw_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_raw_events_product_time ON raw_events(product_id,observed_at);
      CREATE TABLE IF NOT EXISTS product_evidence (
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        event_id TEXT NOT NULL REFERENCES raw_events(id) ON DELETE CASCADE,
        evidence_strength REAL NOT NULL, source_family TEXT NOT NULL, country_code TEXT NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY(product_id,event_id)
      );
      CREATE TABLE IF NOT EXISTS country_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT, product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        event_id TEXT NOT NULL REFERENCES raw_events(id) ON DELETE CASCADE, country_code TEXT NOT NULL,
        signal_date TEXT NOT NULL, source_family TEXT NOT NULL, weight REAL NOT NULL, metrics_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(product_id,event_id)
      );
      CREATE TABLE IF NOT EXISTS media_assets (
        id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        event_id TEXT NOT NULL REFERENCES raw_events(id) ON DELETE CASCADE, url TEXT NOT NULL,
        media_type TEXT NOT NULL, rights_status TEXT NOT NULL, license TEXT, attribution TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, UNIQUE(product_id,url)
      );
      CREATE TABLE IF NOT EXISTS safety_records (
        id TEXT PRIMARY KEY, source_id TEXT NOT NULL, external_id TEXT, title TEXT NOT NULL,
        brand TEXT, model TEXT, country_code TEXT NOT NULL, risk_level TEXT, published_at TEXT,
        source_url TEXT NOT NULL, raw_hash TEXT NOT NULL UNIQUE, raw_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_safety_title ON safety_records(title);
      CREATE TABLE IF NOT EXISTS exchange_rates (
        rate_date TEXT NOT NULL, currency TEXT NOT NULL, rate_per_eur REAL NOT NULL,
        source_url TEXT NOT NULL, observed_at TEXT NOT NULL, PRIMARY KEY(rate_date,currency)
      );
      CREATE TABLE IF NOT EXISTS reuse_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, product_id TEXT NOT NULL,
        from_bucket TEXT, to_bucket TEXT NOT NULL, reason TEXT NOT NULL,
        evidence_ids_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_health (
        source_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'UNKNOWN', consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_success_at TEXT, last_failure_at TEXT, paused_until TEXT, last_error TEXT,
        records_last_run INTEGER NOT NULL DEFAULT 0, baseline_records REAL NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tombstones (
        natural_key_hash TEXT PRIMARY KEY, reason TEXT NOT NULL, first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL, deleted_at TEXT NOT NULL, last_heat_score REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, severity TEXT NOT NULL,
        message TEXT NOT NULL, meta_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
      );
    `)
    this.setSetting('schema.version', 1)
    this.setSetting('project.name', '跨境热销商品雷达：全量商品完整说明版')
    this.setSetting('retention.lowHeatNonReusableDays', 30)
    this.setSetting('threshold.nonReusableResearchHeat', 60)
  }

  close(): void { this.db.close() }

  setSetting(key: string, value: unknown): void {
    this.db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(key, JSON.stringify(value), nowIso())
  }

  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value?: string } | undefined
    return row?.value ? safeJson(row.value, fallback) : fallback
  }

  audit(type: string, message: string, meta: Record<string, unknown> = {}, severity = 'INFO'): void {
    this.db.prepare('INSERT INTO audit_events(type,severity,message,meta_json,created_at) VALUES(?,?,?,?,?)')
      .run(type, severity, message, JSON.stringify(meta), nowIso())
  }

  beginRun(mode: string, meta: Record<string, unknown> = {}): string {
    const id = createId('run')
    this.db.prepare('INSERT INTO runs(id,mode,status,started_at,meta_json) VALUES(?,?,?,?,?)')
      .run(id, mode, 'RUNNING', nowIso(), JSON.stringify(meta))
    return id
  }

  finishRun(id: string, eventCount: number, errors: number, meta: Record<string, unknown> = {}): void {
    this.db.prepare('UPDATE runs SET status=?,completed_at=?,event_count=?,error_count=?,meta_json=? WHERE id=?')
      .run(errors ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED', nowIso(), eventCount, errors, JSON.stringify(meta), id)
  }

  updateSourceHealth(sourceId: string, success: boolean, recordCount: number, error?: string): void {
    const existing = this.db.prepare('SELECT * FROM source_health WHERE source_id=?').get(sourceId) as {
      consecutive_failures?: number
      paused_until?: string | null
      baseline_records?: number
      last_success_at?: string | null
      last_failure_at?: string | null
    } | undefined
    const failures = success ? 0 : Number(existing?.consecutive_failures || 0) + 1
    const now = nowIso()
    const pauseAfter = 3
    const pausedUntil = failures >= pauseAfter ? new Date(Date.now() + 12 * 3_600_000).toISOString() : existing?.paused_until || null
    const oldBaseline = Number(existing?.baseline_records || 0)
    const baseline = success ? (oldBaseline ? oldBaseline * 0.8 + recordCount * 0.2 : recordCount) : oldBaseline
    this.db.prepare(`INSERT INTO source_health(source_id,status,consecutive_failures,last_success_at,last_failure_at,paused_until,last_error,records_last_run,baseline_records,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET
      status=excluded.status,consecutive_failures=excluded.consecutive_failures,last_success_at=excluded.last_success_at,
      last_failure_at=excluded.last_failure_at,paused_until=excluded.paused_until,last_error=excluded.last_error,
      records_last_run=excluded.records_last_run,baseline_records=excluded.baseline_records,updated_at=excluded.updated_at`)
      .run(sourceId, success ? 'HEALTHY' : failures >= pauseAfter ? 'PAUSED' : 'ERROR', failures,
        success ? now : existing?.last_success_at || null, success ? existing?.last_failure_at || null : now,
        pausedUntil, success ? null : error || 'unknown', recordCount, baseline, now)
  }

  sourceIsPaused(sourceId: string): boolean {
    const row = this.db.prepare('SELECT paused_until FROM source_health WHERE source_id=?').get(sourceId) as { paused_until?: string } | undefined
    return Boolean(row?.paused_until && new Date(row.paused_until).getTime() > Date.now())
  }

  importCloudSourceHealth(sources: Record<string, {
    consecutiveFailures?: number, lastSuccessAt?: string | null, lastFailureAt?: string | null,
    pausedUntil?: string | null, lastError?: string | null, recordsLastRun?: number,
  }>, allowedSourceIds: Set<string>): { imported: number } {
    const upsert = this.db.prepare(`INSERT INTO source_health(source_id,status,consecutive_failures,last_success_at,last_failure_at,paused_until,last_error,records_last_run,baseline_records,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET
      status=excluded.status,consecutive_failures=excluded.consecutive_failures,last_success_at=excluded.last_success_at,
      last_failure_at=excluded.last_failure_at,paused_until=excluded.paused_until,last_error=excluded.last_error,
      records_last_run=excluded.records_last_run,updated_at=excluded.updated_at`)
    let imported = 0; const now = nowIso()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const [sourceId, state] of Object.entries(sources)) {
        if (!allowedSourceIds.has(sourceId)) continue
        const failures = Math.max(0, Math.min(100, Number(state.consecutiveFailures || 0)))
        const paused = Boolean(state.pausedUntil && new Date(state.pausedUntil).getTime() > Date.now())
        const status = paused ? 'PAUSED' : failures ? 'ERROR' : 'HEALTHY'
        upsert.run(sourceId, status, failures, state.lastSuccessAt || null, state.lastFailureAt || null,
          state.pausedUntil || null, state.lastError ? String(state.lastError).slice(0, 300) : null,
          Math.max(0, Number(state.recordsLastRun || 0)), 0, now)
        imported += 1
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    this.audit('CLOUD_SOURCE_HEALTH_IMPORTED', `已同步${imported}个云端来源健康状态`, { imported })
    return { imported }
  }

  ingestEvents(events: CollectorEvent[]): { inserted: number, products: number, safety: number, fx: number } {
    let inserted = 0; let products = 0; let safety = 0; let fx = 0
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const event of events) {
        const eventInsert = this.db.prepare(`INSERT OR IGNORE INTO raw_events(
          id,run_id,source_id,source_family,source_url,country_code,event_type,observed_at,published_at,raw_hash,event_json,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(event.eventId, event.runId, event.sourceId, event.sourceFamily, event.sourceUrl,
          event.countryCode, event.eventType, event.observedAt, event.publishedAt || null, event.rawHash, JSON.stringify(event), nowIso())
        if (!Number(eventInsert.changes || 0)) continue
        inserted += 1
        if (event.eventType === 'SAFETY') { this.insertSafety(event); safety += 1; continue }
        if (event.eventType === 'FX') { this.insertRates(event); fx += 1; continue }
        if (!event.productHint?.originalName) continue
        const productId = this.upsertProduct(event)
        if (!productId) continue
        this.db.prepare('UPDATE raw_events SET product_id=? WHERE id=?').run(productId, event.eventId)
        this.db.prepare('INSERT OR IGNORE INTO product_evidence(product_id,event_id,evidence_strength,source_family,country_code,created_at) VALUES(?,?,?,?,?,?)')
          .run(productId, event.eventId, event.evidenceStrength, event.sourceFamily, event.countryCode, nowIso())
        const familyWeights: Record<string, number> = { DEMAND: 4, COMMERCE: 3, CREATIVE: 2, NEWS: 1, SAFETY: 0, FX: 0 }
        this.db.prepare('INSERT OR IGNORE INTO country_signals(product_id,event_id,country_code,signal_date,source_family,weight,metrics_json) VALUES(?,?,?,?,?,?,?)')
          .run(productId, event.eventId, event.countryCode, (event.publishedAt || event.observedAt).slice(0, 10), event.sourceFamily,
            familyWeights[event.sourceFamily] || 1, JSON.stringify(event.metrics || {}))
        for (const media of event.mediaRefs || []) this.db.prepare(`INSERT OR IGNORE INTO media_assets(
          id,product_id,event_id,url,media_type,rights_status,license,attribution,metadata_json,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(createId('media'), productId, event.eventId, media.url, media.type, media.rightsStatus,
          media.license || null, media.attribution || null, JSON.stringify({ width: media.width, height: media.height, durationSeconds: media.durationSeconds }), nowIso())
        products += 1
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return { inserted, products, safety, fx }
  }

  private upsertProduct(event: CollectorEvent): string | null {
    const hint = event.productHint!
    const key = naturalKey(hint)
    const tombstone = this.db.prepare('SELECT * FROM tombstones WHERE natural_key_hash=?').get(sha256(key)) as { deleted_at?: string, reason?: string } | undefined
    const isStrongReturn = Number(event.metrics?.searchVolume || 0) >= 10_000
    const directProductEvidence = event.sourceFamily === 'COMMERCE' || Boolean(hint.gtin || hint.mpn || (hint.brand && hint.model))
    const tombstoneAge = tombstone?.deleted_at ? Date.now() - new Date(tombstone.deleted_at).getTime() : Number.POSITIVE_INFINITY
    const definitiveNonProduct = tombstone?.reason?.startsWith('明确非商品')
    if (tombstone?.deleted_at && ((definitiveNonProduct && !directProductEvidence && tombstoneAge < 30 * 86_400_000) || (!isStrongReturn && !directProductEvidence && tombstoneAge < 7 * 86_400_000))) {
      this.db.prepare('UPDATE tombstones SET last_seen_at=? WHERE natural_key_hash=?').run(event.observedAt, sha256(key))
      return null
    }
    const existing = this.db.prepare('SELECT * FROM products WHERE natural_key=?').get(key) as ProductRecord | undefined
    if (existing) {
      this.db.prepare(`UPDATE products SET
        original_name=?,zh_name=COALESCE(NULLIF(?,''),zh_name),brand=COALESCE(NULLIF(?,''),brand),model=COALESCE(NULLIF(?,''),model),
        gtin=COALESCE(NULLIF(?,''),gtin),mpn=COALESCE(NULLIF(?,''),mpn),category=COALESCE(NULLIF(?,''),category),
        description_zh=COALESCE(NULLIF(?,''),description_zh),specs_json=?,variants_json=?,use_cases_json=?,target_users_json=?,
        unsuitable_scenarios_json=?,features_json=?,supplier_json=?,last_seen_at=?,updated_at=? WHERE id=?`)
        .run(hint.originalName, hint.zhName || '', hint.brand || '', hint.model || '', hint.gtin || '', hint.mpn || '', hint.category || '', hint.description || '',
          JSON.stringify({ ...safeJson(existing.specs_json, {}), ...(hint.specs || {}) }), JSON.stringify([...new Set([...safeJson(existing.variants_json, []), ...(hint.variants || [])])]),
          JSON.stringify([...new Set([...safeJson(existing.use_cases_json, []), ...(hint.useCases || [])])]),
          JSON.stringify([...new Set([...safeJson(existing.target_users_json, []), ...(hint.targetUsers || [])])]),
          JSON.stringify([...new Set([...safeJson(existing.unsuitable_scenarios_json, []), ...(hint.unsuitableScenarios || [])])]),
          JSON.stringify([...new Set([...safeJson(existing.features_json, []), ...(hint.features || [])])]),
          JSON.stringify({ ...safeJson(existing.supplier_json, {}), ...(hint.supplier || {}) }), event.observedAt, nowIso(), existing.id)
      return existing.id
    }
    const id = createId('product')
    const first = event.publishedAt || event.observedAt
    this.db.prepare(`INSERT INTO products(
      id,natural_key,original_name,zh_name,brand,model,gtin,mpn,category,description_zh,specs_json,variants_json,use_cases_json,
      target_users_json,unsuitable_scenarios_json,features_json,supplier_json,first_evidence_at,system_first_seen_at,last_seen_at,
      trend_age_band,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, key, hint.originalName, hint.zhName || null, hint.brand || null,
      hint.model || null, hint.gtin || null, hint.mpn || null, hint.category || null, hint.description || null,
      JSON.stringify(hint.specs || {}), JSON.stringify(hint.variants || []), JSON.stringify(hint.useCases || []), JSON.stringify(hint.targetUsers || []),
      JSON.stringify(hint.unsuitableScenarios || []), JSON.stringify(hint.features || []), JSON.stringify(hint.supplier || {}),
      first, event.observedAt, event.observedAt, ageBand(first), nowIso(), nowIso())
    return id
  }

  private insertSafety(event: CollectorEvent): void {
    const hint = event.productHint || { originalName: String(event.raw?.title || '未命名召回记录') }
    this.db.prepare(`INSERT OR IGNORE INTO safety_records(
      id,source_id,external_id,title,brand,model,country_code,risk_level,published_at,source_url,raw_hash,raw_json,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(createId('safety'), event.sourceId, String(event.raw?.externalId || ''), hint.originalName,
      hint.brand || null, hint.model || null, event.countryCode, String(event.raw?.riskLevel || ''), event.publishedAt || null,
      event.sourceUrl, event.rawHash, JSON.stringify(event.raw || {}), nowIso())
  }

  private insertRates(event: CollectorEvent): void {
    const rates = (event.raw?.rates || {}) as Record<string, number>
    const rateDate = String(event.raw?.rateDate || event.observedAt.slice(0, 10))
    const insert = this.db.prepare('INSERT OR REPLACE INTO exchange_rates(rate_date,currency,rate_per_eur,source_url,observed_at) VALUES(?,?,?,?,?)')
    for (const [currency, rate] of Object.entries(rates)) if (Number.isFinite(Number(rate))) insert.run(rateDate, currency, Number(rate), event.sourceUrl, event.observedAt)
  }

  listProducts(bucket?: ReuseBucket, includeStaging = false): ProductRecord[] {
    const where = [includeStaging ? "status IN ('ACTIVE','STAGING')" : "status='ACTIVE'"]
    const params: SQLInputValue[] = []
    if (bucket) { where.push('reuse_bucket=?'); params.push(bucket) }
    return this.db.prepare(`SELECT * FROM products WHERE ${where.join(' AND ')} ORDER BY research_heat_score DESC,last_seen_at DESC`).all(...params) as unknown as ProductRecord[]
  }

  getProduct(id: string): ProductRecord | null { return (this.db.prepare('SELECT * FROM products WHERE id=?').get(id) as ProductRecord | undefined) || null }

  getEvents(productId: string): CollectorEvent[] {
    return (this.db.prepare('SELECT event_json FROM raw_events WHERE product_id=? ORDER BY observed_at').all(productId) as { event_json: string }[])
      .map((row) => safeJson(row.event_json, null as unknown as CollectorEvent)).filter(Boolean)
  }

  getMedia(productId: string): Record<string, unknown>[] { return this.db.prepare('SELECT * FROM media_assets WHERE product_id=? ORDER BY created_at').all(productId) as Record<string, unknown>[] }
  getCountrySignals(productId: string): Record<string, unknown>[] { return this.db.prepare('SELECT * FROM country_signals WHERE product_id=? ORDER BY signal_date').all(productId) as Record<string, unknown>[] }
  getSafetyRecords(): Record<string, unknown>[] { return this.db.prepare('SELECT * FROM safety_records ORDER BY published_at DESC LIMIT 10000').all() as Record<string, unknown>[] }

  updateAnalysis(product: ProductRecord, analysis: ProductAnalysis, dossier: Record<string, unknown>, options: { resetPeak?: boolean } = {}): void {
    const previousBucket = product.reuse_bucket
    const newPeak = options.resetPeak ? analysis.researchHeatScore : Math.max(Number(product.peak_heat_score || 0), analysis.researchHeatScore)
    const descriptionField = (dossier.productExplanation as Record<string, unknown> | undefined)?.whatItIs as { state?: string, value?: unknown } | undefined
    const verifiedDescription = descriptionField?.state === '已验证' && typeof descriptionField.value === 'string' ? descriptionField.value : null
    this.db.prepare(`UPDATE products SET description_zh=?,trend_start_at=?,trend_age_band=?,lifecycle=?,research_heat_score=?,peak_heat_score=?,
      commercial_score=?,completeness=?,confidence=?,reuse_bucket=?,commercial_grade=?,rights_status=?,risk_flags_json=?,research_reason=?,
      restriction_reason=?,missing_requirements_json=?,status=?,dossier_json=?,updated_at=? WHERE id=?`)
      .run(verifiedDescription, analysis.trendStartAt, analysis.trendAgeBand, analysis.lifecycle, analysis.researchHeatScore, newPeak,
        analysis.commercialScore, analysis.completeness, analysis.confidence, analysis.reuseBucket, analysis.commercialGrade,
        analysis.rightsStatus, JSON.stringify(analysis.riskFlags), analysis.researchReason, analysis.restrictionReason,
        JSON.stringify(analysis.missingRequirements), analysis.status, JSON.stringify(dossier), nowIso(), product.id)
    if (previousBucket !== analysis.reuseBucket) this.db.prepare('INSERT INTO reuse_transitions(product_id,from_bucket,to_bucket,reason,evidence_ids_json,created_at) VALUES(?,?,?,?,?,?)')
      .run(product.id, previousBucket, analysis.reuseBucket, analysis.restrictionReason || analysis.researchReason, JSON.stringify(this.getEvents(product.id).map((event) => event.eventId)), nowIso())
  }

  pruneLowHeat(days = 30): { pruned: number } {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString()
    const rows = this.db.prepare(`SELECT * FROM products WHERE reuse_bucket='NON_REUSABLE' AND status='STAGING'
      AND (peak_heat_score<60 OR research_reason LIKE '范围待确认：%') AND last_seen_at<?`).all(cutoff) as unknown as ProductRecord[]
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows) {
        const reason = row.research_reason.startsWith('范围待确认：') ? '非实体商品或商品范围无法确认，30天后清理' : '普通热度不可复用商品，30天未升温'
        this.db.prepare(`INSERT INTO tombstones(natural_key_hash,reason,first_seen_at,last_seen_at,deleted_at,last_heat_score)
          VALUES(?,?,?,?,?,?) ON CONFLICT(natural_key_hash) DO UPDATE SET reason=excluded.reason,last_seen_at=excluded.last_seen_at,
          deleted_at=excluded.deleted_at,last_heat_score=excluded.last_heat_score`).run(sha256(row.natural_key), reason,
          row.first_evidence_at, row.last_seen_at, nowIso(), row.peak_heat_score)
        this.db.prepare('DELETE FROM raw_events WHERE product_id=?').run(row.id)
        this.db.prepare('DELETE FROM products WHERE id=?').run(row.id)
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    if (rows.length) this.audit('LOW_HEAT_NON_REUSABLE_PRUNED', `已清理${rows.length}个普通热度不可复用商品`, { days })
    return { pruned: rows.length }
  }

  pruneDefinitiveNonProducts(): { pruned: number } {
    const rows = this.db.prepare(`SELECT * FROM products WHERE reuse_bucket='NON_REUSABLE' AND status='STAGING'
      AND research_reason LIKE '范围待确认：%'`).all() as unknown as ProductRecord[]
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows) {
        this.db.prepare(`INSERT INTO tombstones(natural_key_hash,reason,first_seen_at,last_seen_at,deleted_at,last_heat_score)
          VALUES(?,?,?,?,?,?) ON CONFLICT(natural_key_hash) DO UPDATE SET reason=excluded.reason,last_seen_at=excluded.last_seen_at,
          deleted_at=excluded.deleted_at,last_heat_score=excluded.last_heat_score`).run(sha256(row.natural_key),
          '明确非商品或无法证明为实体商品，已立即匿名化清理', row.first_evidence_at, row.last_seen_at, nowIso(), row.peak_heat_score)
        this.db.prepare('DELETE FROM raw_events WHERE product_id=?').run(row.id)
        this.db.prepare('DELETE FROM products WHERE id=?').run(row.id)
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    if (rows.length) this.audit('DEFINITIVE_NON_PRODUCTS_PRUNED', `已立即清理${rows.length}个明确非商品趋势词`, { count: rows.length })
    return { pruned: rows.length }
  }

  removeSourceEvents(sourceId: string, reason: string): { removed: number } {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM raw_events WHERE source_id=?').get(sourceId) as { n?: number }
    const removed = Number(row?.n || 0)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      // 外键级联会同步删除证据、国家信号和素材链接；不删除仍由其它来源支持的商品档案。
      this.db.prepare('DELETE FROM raw_events WHERE source_id=?').run(sourceId)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    this.audit('SOURCE_EVENTS_REMOVED', '已移除来源的错误或过期事件，不删除其它来源支持的商品', { sourceId, removed, reason }, 'WARN')
    return { removed }
  }

  clearUnverifiedHistoricalCategories(sourceId: string): { cleared: number } {
    const result = this.db.prepare(`UPDATE products SET category=NULL, updated_at=?
      WHERE category IS NOT NULL
        AND id IN (
          SELECT DISTINCT pe.product_id FROM product_evidence pe
          JOIN raw_events event ON event.id=pe.event_id
          WHERE event.source_id=?
        )
        AND NOT EXISTS (
          SELECT 1 FROM product_evidence otherEvidence
          JOIN raw_events otherEvent ON otherEvent.id=otherEvidence.event_id
          WHERE otherEvidence.product_id=products.id AND otherEvent.source_id<>?
        )`).run(nowIso(), sourceId, sourceId)
    const cleared = Number(result.changes || 0)
    if (cleared) this.audit('UNVERIFIED_HISTORY_CATEGORY_CLEARED', '已清除仅来自离线广告记录的未核验品类', { sourceId, cleared }, 'WARN')
    return { cleared }
  }

  integrityCheck(full = false): string {
    const pragma = full ? 'integrity_check' : 'quick_check'
    const row = this.db.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown>
    return String(row[pragma] || Object.values(row)[0] || 'unknown')
  }

  createBackup(): { daily: string, weekly?: string, monthly?: string } {
    if (this.dbPath === ':memory:') throw new Error('内存数据库不能备份')
    const backupDir = path.join(paths.backupRoot, '数据库备份')
    fs.mkdirSync(backupDir, { recursive: true })
    this.db.exec('PRAGMA wal_checkpoint(FULL)')
    const now = new Date(); const tags = taipeiBackupTags(now)
    const daily = path.join(backupDir, `daily-${tags.day}.db`)
    const staging = `${daily}.${process.pid}.${Date.now()}.tmp`
    try {
      this.db.exec(`VACUUM INTO '${sqlString(staging)}'`)
      fs.renameSync(staging, daily)
    } finally { if (fs.existsSync(staging)) fs.rmSync(staging, { force: true }) }
    const weekly = path.join(backupDir, `weekly-${tags.week}.db`)
    const monthly = path.join(backupDir, `monthly-${tags.month}.db`)
    copyFileAtomic(daily, weekly); copyFileAtomic(daily, monthly)
    const result: { daily: string, weekly?: string, monthly?: string } = { daily, weekly, monthly }
    // Only canonical calendar snapshots are pruned. Older timestamp backups are
    // preserved as legacy recovery points during this non-destructive migration.
    this.pruneBackupSet(backupDir, /^daily-\d{4}-\d{2}-\d{2}\.db$/, 7)
    this.pruneBackupSet(backupDir, /^weekly-\d{4}-W\d{2}\.db$/, 5)
    this.pruneBackupSet(backupDir, /^monthly-\d{4}-\d{2}\.db$/, 6)
    this.audit('BACKUP_CREATED', '已创建版本化数据库备份', result)
    return result
  }

  private pruneBackupSet(directory: string, pattern: RegExp, keep: number): void {
    const files = fs.readdirSync(directory).filter((name) => pattern.test(name)).map((name) => ({ name, time: fs.statSync(path.join(directory, name)).mtimeMs })).sort((a, b) => b.time - a.time)
    for (const file of files.slice(keep)) fs.rmSync(path.join(directory, file.name), { force: true })
  }

  dashboard(): Record<string, unknown> {
    const count = (sql: string, ...params: SQLInputValue[]) => Number((this.db.prepare(sql).get(...params) as { n?: number })?.n || 0)
    const lastRun = this.db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 1').get() || null
    const lastBackup = this.db.prepare("SELECT created_at,meta_json FROM audit_events WHERE type='BACKUP_CREATED' ORDER BY id DESC LIMIT 1").get() || null
    return {
      counts: {
        reusable: count("SELECT COUNT(*) n FROM products WHERE status='ACTIVE' AND reuse_bucket='REUSABLE'"),
        nonReusableHot: count("SELECT COUNT(*) n FROM products WHERE status='ACTIVE' AND reuse_bucket='NON_REUSABLE'"),
        staging: count("SELECT COUNT(*) n FROM products WHERE status='STAGING'"),
        safety: count('SELECT COUNT(*) n FROM safety_records'),
        tombstones: count('SELECT COUNT(*) n FROM tombstones'),
      },
      lastRun,
      lastBackup,
      integrity: this.integrityCheck(false),
      sources: this.db.prepare('SELECT * FROM source_health ORDER BY source_id').all(),
      recentAudits: this.db.prepare('SELECT * FROM audit_events ORDER BY id DESC LIMIT 20').all(),
    }
  }

  exportSnapshot(bucket: ReuseBucket): Record<string, unknown> {
    const products = this.listProducts(bucket).map((product) => ({
      ...product,
      specs: safeJson(product.specs_json, {}), variants: safeJson(product.variants_json, []), useCases: safeJson(product.use_cases_json, []),
      targetUsers: safeJson(product.target_users_json, []), unsuitableScenarios: safeJson(product.unsuitable_scenarios_json, []),
      features: safeJson(product.features_json, []), supplier: safeJson(product.supplier_json, {}), riskFlags: safeJson(product.risk_flags_json, []),
      missingRequirements: safeJson(product.missing_requirements_json, []), dossier: safeJson(product.dossier_json, {}),
      events: this.getEvents(product.id), media: this.getMedia(product.id), countrySignals: this.getCountrySignals(product.id),
    }))
    return {
      generatedAt: nowIso(), bucket, projectName: this.getSetting('project.name', ''), products,
      sourceHealth: this.db.prepare('SELECT * FROM source_health ORDER BY source_id').all(),
      audits: this.db.prepare('SELECT * FROM audit_events ORDER BY id DESC LIMIT 1000').all(),
    }
  }
}
