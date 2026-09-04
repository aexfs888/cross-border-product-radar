import fs from 'node:fs'
import { atomicWrite } from './utils.js'
import type { SourceConfig } from './types.js'

export type CloudSourceState = {
  consecutiveFailures: number
  lastSuccessAt: string | null
  lastFailureAt: string | null
  pausedUntil: string | null
  lastError: string | null
  recordsLastRun: number
}

export type CloudSourceHealth = {
  schemaVersion: 1
  generatedAt: string
  sources: Record<string, CloudSourceState>
}

const emptySource = (): CloudSourceState => ({
  consecutiveFailures: 0, lastSuccessAt: null, lastFailureAt: null,
  pausedUntil: null, lastError: null, recordsLastRun: 0,
})

export function loadCloudSourceHealth(filePath: string): CloudSourceHealth {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<CloudSourceHealth>
    if (value.schemaVersion !== 1 || !value.sources || typeof value.sources !== 'object') throw new Error('schema')
    return { schemaVersion: 1, generatedAt: String(value.generatedAt || ''), sources: value.sources as Record<string, CloudSourceState> }
  } catch { return { schemaVersion: 1, generatedAt: new Date(0).toISOString(), sources: {} } }
}

export function cloudSourceDecision(source: SourceConfig, state: CloudSourceState | undefined, now = Date.now()): { run: boolean, reason?: string } {
  if (!state) return { run: true }
  const pausedUntil = state.pausedUntil ? new Date(state.pausedUntil).getTime() : NaN
  if (Number.isFinite(pausedUntil) && pausedUntil > now) return { run: false, reason: `熔断至 ${state.pausedUntil}` }
  const interval = Number(source.minIntervalHours || 0) * 3_600_000
  const lastSuccessAt = state.lastSuccessAt ? new Date(state.lastSuccessAt).getTime() : NaN
  if (interval > 0 && Number.isFinite(lastSuccessAt) && now - lastSuccessAt < interval) return { run: false, reason: `低频来源至少间隔 ${source.minIntervalHours} 小时` }
  return { run: true }
}

export function summarizeCloudSourceHealth(health: CloudSourceHealth, sources: SourceConfig[], now = Date.now()): {
  configured: number
  healthy: number
  paused: number
  neverSucceeded: number
  stale: number
  sources: Array<{ sourceId: string, status: 'healthy' | 'paused' | 'never_succeeded' | 'stale', recordsLastRun: number, lastSuccessAt: string | null, pausedUntil: string | null }>
} {
  const rows = sources.filter((source) => source.enabled).map((source) => {
    const state = health.sources[source.id] || emptySource()
    const decision = cloudSourceDecision(source, state, now)
    const lastSuccess = state.lastSuccessAt ? new Date(state.lastSuccessAt).getTime() : NaN
    const maxAge = Math.max(36, Number(source.minIntervalHours || 0) * 3 + 12) * 3_600_000
    const status: 'healthy' | 'paused' | 'never_succeeded' | 'stale' = !decision.run && state.pausedUntil ? 'paused' : !Number.isFinite(lastSuccess) ? 'never_succeeded' : now - lastSuccess > maxAge ? 'stale' : 'healthy'
    return { sourceId: source.id, status, recordsLastRun: Number(state.recordsLastRun || 0), lastSuccessAt: state.lastSuccessAt || null, pausedUntil: state.pausedUntil || null }
  })
  return {
    configured: rows.length,
    healthy: rows.filter((row) => row.status === 'healthy').length,
    paused: rows.filter((row) => row.status === 'paused').length,
    neverSucceeded: rows.filter((row) => row.status === 'never_succeeded').length,
    stale: rows.filter((row) => row.status === 'stale').length,
    sources: rows,
  }
}

function cleanError(value: unknown): string {
  return String(value instanceof Error ? value.message : value)
    .replace(/https?:\/\/\S+/gi, '[URL]')
    .replace(/[A-Za-z]:\\[^\s"'`]+/g, '[PATH]')
    .replace(/(^|\s)\/(?:home|tmp|var|opt|workspace|__w|runner)(?:\/[^\s"'`]*)?/gi, '$1[PATH]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 300)
}

export function recordCloudSourceResult(
  health: CloudSourceHealth,
  sourceId: string,
  success: boolean,
  recordCount: number,
  options: { pauseAfter: number, pauseHours: number, now?: number, error?: unknown },
): CloudSourceState {
  const previous = health.sources[sourceId] || emptySource()
  const nowMs = options.now ?? Date.now(); const now = new Date(nowMs).toISOString()
  const failures = success ? 0 : Number(previous.consecutiveFailures || 0) + 1
  const next: CloudSourceState = success ? {
    consecutiveFailures: 0, lastSuccessAt: now, lastFailureAt: previous.lastFailureAt || null,
    pausedUntil: null, lastError: null, recordsLastRun: recordCount,
  } : {
    consecutiveFailures: failures, lastSuccessAt: previous.lastSuccessAt || null, lastFailureAt: now,
    pausedUntil: failures >= options.pauseAfter ? new Date(nowMs + options.pauseHours * 3_600_000).toISOString() : null,
    lastError: cleanError(options.error), recordsLastRun: 0,
  }
  health.sources[sourceId] = next; health.generatedAt = now
  return next
}

export async function saveCloudSourceHealth(filePath: string, health: CloudSourceHealth): Promise<void> {
  await atomicWrite(filePath, `${JSON.stringify(health, null, 2)}\n`)
}
