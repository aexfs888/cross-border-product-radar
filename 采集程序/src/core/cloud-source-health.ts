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
  if (state.pausedUntil && new Date(state.pausedUntil).getTime() > now) return { run: false, reason: `熔断至 ${state.pausedUntil}` }
  const interval = Number(source.minIntervalHours || 0) * 3_600_000
  if (interval > 0 && state.lastSuccessAt && now - new Date(state.lastSuccessAt).getTime() < interval) return { run: false, reason: `低频来源至少间隔 ${source.minIntervalHours} 小时` }
  return { run: true }
}

function cleanError(value: unknown): string {
  return String(value instanceof Error ? value.message : value).replace(/https?:\/\/\S+/gi, '[URL]').replace(/[\r\n]+/g, ' ').slice(0, 300)
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
