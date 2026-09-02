import { XMLParser } from 'fast-xml-parser'
import { loadApprovedProductPages, loadCountries, loadKeywordRules, loadProductWatchlist } from '../core/config.js'
import { collectApprovedProductPage } from './approved-web.js'
import { asArray, canonicalUrl, createId, fetchText, hostOf, isProductLike, normalizeText, nowIso, parseMagnitude, sha256, textHasTerm, withRetry } from '../core/utils.js'
import type { CollectorEvent, CountryConfig, SourceConfig } from '../core/types.js'

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, trimValues: true })

function eventBase(runId: string, source: SourceConfig, sourceUrl: string, countryCode: string, eventType: CollectorEvent['eventType'], raw: unknown): Pick<CollectorEvent, 'schemaVersion' | 'eventId' | 'runId' | 'sourceId' | 'sourceFamily' | 'sourceUrl' | 'sourceDomain' | 'eventType' | 'countryCode' | 'observedAt' | 'rawHash' | 'rightsStatus' | 'evidenceStrength' | 'policyDecision' | 'raw'> {
  return {
    schemaVersion: '1.0', eventId: createId('event'), runId, sourceId: source.id, sourceFamily: source.family,
    sourceUrl, sourceDomain: hostOf(sourceUrl), eventType, countryCode, observedAt: nowIso(), rawHash: sha256(raw),
    rightsStatus: source.rights === 'FACTS_ONLY' ? 'LINK_ONLY' : source.rights, evidenceStrength: 0.6,
    policyDecision: source.policy === 'PUBLIC_API' ? 'ALLOW_AUTOMATED' : 'ALLOW_FEED_API', raw: raw as Record<string, unknown>,
  }
}

