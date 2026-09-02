import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { loadSourceRules } from './config.js'
import { paths } from './paths.js'

const domainLastRequest = new Map<string, number>()
let requestsThisRun = 0

export function nowIso(): string { return new Date().toISOString() }
export function createId(prefix: string): string { return `${prefix}_${crypto.randomUUID()}` }
export function sha256(value: unknown): string {
  const input = typeof value === 'string' || Buffer.isBuffer(value) ? value : stableStringify(value)
  return crypto.createHash('sha256').update(input).digest('hex')
}
export function hmac256(secret: string, value: string): string {
  return crypto.createHmac('sha256', secret).update(value).digest('hex')
}
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`
}
export function clamp(value: number, min = 0, max = 100): number { return Math.max(min, Math.min(max, value)) }
export function safeJson<T>(value: string | null | undefined, fallback: T): T {
  try { return value ? JSON.parse(value) as T : fallback } catch { return fallback }
}
export function normalizeText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/<[^>]+>/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ')
}
export function normalizeTitle(value: string): string {
  return normalizeText(value).replace(/\b(the|a|an|new|202[0-9]|sale|deal|best|top)\b/g, ' ').replace(/\s+/g, ' ').trim()
}
export function naturalKey(hint: { originalName: string, identityAnchor?: string, brand?: string, model?: string, gtin?: string, mpn?: string }): string {
  // identityAnchor 只在人工已确认“网页与现有候选为同一研究对象”时使用，防止网页短标题、
  // 店铺默认品牌或商家 SKU 将同一商品拆成多个档案。品牌必须和型号同时存在才构成身份键。
  const strongest = hint.identityAnchor || hint.gtin || hint.mpn || (hint.brand && hint.model ? `${hint.brand} ${hint.model}` : '')
  return sha256(normalizeTitle(strongest || hint.originalName)).slice(0, 32)
}
export function canonicalUrl(value: string): string {
  const url = new URL(value)
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$|source$)/i.test(key)) url.searchParams.delete(key)
  url.hash = ''
  return url.toString()
}
export function hostOf(value: string): string { try { return new URL(value).hostname.toLowerCase() } catch { return '' } }
export function asArray<T>(value: T | T[] | undefined | null): T[] { return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value] }
export function parseMagnitude(value: unknown): number | undefined {
  const text = String(value ?? '').replace(/,/g, '').trim().toLowerCase()
  const match = text.match(/([0-9]+(?:\.[0-9]+)?)\s*([kmb]?)/)
  if (!match) return undefined
  const multiplier = match[2] === 'k' ? 1_000 : match[2] === 'm' ? 1_000_000 : match[2] === 'b' ? 1_000_000_000 : 1
  return Math.round(Number(match[1]) * multiplier)
}
export function ageBand(firstSeen: string, now = new Date()): string {
  const days = Math.max(0, Math.floor((now.getTime() - new Date(firstSeen).getTime()) / 86_400_000))
  if (days <= 7) return '0–7天'
  if (days <= 15) return '8–15天'
  if (days <= 30) return '16–30天'
  if (days <= 60) return '31–60天'
  if (days <= 90) return '61–90天'
  if (days <= 120) return '91–120天'
  if (days <= 180) return '121–180天'
  return '180天以上'
}
export function textHasTerm(text: string, term: string): boolean {
  const normalized = normalizeText(text); const needle = normalizeText(term)
  if (!normalized || !needle) return false
  // 英文与数字必须整词匹配，避免把 Pete 误判成 pet、把普通新闻片段误判成商品。
  if (/^[a-z0-9 ]+$/.test(needle)) return ` ${normalized} `.includes(` ${needle} `)
  return normalized.includes(needle)
}
export function isProductLike(text: string, terms: string[], excludedTerms: string[] = []): boolean {
  return !excludedTerms.some((term) => textHasTerm(text, term)) && terms.some((term) => textHasTerm(text, term))
}

export function resetRequestBudget(): void { requestsThisRun = 0 }
export function requestBudgetSnapshot(): { used: number, maximum: number } {
  return { used: requestsThisRun, maximum: loadSourceRules().network.maxRequestsPerRun }
}

function isPrivateIp(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b, c] = address.split('.').map(Number)
    return a === 10 || a === 127 || a === 0 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || a >= 224
  }
  const normalized = address.toLowerCase()
  return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:') || normalized.startsWith('::ffff:127.') || normalized.startsWith('::ffff:10.') || normalized.startsWith('::ffff:192.168.')
}

function isBenchmarkProxyIp(address: string): boolean {
  if (!net.isIPv4(address)) return false
  const [a, b] = address.split('.').map(Number)
  return a === 198 && (b === 18 || b === 19)
}

function explicitlyApprovedHostname(hostname: string): boolean {
  const configured = loadSourceRules().automatic.flatMap((source) => [source.endpoint, source.endpointTemplate]).filter(Boolean).map((value) => {
    try { return new URL(String(value).replace('{geo}', 'US')).hostname.toLowerCase() } catch { return '' }
  })
  let approved: string[] = []
  try { approved = (JSON.parse(fsSync.readFileSync(path.join(paths.root, '来源规则', 'approved-domains.json'), 'utf8')) as { domains?: string[] }).domains || [] } catch { approved = [] }
  const normalized = hostname.toLowerCase()
  return [...configured, ...approved.map((item) => item.toLowerCase())].some((allowed) => normalized === allowed || normalized.endsWith(`.${allowed}`))
}

export async function assertPublicHttpsUrl(value: string): Promise<URL> {
  const url = new URL(value)
  if (url.protocol !== 'https:') throw new Error(`只允许 HTTPS：${url.protocol}`)
  if (url.username || url.password) throw new Error('URL 不允许包含账号或密码')
  const records = await dns.lookup(url.hostname, { all: true })
  if (!records.length || records.some((record) => isPrivateIp(record.address) || (isBenchmarkProxyIp(record.address) && !explicitlyApprovedHostname(url.hostname)))) throw new Error(`拒绝私有或保留地址：${url.hostname}`)
  return url
}

export async function sleep(ms: number): Promise<void> { await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 60_000))) }

export async function safeFetch(value: string, init: RequestInit = {}): Promise<Response> {
  const rules = loadSourceRules().network
  if (requestsThisRun >= rules.maxRequestsPerRun) throw new Error(`单轮请求已达到安全上限 ${rules.maxRequestsPerRun}`)
  let current = await assertPublicHttpsUrl(value)
  for (let redirect = 0; redirect <= rules.maxRedirects; redirect += 1) {
    if (requestsThisRun >= rules.maxRequestsPerRun) throw new Error(`单轮请求已达到安全上限 ${rules.maxRequestsPerRun}`)
    const last = domainLastRequest.get(current.hostname) || 0
    const wait = rules.minDelayMs - (Date.now() - last)
    if (wait > 0) await sleep(wait)
    domainLastRequest.set(current.hostname, Date.now())
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), rules.timeoutMs)
    let response: Response
    try {
      requestsThisRun += 1
      response = await fetch(current, {
        ...init,
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'CrossBorderProductRadar/0.1 (+local research; public sources only)',
          'Accept': 'application/json, application/xml, text/xml, application/atom+xml, application/rss+xml, text/html;q=0.8, */*;q=0.5',
          ...(init.headers || {}),
        },
      })
    } catch (error) {
      const cause = error instanceof Error ? (error as Error & { cause?: { code?: unknown, name?: unknown } }).cause : undefined
      const reason = controller.signal.aborted ? 'TIMEOUT' : String(cause?.code || cause?.name || (error instanceof Error ? error.name : 'UNKNOWN')).slice(0, 80)
      throw new Error(`网络请求失败（${reason}）`)
    } finally { clearTimeout(timer) }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      if (!location) throw new Error(`重定向缺少 Location：${current}`)
      current = await assertPublicHttpsUrl(new URL(location, current).toString())
      continue
    }
    const declared = Number(response.headers.get('content-length') || 0)
    if (declared > rules.maxResponseBytes) throw new Error(`响应过大：${declared} bytes`)
    return response
  }
  throw new Error('重定向次数超过限制')
}

export async function fetchBytes(value: string, init: RequestInit = {}): Promise<Buffer> {
  const response = await safeFetch(value, init)
  if (!response.ok) throw new Error(`HTTP ${response.status}：${value}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const max = loadSourceRules().network.maxResponseBytes
  if (bytes.length > max) throw new Error(`响应实际大小超过限制：${bytes.length} bytes`)
  return bytes
}

