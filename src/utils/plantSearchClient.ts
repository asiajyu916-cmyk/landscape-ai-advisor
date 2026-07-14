// ── plantSearchClient.ts — 呼叫官方植物資料搜尋 API + 映射為資料庫草稿 ─────────

import type { CsvPlantRecord, NormalizedCategory, SunReq, WaterReq, DroughtTolerance, WetTolerance, DrainageSensitivity, MaintenanceLevel } from '@/types/csvPlant'
import type {
  PlantSearchResponse, PlantSearchResult, PlantSearchFields, DraftPlantRecord, FieldVerificationStatus,
  PlantSearchTelemetry, PlantDataSource,
} from '@/types/plantSearch'
import {
  SUN_REQ_KEYWORDS, WATER_REQ_KEYWORDS, DROUGHT_KEYWORDS, WET_KEYWORDS,
  DRAINAGE_KEYWORDS, MAINTENANCE_KEYWORDS, NORMALIZED_CATEGORY_KEYWORDS,
} from '@/types/plantSearch'
import { searchCloudPlant } from '@/services/plantCloudService'
import { getAliasGroup } from '@/utils/plantNameMatch'

// ── 搜尋結果本地快取 ──────────────────────────────────────────────────────────
// AI 網路搜尋一次要 ~20 秒，同一個植物名稱不該每次都重新查詢。成功結果寫入
// localStorage，30 天內同名稱查詢直接使用快取；失敗結果不快取（允許重試）。
const SEARCH_CACHE_KEY = 'landscape_advisor_plant_search_cache_v1'
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000   // 30 天

interface SearchCacheEntry { result: PlantSearchResult; cachedAt: number }

function readSearchCache(): Record<string, SearchCacheEntry> {
  try {
    const raw = localStorage.getItem(SEARCH_CACHE_KEY)
    return raw ? JSON.parse(raw) as Record<string, SearchCacheEntry> : {}
  } catch { return {} }
}
function writeSearchCache(cache: Record<string, SearchCacheEntry>): void {
  try { localStorage.setItem(SEARCH_CACHE_KEY, JSON.stringify(cache)) } catch { /* quota exceeded，放棄快取即可 */ }
}
function searchCacheKey(queryName: string, scientificNameHint?: string): string {
  return `${queryName.trim().toLowerCase()}|${(scientificNameHint ?? '').trim().toLowerCase()}`
}

/** 呼叫後端 /api/plant-search。任何失敗都回傳結構化的失敗結果，不拋例外中斷審查流程。
 *  成功結果會快取 30 天，相同植物名稱重複查詢不再重新呼叫網路搜尋。*/
export async function searchOfficialPlantData(
  queryName: string,
  scientificNameHint?: string,
  contextNote?: string,
): Promise<PlantSearchResponse> {
  const key = searchCacheKey(queryName, scientificNameHint)
  const cache = readSearchCache()
  const cached = cache[key]
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    console.debug(`[plant-search] 快取命中："${queryName}"，略過 AI 網路查詢`)
    return { ok: true, result: cached.result }
  }

  try {
    const res = await fetch('/api/plant-search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ queryName, scientificNameHint, contextNote }),
    })
    const data = await res.json()
    const telemetry: PlantSearchTelemetry[] | undefined = data.telemetry
    if (data.ok) {
      const result = data.result as PlantSearchResult
      cache[key] = { result, cachedAt: Date.now() }
      writeSearchCache(cache)
      return { ok: true, result, telemetry }
    }
    return { ok: false, queryName, reason: data.reason || '目前查無足夠官方資料，建議人工確認。', telemetry }
  } catch (err) {
    return {
      ok: false, queryName,
      reason: `搜尋服務連線失敗：${err instanceof Error ? err.message : '未知錯誤'}`,
      telemetry: [{
        tier: 'ai_web_search', searchQuery: queryName, searchDurationMs: 0,
        jsonParseOk: false, timedOut: false,
        failureReason: err instanceof Error ? err.message : String(err),
      }],
    }
  }
}

// ── 第三層：指定植物網站查詢（臺北典藏植物園 / 農業知識入口網）─────────────────

interface SiteSearchApiResult {
  queryName: string
  matchedName: string
  scientificName: string
  englishName: string
  family: string
  genus: string
  aliases: string[]
  plantType: string
  growthHabit: string
  sunRequirement: string
  waterRequirement: string
  soilRequirement: string
  landscapeUse: string
  dataSourceName: string
  dataSourceUrl: string
  dataSource: 'taipei_botanical' | 'moa_agriculture'
  retrievedAt: string
}

