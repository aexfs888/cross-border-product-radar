import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { buildDossier } from '../src/core/dossier.js'
import { analyzeProduct } from '../src/core/scoring.js'
import { RadarStore } from '../src/core/store.js'
import { commonCrawlCaptureEvent, googleNewsLocale, matchesWatchlistHeadline, safetyGateDetailEvents, safetyGateReportUrls } from '../src/collectors/index.js'
import { publicResearchLinkEvents } from '../src/importers/public-research-links.js'
import { paths } from '../src/core/paths.js'
import { isProductLike, naturalKey, safeFetch, sha256 } from '../src/core/utils.js'
import { cloudSourceDecision, recordCloudSourceResult, type CloudSourceHealth } from '../src/core/cloud-source-health.js'
import { loadApprovedProductPages, loadSourceRules } from '../src/core/config.js'
import type { CollectorEvent, ProductHint } from '../src/core/types.js'

function event(index: number, options: {
  name?: string, country?: string, family?: CollectorEvent['sourceFamily'], observedAt?: string,
  searchVolume?: number, price?: number, rights?: CollectorEvent['rightsStatus'], media?: boolean, hint?: Partial<ProductHint>, type?: CollectorEvent['eventType'],
} = {}): CollectorEvent {
  const family = options.family || 'DEMAND'; const name = options.name || 'Portable Modular Desk Organizer Pro'
  return {
    schemaVersion: '1.0', eventId: `event-${index}`, runId: 'test-run', sourceId: `source-${family.toLowerCase()}`,
    sourceFamily: family, sourceUrl: `https://example.com/public/${index}`, sourceDomain: 'example.com',
    eventType: options.type || (family === 'NEWS' ? 'NEWS' : family === 'COMMERCE' ? 'COMMERCE' : 'TREND'),
    countryCode: options.country || 'US', observedAt: options.observedAt || new Date().toISOString(),
    rawHash: sha256(`raw-${index}`), productHint: { originalName: name, ...options.hint },
    metrics: { searchVolume: options.searchVolume, price: options.price, currency: options.price ? 'USD' : undefined },
    mediaRefs: options.media ? [{ url: `https://example.com/assets/${index}.jpg`, type: 'IMAGE', rightsStatus: options.rights || 'LINK_ONLY', license: options.rights === 'AUTHORIZED' ? 'CC0-1.0' : undefined }] : [],
    rightsStatus: options.rights || 'LINK_ONLY', evidenceStrength: 1, policyDecision: 'ALLOW_FEED_API', raw: { title: name },
  }
}

function analyze(store: RadarStore, id: string) {
  const product = store.getProduct(id)!; const events = store.getEvents(id); const media = store.getMedia(id)
  return { product, events, media, analysis: analyzeProduct(product, events, media, store.getSafetyRecords()) }
}

test('可复用商品必须通过身份、供应、证据、风险和商业素材全部闸门', () => {
  const store = new RadarStore({ memory: true })
  const hint: Partial<ProductHint> = {
    brand: 'ExampleHome', model: 'PDO-100', description: '用于整理桌面小物件的模块化收纳用品。',
    variants: ['白色', '黑色'], useCases: ['桌面整理'], targetUsers: ['居家办公用户'], unsuitableScenarios: ['潮湿环境'],
    features: ['模块化组合'], specs: { material: 'PP', size: '30×20×10 cm' },
    supplier: { name: 'Example Supplier', url: 'https://example.com/supplier', verified: true, shipsTo: ['US', 'GB', 'CA'], leadTimeDays: 7, returnsPolicy: '30 days' },
  }
  const events = [
    event(1, { country: 'US', family: 'DEMAND', searchVolume: 100000, hint }),
    event(2, { country: 'GB', family: 'NEWS', hint }),
    event(3, { country: 'CA', family: 'COMMERCE', price: 19.99, rights: 'AUTHORIZED', media: true, hint }),
  ]
  store.ingestEvents(events)
  const product = store.listProducts(undefined, true)[0]; const result = analyze(store, product.id)
  assert.equal(result.analysis.reuseBucket, 'REUSABLE')
  assert.equal(result.analysis.status, 'ACTIVE')
  assert.ok(result.analysis.completeness >= 85)
  assert.ok(result.analysis.confidence >= 0.75)
  store.close()
})

