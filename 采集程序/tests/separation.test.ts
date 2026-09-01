import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDossier } from '../src/core/dossier.js'
import { analyzeProduct } from '../src/core/scoring.js'
import { RadarStore } from '../src/core/store.js'
import { sha256 } from '../src/core/utils.js'
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