async function searchDesignatedSitePlantData(
  queryName: string,
  scientificNameHint?: string,
  aliasHints?: string[],
): Promise<{ ok: true; result: SiteSearchApiResult; telemetry?: PlantSearchTelemetry[] }
  | { ok: false; reason: string; telemetry?: PlantSearchTelemetry[] }> {
  try {
    const res = await fetch('/api/plant-site-search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ queryName, scientificNameHint, aliasHints }),
    })
    const data = await res.json()
    const telemetry: PlantSearchTelemetry[] | undefined = data.telemetry
    if (data.ok) return { ok: true, result: data.result as SiteSearchApiResult, telemetry }
    return { ok: false, reason: data.reason || '指定網站查無此植物。', telemetry }
  } catch (err) {
    return {
      ok: false,
      reason: `指定網站查詢連線失敗：${err instanceof Error ? err.message : '未知錯誤'}`,
      telemetry: [{
        tier: 'site_search', searchQuery: queryName, searchDurationMs: 0,
        jsonParseOk: false, timedOut: false,
        failureReason: err instanceof Error ? err.message : String(err),
      }],
    }
  }
}

/** 指定網站查詢結果 → PlantSearchResult（沿用既有欄位格式，官方網站資料一律標記 official_confirmed）*/
function siteResultToPlantSearchResult(site: SiteSearchApiResult): PlantSearchResult {
  const status = (v: string): FieldVerificationStatus => v ? 'official_confirmed' : 'insufficient'
  const field = (v: string, note?: string) => ({ value: v, status: status(v), note })
  const fields: PlantSearchFields = {
    plantType: field(site.plantType),
    sunRequirement: field(site.sunRequirement),
    waterRequirement: field(site.waterRequirement),
    droughtTolerance: field(''),
    wetTolerance: field(''),
    drainageRequirement: field(''),
    soilRequirement: field(site.soilRequirement),
    height: field(''),
    crownWidth: field(''),
    soilDepth: field(''),
    plantingSpacing: field(''),
    flowerPeriod: field(''),
    flowerColor: field(''),
    deciduous: field(''),
    deciduousLevel: field(''),
    flowerDropRisk: field(''),
    maintenanceNote: field(site.growthHabit, site.growthHabit ? '生長習性（來自指定網站，非正式維護管理欄位）' : undefined),
    maintenanceRisk: field(''),
  }
  const missingFieldKeys = (Object.keys(fields) as (keyof PlantSearchFields)[])
    .filter(k => fields[k].status === 'insufficient')
  return {
    queryName: site.queryName,
    matchedName: site.matchedName,
    scientificName: site.scientificName,
    aliases: site.aliases,
    fields,
    dataSourceName: site.dataSourceName,
    dataSourceUrl: site.dataSourceUrl,
    retrievedAt: site.retrievedAt,
    overallStatus: missingFieldKeys.length === 0 ? 'official_confirmed' : 'inferred',
    overallConfidence: Math.round(((5 - missingFieldKeys.filter(
      k => (['plantType', 'sunRequirement', 'waterRequirement', 'soilRequirement', 'maintenanceNote'] as const).includes(k as any)
    ).length) / 5) * 100),
    missingFieldKeys,
    searchNote: site.landscapeUse ? `景觀用途：${site.landscapeUse}` : undefined,
    citedSources: [{ name: site.dataSourceName, url: site.dataSourceUrl }],
    dataSource: site.dataSource,
  }
}