test('很火但不可复用的商品进入研究库，普通热度不可复用商品不进入研究导出', () => {
  const store = new RadarStore({ memory: true })
  const countries = ['US', 'GB', 'AU', 'CA', 'NZ']
  store.ingestEvents(countries.map((country, index) => event(index + 10, { name: 'Viral Mystery Gadget', country, searchVolume: 1_000_000 })))
  const product = store.listProducts(undefined, true)[0]; const hot = analyze(store, product.id)
  assert.equal(hot.analysis.reuseBucket, 'NON_REUSABLE')
  assert.ok(hot.analysis.researchHeatScore >= 60)
  assert.equal(hot.analysis.status, 'ACTIVE')
  store.updateAnalysis(hot.product, hot.analysis, buildDossier(hot.product, hot.analysis, hot.events, hot.media))

  store.ingestEvents([event(30, { name: 'Ordinary Unknown Trinket', country: 'US', searchVolume: 10 })])
  const ordinary = store.listProducts(undefined, true).find((item) => item.original_name === 'Ordinary Unknown Trinket')!
  const ordinaryResult = analyze(store, ordinary.id)
  assert.equal(ordinaryResult.analysis.reuseBucket, 'NON_REUSABLE')
  assert.ok(ordinaryResult.analysis.researchHeatScore < 60)
  assert.equal(ordinaryResult.analysis.status, 'STAGING')
  store.updateAnalysis(ordinaryResult.product, ordinaryResult.analysis, buildDossier(ordinaryResult.product, ordinaryResult.analysis, ordinaryResult.events, ordinaryResult.media))

  const exported = store.exportSnapshot('NON_REUSABLE') as { products: Array<{ original_name: string }> }
  assert.deepEqual(exported.products.map((item) => item.original_name), ['Viral Mystery Gadget'])
  store.close()
})

test('票务、人物、赛事和纯服务即使热度很高也不进入正式商品库', () => {
  const store = new RadarStore({ memory: true })
  const countries = ['US', 'GB', 'AU', 'CA', 'NZ']
  store.ingestEvents(countries.map((country, index) => event(index + 70, { name: 'Ticketmaster', country, searchVolume: 1_000_000 })))
  const product = store.listProducts(undefined, true)[0]; const result = analyze(store, product.id)
  assert.ok(result.analysis.researchHeatScore >= 60)
  assert.equal(result.analysis.status, 'STAGING')
  assert.match(result.analysis.researchReason, /^范围待确认：/)
  store.updateAnalysis(result.product, result.analysis, buildDossier(result.product, result.analysis, result.events, result.media))
  const exported = store.exportSnapshot('NON_REUSABLE') as { products: Array<{ original_name: string }> }
  assert.deepEqual(exported.products, [])
  store.close()
})

test('实体商品词采用整词匹配，避免把人物姓名中的 pet 等片段误判为商品', () => {
  assert.equal(isProductLike('Pete Hegseth', ['pet']), false)
  assert.equal(isProductLike('Weighted Sleep Mask', ['sleep mask']), true)
  assert.equal(isProductLike('Ticketmaster', ['ticket'], ['ticketmaster']), false)
})

test('Google News 需求观察只覆盖已配置的11个销售目标国', () => {
  const countries = JSON.parse(fs.readFileSync(paths.countries, 'utf8')).countries
  const source = loadSourceRules().automatic.find((item) => item.id === 'google-news-product-watchlist')!
  assert.equal(countries.length, 11)
  assert.equal(source.maxRecords, 8)
  assert.equal(countries.length * source.maxRecords, 88)
  assert.deepEqual(googleNewsLocale(countries.find((item: any) => item.code === 'US')), { hl: 'en-US', gl: 'US', ceid: 'US:en' })
  assert.deepEqual(googleNewsLocale(countries.find((item: any) => item.code === 'CA')), { hl: 'en-CA', gl: 'CA', ceid: 'CA:en' })
})

