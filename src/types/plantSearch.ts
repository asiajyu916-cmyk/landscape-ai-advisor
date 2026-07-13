// ── 缺漏植栽自動補資料：型別定義 ──────────────────────────────────────────────
// 對應功能：圖面/索引表辨識到植物但資料庫查無時，搜尋官方資料 → 人工確認 → 寫入資料庫

import type { CsvPlantRecord, NormalizedCategory, SunReq, WaterReq, DroughtTolerance, WetTolerance, DrainageSensitivity, MaintenanceLevel } from './csvPlant'

// 單一欄位的資料可信度：
//   official_confirmed - 官方資料明確記載
//   inferred           - 根據官方文字推論（例如同屬植物的一般性狀）
//   insufficient        - 資料不足，找不到可靠依據
export type FieldVerificationStatus = 'official_confirmed' | 'inferred' | 'insufficient'

export interface PlantFieldValue {
  value: string
  status: FieldVerificationStatus
  note?: string   // 推論依據 / 為何資料不足的簡短說明
}

// 搜尋結果涵蓋的欄位（對應需求 2 的清單）
export interface PlantSearchFields {
  plantType: PlantFieldValue          // 喬木 / 小喬木 / 灌木 / 地被 / 草本 / 草皮
  sunRequirement: PlantFieldValue
  waterRequirement: PlantFieldValue
  droughtTolerance: PlantFieldValue
  wetTolerance: PlantFieldValue
  drainageRequirement: PlantFieldValue
  soilRequirement: PlantFieldValue
  height: PlantFieldValue
  crownWidth: PlantFieldValue
  soilDepth: PlantFieldValue
  plantingSpacing: PlantFieldValue
  flowerPeriod: PlantFieldValue
  flowerColor: PlantFieldValue
  deciduous: PlantFieldValue          // 是否落葉
  deciduousLevel: PlantFieldValue     // 落葉程度
  flowerDropRisk: PlantFieldValue     // 落花風險
  maintenanceNote: PlantFieldValue    // 維護管理
  maintenanceRisk: PlantFieldValue    // 常見養護風險
}

export const PLANT_SEARCH_FIELD_LABELS: Record<keyof PlantSearchFields, string> = {
  plantType: '植物類型',
  sunRequirement: '日照需求',
  waterRequirement: '水分需求',
  droughtTolerance: '耐旱性',
  wetTolerance: '耐濕性',
  drainageRequirement: '排水需求',
  soilRequirement: '土壤需求',
  height: '樹高',
  crownWidth: '樹冠',
  soilDepth: '覆土深度',
  plantingSpacing: '種植株距',
  flowerPeriod: '花期',
  flowerColor: '花色',
  deciduous: '是否落葉',
  deciduousLevel: '落葉程度',
  flowerDropRisk: '落花風險',
  maintenanceNote: '維護管理',
  maintenanceRisk: '常見養護風險',
}

// ── 資料來源分類（需求八：UI 顯示資料來源）──────────────────────────────────────
export type PlantDataSource =
  | 'csv'                 // CSV 內建植栽資料庫
  | 'cloud_db'             // 雲端植物資料庫（Supabase）
  | 'taipei_botanical'     // 臺北典藏植物園
  | 'moa_agriculture'      // 農業知識入口網
  | 'ai_web_search'        // AI 網路補充（一般 Claude web_search）

export const PLANT_DATA_SOURCE_LABELS: Record<PlantDataSource, string> = {
  csv: 'CSV 內建植栽資料庫',
  cloud_db: '雲端植物資料庫',
  taipei_botanical: '臺北典藏植物園',
  moa_agriculture: '農業知識入口網',
  ai_web_search: 'AI 網路補充',
}

