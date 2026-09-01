import fs from 'node:fs/promises'
import path from 'node:path'
import { loadCountries } from './config.js'
import { paths } from './paths.js'
import { atomicWrite, safeJson, slug } from './utils.js'
import type { CollectorEvent, DossierField, EvidenceState, ProductAnalysis, ProductRecord } from './types.js'

function field<T>(value: T | null | undefined, evidenceIds: string[], note?: string, explicitState?: EvidenceState): DossierField<T> {
  const present = value !== null && value !== undefined && value !== '' && (!Array.isArray(value) || value.length > 0) &&
    (typeof value !== 'object' || Array.isArray(value) || Object.keys(value as object).length > 0)
  const state = explicitState || (present ? '已验证' : '未知')
  return {
    state,
    value: state === '未知' ? null : value as T,
    evidenceIds: state === '未知' ? [] : evidenceIds,
    note: note || (state === '未知' ? '当前公开证据不足，未作推测' : undefined),
  }
}

function metricEvents(events: CollectorEvent[], key: keyof NonNullable<CollectorEvent['metrics']>): CollectorEvent[] {
  return events.filter((event) => event.metrics?.[key] !== undefined && event.metrics?.[key] !== null)
}

function metricValues(events: CollectorEvent[], key: keyof NonNullable<CollectorEvent['metrics']>): Record<string, unknown>[] {
  return metricEvents(events, key).map((event) => ({ value: event.metrics?.[key], country: event.countryCode, at: event.publishedAt || event.observedAt, source: event.sourceUrl }))
}

function evidenceOf(events: CollectorEvent[]): string[] { return events.map((event) => event.eventId) }

function specsValue(specs: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) if (specs[name] !== undefined && specs[name] !== null && specs[name] !== '') return specs[name]
  return null
}

function identityValue(productValue: string | null, events: CollectorEvent[], key: 'brand' | 'model' | 'gtin' | 'mpn'): DossierField {
  const values = [...new Set(events.map((event) => event.productHint?.[key]).filter(Boolean).map(String))]
  if (values.length > 1) return field(values, evidenceOf(events.filter((event) => event.productHint?.[key])), '多个公开来源给出不同值，必须人工确认', '来源冲突')
  return field(productValue || values[0] || null, evidenceOf(events.filter((event) => event.productHint?.[key])))
}