test('观察词新闻必须同时命中足够的商品核心词，泛品类新闻不能挂到具体商品', () => {
  assert.equal(matchesWatchlistHeadline('The Fashion Crowd Has Spoken: Fringe Is Everywhere', 'fringe midi dress'), false)
  assert.equal(matchesWatchlistHeadline('Best Fringe Midi Dress Styles for Summer Weddings', 'fringe midi dress'), true)
  assert.equal(matchesWatchlistHeadline('A 40 oz tumbler is the travel accessory trend', '40 oz tumbler'), true)
  assert.equal(matchesWatchlistHeadline('Owala’s Matcha-Green Tumbler is $28', '40 oz tumbler'), false)
})

test('离线历史广告高信号只进入不可复用研究库，并明确不是销量证明', () => {
  const store = new RadarStore({ memory: true })
  const historical = event(88, { name: 'Weighted Sleep Mask', family: 'CREATIVE', type: 'CREATIVE', price: 39.99 })
  historical.sourceId = 'pipiads-offline-history-20260822'
  historical.sourceUrl = 'local-history://pipiads/20260822/sample'
  historical.metrics = { price: 39.99, currency: 'USD', creativeCount: 78, adViews: 781000, adDurationDays: 2, adSignal: 67.6 }
  historical.productHint!.specs = { sourceRiskFlags: '离线历史广告 OCR 置信度为 LOW，必须独立复核' }
  store.ingestEvents([historical])
  const product = store.listProducts(undefined, true)[0]; const result = analyze(store, product.id)
  assert.ok(result.analysis.researchHeatScore >= 60)
  assert.equal(result.analysis.reuseBucket, 'NON_REUSABLE')
  assert.equal(result.analysis.status, 'ACTIVE')
  assert.match(result.analysis.researchReason, /^离线历史广告代理研究品：/)
  assert.match(result.analysis.restrictionReason, /OCR 置信度/)
  store.close()
})

test('人工公开链接只作为研究入口，不会使商品获得可复用资格', async () => {
  const imported = await publicResearchLinkEvents(paths.publicResearchLinks, 'test-links')
  assert.equal(imported.events.length, 14)
  assert.ok(imported.events.every((item) => item.policyDecision === 'MANUAL_LINK_ONLY' && item.rightsStatus === 'LINK_ONLY'))
  const store = new RadarStore({ memory: true })
  store.ingestEvents([imported.events.find((item) => item.productHint?.originalName === 'Cloudlight Soft Glow Diffused Blush')!])
  const product = store.listProducts(undefined, true)[0]; const result = analyze(store, product.id)
  assert.equal(result.analysis.reuseBucket, 'NON_REUSABLE')
  assert.equal(result.analysis.status, 'STAGING')
  store.close()
})

test('人工公开链接不会提高商品热度、可信度或商业分', async () => {
  const imported = await publicResearchLinkEvents(paths.publicResearchLinks, 'test-links')
  const publicLink = imported.events.find((item) => item.productHint?.originalName === 'Cloudlight Soft Glow Diffused Blush')!
  const historical = event(89, { name: 'Cloudlight Soft Glow Diffused Blush', family: 'CREATIVE', type: 'CREATIVE', price: 18.99 })
  historical.sourceId = 'pipiads-offline-history-20260822'
  historical.sourceUrl = 'local-history://pipiads/20260822/cloudlight'
  historical.policyDecision = 'MANUAL_LINK_ONLY'
  historical.metrics = { price: 18.99, currency: 'USD', creativeCount: 20, adSignal: 67.6 }

  const withoutLink = new RadarStore({ memory: true })
  withoutLink.ingestEvents([historical])
  const baselineProduct = withoutLink.listProducts(undefined, true)[0]
  const baseline = analyze(withoutLink, baselineProduct.id).analysis

  const withLink = new RadarStore({ memory: true })
  withLink.ingestEvents([historical, publicLink])
  const linkedProduct = withLink.listProducts(undefined, true)[0]
  const linked = analyze(withLink, linkedProduct.id).analysis

  assert.equal(linked.researchHeatScore, baseline.researchHeatScore)
  assert.equal(linked.confidence, baseline.confidence)
  assert.equal(linked.commercialScore, baseline.commercialScore)
  assert.equal(linked.reuseBucket, 'NON_REUSABLE')
  assert.ok(baseline.researchHeatScore >= 60)
  withoutLink.close(); withLink.close()
})

