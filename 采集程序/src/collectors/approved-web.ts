import fs from 'node:fs'
import { load } from 'cheerio'
import { JSDOM } from 'jsdom'
import { Readability } from '@mozilla/readability'
import { paths } from '../core/paths.js'
import { assertPublicHttpsUrl, canonicalUrl, createId, fetchText, hostOf, nowIso, sha256 } from '../core/utils.js'
import type { CollectorEvent } from '../core/types.js'

function allowedDomains(): string[] {
  const parsed = JSON.parse(fs.readFileSync(`${paths.root}\\来源规则\\approved-domains.json`, 'utf8'))
  return Array.isArray(parsed.domains) ? parsed.domains.map((value: unknown) => String(value).toLowerCase()) : []
}

function jsonLdItems(value: unknown): Record<string, any>[] {
  if (Array.isArray(value)) return value.flatMap(jsonLdItems)
  if (!value || typeof value !== 'object') return []
  const object = value as Record<string, any>
  return [object, ...Object.values(object).flatMap(jsonLdItems)]
}

function firstProductJsonLd(html: string): Record<string, any> | null {
  const $ = load(html)
  for (const element of $('script[type="application/ld+json"]').toArray()) {
    try {
      const items = jsonLdItems(JSON.parse($(element).text()))
      const product = items.find((item) => item?.['@type'] === 'Product' || (Array.isArray(item?.['@type']) && item['@type'].includes('Product')))
      if (product) return product
    } catch { /* 非法 JSON-LD 只跳过，不猜测 */ }
  }
  return null
}

function textValue(value: unknown): string | undefined {
  const result = String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  return result || undefined
}

function itemList(value: unknown): any[] { return Array.isArray(value) ? value : value ? [value] : [] }

function structuredSpecs(product: Record<string, any>, offer: Record<string, any>): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {}
  const direct: Array<[string, unknown]> = [
    ['pageProductName', product.name], ['sku', product.sku], ['productID', product.productID],
    ['material', product.material], ['size', product.size], ['weight', product.weight],
    ['color', product.color], ['availability', offer.availability], ['itemCondition', offer.itemCondition],
  ]
  for (const [key, value] of direct) {
    const normalized = typeof value === 'object' ? textValue((value as Record<string, unknown>)?.value || (value as Record<string, unknown>)?.name) : textValue(value)
    if (normalized) result[key] = normalized
  }
  for (const property of itemList(product.additionalProperty)) {
    if (!property || typeof property !== 'object') continue
    const name = textValue(property.name); const value = textValue(property.value)
    if (name && value && Object.keys(result).length < 30) result[name] = value
  }
  return result
}

export async function collectApprovedProductPage(
  runId: string,
  value: string,
  countryCode = 'GLOBAL',
  canonicalName?: string,
): Promise<CollectorEvent[]> {
  const url = await assertPublicHttpsUrl(value)
  const allowed = allowedDomains()
  if (!allowed.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) throw new Error(`域名尚未通过自动采集审核：${url.hostname}`)
  const html = await fetchText(url.toString(), { headers: { Accept: 'text/html,application/xhtml+xml' } })
  const product = firstProductJsonLd(html)
  if (!product?.name) return []
  let readable = ''
  try { readable = new Readability(new JSDOM(html, { url: url.toString() }).window.document).parse()?.textContent?.trim() || '' } catch { /* JSON-LD 仍可用 */ }
  const offers = itemList(product.offers).find((item) => item && typeof item === 'object') as Record<string, any> | undefined || {}
  const image = itemList(product.image).map((item) => typeof item === 'object' ? item?.url || item?.contentUrl : item).find(Boolean)
  const sourceUrl = canonicalUrl(url.toString())
  const rawBrand = typeof product.brand === 'object' ? textValue(product.brand.name) : textValue(product.brand)
  const brand = rawBrand && !/^(my store(?: \d+)?|store|unknown|n\/a)$/i.test(rawBrand) ? rawBrand : undefined
  const variants = [...new Set(itemList(product.color).concat(itemList(product.size)).map(textValue).filter(Boolean))] as string[]
  const specs = structuredSpecs(product, offers)
  const raw = {
    jsonLd: product,
    readableExcerpt: readable.slice(0, 1500),
    canonicalName: canonicalName || null,
    extractionBoundary: '公开商品页 JSON-LD；页面主张不等于独立核验，素材仅保留链接',
  }
  const availability = String(offers.availability || '')
  return [{
    schemaVersion: '1.0', eventId: createId('event'), runId, sourceId: `approved-jsonld-${hostOf(sourceUrl)}`,
    sourceFamily: 'COMMERCE', sourceUrl, sourceDomain: hostOf(sourceUrl), eventType: 'COMMERCE', countryCode,
    observedAt: nowIso(), rawHash: sha256(raw), rightsStatus: 'LINK_ONLY', evidenceStrength: 0.78,
    policyDecision: 'ALLOW_AUTOMATED', raw,
    productHint: {
      originalName: canonicalName || String(product.name),
      identityAnchor: canonicalName || undefined,
      brand,
      // 商家内部 SKU 不是制造商型号。只有页面明确给出 model 才能满足型号闸门。
      model: textValue(product.model), gtin: textValue(product.gtin13 || product.gtin12 || product.gtin), mpn: textValue(product.mpn),
      category: textValue(product.category), description: textValue(product.description) || readable.slice(0, 600), productUrl: sourceUrl,
      imageUrl: image ? String(image) : undefined, variants, specs,
      features: [], supplier: { name: hostOf(sourceUrl), url: sourceUrl, verified: false },
    },
    metrics: {
      price: Number(offers.price || offers.lowPrice || 0) || undefined,
      currency: textValue(offers.priceCurrency), offerCount: Object.keys(offers).length ? 1 : 0,
      stockSignal: /InStock/i.test(availability) ? 1 : 0,
    },
    mediaRefs: image ? [{ url: String(image), type: 'IMAGE', rightsStatus: 'LINK_ONLY' }] : [],
  }]
}