/** Supabase 雲端資料庫命中的既有紀錄 → PlantSearchResult（欄位皆視為既有已確認資料）*/
function cloudRecordToPlantSearchResult(
  record: CsvPlantRecord & { cloudDataSource: PlantDataSource; cloudSourceUrl: string },
): PlantSearchResult {
  const field = (v: string) => ({ value: v || '', status: (v ? 'official_confirmed' : 'insufficient') as FieldVerificationStatus })
  const fields: PlantSearchFields = {
    plantType: field(record.category),
    sunRequirement: field(record.sunRequirement),
    waterRequirement: field(record.waterRequirement),
    droughtTolerance: field(record.droughtTolerance),
    wetTolerance: field(record.wetTolerance),
    drainageRequirement: field(record.drainageSensitivity),
    soilRequirement: field(record.soilTexture),
    height: field(record.height),
    crownWidth: field(record.crownWidth),
    soilDepth: field(record.soilDepth),
    plantingSpacing: field(record.plantingSpacing),
    flowerPeriod: field(record.flowerPeriod),
    flowerColor: field(record.flowerColor),
    deciduous: field(record.leafDropStatus),
    deciduousLevel: field(''),
    flowerDropRisk: field(''),
    maintenanceNote: field(record.maintenanceNote),
    maintenanceRisk: field(''),
  }
  return {
    queryName: record.name,
    matchedName: record.name,
    scientificName: record.scientificName,
    aliases: [],
    fields,
    dataSourceName: '雲端植物資料庫（先前已查證並人工確認）',
    dataSourceUrl: record.cloudSourceUrl,
    retrievedAt: new Date().toISOString(),
    overallStatus: 'official_confirmed',
    overallConfidence: 100,
    missingFieldKeys: [],
    citedSources: record.cloudSourceUrl ? [{ name: '雲端植物資料庫', url: record.cloudSourceUrl }] : [],
    dataSource: 'cloud_db',
  }
}

// ── 主流程：完整四層搜尋順序 ─────────────────────────────────────────────────
// 呼叫端應先自行比對本地 CSV / localStorage 資料庫（existsExactInLocalDatabase /
// findLocalPlantMatch），完全查無時才呼叫這個函式，依序往下查：
//   第二層：Supabase 雲端植物資料庫（查到就停止，不呼叫 Claude API / web_search）
//   第三層：指定植物網站（臺北典藏植物園、農業知識入口網）
//   第四層：一般 Claude 網路搜尋（沿用既有 /api/plant-search，含 30 天本地快取）
export async function searchPlantAllTiers(
  queryName: string,
  scientificNameHint?: string,
  contextNote?: string,
): Promise<PlantSearchResponse & { telemetry: PlantSearchTelemetry[]; alreadyInCloudDb?: boolean }> {
  const telemetry: PlantSearchTelemetry[] = []

  // 第二層：Supabase
  const cloudStart = Date.now()
  const cloudRes = await searchCloudPlant(queryName, scientificNameHint)
  telemetry.push({
    tier: 'cloud_db', searchQuery: queryName, searchDurationMs: Date.now() - cloudStart,
    jsonParseOk: true, timedOut: false, failureReason: cloudRes.found ? undefined : 'not_found_in_cloud_db',
  })
  if (cloudRes.found && cloudRes.record) {
    return {
      ok: true, result: cloudRecordToPlantSearchResult(cloudRes.record),
      telemetry, alreadyInCloudDb: true,
    }
  }

  // 第三層：指定植物網站（帶上本地別名表，主要名稱查無結果時可改用別名再試）
  const aliasHints = getAliasGroup(queryName).filter(a => a !== queryName)
  const siteRes = await searchDesignatedSitePlantData(queryName, scientificNameHint, aliasHints)
  if (siteRes.telemetry) telemetry.push(...siteRes.telemetry)
  if (siteRes.ok) {
    return { ok: true, result: siteResultToPlantSearchResult({ ...siteRes.result, queryName }), telemetry }
  }

  // 第四層：一般 AI 網路搜尋
  const generalRes = await searchOfficialPlantData(queryName, scientificNameHint, contextNote)
  if (generalRes.telemetry) telemetry.push(...generalRes.telemetry)
  if (generalRes.ok) return { ...generalRes, telemetry }
  return { ok: false, queryName, reason: generalRes.reason, telemetry }
}

// ── enum 欄位映射：搜尋結果是自由文字，需對應到 CsvPlantRecord 的固定選項 ──────
function mapByKeywords<T extends string>(
  text: string, table: Array<{ re: RegExp; value: T }>, fallback: T,
): T {
  for (const { re, value } of table) if (re.test(text)) return value
  return fallback
}

