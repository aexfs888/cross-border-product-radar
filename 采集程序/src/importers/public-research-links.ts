import fs from 'node:fs/promises'
import { createId, nowIso, sha256 } from '../core/utils.js'
import type { CollectorEvent } from '../core/types.js'

type PublicResearchLink = {
  originalName: string
  label: string
  url: string
  matchStatus: 'EXACT_PRODUCT_PAGE' | 'TITLE_VARIANT_PAGE' | 'COLLECTION_LISTING' | 'CATEGORY_MATCH'
  note: string
}

type PublicResearchLinksFile = { version: number, note: string, items: PublicResearchLink[] }

export async function publicResearchLinkEvents(inputPath: string, runId: string): Promise<{ events: CollectorEvent[], sourceHash: string }> {
  const bytes = await fs.readFile(inputPath); const sourceHash = sha256(bytes)
  const parsed = JSON.parse(bytes.toString('utf8')) as PublicResearchLinksFile
  if (!Array.isArray(parsed.items)) throw new Error('公开研究链接文件缺少 items 数组')
  const observedAt = nowIso(); const events: CollectorEvent[] = []
  for (const item of parsed.items) {
    const url = new URL(String(item.url || ''))
    if (url.protocol !== 'https:') throw new Error(`公开研究链接必须为 HTTPS：${item.originalName}`)
    if (!item.originalName || !item.label || !item.matchStatus || !item.note) throw new Error('公开研究链接缺少商品名称、标签、匹配状态或限制说明')
    const raw = { manualLink: true, sourceHash, linkLabel: item.label, matchStatus: item.matchStatus, matchNote: item.note, sourceNote: parsed.note }
    events.push({
      schemaVersion: '1.0', eventId: createId('event'), runId, sourceId: 'manual-public-product-links-20260901',
      sourceFamily: 'COMMERCE', sourceUrl: url.toString(), sourceDomain: url.hostname.toLowerCase(), eventType: 'COMMERCE', countryCode: 'GLOBAL',
      observedAt, rawHash: sha256({ originalName: item.originalName, url: url.toString(), raw }), rightsStatus: 'LINK_ONLY', evidenceStrength: item.matchStatus === 'EXACT_PRODUCT_PAGE' ? 0.45 : 0.25,
      policyDecision: 'MANUAL_LINK_ONLY', raw,
      productHint: {
        originalName: item.originalName,
        description: '人工添加的公开商品/研究链接；只证明链接页面存在，不证明商品身份、授权、供应、销量、功效或合规。',
        productUrl: url.toString(),
      },
      metrics: {}, mediaRefs: [],
    })
  }
  return { events, sourceHash }
}