test('普通热度不可复用商品30天后删除详情并留下匿名墓碑', () => {
  const store = new RadarStore({ memory: true })
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString()
  store.ingestEvents([event(40, { name: 'Old Low Heat Unknown Item', observedAt: old, searchVolume: 5 })])
  const product = store.listProducts(undefined, true)[0]; const result = analyze(store, product.id)
  store.updateAnalysis(result.product, result.analysis, buildDossier(result.product, result.analysis, result.events, result.media))
  assert.equal(result.analysis.status, 'STAGING')
  assert.deepEqual(store.pruneLowHeat(30), { pruned: 1 })
  assert.equal(store.listProducts(undefined, true).length, 0)
  const dashboard = store.dashboard() as { counts: { tombstones: number } }
  assert.equal(dashboard.counts.tombstones, 1)
  store.close()
})

test('完整说明固定包含7个时间窗口和11个目标国家，未知字段不留空', () => {
  const store = new RadarStore({ memory: true })
  store.ingestEvents([event(50, { name: 'Research Sample Product', country: 'US', searchVolume: 1000, media: true })])
  const product = store.listProducts(undefined, true)[0]; const result = analyze(store, product.id)
  const dossier = buildDossier(result.product, result.analysis, result.events, result.media) as any
  assert.equal(Object.keys(dossier.chronology.timeWindows).length, 7)
  assert.equal(Object.keys(dossier.countryPerformance).length, 11)
  assert.equal(dossier.physicalAndPackage.material.state, '未知')
  assert.equal(dossier.countryPerformance.US.evidenceCount.state, '已验证')
  assert.equal(dossier.countryPerformance.FI.latestEvidenceAt.state, '未知')
  store.close()
})

test('未知权利素材只保存链接元数据，不会被判定为可复用素材', () => {
  const store = new RadarStore({ memory: true })
  store.ingestEvents([event(60, { name: 'Linked Video Product', media: true, rights: 'LINK_ONLY' })])
  const product = store.listProducts(undefined, true)[0]; const result = analyze(store, product.id)
  assert.equal(result.analysis.rightsStatus, 'LINK_ONLY')
  assert.equal(result.analysis.reuseBucket, 'NON_REUSABLE')
  assert.equal(result.media.length, 1)
  assert.equal(result.media[0].rights_status, 'LINK_ONLY')
  store.close()
})

test('明确非商品趋势词立即匿名化清理，不在待复核区堆积', () => {
  const store = new RadarStore({ memory: true })
  store.ingestEvents([event(90, { name: 'Famous Person News', searchVolume: 1_000_000 })])
  const product = store.listProducts(undefined, true)[0]; const result = analyze(store, product.id)
  store.updateAnalysis(result.product, result.analysis, buildDossier(result.product, result.analysis, result.events, result.media))
  assert.equal(result.analysis.status, 'STAGING')
  assert.deepEqual(store.pruneDefinitiveNonProducts(), { pruned: 1 })
  assert.equal(store.listProducts(undefined, true).length, 0)
  assert.equal((store.dashboard() as any).counts.tombstones, 1)
  // 同一非商品即使搜索量很高，也不会在30天内反复建档。
  store.ingestEvents([event(91, { name: 'Famous Person News', searchVolume: 2_000_000 })])
  assert.equal(store.listProducts(undefined, true).length, 0)
  // 若后来出现直接商品页证据，则允许重新进入核验流程。
  store.ingestEvents([event(92, { name: 'Famous Person News', family: 'COMMERCE', price: 20 })])
  assert.equal(store.listProducts(undefined, true).length, 1)
  store.close()
})

