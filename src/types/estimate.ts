// ── 工程估價／景觀概算 型別 ──────────────────────────────────────────────────
// 刻意獨立於植物生態資料型別（src/types/csvPlant.ts、Supabase plants 表）之外：
// 植物資料庫存放日照/水分/土壤/耐旱/耐陰/間距等生態資訊，
// 這裡只存放「計價」相關資料（單價、數量、小計），避免兩者互相污染。
// 資料來源：既有 DXF 分區解析結果（src/types/dxf.ts 的 ZoneStatisticsResult），
// 透過 src/utils/estimateAdapter.ts 轉換，不重新解析 DXF。
//
// 價格模型（2026-08-20 起）：統一改為「連工帶料單價」單一欄位，不再區分材料/施工——
// 景觀公司報價本來就是連工帶料一次報一個數字，拆成材料+施工反而是系統自己發明的
// 假象精確度。舊的材料參考價（工程會/市場價）不會被當成連工帶料單價使用，只保留在
// legacyMaterialPrice 供核對用，正式計價一律等使用者匯入景觀公司填好的連工帶料單價
// 才會出現金額（見 estimatePriceRequestSheet.ts 的匯出/匯入流程）。

export type EstimateCategory = 'tree' | 'shrub' | 'groundcover' | 'grass'

export const ESTIMATE_CATEGORY_LABEL: Record<EstimateCategory, string> = {
  tree: '喬木',
  shrub: '灌木',
  groundcover: '地被',
  grass: '草皮',
}

export type PricingUnit = 'plant' | 'm2' | 'ping' | 'pot' | 'kg'

export const PRICING_UNIT_LABEL: Record<PricingUnit, string> = {
  plant: '株',
  m2: '㎡',
  ping: '坪',
  pot: '盆',
  kg: 'kg',
}

/** 價格來源類型（供「價格基準」選擇器篩選/自動優先序判斷用）：
 *  gov=公共工程官方參考價、market=苗圃/市場參考價、manual=使用者自行輸入 */
export type PriceSourceType = 'gov' | 'market' | 'manual'

export const PRICE_SOURCE_TYPE_LABEL: Record<PriceSourceType, string> = {
  gov: '工程會參考價',
  market: '苗圃市場價',
  manual: '自訂單價',
}

/** 植栽單價資料（獨立於植物生態資料庫，key 用植物名稱＋規格比對）。
 *  同一種植物允許存在多筆不同規格／不同來源的紀錄，不會互相覆蓋——
 *  比對時一律用「植物名稱＋規格」，不是只取第一筆（見 estimatePriceStore.ts resolvePlantPrice）。 */
export interface PlantPrice {
  id: string
  plantName: string
  category: EstimateCategory
  specification?: string   // 統一估價規格
  pricingUnit: PricingUnit
  // 連工帶料單價——正式計價唯一使用的欄位。景觀公司報價出來之前一律留空，
  // 不要拿舊的材料參考價頂替（那會低估真正的連工帶料成本）。
  unitPrice?: number
  updatedAt?: string
  // ── 價格來源追溯：只供核對/未來更新用，不參與計價公式 ──
  sourceType: PriceSourceType  // 篩選/自動優先序判斷用（工程會優先於市場價）
  sourceYear?: number          // 工程會價格的年度（例如 112、110），同植物同規格時新年度優先
  priceSource?: string         // 人類可讀的來源說明，例如「XX景觀工程行報價」「112年度公共工程植栽材料價格參考表」
  sourceUrl?: string           // 來源網址（市場價格通常有商品頁連結）
  checkedAt?: string           // 查價／報價日期
  note?: string                // 備註
  workItemCode?: string        // 工程會工項編碼
  region?: string              // 地區別
  stdDeviationPrice?: number   // 標準差_元
  // 舊制材料參考價（工程會/市場價匯入留下的歷史數字）：只供人工核對「連工帶料報價
  // 是否合理」時參考，完全不參與計價公式，正式 UI 不直接顯示成單價。
  legacyMaterialPrice?: number
  // 灌木/地被/草皮若以「株」計價，但 DXF 只解析出 HATCH 面積（㎡）時，需要這個換算成
  // 株數才能計價——目前沒有種植密度資料來源，一律留空，不自行假設（見 estimateAdapter.ts）
  plantingDensityPerM2?: number
  // 此價格是否為「候選對應」（例如市場商品名稱跟資料庫植物名稱不完全一樣，如厚葉石斑木
  // 對應石斑木、四季桂對應桂花）——只在比對不到完全同名價格時才會被選用，UI 必須明確標示，
  // 不可當成完全相同植物/規格。
  candidateForPlantName?: string  // 這筆價格實際適用的候選對象植物名稱（DB/DXF 標準名稱）
  candidateNote?: string          // 候選對應說明，例如「四季桂為桂花栽培品種，僅供市場參考候選」
  // 同一植物在參考價格表常有多個規格級距。這是系統認定的預設級距，圖面完全沒有規格
  // 資訊、純靠植物名稱比對又同時命中多個規格時，用這個當最後一層 tie-break，而不是
  // 直接卡在「規格不明確」。只有唯一一筆候選帶這個標記時才會生效，見 resolvePlantPrice()。
  isDefaultTreeSpec?: boolean
  // 這筆價格是否為「暫估」——仍可正常計價，只是 UI 要用黃色小標籤提醒「暫估」，
  // 方便日後替換成正式的連工帶料報價。
  isProvisional?: boolean
  // 這筆是否已由景觀公司填妥連工帶料單價後重新匯入（見 estimatePriceRequestSheet.ts）。
  // 純供 UI／匯入紀錄追溯用，不影響計價。
  quotedByCompany?: boolean
}