function parseTrendDate(value: unknown): string | undefined {
  const date = new Date(String(value || ''))
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

export function matchesWatchlistHeadline(headline: string, query: string): boolean {
  // 仅接受标题本身明确提及观察词的近期开源文章，避免把泛品类新闻错误挂到具体商品名下。
  const ignored = new Set(['and', 'the', 'with', 'for', 'from', 'that', 'this', 'light', 'wireless', 'comfort', 'portable', 'double', 'removable', 'open'])
  if (textHasTerm(headline, query)) return true
  const units = new Set(['oz', 'ml', 'cm', 'mm', 'in'])
  const terms = [...new Set(normalizeText(query).split(' ').filter((term) => (term.length >= 3 || /^\d+$/.test(term) || units.has(term)) && !ignored.has(term)))]
  // 观察词若只剩一个泛化核心词，不能据此认定文章和目标商品有关。
  if (terms.length < 2) return false
  const matched = terms.filter((term) => textHasTerm(headline, term)).length
  return matched >= 2
}

async function googleTrends(runId: string, source: SourceConfig, countries: CountryConfig[]): Promise<CollectorEvent[]> {
  const rules = loadKeywordRules(); const results: CollectorEvent[] = []
  for (const country of countries) {
    const endpoint = String(source.endpointTemplate).replace('{geo}', country.googleTrendsGeo)
    const parsed = xml.parse(await withRetry(() => fetchText(endpoint)))
    const items = asArray(parsed?.rss?.channel?.item)
    for (const item of items) {
      const title = String(item?.title || '').trim()
      const related = asArray(item?.news_item).map((entry: any) => String(entry?.news_item_title || '')).filter(Boolean)
      // 相关新闻可能偶然提到 phone、car 等商品词，不能据此把人物、赛事、票务或纯服务
      // 误建成商品。趋势标题本身必须具备商品属性；品牌型号可由后续商业证据补充。
      if (!title || !isProductLike(title, rules.productTerms, rules.nonProductTerms)) continue
      const sourceUrl = String(item?.link || `https://trends.google.com/trending?geo=${country.googleTrendsGeo}`)
      const base = eventBase(runId, source, sourceUrl, country.code, 'TREND', { title, related, traffic: item?.approx_traffic, country: country.code })
      results.push({
        ...base, publishedAt: parseTrendDate(item?.pubDate), evidenceStrength: 0.8,
        productHint: {
          originalName: title, description: `Google Trends ${country.nameZh}公开趋势；相关查询：${related.slice(0, 5).join('、') || '未知'}`,
          productUrl: sourceUrl, imageUrl: item?.picture ? String(item.picture) : undefined,
        },
        metrics: { searchVolume: parseMagnitude(item?.approx_traffic) },
        mediaRefs: item?.picture ? [{ url: String(item.picture), type: 'IMAGE', rightsStatus: 'LINK_ONLY' }] : [],
      })
    }
  }
  return results
}

async function googleNewsWatchlist(runId: string, source: SourceConfig): Promise<CollectorEvent[]> {
  const watchlist = loadProductWatchlist(); const results: CollectorEvent[] = []
  for (const candidate of watchlist.items.slice(0, source.maxRecords || 8)) {
    const endpoint = new URL('https://news.google.com/rss/search')
    endpoint.searchParams.set('q', `"${candidate.query}"`); endpoint.searchParams.set('hl', 'en-US'); endpoint.searchParams.set('gl', 'US'); endpoint.searchParams.set('ceid', 'US:en')
    const parsed = xml.parse(await withRetry(() => fetchText(endpoint.toString())))
    for (const item of asArray(parsed?.rss?.channel?.item).slice(0, 5)) {
      const articleTitle = String(item?.title || '').trim(); const sourceUrl = String(item?.link || endpoint)
      const publishedAt = parseTrendDate(item?.pubDate)
      const publishedMs = publishedAt ? new Date(publishedAt).getTime() : NaN
      const cutoff = Date.now() - 180 * 86_400_000
      if (!articleTitle || !Number.isFinite(publishedMs) || publishedMs < cutoff || publishedMs > Date.now() + 86_400_000 || !matchesWatchlistHeadline(articleTitle, candidate.query)) continue
      const raw = { watchlist: candidate, articleTitle, publishedAt: item?.pubDate || null, source: item?.source || null }
      const base = eventBase(runId, source, sourceUrl, 'GLOBAL', 'NEWS', raw)
      results.push({
        ...base, publishedAt, evidenceStrength: 0.55,
        productHint: { originalName: candidate.name, description: 'Google News 公开 RSS 对高热实体商品观察词的匹配；文章只作为当前研究信号，不能替代商品身份、授权、供应或合规核验。', productUrl: sourceUrl },
        metrics: {}, mediaRefs: [],
      })
    }
  }
  return results
}

const sourceCountryMap: Record<string, string> = {
  'United States': 'US', 'United Kingdom': 'GB', Australia: 'AU', Canada: 'CA', 'New Zealand': 'NZ', Switzerland: 'CH',
  Ireland: 'IE', Norway: 'NO', Sweden: 'SE', Denmark: 'DK', Finland: 'FI',
}

function gdeltDate(value: unknown): string | undefined {
  const text = String(value || '')
  const match = text.match(/^(\d{4})(\d{2})(\d{2})T?(\d{2})?(\d{2})?(\d{2})?Z?$/)
  if (!match) return parseTrendDate(text)
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4] || 0), Number(match[5] || 0), Number(match[6] || 0))).toISOString()
}

async function gdelt(runId: string, source: SourceConfig): Promise<CollectorEvent[]> {
  const endpoint = new URL(String(source.endpoint))
  const watchlist = loadProductWatchlist()
  // 广泛的“viral product”查询会返回大量与商品无关的新闻。用已达到高热保留线的
  // 精确观察词形成一条合并查询，并在结果标题上再次做匹配，避免新闻噪声建档。
  const watchQueries = watchlist.items.map((item) => `"${item.query.replaceAll('"', '')}"`)
  endpoint.searchParams.set('query', watchQueries.length ? `(${watchQueries.join(' OR ')})` : String(source.query))
  endpoint.searchParams.set('mode', 'artlist')
  endpoint.searchParams.set('maxrecords', String(source.maxRecords || 75))
  endpoint.searchParams.set('timespan', String(source.timespan || '7d'))
  endpoint.searchParams.set('sort', 'datedesc')
  endpoint.searchParams.set('format', 'json')
  const body = await withRetry(() => fetchText(endpoint.toString()))
  const parsed = JSON.parse(body); const rules = loadKeywordRules(); const results: CollectorEvent[] = []
  for (const article of asArray(parsed?.articles)) {
    const title = String(article?.title || '').trim()
    const candidate = watchlist.items.find((item) => matchesWatchlistHeadline(title, item.query))
    if (!title || !candidate || !isProductLike(candidate.name, rules.productTerms, rules.nonProductTerms)) continue
    const url = canonicalUrl(String(article?.url || endpoint))
    const countryCode = sourceCountryMap[String(article?.sourcecountry || '')] || 'GLOBAL'
    const base = eventBase(runId, source, url, countryCode, 'NEWS', { title, url, domain: article?.domain, language: article?.language, sourcecountry: article?.sourcecountry, seendate: article?.seendate })
    results.push({
      ...base, publishedAt: gdeltDate(article?.seendate), evidenceStrength: 0.55,
      productHint: { originalName: candidate.name, description: `GDELT公开新闻标题匹配高热商品观察词：${title}。新闻只作研究信号，身份、销量、供应和授权仍需独立核验。`, productUrl: url, imageUrl: article?.socialimage || undefined },
      mediaRefs: article?.socialimage ? [{ url: String(article.socialimage), type: 'IMAGE', rightsStatus: 'LINK_ONLY' }] : [],
    })
  }
  return results
}

