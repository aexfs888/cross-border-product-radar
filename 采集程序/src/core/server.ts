import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { paths } from './paths.js'
import { RadarStore } from './store.js'
import { safeJson } from './utils.js'

const contentTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }

function json(response: http.ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  response.end(JSON.stringify(value))
}

export function startDashboard(port = 8765): http.Server {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', `http://127.0.0.1:${port}`)
    if (request.method !== 'GET') { json(response, 405, { error: '看板只提供只读查询' }); return }
    if (url.pathname === '/api/status') {
      const store = new RadarStore(); try { json(response, 200, store.dashboard()) } finally { store.close() }
      return
    }
    if (url.pathname === '/api/products') {
      const requested = url.searchParams.get('bucket'); const bucket = requested === 'REUSABLE' || requested === 'NON_REUSABLE' ? requested : undefined
      const store = new RadarStore()
      try {
        json(response, 200, store.listProducts(bucket).map((product) => {
          const events = store.getEvents(product.id)
          const publicEvent = events.find((event) => event.sourceId.startsWith('approved-jsonld-')) || events.find((event) => event.sourceId.startsWith('manual-public-product-links-')) || events.find((event) => event.sourceUrl.startsWith('https://'))
          return {
            id: product.id, name: product.zh_name || product.original_name, originalName: product.original_name,
            heat: product.research_heat_score, peakHeat: product.peak_heat_score, commercial: product.commercial_score,
            completeness: product.completeness, confidence: product.confidence, grade: product.commercial_grade,
            bucket: product.reuse_bucket, ageBand: product.trend_age_band,
            evidenceCount: events.length, sourceFamilies: [...new Set(events.map((event) => event.sourceFamily))],
            countries: [...new Set(events.map((event) => event.countryCode).filter((code) => code !== 'GLOBAL'))],
            publicUrl: publicEvent?.sourceUrl.startsWith('https://') ? publicEvent.sourceUrl : null,
            missingRequirements: safeJson(product.missing_requirements_json, []),
            reason: product.restriction_reason || product.research_reason, updatedAt: product.updated_at,
          }
        }))
      } finally { store.close() }
      return
    }
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '')
    const file = path.resolve(paths.dashboard, relative)
    if (!file.startsWith(path.resolve(paths.dashboard)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404); response.end('Not found'); return }
    response.writeHead(200, { 'Content-Type': contentTypes[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'" })
    fs.createReadStream(file).pipe(response)
  })
  server.listen(port, '127.0.0.1')
  return server
}