export function buildDossier(product: ProductRecord, analysis: ProductAnalysis, events: CollectorEvent[], media: Record<string, unknown>[]): Record<string, unknown> {
  const evidenceIds = evidenceOf(events)
  const specs = safeJson<Record<string, unknown>>(product.specs_json, {})
  const supplier = safeJson<Record<string, unknown>>(product.supplier_json, {})
  const variants = safeJson<unknown[]>(product.variants_json, [])
  const useCases = safeJson<unknown[]>(product.use_cases_json, [])
  const targetUsers = safeJson<unknown[]>(product.target_users_json, [])
  const unsuitable = safeJson<unknown[]>(product.unsuitable_scenarios_json, [])
  const features = safeJson<unknown[]>(product.features_json, [])
  const authorized = media.filter((item) => item.rights_status === 'AUTHORIZED')
  const firstEvidenceTime = new Date(product.first_evidence_at).getTime()
  const now = Date.now()
  const sourceFamilies = [...new Set(events.map((event) => event.sourceFamily))]

  const windows = [
    { name: '0–7天', min: 0, max: 7 }, { name: '8–15天', min: 8, max: 15 }, { name: '16–30天', min: 16, max: 30 },
    { name: '31–60天（1–2个月）', min: 31, max: 60 }, { name: '61–90天（2–3个月）', min: 61, max: 90 },
    { name: '91–120天（3–4个月）', min: 91, max: 120 }, { name: '121–180天（4个月–半年）', min: 121, max: 180 },
  ]
  const timeWindows = Object.fromEntries(windows.map((window) => {
    const matches = events.filter((event) => {
      const age = Math.floor((now - new Date(event.publishedAt || event.observedAt).getTime()) / 86_400_000)
      return age >= window.min && age <= window.max
    })
    const ids = evidenceOf(matches)
    return [window.name, {
      observedEvidenceCount: field(matches.length, ids, '仅表示本系统已采集且去重后的证据数量，不等于全网销量'),
      sourceFamilies: field([...new Set(matches.map((event) => event.sourceFamily))], ids),
      countries: field([...new Set(matches.map((event) => event.countryCode).filter((code) => code !== 'GLOBAL'))], ids),
      searchSignals: field(metricValues(matches, 'searchVolume'), evidenceOf(metricEvents(matches, 'searchVolume'))),
      publicSalesSignals: field(metricValues(matches, 'publicSales'), evidenceOf(metricEvents(matches, 'publicSales'))),
    }]
  }))

  const countryPerformance = Object.fromEntries(loadCountries().map((country) => {
    const matches = events.filter((event) => event.countryCode === country.code)
    const ids = evidenceOf(matches)
    return [country.code, {
      countryName: field(country.nameZh, ids, '目标国家固定配置'),
      evidenceCount: field(matches.length, ids, '零表示当前采集来源未发现证据，不代表市场上绝对不存在'),
      latestEvidenceAt: field(matches.length ? matches.map((event) => event.publishedAt || event.observedAt).sort().at(-1) : null, ids),
      search: field(metricValues(matches, 'searchVolume'), evidenceOf(metricEvents(matches, 'searchVolume'))),
      news: field(matches.filter((event) => event.sourceFamily === 'NEWS').map((event) => event.sourceUrl), evidenceOf(matches.filter((event) => event.sourceFamily === 'NEWS'))),
      ads: field(metricValues(matches, 'creativeCount'), evidenceOf(metricEvents(matches, 'creativeCount'))),
      offers: field(metricValues(matches, 'offerCount'), evidenceOf(metricEvents(matches, 'offerCount'))),
      reviews: field(metricValues(matches, 'reviewCount'), evidenceOf(metricEvents(matches, 'reviewCount'))),
      publicSales: field(metricValues(matches, 'publicSales'), evidenceOf(metricEvents(matches, 'publicSales'))),
    }]
  }))

  const prices = events.filter((event) => Number(event.metrics?.price || 0) > 0).map((event) => ({
    value: event.metrics?.price, currency: event.metrics?.currency, country: event.countryCode,
    source: event.sourceUrl, at: event.observedAt,
  }))
  const summary = `${product.zh_name || product.original_name}当前研究热度${analysis.researchHeatScore.toFixed(0)}分。` +
    `系统将其归入${analysis.reuseBucket === 'REUSABLE' ? '可复用商品库' : analysis.status === 'ACTIVE' ? '高热度不可复用研究库' : '30天待复核区（不会进入研究报表）'}。` +
    `当前结论：${analysis.restrictionReason || analysis.researchReason}。热度是公开信号评分，不是销量或利润证明。`

  return {
    schemaVersion: '2.0', productId: product.id, generatedAt: new Date().toISOString(), summary,
    identity: {
      originalName: field(product.original_name, evidenceIds), chineseName: field(product.zh_name, evidenceIds),
      brand: identityValue(product.brand, events, 'brand'), model: identityValue(product.model, events, 'model'),
      gtin: identityValue(product.gtin, events, 'gtin'), mpn: identityValue(product.mpn, events, 'mpn'),
      category: field(product.category, evidenceIds), variants: field(variants, evidenceIds),
    },
    productExplanation: {
      whatItIs: field(product.description_zh, evidenceIds), howToUse: field(specsValue(specs, ['howToUse', 'instructions']), evidenceIds),
      problemSolved: field(specsValue(specs, ['problemSolved', 'benefit']), evidenceIds), useCases: field(useCases, evidenceIds),
      targetUsers: field(targetUsers, evidenceIds), unsuitableScenarios: field(unsuitable, evidenceIds),
    },
    physicalAndPackage: {
      material: field(specsValue(specs, ['material', 'materials']), evidenceIds), size: field(specsValue(specs, ['size', 'dimensions']), evidenceIds),
      weight: field(specsValue(specs, ['weight']), evidenceIds), capacity: field(specsValue(specs, ['capacity']), evidenceIds),
      power: field(specsValue(specs, ['power', 'wattage']), evidenceIds), plug: field(specsValue(specs, ['plug', 'plugType']), evidenceIds),
      packaging: field(specsValue(specs, ['packaging', 'package']), evidenceIds), accessories: field(specsValue(specs, ['accessories', 'included']), evidenceIds),
    },
    functionsAndDifferentiation: {
      coreFunctions: field(features, evidenceIds), differentiators: field(specsValue(specs, ['differentiators', 'uniqueSellingPoints']), evidenceIds),
      demonstrableFeatures: field(specsValue(specs, ['demonstrableFeatures', 'demoPoints']), evidenceIds),
    },
    chronology: {
      earliestEvidence: field(product.first_evidence_at, evidenceIds), trendStart: field(analysis.trendStartAt, evidenceIds, analysis.trendStartAt ? undefined : '未达到连续、多源趋势起点条件'),
      systemFirstFound: field(product.system_first_seen_at, evidenceIds), currentAgeBand: field(analysis.trendAgeBand, evidenceIds),
      daysSinceEarliestEvidence: field(Number.isFinite(firstEvidenceTime) ? Math.max(0, Math.floor((now - firstEvidenceTime) / 86_400_000)) : null, evidenceIds),
      lifecycle: field(analysis.lifecycle, evidenceIds), timeWindows,
    },
    countryPerformance,
    marketEvidence: {
      search: field(metricValues(events, 'searchVolume'), evidenceOf(metricEvents(events, 'searchVolume'))),
      news: field(events.filter((event) => event.sourceFamily === 'NEWS').map((event) => event.sourceUrl), evidenceOf(events.filter((event) => event.sourceFamily === 'NEWS'))),
      ads: field(metricValues(events, 'creativeCount'), evidenceOf(metricEvents(events, 'creativeCount'))),
      quotesAndPrices: field(prices, evidenceOf(events.filter((event) => Number(event.metrics?.price || 0) > 0))),
      inventory: field(metricValues(events, 'stockSignal'), evidenceOf(metricEvents(events, 'stockSignal'))),
      reviews: field(metricValues(events, 'reviewCount'), evidenceOf(metricEvents(events, 'reviewCount'))),
      publicSales: field(metricValues(events, 'publicSales'), evidenceOf(metricEvents(events, 'publicSales')), '只有来源明确公开时才记录；不得反推或估算'),
    },
    supplyAndLogistics: {
      supplierName: field(supplier.name, evidenceIds), supplierUrl: field(supplier.url, evidenceIds), supplierVerified: field(supplier.verified, evidenceIds),
      moq: field(supplier.moq, evidenceIds), leadTimeDays: field(supplier.leadTimeDays, evidenceIds), shipsTo: field(supplier.shipsTo, evidenceIds),
      returnsPolicy: field(supplier.returnsPolicy, evidenceIds), logisticsRestrictions: field(supplier.logisticsRestrictions, evidenceIds),
    },
    shopifyAssessment: {
      fit: field(analysis.reuseBucket === 'REUSABLE' ? '通过初筛' : '当前不具备安全商业复用条件', evidenceIds),
      variantComplexity: field(variants.length ? variants.length : null, evidenceIds), afterSalesDifficulty: field(specsValue(specs, ['afterSalesDifficulty']), evidenceIds),
      commercialGrade: field(analysis.commercialGrade, evidenceIds), commercialScore: field(analysis.commercialScore, evidenceIds),
    },
    mediaAndRights: {
      references: field(media.map((item) => ({ url: item.url, type: item.media_type, rights: item.rights_status, license: item.license, attribution: item.attribution })), evidenceIds),
      authorizedCommercialUseCount: field(authorized.length, evidenceIds), overallRightsStatus: field(analysis.rightsStatus, evidenceIds),
      attributionRequirements: field(authorized.map((item) => item.attribution).filter(Boolean), evidenceIds),
      storageRule: field(analysis.reuseBucket === 'REUSABLE' ? '只允许保存明确商业授权素材' : '只保留公开链接、元数据与研究说明，不下载未知权利素材', evidenceIds),
    },
    promotionAndCompetition: {
      creativePatterns: field(specsValue(specs, ['creativePatterns', 'promotionPatterns']), evidenceIds), competitionLevel: field(specsValue(specs, ['competitionLevel']), evidenceIds),
      saturation: field(specsValue(specs, ['marketSaturation']), evidenceIds), sourceFamilyCoverage: field(sourceFamilies, evidenceIds),
    },
    riskReview: {
      recallAndSafety: field(analysis.riskFlags.filter((item) => /召回|安全|禁止|危险/.test(item)), evidenceIds),
      regulatory: field(analysis.riskFlags.filter((item) => /监管|责任主体/.test(item)), evidenceIds),
      trademarkAndIp: field(analysis.riskFlags.filter((item) => /知识产权|商标|仿/.test(item)), evidenceIds),
      logistics: field(analysis.riskFlags.filter((item) => /物流/.test(item)), evidenceIds),
      allFlags: field(analysis.riskFlags, evidenceIds), restrictionReason: field(analysis.restrictionReason, evidenceIds),
    },
    balancedAssessment: {
      advantages: field(features, evidenceIds), disadvantages: field(analysis.riskFlags, evidenceIds),
      unknownInformation: field(analysis.missingRequirements, evidenceIds), sourceConflicts: field(null, [], '只有出现互相矛盾的身份或规格证据时才标记；当前未形成可验证冲突'),
      researchHeat: field(analysis.researchHeatScore, evidenceIds), commercialPotential: field(analysis.commercialScore, evidenceIds),
      reuseStatus: field(analysis.reuseBucket, evidenceIds), decisionReason: field(analysis.restrictionReason || analysis.researchReason, evidenceIds),
      requirementsToBecomeReusable: field(analysis.missingRequirements, evidenceIds), completeness: field(analysis.completeness, evidenceIds),
      confidence: field(analysis.confidence, evidenceIds), retentionStatus: field(analysis.status, evidenceIds),
    },
    evidence: events.map((event) => ({
      state: '已验证', id: event.eventId, sourceId: event.sourceId, sourceFamily: event.sourceFamily,
      country: event.countryCode, url: event.sourceUrl, publishedAt: event.publishedAt || null,
      collectedAt: event.observedAt, freshnessDays: Math.max(0, Math.floor((now - new Date(event.observedAt).getTime()) / 86_400_000)),
      strength: event.evidenceStrength, rightsStatus: event.rightsStatus,
    })),
  }
}