export async function fetchText(value: string, init: RequestInit = {}): Promise<string> {
  return (await fetchBytes(value, init)).toString('utf8')
}

export function credibleProductDescription(value: unknown, productName = '', brand = ''): string | undefined {
  const text = String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 800)
  if (!text) return undefined
  const normalized = normalizeText(text)
  if (normalized === normalizeText(productName) || (brand && normalized === normalizeText(brand))) return undefined
  const cjkCount = (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).length
  if (text.length < 40 && cjkCount < 12) return undefined
  if (/regular price|sale price|unit price|sold out|save \d+%|verified reviews|secure (?:payment|checkout)|free shipping|money-back guarantee|未取得制造商说明|只证明链接页面存在|资料均需独立核验/i.test(text)) return undefined
  return text
}

export async function withRetry<T>(action: () => Promise<T>, retries = loadSourceRules().network.retries): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try { return await action() } catch (error) {
      lastError = error
      if (attempt < retries) await sleep(1_000 * 2 ** attempt)
    }
  }
  throw lastError
}

export async function atomicWrite(filePath: string, content: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tempPath, content)
  await fs.rename(tempPath, filePath)
}

export function slug(value: string): string {
  const result = normalizeText(value).replace(/\s+/g, '-').replace(/[^\p{L}\p{N}-]/gu, '').slice(0, 80)
  return result || 'product'
}
