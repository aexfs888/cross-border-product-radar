export type EvidenceState = '已验证' | '来源冲突' | '未知' | '不适用'
export type ReuseBucket = 'REUSABLE' | 'NON_REUSABLE'
export type ProductStatus = 'STAGING' | 'ACTIVE' | 'PRUNED'
export type RightsStatus = 'AUTHORIZED' | 'LINK_ONLY' | 'UNKNOWN' | 'PROHIBITED'
export type EventType = 'TREND' | 'NEWS' | 'COMMERCE' | 'CREATIVE' | 'SAFETY' | 'FX'
export type SourceFamily = 'DEMAND' | 'NEWS' | 'COMMERCE' | 'CREATIVE' | 'SAFETY' | 'FX'
export type PolicyDecision = 'ALLOW_AUTOMATED' | 'ALLOW_FEED_API' | 'MANUAL_LINK_ONLY' | 'BLOCKED'

export interface ProductHint {
  originalName: string
  zhName?: string
  brand?: string
  model?: string
  gtin?: string
  mpn?: string
  category?: string
  description?: string
  productUrl?: string
  imageUrl?: string
  variants?: string[]
  specs?: Record<string, string | number | boolean>
  useCases?: string[]
  targetUsers?: string[]
  unsuitableScenarios?: string[]
  features?: string[]
  supplier?: {
    name?: string
    url?: string
    moq?: number
    leadTimeDays?: number
    shipsTo?: string[]
    returnsPolicy?: string
    verified?: boolean
  }
}

export interface CollectorMetrics {
  searchVolume?: number
  growthPercent?: number
  offerCount?: number
  reviewCount?: number
  stockSignal?: number
  creativeCount?: number
  price?: number
  currency?: string
  publicSales?: number
}

export interface MediaReference {
  url: string
  type: 'IMAGE' | 'VIDEO' | 'PAGE'
  rightsStatus: RightsStatus
  license?: string
  attribution?: string
  width?: number
  height?: number
  durationSeconds?: number
}

export interface CollectorEvent {
  schemaVersion: '1.0'
  eventId: string
  runId: string
  sourceId: string
  sourceFamily: SourceFamily
  sourceUrl: string
  sourceDomain: string
  eventType: EventType
  countryCode: string
  observedAt: string
  publishedAt?: string
  rawHash: string
  productHint?: ProductHint
  metrics?: CollectorMetrics
  mediaRefs?: MediaReference[]
  rightsStatus: RightsStatus
  evidenceStrength: number
  policyDecision: PolicyDecision
  raw?: Record<string, unknown>
}

export interface CountryConfig {
  code: string
  nameZh: string
  nameEn: string
  currency: string
  hemisphere: 'NORTH' | 'SOUTH'
  locales: string[]
  googleTrendsGeo: string
}

export interface SourceConfig {
  id: string
  family: SourceFamily
  adapter: 'GOOGLE_TRENDS_RSS' | 'GDELT_DOC' | 'CPSC_XML' | 'ATOM_SAFETY' | 'GENERIC_RSS_SAFETY' | 'SITEMAP_SAFETY' | 'ECB_XML' | 'GENERIC_RSS' | 'JSON_LD'
  enabled: boolean
  endpoint?: string
  endpointTemplate?: string
  countryCode?: string
  query?: string
  maxRecords?: number
  timespan?: string
  lookbackDays?: number
  policy: string
  rights: RightsStatus | 'FACTS_ONLY'
}

export interface ProductRecord {
  id: string
  natural_key: string
  original_name: string
  zh_name: string | null
  brand: string | null
  model: string | null
  gtin: string | null
  mpn: string | null
  category: string | null
  description_zh: string | null
  specs_json: string
  variants_json: string
  use_cases_json: string
  target_users_json: string
  unsuitable_scenarios_json: string
  features_json: string
  supplier_json: string
  first_evidence_at: string
  trend_start_at: string | null
  system_first_seen_at: string
  last_seen_at: string
  trend_age_band: string
  lifecycle: string
  research_heat_score: number
  peak_heat_score: number
  commercial_score: number
  completeness: number
  confidence: number
  reuse_bucket: ReuseBucket
  commercial_grade: string
  rights_status: RightsStatus
  risk_flags_json: string
  research_reason: string
  restriction_reason: string
  missing_requirements_json: string
  status: ProductStatus
  dossier_json: string
  created_at: string
  updated_at: string
}

export interface ProductAnalysis {
  researchHeatScore: number
  commercialScore: number
  completeness: number
  confidence: number
  reuseBucket: ReuseBucket
  commercialGrade: 'A' | 'B' | 'C' | 'RESEARCH_ONLY' | 'BLOCKED'
  rightsStatus: RightsStatus
  riskFlags: string[]
  researchReason: string
  restrictionReason: string
  missingRequirements: string[]
  trendAgeBand: string
  lifecycle: string
  trendStartAt: string | null
  status: ProductStatus
}

export interface DossierField<T = unknown> {
  state: EvidenceState
  value: T | null
  evidenceIds: string[]
  note?: string
}