function display(value: unknown): string {
  if (value === null || value === undefined || value === '') return '未知'
  if (Array.isArray(value)) return value.length ? value.map((item) => typeof item === 'object' ? JSON.stringify(item) : String(item)).join('；') : '未知'
  if (typeof value === 'object') return Object.keys(value as object).length ? JSON.stringify(value) : '未知'
  return String(value)
}

function isField(value: unknown): value is DossierField {
  return Boolean(value && typeof value === 'object' && 'state' in (value as Record<string, unknown>) && 'evidenceIds' in (value as Record<string, unknown>))
}

function flattenFields(value: unknown, prefix = ''): string[] {
  if (isField(value)) return [`- **${prefix}**：${value.state}｜${display(value.value)}${value.note ? `｜${value.note}` : ''}${value.evidenceIds.length ? `｜证据：${value.evidenceIds.join(', ')}` : ''}`]
  if (!value || typeof value !== 'object') return [`- **${prefix}**：未知｜当前公开证据不足，未作推测`]
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => flattenFields(item, prefix ? `${prefix}.${key}` : key))
}

const sectionTitles: Record<string, string> = {
  identity: '商品身份', productExplanation: '商品是什么、如何使用及适用人群', physicalAndPackage: '材质、规格、包装与配件',
  functionsAndDifferentiation: '核心功能、差异点与演示特点', chronology: '时间、趋势阶段与七个窗口', countryPerformance: '11个目标国家分别表现',
  marketEvidence: '搜索、新闻、广告、报价、库存、评价与公开销量', supplyAndLogistics: '供应商、MOQ、交期、退货与物流',
  shopifyAssessment: 'Shopify适配、变体与售后', mediaAndRights: '图片视频、授权与署名', promotionAndCompetition: '推广创意、竞争与饱和',
  riskReview: '召回、安全、监管、商标与知识产权', balancedAssessment: '优缺点、未知、热度、潜力与转库条件',
}