export type EstimatePricingStatus = 'priced' | 'missing_price' | 'missing_density' | 'ambiguous_spec'

/** 價格比對命中方式，供 UI 判斷要不要顯示「市場參考規格」等提示 */
export type PriceMatchKind = 'exact_spec' | 'single_candidate' | 'name_candidate' | 'ambiguous' | 'none'

/** 由 DXF 分區解析結果轉換而來的一筆估價項目 */
export interface EstimateItem {
  id: string
  zoneId: string
  plantName: string
  category: EstimateCategory
  specification?: string
  quantity: number
  unit: '株' | '㎡'
  // 連工帶料單價（唯一計價欄位，不再拆材料/施工）
  unitPrice?: number
  subtotal?: number
  pricingStatus: EstimatePricingStatus
  priceId?: string   // 實際採用的 PlantPrice.id（沒有比對到價格時 undefined）——編輯單價/
                      // 解決規格不明確時，用這個精準指到那一筆紀錄，不再靠名稱＋規格重新猜
  priceSource?: string
  priceSourceType?: PriceSourceType
  isProvisional?: boolean   // 複製自 PlantPrice.isProvisional，UI 顯示黃色「暫估」標籤用
  // DXF 原始代碼（blockName 或 layerName）——只供除錯/追溯用（tooltip、debug 模式），
  // 正式 UI「項目」欄一律顯示 plantName，不顯示這個欄位。
  rawBlockName?: string
  // ── 灌木/地被面積型植栽的株數換算（來源：DXF 植栽索引表「株/M2」「株數」欄，
  // 見 src/types/dxf.ts PlantScheduleEntry）：quantity/unit 仍是 DXF 解析出的原始面積，
  // 這三個是換算後的可追溯資訊，計價公式優先用 plantCount（見 estimateAdapter.ts）──
  areaM2?: number         // HATCH 面積（㎡），與 quantity 相同數值，獨立欄位方便 UI 顯示來源
  plantsPerM2?: number    // 索引表「株/M2」種植密度
  plantCount?: number     // 索引表「株數」或 Math.ceil(areaM2 × plantsPerM2) 換算而得
  // ── 價格規格比對追溯 ──────────────────────────────────────
  dxfSpec?: string             // 圖面規格（來自 DXF 植栽索引表 spec 欄），沒有就是 undefined
  priceMatchKind?: PriceMatchKind
  candidateNote?: string       // 候選對應（近似名稱/栽培品種）說明，複製自 PlantPrice.candidateNote
  ambiguousCandidates?: PlantPrice[]  // priceMatchKind==='ambiguous' 時，供 UI 顯示可選規格清單
}

/** 單一分區的估價彙總 */
export interface EstimateZoneSummary {
  zoneId: string
  items: EstimateItem[]
  total: number
  pricedCount: number
  totalCount: number
}

/** 全案估價彙總 */
export interface EstimateCaseSummary {
  zones: EstimateZoneSummary[]
  total: number
  pricedCount: number
  totalCount: number
  // 依分類拆分的金額（給統計卡片明細用）
  categoryTotal: Record<EstimateCategory, number>
}
