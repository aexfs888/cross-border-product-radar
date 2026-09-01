import fs from 'node:fs'
import { CheerioCrawler } from 'crawlee'
import { JSDOM } from 'jsdom'
import { Readability } from '@mozilla/readability'
import { paths } from '../core/paths.js'
import { assertPublicHttpsUrl, createId, hostOf, nowIso, sha256 } from '../core/utils.js'
import type { CollectorEvent } from '../core/types.js'

function allowedDomains(): string[] {
  const parsed = JSON.parse(fs.readFileSync(`${paths.root}\\来源规则\\approved-domains.json`, 'utf8'))
  return Array.isArray(parsed.domains) ? parsed.domains.map((value: unknown) => String(value).toLowerCase()) : []
}

function firstProductJsonLd($: any): Record<string, any> | null {
  for (const element of $('script[type="application/ld+json"]').toArray()) {
    try {
      const parsed = JSON.parse($(element).text())
      const items = Array.isArray(parsed) ? parsed : parsed?.['@graph'] || [parsed]
      const product = items.find((item: any) => item?.['@type'] === 'Product' || (Array.isArray(item?.['@type']) && item['@type'].includes('Product')))
      if (product) return product
    } catch { /* 非法 JSON-LD 只跳过，不猜测 */ }
  }
  return null
}

export async function collectApprovedProductPage(runId: string, value: string, countryCode = 'GLOBAL'): Promise<CollectorEvent[]> {
  const url = await assertPublicHttpsUrl(value)
  const allowed = allowedDomains()
  if (!allowed.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) throw new Error(`域名尚未通过自动采集审核：${url.hostname}`)
  const events: CollectorEvent[] = []
  const crawler = new CheerioCrawler({
    maxConcurrency: 1,
    maxRequestRetries: 2,
    requestHandlerTimeoutSecs: 20,
    preNavigationHooks: [async (_context, gotOptions) => {
      gotOptions.headers = { ...gotOptions.headers, 'user-agent': 'CrossBorderProductRadar/0.1 approved-public-page' }
    }],
    async requestHandler({ request, $, body }) {
      const product = firstProductJsonLd($)
      if (!product?.name) return
      let readable = ''
      try { readable = new Readability(new JSDOM(String(body), { url: request.loadedUrl || request.url }).window.document).parse()?.textContent?.trim() || '' } catch { /* JSON-LD 仍可用 */ }
      const offers = Array.isArray(product.offers) ? product.offers[0] : product.offers || {}
      const image = Array.isArray(product.image) ? product.image[0] : product.image
      const sourceUrl = request.loadedUrl || request.url
      const raw = { jsonLd: product, readableExcerpt: readable.slice(0, 1500) }
      events.push({
        schemaVersion: '1.0', eventId: createId('event'), runId, sourceId: `approved-jsonld-${hostOf(sourceUrl)}`,
        sourceFamily: 'COMMERCE', sourceUrl, sourceDomain: hostOf(sourceUrl), eventType: 'COMMERCE', countryCode,
        observedAt: nowIso(), rawHash: sha256(raw), rightsStatus: 'LINK_ONLY', evidenceStrength: 0.85,
        policyDecision: 'ALLOW_AUTOMATED', raw,
        productHint: {
          originalName: String(product.name), brand: typeof product.brand === 'object' ? String(product.brand.name || '') : String(product.brand || ''),
          model: String(product.model || product.sku || ''), gtin: String(product.gtin13 || product.gtin12 || product.gtin || ''), mpn: String(product.mpn || ''),
          category: String(product.category || ''), description: String(product.description || readable.slice(0, 600)), productUrl: sourceUrl,
          imageUrl: image ? String(image) : undefined, variants: [], specs: {},
          supplier: { name: hostOf(sourceUrl), url: sourceUrl, verified: false },
        },
        metrics: { price: Number(offers.price || 0) || undefined, currency: String(offers.priceCurrency || '') || undefined, offerCount: 1 },
        mediaRefs: image ? [{ url: String(image), type: 'IMAGE', rightsStatus: 'LINK_ONLY' }] : [],
      })
    },
  })
  await crawler.run([url.toString()])
  return events
}