export function dossierMarkdown(product: ProductRecord, dossier: Record<string, unknown>): string {
  const sections = Object.entries(sectionTitles).map(([key, title]) => `## ${title}\n\n${flattenFields(dossier[key]).join('\n')}`).join('\n\n')
  const evidence = ((dossier.evidence || []) as Record<string, unknown>[]).map((item) =>
    `- [${item.id}] 已验证｜${item.sourceId}｜${item.country}｜采集：${item.collectedAt}｜新鲜度：${item.freshnessDays}天｜${item.url}`).join('\n') || '- 未知｜当前没有可列出的证据'
  return `# ${product.zh_name || product.original_name}\n\n> ${String(dossier.summary || '')}\n\n${sections}\n\n## 证据目录\n\n${evidence}\n`
}

export async function writeDossierFile(product: ProductRecord, dossier: Record<string, unknown>): Promise<string | null> {
  if (product.status !== 'ACTIVE') return null
  const directory = product.reuse_bucket === 'REUSABLE' ? paths.reusable : paths.nonReusable
  const otherDirectory = product.reuse_bucket === 'REUSABLE' ? paths.nonReusable : paths.reusable
  const filename = `${product.id}-${slug(product.zh_name || product.original_name)}.md`
  await fs.mkdir(directory, { recursive: true }); await fs.mkdir(paths.history, { recursive: true })
  const otherFiles = (await fs.readdir(otherDirectory).catch(() => [])).filter((name) => name.startsWith(`${product.id}-`) && name.endsWith('.md'))
  for (const old of otherFiles) await fs.rename(path.join(otherDirectory, old), path.join(paths.history, `${new Date().toISOString().replace(/[:.]/g, '-')}-${old}`))
  const filePath = path.join(directory, filename)
  await atomicWrite(filePath, dossierMarkdown(product, dossier))
  return filePath
}
