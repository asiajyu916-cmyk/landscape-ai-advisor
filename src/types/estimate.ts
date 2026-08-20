// ── 工程估價／景觀概算 型別 ──────────────────────────────────────────────────
// 刻意獨立於植物生態資料型別（src/types/csvPlant.ts、Supabase plants 表）之外：
// 植物資料庫存放日照/水分/土壤/耐旱/耐陰/間距等生態資訊，
// 這裡只存放「計價」相關資料（單價、數量、小計），避免兩者互相污染。
// 資料來源：既有 DXF 分區解析結果（src/types/dxf.ts 的 ZoneStatisticsResult），
// 透過 src/utils/estimateAdapter.ts 轉換，不重新解析 DXF。

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
  specification?: string
  pricingUnit: PricingUnit
  materialPrice?: number
  laborPrice?: number
  updatedAt?: string
  // ── 價格來源追溯：只供核對/未來更新用，不參與計價公式 ──
  sourceType: PriceSourceType  // 篩選/自動優先序判斷用（工程會優先於市場價，見規格五）
  sourceYear?: number          // 工程會價格的年度（例如 112、110），同植物同規格時新年度優先（見規格二）
  priceSource?: string         // 人類可讀的來源說明，例如「112年度公共工程植栽材料價格參考表」「田尾玫瑰園／市場參考價」
  sourceUrl?: string           // 來源網址（市場價格通常有商品頁連結）
  checkedAt?: string           // 查價日期
  note?: string                // 備註，例如「小規格苗木市場價；不得直接拿來代表14–15cm米徑工程規格」
  workItemCode?: string        // 工程會工項編碼
  region?: string              // 地區別
  stdDeviationPrice?: number   // 標準差_元
  // 灌木/地被/草皮若以「元/株」計價，但 DXF 只解析出 HATCH 面積（㎡）時，需要這個換算成
  // 株數才能計價——目前沒有種植密度資料來源，一律留空，不自行假設（見 estimateAdapter.ts）
  plantingDensityPerM2?: number
  // 此價格是否為「候選對應」（例如市場商品名稱跟資料庫植物名稱不完全一樣，如厚葉石斑木
  // 對應石斑木、四季桂對應桂花）——只在比對不到完全同名價格時才會被選用，UI 必須明確標示，
  // 不可當成完全相同植物/規格（見規格八）。
  candidateForPlantName?: string  // 這筆價格實際適用的候選對象植物名稱（DB/DXF 標準名稱）
  candidateNote?: string          // 候選對應說明，例如「四季桂為桂花栽培品種，僅供市場參考候選」
  // 同一植物在工程會價格表常有多個規格級距（例如喬木常見「270-300cm」跟「450-500cm/
  // 14-16cm米徑」兩級）。這是使用者在本專案第一次匯入工程會喬木價格時明確指定的預設
  // 級距（14-15cm米徑，見 estimatePriceSeedGov112.ts）——當圖面完全沒有規格資訊、
  // 純靠植物名稱比對又同時命中多個規格時，用這個當最後一層 tie-break，而不是直接卡在
  // 「規格不明確」。只有唯一一筆候選帶這個標記時才會生效，見 resolvePlantPrice()。
  isDefaultTreeSpec?: boolean
  // 這筆價格是否為「暫估」（狀態欄＝暫估，例如用近似苗木/簡報暫用價頂替，還沒有正式
  // 規格對應的公開價）。暫估價格仍可正常計價、正常計入小計，只是 UI 要用黃色小標籤
  // 提醒「暫估」，方便日後替換成正式價格（見「缺價植栽單價補齊」匯入規則）。
  isProvisional?: boolean
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
  materialUnitPrice?: number
  laborUnitPrice?: number
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
  // ── 價格規格比對追溯（見規格三、四、七）──────────────────────────────────────
  dxfSpec?: string             // 圖面規格（來自 DXF 植栽索引表 spec 欄），沒有就是 undefined
  priceMatchKind?: PriceMatchKind
  candidateNote?: string       // 候選對應（近似名稱/栽培品種）說明，複製自 PlantPrice.candidateNote
  ambiguousCandidates?: PlantPrice[]  // priceMatchKind==='ambiguous' 時，供 UI 顯示可選規格清單
}

/** 單一分區的估價彙總 */
export interface EstimateZoneSummary {
  zoneId: string
  items: EstimateItem[]
  materialTotal: number
  laborTotal: number
  otherTotal: number
  total: number
  pricedCount: number
  totalCount: number
}

/** 全案估價彙總 */
export interface EstimateCaseSummary {
  zones: EstimateZoneSummary[]
  materialTotal: number
  laborTotal: number
  otherTotal: number
  total: number
  pricedCount: number
  totalCount: number
  // 依分類拆分的材料費（給統計卡片「植栽材料費」明細用）
  categoryMaterialTotal: Record<EstimateCategory, number>
}