// 一筆完整的搜尋結果（/api/plant-search 的回傳內容）
export interface PlantSearchResult {
  queryName: string             // 原始查詢名稱（圖面辨識到的名稱）
  matchedName: string           // 搜尋確認的正式中文名稱
  scientificName: string
  aliases: string[]
  fields: PlantSearchFields
  dataSourceName: string        // 主要來源機構名稱，例如「行政院農業部林業及自然保育署」
  dataSourceUrl: string
  retrievedAt: string           // ISO timestamp
  overallStatus: FieldVerificationStatus
  overallConfidence: number     // 0~100，根據 official_confirmed 欄位比例估算
  missingFieldKeys: (keyof PlantSearchFields)[]
  searchNote?: string           // 找不到資料時的說明文字
  citedSources?: Array<{ name: string; url: string }>   // 搜尋過程引用的所有來源（可能多筆）
  dataSource: PlantDataSource   // 這筆結果實際命中哪一層（供 UI 標示 + 寫入資料庫時記錄）
}

// ── 查詢過程遙測資訊（需求三：AI 網路搜尋時記錄搜尋過程細節）──────────────────
// 目的：避免把「API timeout」「Vercel timeout」「查無資料」「JSON parse error」
// 「rate limit」全部顯示成同一個籠統的「查無資料」，方便排查真正的失敗原因。
export interface PlantSearchTelemetry {
  tier: 'csv' | 'cloud_db' | 'site_search' | 'ai_web_search'
  searchQuery: string
  searchDurationMs: number
  matchedDomain?: string
  matchedUrl?: string
  respondedAt?: string          // Claude 回傳時間（ISO）
  jsonParseOk: boolean
  timedOut: boolean
  failureReason?: string        // 實際失敗原因（非籠統的「查無資料」）
}

// API 呼叫失敗 / 完全查無資料時的回應
export interface PlantSearchFailure {
  ok: false
  queryName: string
  reason: string   // 面向使用者的訊息，例如「目前查無足夠官方資料，建議人工確認。」
  telemetry?: PlantSearchTelemetry[]   // 各層查詢過程記錄，供排查真正失敗原因
}

export interface PlantSearchSuccess {
  ok: true
  result: PlantSearchResult
  telemetry?: PlantSearchTelemetry[]
}

export type PlantSearchResponse = PlantSearchSuccess | PlantSearchFailure

// ── 本地資料庫名稱比對（正規化）────────────────────────────────────────────────

export interface PlantMatchCandidate {
  plant: CsvPlantRecord
  matchType: 'exact_name' | 'exact_scientific' | 'alias' | 'normalized_name' | 'cross_reference'
  score: number   // 0~100
}

// ── 相近植物替代測試（人工確認流程）────────────────────────────────────────────
// 本地資料庫找不到完全相符的植物時，列出名稱最相近的候選供人工確認，
// 不得自動視為同一植物。

export interface SimilarPlantCandidate {
  plant: CsvPlantRecord
  nameSimilarity: number       // 0~100，名稱相似度
  genus: string | null         // 候選植物學名屬名（取自 scientificName 第一個字）
  sameGenus: boolean | null    // 與原始植物是否同屬；null = 無法判斷（缺學名資料比對）
}

// ── 確認新增流程狀態 ──────────────────────────────────────────────────────────

export type MissingPlantResolution = 'pending' | 'searching' | 'found' | 'not_found' | 'confirmed' | 'skipped' | 'editing'

export interface MissingPlantEntry {
  id: string                    // = queryName（正規化後）作為 key
  queryName: string              // 圖面 / 索引表辨識到的原始名稱
  scientificNameHint?: string    // 若索引表有學名欄位
  zoneNames: string[]            // 出現在哪些分區（供重新評估時定位）
  resolution: MissingPlantResolution
  searchResult?: PlantSearchResult
  failureReason?: string
}

// ── 搜尋結果 → CsvPlantRecord 草稿（供確認視窗編輯 / 寫入資料庫）────────────────

