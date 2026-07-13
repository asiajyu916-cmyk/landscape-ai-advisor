// ── plantSearchClient.ts — 呼叫官方植物資料搜尋 API + 映射為資料庫草稿 ─────────

import type { CsvPlantRecord, NormalizedCategory, SunReq, WaterReq, DroughtTolerance, WetTolerance, DrainageSensitivity, MaintenanceLevel } from '@/types/csvPlant'
import type {
  PlantSearchResponse, PlantSearchResult, PlantSearchFields, DraftPlantRecord, FieldVerificationStatus,
} from '@/types/plantSearch'
import {
  SUN_REQ_KEYWORDS, WATER_REQ_KEYWORDS, DROUGHT_KEYWORDS, WET_KEYWORDS,
  DRAINAGE_KEYWORDS, MAINTENANCE_KEYWORDS, NORMALIZED_CATEGORY_KEYWORDS,
} from '@/types/plantSearch'

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
    if (data.ok) {
      const result = data.result as PlantSearchResult
      cache[key] = { result, cachedAt: Date.now() }
      writeSearchCache(cache)
      return { ok: true, result }
    }
    return { ok: false, queryName, reason: data.reason || '目前查無足夠官方資料，建議人工確認。' }
  } catch (err) {
    return {
      ok: false, queryName,
      reason: `搜尋服務連線失敗：${err instanceof Error ? err.message : '未知錯誤'}`,
    }
  }
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

  return { ...record, isAutoSourced: true, autoSourceFields }
}