test('云端来源连续失败三次熔断12小时，低频商品页每天最多运行一次', () => {
  const health: CloudSourceHealth = { schemaVersion: 1, generatedAt: new Date(0).toISOString(), sources: {} }
  const base = Date.parse('2026-09-02T00:00:00.000Z')
  for (let index = 0; index < 3; index += 1) recordCloudSourceResult(health, 'gdelt-product-news', false, 0, { pauseAfter: 3, pauseHours: 12, now: base + index, error: 'fetch failed https://example.test/private at /home/runner/work/private/file.ts and E:\\secret\\token.txt' })
  const gdelt = loadSourceRules().automatic.find((source) => source.id === 'gdelt-product-news')!
  assert.equal(cloudSourceDecision(gdelt, health.sources['gdelt-product-news'], base + 1000).run, false)
  assert.equal(health.sources['gdelt-product-news'].lastError?.includes('example.test'), false)
  assert.equal(health.sources['gdelt-product-news'].lastError?.includes('/home/runner'), false)
  assert.equal(health.sources['gdelt-product-news'].lastError?.includes('E:\\secret'), false)

  const approved = loadSourceRules().automatic.find((source) => source.id === 'approved-product-jsonld')!
  recordCloudSourceResult(health, approved.id, true, 3, { pauseAfter: 3, pauseHours: 12, now: base })
  assert.equal(cloudSourceDecision(approved, health.sources[approved.id], base + 23 * 3_600_000).run, false)
  assert.equal(cloudSourceDecision(approved, health.sources[approved.id], base + 24 * 3_600_000).run, true)
  assert.equal(loadApprovedProductPages().items.length, 3)
})

test('商品锚点稳定归并证据，店铺默认品牌或单独SKU不会误建新商品', () => {
  const baseline = naturalKey({ originalName: 'Noiré Fringe Midi Dress' })
  assert.equal(naturalKey({ originalName: 'Noiré Fringe Midi Dress', brand: 'My Store 5' }), baseline)
  assert.equal(naturalKey({ originalName: 'Short Page Title', identityAnchor: 'Noiré Fringe Midi Dress', brand: 'Brand', model: 'SKU-1' }), baseline)
})

test('公开商品页可补价格和身份，但不会冒充需求趋势造成热度暴涨', () => {
  const store = new RadarStore({ memory: true })
  const historical = event(100, { name: 'Cloudlight Soft Glow Diffused Blush', family: 'CREATIVE', type: 'CREATIVE', price: 18.99 })
  historical.sourceId = 'pipiads-offline-history-20260822'; historical.metrics = { price: 18.99, currency: 'USD', creativeCount: 20, adSignal: 60 }
  store.ingestEvents([historical])
  const first = store.listProducts(undefined, true)[0]; const baseline = analyze(store, first.id).analysis
  const page = event(101, { name: 'Cloudlight Soft Glow Diffused Blush', family: 'COMMERCE', price: 16, hint: { identityAnchor: 'Cloudlight Soft Glow Diffused Blush', gtin: '192608268644' } })
  page.sourceId = 'approved-jsonld-www.morphe.com'
  store.ingestEvents([page])
  const enriched = analyze(store, first.id).analysis
  assert.ok(enriched.researchHeatScore - baseline.researchHeatScore <= 10)
  assert.ok(enriched.confidence > baseline.confidence)
  assert.equal(enriched.reuseBucket, 'NON_REUSABLE')
  store.close()
})

test('同一公开商品页的重复观察只按一个商业信号计分', () => {
  const store = new RadarStore({ memory: true })
  const first = event(110, { name: 'Repeat Observation Desk Lamp', family: 'COMMERCE', price: 20, observedAt: new Date(Date.now() - 2000).toISOString() })
  first.sourceUrl = 'https://example.com/products/desk-lamp'
  store.ingestEvents([first])
  const product = store.listProducts(undefined, true)[0]
  const baseline = analyze(store, product.id).analysis
  const repeated = event(111, { name: 'Repeat Observation Desk Lamp', family: 'COMMERCE', price: 20, observedAt: new Date(Date.now() - 1000).toISOString() })
  repeated.sourceUrl = first.sourceUrl
  store.ingestEvents([repeated])
  const afterRepeat = analyze(store, product.id)
  assert.equal(afterRepeat.analysis.researchHeatScore, baseline.researchHeatScore)
  const dossier = buildDossier(afterRepeat.product, afterRepeat.analysis, afterRepeat.events, afterRepeat.media) as any
  assert.equal(dossier.chronology.timeWindows['0–7天'].independentSourceCount.value, 1)
  assert.equal(dossier.chronology.timeWindows['0–7天'].observedEvidenceCount.value, 2)
  assert.equal(dossier.countryPerformance.US.evidenceCount.value, 1)
  assert.equal(dossier.countryPerformance.US.observedEvidenceCount.value, 2)
  store.close()
})