async function approvedJsonLdWatchlist(runId: string): Promise<CollectorEvent[]> {
  const results: CollectorEvent[] = []
  for (const item of loadApprovedProductPages().items) {
    results.push(...await collectApprovedProductPage(runId, item.url, item.countryCode, item.canonicalName))
  }
  return results
}

async function cpsc(runId: string, source: SourceConfig): Promise<CollectorEvent[]> {
  const start = new Date(Date.now() - Number(source.lookbackDays || 90) * 86_400_000).toISOString().slice(0, 10)
  const endpoint = new URL(String(source.endpoint)); endpoint.searchParams.set('RecallDateStart', start)
  const parsed = xml.parse(await withRetry(() => fetchText(endpoint.toString())))
  const recalls = asArray(parsed?.Recalls?.Recall); const results: CollectorEvent[] = []
  for (const recall of recalls.slice(0, 500)) {
    const products = asArray(recall?.Products?.Product)
    const primary = products[0] || {}
    const title = String(primary?.Name || recall?.Title || '').trim()
    if (!title) continue
    const url = String(recall?.URL || endpoint)
    const base = eventBase(runId, source, url, 'US', 'SAFETY', { externalId: recall?.RecallID || recall?.RecallNumber, title, recall })
    results.push({
      ...base, publishedAt: parseTrendDate(recall?.RecallDate), evidenceStrength: 1,
      productHint: { originalName: title, brand: String(primary?.Manufacturer || primary?.Name || '') || undefined, model: String(primary?.Model || '') || undefined, description: String(recall?.Description || '') },
      raw: { externalId: recall?.RecallID || recall?.RecallNumber, title, riskLevel: String(recall?.Hazards?.Hazard?.Name || '官方召回'), recall },
    })
  }
  return results
}

async function atomSafety(runId: string, source: SourceConfig): Promise<CollectorEvent[]> {
  const endpoint = String(source.endpoint); const parsed = xml.parse(await withRetry(() => fetchText(endpoint)))
  const entries = asArray(parsed?.feed?.entry); const results: CollectorEvent[] = []
  for (const entry of entries) {
    const title = String(entry?.title || '').replace(/^Product (Recall|Safety Report|Safety Alert):\s*/i, '').trim()
    const links = asArray(entry?.link); const link = String(links.find((item: any) => item?.['@_rel'] === 'alternate')?.['@_href'] || links[0]?.['@_href'] || endpoint)
    if (!title) continue
    const base = eventBase(runId, source, link, source.countryCode || 'GB', 'SAFETY', { externalId: entry?.id, title, summary: entry?.summary, category: entry?.category })
    results.push({ ...base, publishedAt: parseTrendDate(entry?.updated || entry?.published), evidenceStrength: 1, productHint: { originalName: title, description: String(entry?.summary || '').replace(/<[^>]+>/g, ' ') }, raw: { externalId: entry?.id, title, riskLevel: 'OPSS安全记录', entry } })
  }
  return results
}

