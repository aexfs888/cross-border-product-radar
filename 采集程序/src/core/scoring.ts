import { loadCountries, loadKeywordRules } from './config.js'
import { ageBand, clamp, credibleProductDescription, isProductLike, normalizeText, safeJson, textHasTerm } from './utils.js'
import type { CollectorEvent, ProductAnalysis, ProductRecord, RightsStatus } from './types.js'

function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function tokenSimilarity(a: string, b: string): number {
  const left = new Set(normalizeText(a).split(' ').filter((value) => value.length >= 3))
  const right = new Set(normalizeText(b).split(' ').filter((value) => value.length >= 3))
  if (!left.size || !right.size) return 0
  const common = [...left].filter((token) => right.has(token)).length
  return common / new Set([...left, ...right]).size
}

export function analyzeProduct(product: ProductRecord, events: CollectorEvent[], media: Record<string, unknown>[], safetyRecords: Record<string, unknown>[]): ProductAnalysis {
  const now = Date.now()
  // 公开网页研究链接只保存为跳转、核对与证据链入口。它不代表该页面
  // 已证明商品身份、真实需求、价格、供应或商业可用性，因此绝不能影响分数或闸门。
  // 注意：离线历史广告同为仅研究来源，但有独立的、允许使用的广告代理分值，不能一概排除。
  const eligibleEvents = events.filter((event) => event.sourceId !== 'manual-public-product-links-20260901')
  const latestCommerceByPage = new Map<string, CollectorEvent>()
  for (const event of eligibleEvents.filter((item) => item.sourceFamily === 'COMMERCE')) {
    const previous = latestCommerceByPage.get(event.sourceUrl)
    if (!previous || new Date(event.observedAt).getTime() > new Date(previous.observedAt).getTime()) latestCommerceByPage.set(event.sourceUrl, event)
  }
  // Re-reading one unchanged product page is freshness monitoring, not a new
  // independent commercial signal.  Only the latest observation per page may score.
  const scoringEvents = [
    ...eligibleEvents.filter((event) => event.sourceFamily !== 'COMMERCE'),
    ...latestCommerceByPage.values(),
  ]
  const signalWeights = new Map<string, number>()
  const families = new Set<string>(); const countries = new Set<string>()
  const heatFamilies = new Set<string>(); const heatCountries = new Set<string>(); const heatDays = new Set<string>()
  let latestHeatSignal = 0; let maxSearchVolume = 0; let creativeCount = 0; let commerceSignal = 0; let evidenceSum = 0; let historicalAdSignal = 0
  for (const event of scoringEvents) {
    const time = new Date(event.publishedAt || event.observedAt).getTime()
    const day = new Date(time).toISOString().slice(0, 10)
    const weight = ({ DEMAND: 4, COMMERCE: 3, CREATIVE: 2, NEWS: 1, SAFETY: 0, FX: 0 } as Record<string, number>)[event.sourceFamily] || 1
    // 商品页存在、价格和库存只能补充商业证据，不能冒充趋势加速。热度时间序列只接收
    // DEMAND / NEWS / CREATIVE；COMMERCE 仅通过下面有上限的 commerce 分量贡献。
    if (['DEMAND', 'NEWS', 'CREATIVE'].includes(event.sourceFamily)) {
      signalWeights.set(day, (signalWeights.get(day) || 0) + weight)
      heatFamilies.add(event.sourceFamily); if (event.countryCode !== 'GLOBAL') heatCountries.add(event.countryCode); heatDays.add(day)
      latestHeatSignal = Math.max(latestHeatSignal, time)
    }
    families.add(event.sourceFamily); if (event.countryCode !== 'GLOBAL') countries.add(event.countryCode)
    maxSearchVolume = Math.max(maxSearchVolume, Number(event.metrics?.searchVolume || 0))
    creativeCount += Number(event.metrics?.creativeCount || (event.sourceFamily === 'CREATIVE' ? 1 : 0))
    if (event.sourceId === 'pipiads-offline-history-20260822') historicalAdSignal = Math.max(historicalAdSignal, Number(event.metrics?.adSignal || 0))
    commerceSignal += Number(Boolean(event.metrics?.price)) + Math.min(3, Number(event.metrics?.offerCount || 0)) + Math.min(3, Number(event.metrics?.stockSignal || 0))
    evidenceSum += event.evidenceStrength
  }
  const recent7 = [...signalWeights].filter(([day]) => now - new Date(day).getTime() <= 7 * 86_400_000).reduce((sum, [, value]) => sum + value, 0)
  const priorDays = [...signalWeights].filter(([day]) => {
    const age = now - new Date(day).getTime(); return age > 7 * 86_400_000 && age <= 35 * 86_400_000
  }).map(([, value]) => value)
  const baseline = Math.max(1, median(priorDays))
  const ratioScore = clamp((recent7 / baseline - 1) * 17.5, 0, 35)
  const volumeScore = clamp(Math.log10(maxSearchVolume + 1) / 6 * 35, 0, 35)
  const acceleration = Math.max(ratioScore, volumeScore)
  const persistence = clamp(heatFamilies.size * 5 + Math.min(5, heatDays.size), 0, 20)
  const countrySpread = clamp(heatCountries.size * 3, 0, 15)
  const ageDays = latestHeatSignal ? (now - latestHeatSignal) / 86_400_000 : 180
  const freshness = ageDays <= 1 ? 10 : ageDays <= 7 ? 8 : ageDays <= 30 ? 5 : 2
  const creative = clamp(creativeCount * 2, 0, 10)
  const commerce = clamp(commerceSignal * 2, 0, 10)
  // 历史广告代理只用于决定是否值得进入“不可复用研究库”；它绝不是销量或利润，且无法帮助商品通过可复用闸门。
  const historicalCreativeProxy = clamp(historicalAdSignal * 0.62, 0, 45)
  const researchHeatScore = Number(clamp(acceleration + persistence + countrySpread + freshness + creative + commerce + historicalCreativeProxy).toFixed(2))

  const rules = loadKeywordRules(); const title = normalizeText(`${product.original_name} ${product.brand || ''} ${product.model || ''}`)
  const hasAny = (terms: string[]) => terms.some((term) => textHasTerm(title, term))
  const riskFlags: string[] = []
  if (hasAny(rules.ipRiskTerms)) riskFlags.push('知识产权关键词需人工复核')
  if (hasAny(rules.regulatedTerms)) riskFlags.push('受监管品类资料不足')
  if (hasAny(rules.logisticsRiskTerms)) riskFlags.push('跨境物流风险')
  const blockedTerm = hasAny(rules.blockedProductTerms)
  if (blockedTerm) riskFlags.push('命中明确禁止或高风险关键词')
  const safetyMatches = safetyRecords.filter((record) => tokenSimilarity(product.original_name, String(record.title || '')) >= 0.58).slice(0, 5)
  if (safetyMatches.length) riskFlags.push(`疑似匹配${safetyMatches.length}条官方召回或安全记录`)

  const specs = safeJson<Record<string, unknown>>(product.specs_json, {})
  const supplier = safeJson<Record<string, unknown>>(product.supplier_json, {})
  const sourceRiskFlags = String(specs.sourceRiskFlags || '').split('；').map((item) => item.trim()).filter(Boolean)
  for (const flag of sourceRiskFlags) if (!riskFlags.includes(flag)) riskFlags.push(flag)
  const authorizedMedia = media.filter((item) => item.rights_status === 'AUTHORIZED')
  const rightsStatus: RightsStatus = authorizedMedia.length ? 'AUTHORIZED' : media.some((item) => item.rights_status === 'PROHIBITED') ? 'PROHIBITED' : media.length ? 'LINK_ONLY' : 'UNKNOWN'
  const identityConfirmed = Boolean(product.gtin || product.mpn || (product.brand && product.model))
  const scopeConfirmed = isProductLike(product.original_name, rules.productTerms, rules.nonProductTerms) || identityConfirmed || scoringEvents.some((event) => event.sourceFamily === 'COMMERCE' || event.eventType === 'SAFETY')
  const targetEu = [...countries].some((code) => ['IE', 'SE', 'DK', 'FI'].includes(code))
  const responsibleReady = !targetEu || Boolean(specs.manufacturer && specs.euResponsiblePerson && specs.warnings)
  const supplierReady = supplier.verified === true && Boolean(supplier.url || supplier.name) && Boolean(supplier.shipsTo)
  const costReady = Boolean(scoringEvents.some((event) => Number(event.metrics?.price || 0) > 0))

  const mandatoryChecks = [
    Boolean(product.original_name), identityConfirmed,
    scoringEvents.some((event) => Boolean(credibleProductDescription(event.productHint?.description, product.original_name, product.brand || ''))),
    safeJson(product.use_cases_json, []).length > 0,
    Object.keys(specs).length > 0, countries.size > 0, costReady, supplierReady, media.length > 0,
    authorizedMedia.length > 0, responsibleReady, scoringEvents.length > 0,
  ]
  const completeness = Number((mandatoryChecks.filter(Boolean).length / mandatoryChecks.length * 100).toFixed(2))
  const averageEvidence = scoringEvents.length ? evidenceSum / scoringEvents.length : 0
  const confidence = Number(clamp(averageEvidence * 55 + Math.min(25, families.size * 8) + Math.min(20, countries.size * 5), 0, 100).toFixed(2)) / 100

  const evidenceIdentity = clamp((identityConfirmed ? 12 : 3) + averageEvidence * 8, 0, 20)
  const demandRobustness = clamp(researchHeatScore / 5, 0, 20)
  const supplierScore = supplierReady ? 20 : supplier.verified ? 10 : 2
  const complianceScore = blockedTerm || safetyMatches.length ? 0 : responsibleReady && !hasAny(rules.regulatedTerms) ? 20 : 6
  const costScore = costReady ? 10 : 0
  const mediaScore = authorizedMedia.length ? 10 : 0
  const saturationPenalty = scoringEvents.length > 20 && families.size <= 1 ? 10 : 0
  const commercialScore = Number(clamp(evidenceIdentity + demandRobustness + supplierScore + complianceScore + costScore + mediaScore - saturationPenalty).toFixed(2))

  const missingRequirements: string[] = []
  if (!scopeConfirmed) missingRequirements.push('确认其为可上架的实体商品（排除人物、赛事、票务和纯服务）')
  if (!identityConfirmed) missingRequirements.push('品牌+型号或GTIN/MPN身份信息')
  if (!responsibleReady) missingRequirements.push('制造商、欧盟责任主体和警示信息')
  if (!supplierReady) missingRequirements.push('已核实供应商、可送国家、交期和退货资料')
  if (!authorizedMedia.length) missingRequirements.push('至少一组明确允许商业使用的图片或视频')
  if (completeness < 85) missingRequirements.push(`资料完整度需从${completeness.toFixed(0)}%提高到85%`)
  if (confidence < 0.75) missingRequirements.push(`证据可信度需从${confidence.toFixed(2)}提高到0.75`)
  if (riskFlags.length) missingRequirements.push('解决全部安全、监管、物流和知识产权风险')

  const blocked = blockedTerm || safetyMatches.length > 0
  const reusable = scopeConfirmed && !blocked && !riskFlags.length && identityConfirmed && responsibleReady && supplierReady && authorizedMedia.length > 0 && completeness >= 85 && confidence >= 0.75
  const previousPeak = Number(product.peak_heat_score || 0)
  const status = reusable || (scopeConfirmed && Math.max(previousPeak, researchHeatScore) >= 60) ? 'ACTIVE' : 'STAGING'
  const first = product.first_evidence_at
  const band = ageBand(first)
  const daysSinceFirst = Math.max(0, Math.floor((Date.now() - new Date(first).getTime()) / 86_400_000))
  const lifecycle = !scopeConfirmed ? 'WATCH' : daysSinceFirst <= 7 ? 'NEW' : researchHeatScore >= 80 ? 'ACCELERATING' : researchHeatScore >= 60 ? 'RISING' : researchHeatScore >= 40 ? 'COOLING' : 'WATCH'
  const trendStartAt = recent7 >= 8 && heatFamilies.size >= 2 ? [...scoringEvents].filter((event) => ['DEMAND', 'NEWS', 'CREATIVE'].includes(event.sourceFamily)).sort((a, b) => new Date(a.observedAt).getTime() - new Date(b.observedAt).getTime())[0]?.observedAt || null : null
  const grade = blocked ? 'BLOCKED' : reusable ? commercialScore >= 75 ? 'A' : commercialScore >= 60 ? 'B' : 'C' : 'RESEARCH_ONLY'
  const researchReason = !scopeConfirmed ? '范围待确认：当前线索不能证明它是可上架实体商品，不进入正式库' : historicalAdSignal > 0 && researchHeatScore >= 60 ? '离线历史广告代理研究品：广告信号达到保留门槛；这不是销量或利润证明' : researchHeatScore >= 80 ? '爆发研究品：多源热度显著' : researchHeatScore >= 60 ? '上升研究品：达到不可复用研究保留门槛' : '普通热度：仅在30天待复核区观察'
  const restrictionReason = reusable ? '已通过当前系统级复用初筛' : blocked ? riskFlags.join('；') : [...new Set([...missingRequirements, ...riskFlags])].join('；') || '尚未满足商业复用条件'

  return {
    researchHeatScore, commercialScore, completeness, confidence,
    reuseBucket: reusable ? 'REUSABLE' : 'NON_REUSABLE', commercialGrade: grade, rightsStatus,
    riskFlags, researchReason, restrictionReason, missingRequirements,
    trendAgeBand: band, lifecycle, trendStartAt, status,
  }
}