export interface DraftPlantRecord extends CsvPlantRecord {
  isAutoSourced: true
  autoSourceFields: Partial<Record<keyof CsvPlantRecord, FieldVerificationStatus>>
  dataSource: PlantDataSource
  dataSourceUrlForCloud: string   // 寫入 Supabase 時的 source_url（cloud_db 命中時不需要再寫入）
}

// ── enum 值正規化對照（搜尋結果為自由文字，需映射進 CsvPlantRecord 的固定選項）──

export const SUN_REQ_KEYWORDS: Array<{ re: RegExp; value: SunReq }> = [
  { re: /全日照.{0,3}(半日照|半陰)/, value: '全日照至半日照' },
  { re: /半日照.{0,4}(遮陰|全陰|耐陰)/, value: '半日照至遮陰' },
  { re: /全日照|強光|日照充足/, value: '全日照' },
  // 真正耐陰：明確提到遮陰/全陰/耐陰/陰暗等強遮蔭字眼，可長期在低光環境生長
  { re: /耐陰|遮陰|全陰|陰暗|背光|光線不足/, value: '半日照至遮陰' },
  // 半日照適應／可耐半陰：只提到「半陰」「半日照」這類較弱的字眼，代表仍需部分日照、
  // 只是能容忍半日照或部分遮陰，不能等同於真正耐陰，需另外分類避免混入耐陰查詢結果
  { re: /半日照|半陰|可耐半陰|部分遮陰/, value: '半日照' },
]

export const WATER_REQ_KEYWORDS: Array<{ re: RegExp; value: WaterReq }> = [
  { re: /高.{0,2}(水分|需水|水量)|喜濕|喜濕潤/, value: '高' },
  { re: /中.{0,2}(至|~|到).{0,2}高/, value: '中至高' },
  { re: /低.{0,2}(至|~|到).{0,2}中/, value: '低至中' },
  { re: /中等|適中/, value: '中' },
  { re: /低.{0,2}(水分|需水|水量)|耐旱/, value: '低' },
]

export const DROUGHT_KEYWORDS: Array<{ re: RegExp; value: DroughtTolerance }> = [
  { re: /極耐旱|強耐旱|非常耐旱|耐旱性佳|耐旱性強/, value: '耐旱' },
  { re: /耐旱/, value: '耐旱' },
  { re: /稍耐旱|略耐旱|中等耐旱/, value: '稍耐旱' },
  { re: /不耐旱|忌乾旱/, value: '不耐旱' },
]

export const WET_KEYWORDS: Array<{ re: RegExp; value: WetTolerance }> = [
  { re: /耐濕|耐水濕|耐淹|濕地適生/, value: '耐濕' },
  { re: /稍耐濕|略耐濕/, value: '稍耐濕' },
  { re: /不耐積水|忌積水|排水不良.{0,4}(不良|死亡|爛根)/, value: '不耐積水' },
]

export const DRAINAGE_KEYWORDS: Array<{ re: RegExp; value: DrainageSensitivity }> = [
  { re: /排水.{0,3}(需求高|要求高|需良好|需佳)|忌積水/, value: '高' },
  { re: /排水.{0,3}(普通|一般|適中)/, value: '中' },
  { re: /排水.{0,3}(不拘|不敏感|要求低)/, value: '低' },
]

export const MAINTENANCE_KEYWORDS: Array<{ re: RegExp; value: MaintenanceLevel }> = [
  { re: /高.{0,2}(維護|管理)|需頻繁修剪|管理.{0,2}(繁複|費工)/, value: '高' },
  { re: /低.{0,2}(維護|管理)|粗放|少維護|免修剪/, value: '低' },
  { re: /中等.{0,2}(維護|管理)|一般管理/, value: '中' },
]

export const NORMALIZED_CATEGORY_KEYWORDS: Array<{ re: RegExp; value: NormalizedCategory }> = [
  { re: /喬木|小喬木|大喬木/, value: 'tree' },
  { re: /灌木|灌叢/, value: 'shrub' },
  { re: /地被|草本|草皮|草坪|蕨類/, value: 'groundcover' },
]