/** 將搜尋結果轉為可編輯的 CsvPlantRecord 草稿（尚未寫入資料庫）。*/
export function searchResultToDraft(result: PlantSearchResult): DraftPlantRecord {
  const f = result.fields
  const val = (k: keyof PlantSearchFields) => f[k]?.value ?? ''

  const normalizedCategory = mapByKeywords<NormalizedCategory>(
    val('plantType'), NORMALIZED_CATEGORY_KEYWORDS, 'shrub',
  )
  const sunRequirement = val('sunRequirement')
    ? mapByKeywords<SunReq>(val('sunRequirement'), SUN_REQ_KEYWORDS, '待查') : '待查'
  const waterRequirement = val('waterRequirement')
    ? mapByKeywords<WaterReq>(val('waterRequirement'), WATER_REQ_KEYWORDS, '待查') : '待查'
  const droughtTolerance = val('droughtTolerance')
    ? mapByKeywords<DroughtTolerance>(val('droughtTolerance'), DROUGHT_KEYWORDS, '待查') : '待查'
  const wetTolerance = val('wetTolerance')
    ? mapByKeywords<WetTolerance>(val('wetTolerance'), WET_KEYWORDS, '待查') : '待查'
  const drainageSensitivity = val('drainageRequirement')
    ? mapByKeywords<DrainageSensitivity>(val('drainageRequirement'), DRAINAGE_KEYWORDS, '待查') : '待查'
  const maintenanceLevel = val('maintenanceNote')
    ? mapByKeywords<MaintenanceLevel>(val('maintenanceNote'), MAINTENANCE_KEYWORDS, '待查') : '待查'

  const autoSourceFields: Partial<Record<keyof CsvPlantRecord, FieldVerificationStatus>> = {}
  const setSrc = (k: keyof CsvPlantRecord, fk: keyof PlantSearchFields) => { autoSourceFields[k] = f[fk]?.status }

  const record: CsvPlantRecord = {
    id: `auto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: result.matchedName,
    category: val('plantType'),
    normalizedCategory,
    subCategory: '',
    scientificName: result.scientificName,

    height: val('height'),
    crownWidth: val('crownWidth'),
    trunkDiameter: '',
    treeForm: '',
    soilDepth: val('soilDepth'),
    plantingSpacing: val('plantingSpacing'),
    minimumPlantSpacing: '',
    leafDropStatus: val('deciduous'),
    toxicity: '',
    plantSafetyNote: '',

    flowerColor: val('flowerColor'),
    flowerMonth: '',
    flowerPeriod: val('flowerPeriod'),
    flowerSupplement: val('flowerDropRisk') ? `落花風險：${val('flowerDropRisk')}` : '',

    nativeStatus: '',
    biodiversityValue: '',

    maintenanceNote: val('maintenanceNote'),
    maintenanceLevel,

    sunRequirement,
    droughtTolerance,
    wetTolerance,
    waterRequirement,
    waterToleranceTag: '',
    drainageSensitivity,

    soilPh: '',
    soilPhRange: '',
    soilTexture: val('soilRequirement'),
    soilAmendment: '',

    riskTags: val('maintenanceRisk') ? [val('maintenanceRisk')] : [],

    price: '',
    referencePageNo: '',
    referenceNote: result.searchNote ?? '',
    officialUrl: result.dataSourceUrl,
    remarks: [
      val('deciduous') ? `落葉性：${val('deciduous')}` : '',
      val('deciduousLevel') ? `落葉程度：${val('deciduousLevel')}` : '',
    ].filter(Boolean).join('；'),
    sunWaterSource: result.dataSourceName,
    sunWaterSourceUrl: result.dataSourceUrl,
    verificationStatus: result.overallStatus,
    verifiedAt: result.retrievedAt,
    verificationSummary: result.missingFieldKeys.length > 0
      ? `自動搜尋：${result.missingFieldKeys.length} 個欄位資料不足，需人工確認`
      : '自動搜尋：官方資料完整',

    reviewNote: '',
    dataComplete: result.missingFieldKeys.length === 0,
  }

  setSrc('sunRequirement', 'sunRequirement')
  setSrc('waterRequirement', 'waterRequirement')
  setSrc('droughtTolerance', 'droughtTolerance')
  setSrc('wetTolerance', 'wetTolerance')
  setSrc('drainageSensitivity', 'drainageRequirement')
  setSrc('soilTexture', 'soilRequirement')
  setSrc('height', 'height')
  setSrc('crownWidth', 'crownWidth')
  setSrc('soilDepth', 'soilDepth')
  setSrc('plantingSpacing', 'plantingSpacing')
  setSrc('flowerPeriod', 'flowerPeriod')
  setSrc('flowerColor', 'flowerColor')
  setSrc('maintenanceNote', 'maintenanceNote')

  return {
    ...record, isAutoSourced: true, autoSourceFields,
    dataSource: result.dataSource,
    dataSourceUrlForCloud: result.dataSourceUrl,
  }
}