test('欧盟 Safety Gate 官方周报索引和详情可转换为事实型安全记录', () => {
  const now = Date.UTC(2026, 8, 2)
  const list = `<?xml version="1.0"?><Safety-Gate>
    <weeklyReport><publicationDate>29/08/2026</publicationDate><URL>https://ec.europa.eu/safety-gate-alerts/api/download/weeklyReport/detail/xml/10000320?language=en</URL></weeklyReport>
    <weeklyReport><publicationDate>01/01/2026</publicationDate><URL>https://ec.europa.eu/safety-gate-alerts/api/download/weeklyReport/detail/xml/999</URL></weeklyReport>
  </Safety-Gate>`
  assert.deepEqual(safetyGateReportUrls(list, 35, now), ['https://ec.europa.eu/safety-gate-alerts/api/download/weeklyReport/detail/xml/10000320?language=en'])

  const detail = `<?xml version="1.0"?><Safety-Gate><report_date>29/08/2026</report_date><notifications>
    <caseNumber>IE/00001/26</caseNumber><notifyingCountry>Ireland</notifyingCountry><product>Jewellery</product><name>Necklace</name>
    <brand>Example</brand><type_numberOfModel>N-100</type_numberOfModel><barcode>12345678</barcode><category>Jewellery</category>
    <description>Silver-coloured necklace.</description><riskType>Chemical</riskType><level>Serious risk</level>
    <reference>https://ec.europa.eu/safety-gate-alerts/screen/webReport/alertDetail/10000320</reference>
  </notifications></Safety-Gate>`
  const source = loadSourceRules().automatic.find((item) => item.id === 'eu-safety-gate-weekly')!
  const records = safetyGateDetailEvents('eu-test', source, detail)
  assert.equal(records.length, 1)
  assert.equal(records[0].countryCode, 'IE')
  assert.equal(records[0].productHint?.brand, 'Example')
  assert.equal(records[0].productHint?.model, 'N-100')
  assert.equal(records[0].productHint?.gtin, '12345678')
  assert.match(String(records[0].raw?.riskLevel), /Chemical/)
  assert.equal(records[0].rightsStatus, 'LINK_ONLY')
})

test('网络失败会保留可诊断错误代码但不泄露请求地址', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    const error = new TypeError('fetch failed') as TypeError & { cause?: { code: string } }
    error.cause = { code: 'ECONNRESET' }
    throw error
  }
  try {
    await assert.rejects(
      safeFetch('https://api.gdeltproject.org/api/v2/doc/doc?query=test'),
      (error) => error instanceof Error && /ECONNRESET/.test(error.message) && !/gdeltproject/.test(error.message),
    )
  } finally { globalThis.fetch = originalFetch }
})

test('Common Crawl 只保留获准商品页的历史索引证据，不提高热度或复用资格', () => {
  const source = loadSourceRules().automatic.find((item) => item.id === 'common-crawl-approved-pages')!
  const item = loadApprovedProductPages().items[0]
  const capture = commonCrawlCaptureEvent(
    'cc-test', source, item, 'CC-MAIN-2026-34',
    'https://index.commoncrawl.org/CC-MAIN-2026-34-index?url=example',
    { url: item.url, timestamp: '20260812123456', status: '200', mime: 'text/html', digest: 'ABC123' },
  )!
  assert.equal(capture.rightsStatus, 'LINK_ONLY')
  assert.match(String(capture.raw?.evidenceBoundary), /不下载归档网页/)
  const store = new RadarStore({ memory: true })
  store.ingestEvents([capture])
  const product = store.listProducts(undefined, true)[0]
  const result = analyze(store, product.id)
  assert.ok(result.analysis.researchHeatScore < 10)
  assert.equal(result.analysis.reuseBucket, 'NON_REUSABLE')
  assert.equal(result.analysis.status, 'STAGING')
  store.close()
})