async function genericRssSafety(runId: string, source: SourceConfig): Promise<CollectorEvent[]> {
  const endpoint = String(source.endpoint); const parsed = xml.parse(await withRetry(() => fetchText(endpoint)))
  const items = asArray(parsed?.rss?.channel?.item || parsed?.feed?.entry); const results: CollectorEvent[] = []
  for (const item of items.slice(0, source.maxRecords || 250)) {
    const title = String(item?.title || '').replace(/<[^>]+>/g, ' ').trim()
    const rawLink = typeof item?.link === 'string' ? item.link : item?.link?.['@_href']
    const link = String(rawLink || item?.guid || endpoint)
    if (!title) continue
    const description = String(item?.description || item?.summary || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    const base = eventBase(runId, source, link, source.countryCode || 'GLOBAL', 'SAFETY', { externalId: item?.guid || item?.id, title, description, item })
    results.push({ ...base, publishedAt: parseTrendDate(item?.pubDate || item?.published || item?.updated), evidenceStrength: 1, productHint: { originalName: title, description }, raw: { externalId: item?.guid || item?.id, title, riskLevel: '官方召回或安全警示', item } })
  }
  return results
}

async function sitemapSafety(runId: string, source: SourceConfig): Promise<CollectorEvent[]> {
  const endpoint = String(source.endpoint); const index = xml.parse(await withRetry(() => fetchText(endpoint)))
  const sitemapUrl = String(asArray(index?.sitemapindex?.sitemap)[0]?.loc || endpoint)
  const parsed = sitemapUrl === endpoint ? index : xml.parse(await withRetry(() => fetchText(sitemapUrl)))
  const cutoff = Date.now() - Number(source.lookbackDays || 180) * 86_400_000
  const records = asArray(parsed?.urlset?.url).filter((item: any) => /\/recalls?\//i.test(String(item?.loc || '')) && (!item?.lastmod || new Date(String(item.lastmod)).getTime() >= cutoff))
    .sort((a: any, b: any) => new Date(String(b?.lastmod || 0)).getTime() - new Date(String(a?.lastmod || 0)).getTime()).slice(0, source.maxRecords || 250)
  return records.map((item: any) => {
    const link = String(item.loc); const lastSegment = decodeURIComponent(new URL(link).pathname.split('/').filter(Boolean).at(-1) || '未命名召回')
    const title = lastSegment.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
    const base = eventBase(runId, source, link, source.countryCode || 'GLOBAL', 'SAFETY', { externalId: link, title, lastmod: item.lastmod })
    return { ...base, publishedAt: parseTrendDate(item.lastmod), evidenceStrength: 0.8, productHint: { originalName: title, description: '官方产品召回站点地图中的公开召回记录；详情需回到官方页面人工确认。' }, raw: { externalId: link, title, riskLevel: '官方召回索引', lastmod: item.lastmod } }
  })
}

async function ecb(runId: string, source: SourceConfig): Promise<CollectorEvent[]> {
  const endpoint = String(source.endpoint); const parsed = xml.parse(await withRetry(() => fetchText(endpoint)))
  const cubes = asArray(parsed?.Envelope?.Cube?.Cube)
  const dated = cubes.find((cube: any) => cube?.['@_time']) || cubes[0] || {}
  const rates: Record<string, number> = { EUR: 1 }
  for (const item of asArray(dated?.Cube)) if (item?.['@_currency'] && item?.['@_rate']) rates[String(item['@_currency'])] = Number(item['@_rate'])
  const base = eventBase(runId, source, endpoint, 'GLOBAL', 'FX', { rateDate: dated?.['@_time'], rates })
  return [{ ...base, evidenceStrength: 1, raw: { rateDate: dated?.['@_time'], rates } }]
}

export async function collectSource(runId: string, source: SourceConfig, countries = loadCountries()): Promise<CollectorEvent[]> {
  switch (source.adapter) {
    case 'GOOGLE_TRENDS_RSS': return googleTrends(runId, source, countries)
    case 'GOOGLE_NEWS_RSS_WATCHLIST': return googleNewsWatchlist(runId, source)
    case 'GDELT_DOC': return gdelt(runId, source)
    case 'APPROVED_JSON_LD_WATCHLIST': return approvedJsonLdWatchlist(runId)
    case 'CPSC_XML': return cpsc(runId, source)
    case 'ATOM_SAFETY': return atomSafety(runId, source)
    case 'GENERIC_RSS_SAFETY': return genericRssSafety(runId, source)
    case 'SITEMAP_SAFETY': return sitemapSafety(runId, source)
    case 'ECB_XML': return ecb(runId, source)
    default: throw new Error(`尚未启用的采集适配器：${source.adapter}`)
  }
}
