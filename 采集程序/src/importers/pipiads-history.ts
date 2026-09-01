import fs from 'node:fs/promises'
import { loadKeywordRules } from '../core/config.js'
import { createId, isProductLike, nowIso, sha256 } from '../core/utils.js'
import type { CollectorEvent } from '../core/types.js'

type HistoricalProduct = {
  naturalKey?: unknown
  title?: unknown
  priceUsd?: unknown
  adStartDate?: unknown
  adEndDate?: unknown
  adCount?: unknown
  views?: unknown
  durationDays?: unknown
  shopify?: unknown
  captureConfidence?: unknown
  adSignal?: unknown
  totalScore?: unknown
  decision?: unknown
  riskFlags?: unknown
  decisionReason?: unknown
  category?: unknown
  sourcePage?: unknown
}

type HistoricalExport = { generatedAt?: unknown, products?: HistoricalProduct[] }

function number(value: unknown): number { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0 }
function titleOf(value: unknown): string { return String(value || '').replace(/[™©®]/g, '').replace(/\s+/g, ' ').trim() }
function dateOf(value: unknown, fallback: string): string {
  const parsed = new Date(String(value || ''))
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback
}
function riskFlagsOf(value: unknown, captureConfidence: string): string[] {
  const listed = Array.isArray(value) ? value.map(String).filter(Boolean) : []
  if (captureConfidence !== 'HIGH') listed.push(`离线历史广告 OCR 置信度为 ${captureConfidence || 'UNKNOWN'}，必须独立复核`)
  return [...new Set(listed)]
}

export async function pipiadsHistoryEvents(inputPath: string, runId: string): Promise<{ events: CollectorEvent[], selected: number, skipped: number, sourceHash: string }> {
  const bytes = await fs.readFile(inputPath); const sourceHash = sha256(bytes)
  const parsed = JSON.parse(bytes.toString('utf8')) as HistoricalExport
  if (!Array.isArray(parsed.products)) throw new Error('离线历史文件缺少 products 数组')
  const rules = loadKeywordRules(); const observedAt = nowIso(); const generatedAt = dateOf(parsed.generatedAt, observedAt)
  const events: CollectorEvent[] = []; let skipped = 0
  for (const row of parsed.products) {
    const title = titleOf(row.title); const totalScore = number(row.totalScore); const adSignal = number(row.adSignal)
    const views = number(row.views); const adCount = number(row.adCount); const durationDays = number(row.durationDays); const price = number(row.priceUsd)
    const physical = isProductLike(title, rules.productTerms, rules.nonProductTerms)
    const usable = title.length >= 8 && /\p{L}{3}/u.test(title) && row.shopify === true && totalScore >= 70 && adSignal >= 60 && views >= 100_000 && adCount >= 1 && durationDays >= 1 && price > 0 && physical
    if (!usable) { skipped += 1; continue }
    const captureConfidence = String(row.captureConfidence || 'UNKNOWN'); const sourceRiskFlags = riskFlagsOf(row.riskFlags, captureConfidence)
    const naturalKey = String(row.naturalKey || sha256(title).slice(0, 24)); const publishedAt = dateOf(row.adEndDate || row.adStartDate, generatedAt)
    const raw = {
      provenance: 'Pipiads 离线历史导出；未访问 Pipiads 网页，未消耗额度', sourceHash, generatedAt: parsed.generatedAt || null,
      sourcePage: row.sourcePage || null, captureConfidence, row,
    }
    events.push({
      schemaVersion: '1.0', eventId: createId('event'), runId, sourceId: 'pipiads-offline-history-20260822',
      sourceFamily: 'CREATIVE', sourceUrl: `local-history://pipiads/20260822/${naturalKey}`, sourceDomain: 'local-history', eventType: 'CREATIVE', countryCode: 'GLOBAL',
      observedAt, publishedAt, rawHash: sha256(raw), rightsStatus: 'LINK_ONLY', evidenceStrength: 0.45, policyDecision: 'MANUAL_LINK_ONLY', raw,
      productHint: {
        // 历史广告导出的品类不是商品事实；保留在原始证据中，不能写入正式商品档案。
        originalName: title,
        description: '离线历史广告记录中的商品标题；未取得制造商说明，功能、规格、品牌、型号、供应与合规资料均需独立核验。',
        specs: {
          historicalSource: 'Pipiads 离线历史导出（只读）', captureConfidence,
          historicalAdViews: views, historicalAdCount: adCount, historicalAdDurationDays: durationDays,
          historicalPromotionScore: totalScore, promotionPatterns: `历史广告卡片记录：${adCount} 个广告、${views} 次浏览、${durationDays} 天；广告指标为研究代理，不代表销量或利润。`,
          sourceRiskFlags: sourceRiskFlags.join('；'),
        },
        features: [], supplier: {},
      },
      metrics: { price, currency: 'USD', creativeCount: adCount, adViews: views, adDurationDays: durationDays, adSignal }, mediaRefs: [],
    })
  }
  return { events, selected: events.length, skipped, sourceHash }
}
