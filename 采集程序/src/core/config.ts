import fs from 'node:fs'
import { z } from 'zod'
import { paths } from './paths.js'
import type { CountryConfig, SourceConfig } from './types.js'

const countriesSchema = z.object({
  version: z.number(),
  countries: z.array(z.object({
    code: z.string().length(2),
    nameZh: z.string(),
    nameEn: z.string(),
    currency: z.string().length(3),
    hemisphere: z.enum(['NORTH', 'SOUTH']),
    locales: z.array(z.string()),
    googleTrendsGeo: z.string(),
  })),
})

const sourceSchema = z.object({
  version: z.number(),
  network: z.object({
    httpsOnly: z.boolean(),
    maxRedirects: z.number(),
    maxResponseBytes: z.number(),
    maxRequestsPerRun: z.number(),
    perDomainConcurrency: z.number(),
    minDelayMs: z.number(),
    timeoutMs: z.number(),
    retries: z.number(),
    pauseAfterConsecutiveFailures: z.number(),
    pauseHours: z.number(),
  }),
  automatic: z.array(z.object({
    id: z.string(),
    family: z.enum(['DEMAND', 'NEWS', 'COMMERCE', 'CREATIVE', 'SAFETY', 'FX']),
    adapter: z.enum(['GOOGLE_TRENDS_RSS', 'GOOGLE_NEWS_RSS_WATCHLIST', 'GDELT_DOC', 'APPROVED_JSON_LD_WATCHLIST', 'CPSC_XML', 'ATOM_SAFETY', 'GENERIC_RSS_SAFETY', 'SITEMAP_SAFETY', 'EU_SAFETY_GATE_XML', 'ECB_XML', 'GENERIC_RSS', 'JSON_LD']),
    enabled: z.boolean(),
    endpoint: z.string().optional(),
    endpointTemplate: z.string().optional(),
    countryCode: z.string().optional(),
    query: z.string().optional(),
    maxRecords: z.number().optional(),
    timespan: z.string().optional(),
    lookbackDays: z.number().optional(),
    minIntervalHours: z.number().positive().optional(),
    policy: z.string(),
    rights: z.enum(['AUTHORIZED', 'LINK_ONLY', 'UNKNOWN', 'PROHIBITED', 'FACTS_ONLY']),
  })),
  optionalDisabled: z.array(z.record(z.string(), z.string())),
  manualOnlyDomains: z.array(z.string()),
  blockedAccessPatterns: z.array(z.string()),
})

const keywordSchema = z.object({
  version: z.number(),
  productTerms: z.array(z.string()),
  nonProductTerms: z.array(z.string()).default([]),
  ipRiskTerms: z.array(z.string()),
  regulatedTerms: z.array(z.string()),
  blockedProductTerms: z.array(z.string()),
  logisticsRiskTerms: z.array(z.string()),
})

const watchlistSchema = z.object({
  version: z.number(),
  note: z.string(),
  items: z.array(z.object({ name: z.string().min(3), query: z.string().min(3), note: z.string() })),
})

const approvedProductPagesSchema = z.object({
  version: z.number(),
  note: z.string(),
  items: z.array(z.object({
    canonicalName: z.string().min(3),
    url: z.string().url(),
    countryCode: z.string().length(2),
    robotsCheckedAt: z.string(),
    rights: z.literal('LINK_ONLY'),
    note: z.string(),
  })),
})

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

export function loadCountries(): CountryConfig[] {
  return countriesSchema.parse(readJson(paths.countries)).countries as CountryConfig[]
}

export function loadSourceRules() {
  const parsed = sourceSchema.parse(readJson(paths.sourceRules))
  return { ...parsed, automatic: parsed.automatic as SourceConfig[] }
}

export function loadKeywordRules() {
  return keywordSchema.parse(readJson(paths.keywordRules))
}

export function loadProductWatchlist() {
  return watchlistSchema.parse(readJson(paths.productWatchlist))
}

export function loadApprovedProductPages() {
  return approvedProductPagesSchema.parse(readJson(paths.approvedProductPages))
}
