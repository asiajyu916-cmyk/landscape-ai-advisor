// ── DXF 分區解析結果 → 工程估價項目 轉換層 ────────────────────────────────────
// 只讀取既有 ZoneStatisticsResult（src/utils/zoneStatistics.ts 產出），
// 不重新解析 DXF、不修改原始解析結果。所有金額計算都是純函式加減乘除，
// 不經過 AI，符合「計價公式必須用程式計算」的要求。
//
// 價格模型：統一用「連工帶料單價」（PlantPrice.unitPrice）計價，不再拆材料/施工兩欄。

import type { ZoneStatisticsResult, PlantStatCategory, PlantScheduleEntry } from '@/types/dxf'
import type { EstimateItem, EstimateCategory, PlantPrice, EstimateZoneSummary, EstimateCaseSummary, PriceMatchKind } from '@/types/estimate'
import { resolvePlantPrice, type PriceBasis } from '@/lib/estimatePriceStore'
import { normalizePlantName, normalizeForCompare } from '@/utils/plantNameMatch'

function toEstimateCategory(cat: PlantStatCategory): EstimateCategory | null {
  switch (cat) {
    case 'tree': return 'tree'
    case 'shrub': return 'shrub'
    case 'groundcover': return 'groundcover'
    case 'lawn': return 'grass'
    default: return null   // 'unknown'：尚未正確辨識，不列入估價（避免亂猜）
  }
}

const UNRESOLVED_PLANT_LABEL = '待確認植栽'

// zoneStatistics 在無法解析出具體植物名稱時，會退回原始 DXF 代碼本身當作 plantName
// （見 src/utils/zoneStatistics.ts 的 `item.plantName ?? ins.blockName` / 圖層名稱 fallback）。
// 這裡只處理「這個退回情況」：把代碼裡常見的 CAD 類別/代號前綴去掉，剩下的中文字樣
// （通常就是繪圖者直接把植物名稱寫在 block/layer 名稱裡，例如 TREE_TA04_樟樹）交給
// 既有的別名比對（normalizePlantName，跟其他頁面共用同一套資料庫別名表，不另外造一套）。
// 絕對不會發生在「已經正確辨識」的情況——那種情況 plantName 不等於原始代碼，直接沿用。
function recoverPlantNameFromRawCode(rawCode: string): string {
  const stripped = rawCode
    .replace(/^(TREE|SHRUB|GROUND(?:COVER)?|GRASS|LAWN)[_-]+/i, '')
    .replace(/^[A-Z]{1,6}\d+[_-]+/i, '')
    .replace(/^\d+[_-]+/, '')
    .replace(/[_-]+/g, ' ')
    .trim()
  if (!stripped) return ''
  const resolved = normalizePlantName(stripped)
  // normalizePlantName 對查不到別名的字串只會做清理，不會過濾掉「看起來還是代碼」的殘留
  // （例如純英數字），這種殘留不能當植物名稱使用，寧可顯示「待確認植栽」也不要顯示代碼。
  return /^[A-Za-z0-9\s_-]+$/.test(resolved) ? '' : resolved
}

interface DebugRow {
  rawBlockName: string
  detectedPlantName: string
  normalizedPlantName: string
  dxfSpec: string | undefined
  matchedPriceName: string | undefined
  matchedSpec: string | undefined
  matchKind: PriceMatchKind
  areaM2: number | undefined
  plantsPerM2: number | undefined
  plantCount: number | undefined
  unitPrice: number | undefined
  subtotal: number | undefined
}

/** 依標準化植物名稱找植栽索引表裡對應的列（規格、株/M2、株數來源）——用既有的
 *  normalizeForCompare 比對，跟別名/大小寫/全半形處理共用同一套，不另建規則。 */
function findScheduleEntryForPlant(entries: PlantScheduleEntry[], plantName: string): PlantScheduleEntry | undefined {
  const key = normalizeForCompare(plantName)
  return entries.find(e => normalizeForCompare(e.plantName) === key)
}

/** 把目前已解析的分區統計，轉換成估價明細項目（喬木用株數、其餘用面積）。
 *  scheduleEntries：植栽索引表（含規格、株/M2、株數欄），供圖面規格比對與灌木/地被
 *  面積換算株數用。priceBasis：價格基準（自動選擇／工程會／市場價／自訂單價）。 */
export function buildEstimateItemsFromDxf(
  zoneStatistics: ZoneStatisticsResult[],
  prices: PlantPrice[],
  scheduleEntries: PlantScheduleEntry[] = [],
  priceBasis: PriceBasis = 'auto',
): EstimateItem[] {
  const items: EstimateItem[] = []
  const debugRows: DebugRow[] = []
  // 單一分區的圖面：分區面積等同全圖面積，索引表本身的「株數」欄可以直接信任、
  // 不必重算。多分區圖面則沒有辦法把索引表的全圖總株數直接套用到單一分區，
  // 改用「本分區 HATCH 面積 × 株/M2」個別換算。
  const isSingleZone = zoneStatistics.length === 1

  for (const zone of zoneStatistics) {
    for (const tree of zone.treePlants) {
      const isRawFallback = tree.plantName === tree.blockName
      const recovered = isRawFallback ? recoverPlantNameFromRawCode(tree.blockName) : ''
      const plantName = isRawFallback ? (recovered || UNRESOLVED_PLANT_LABEL) : tree.plantName
      const scheduleEntry = plantName !== UNRESOLVED_PLANT_LABEL ? findScheduleEntryForPlant(scheduleEntries, plantName) : undefined
      const dxfSpec = scheduleEntry?.spec
      // 未能辨識出具體植物時不查價格——「植物辨識」跟「價格辨識」是兩件事，不能因為
      // 查不到價格就把代碼當植物名稱去搜尋，也不能因為搜不到植物就自動歸零。
      const resolved = plantName !== UNRESOLVED_PLANT_LABEL
        ? resolvePlantPrice(prices, plantName, dxfSpec, priceBasis)
        : { status: 'missing_price' as const, matchKind: 'none' as const, candidates: [] }
      const item = buildItem({
        id: `${zone.zoneId}__tree__${tree.plantName}__${tree.blockName}`,
        zoneId: zone.zoneId,
        plantName,
        rawBlockName: tree.blockName,
        category: 'tree',
        quantity: tree.count,
        unit: '株',
        dxfSpec,
        resolved,
      })
      items.push(item)
      debugRows.push({
        rawBlockName: tree.blockName, detectedPlantName: tree.plantName, normalizedPlantName: plantName,
        dxfSpec, matchedPriceName: resolved.selected?.plantName, matchedSpec: resolved.selected?.specification,
        matchKind: resolved.matchKind, areaM2: undefined, plantsPerM2: undefined, plantCount: undefined,
        unitPrice: resolved.selected?.unitPrice, subtotal: item.subtotal,
      })
    }
    for (const hatch of zone.hatchPlants) {
      const category = toEstimateCategory(hatch.category)
      if (!category) continue
      const isRawFallback = hatch.plantName === hatch.layerName
      const recovered = isRawFallback ? recoverPlantNameFromRawCode(hatch.layerName) : ''
      const plantName = isRawFallback ? (recovered || UNRESOLVED_PLANT_LABEL) : hatch.plantName
      const scheduleEntry = plantName !== UNRESOLVED_PLANT_LABEL ? findScheduleEntryForPlant(scheduleEntries, plantName) : undefined
      const dxfSpec = scheduleEntry?.spec
      const resolved = plantName !== UNRESOLVED_PLANT_LABEL
        ? resolvePlantPrice(prices, plantName, dxfSpec, priceBasis)
        : { status: 'missing_price' as const, matchKind: 'none' as const, candidates: [] }

      // 灌木/地被面積型植栽的株數換算：草皮一律用㎡計價，不套用密度換算。
      let plantsPerM2: number | undefined
      let plantCount: number | undefined
      if (category === 'shrub' || category === 'groundcover') {
        if (scheduleEntry?.plantsPerM2 !== undefined) {
          plantsPerM2 = scheduleEntry.plantsPerM2
          // 單一分區圖面且索引表本身已有株數欄時，直接信任該值（不重算覆蓋）；
          // 否則用本分區實際 HATCH 面積 × 株/M2 換算（Math.ceil，沿用索引表解析同一套進位規則）。
          plantCount = (isSingleZone && scheduleEntry.plantCount !== undefined)
            ? scheduleEntry.plantCount
            : Math.ceil(hatch.areaM2 * scheduleEntry.plantsPerM2)
        } else if (resolved.selected?.plantingDensityPerM2 !== undefined) {
          // 索引表沒有株/M2 時，退回單價設定裡人工填的種植密度（舊版備援）。
          plantsPerM2 = resolved.selected.plantingDensityPerM2
          plantCount = Math.ceil(hatch.areaM2 * resolved.selected.plantingDensityPerM2)
        }
      }

      const item = buildItem({
        id: `${zone.zoneId}__${category}__${hatch.plantName}__${hatch.layerName}`,
        zoneId: zone.zoneId,
        plantName,
        rawBlockName: hatch.layerName,
        category,
        quantity: hatch.areaM2,
        unit: '㎡',
        dxfSpec,
        resolved,
        areaM2: hatch.areaM2,
        plantsPerM2,
        plantCount,
      })
      items.push(item)
      debugRows.push({
        rawBlockName: hatch.layerName, detectedPlantName: hatch.plantName, normalizedPlantName: plantName,
        dxfSpec, matchedPriceName: resolved.selected?.plantName, matchedSpec: resolved.selected?.specification,
        matchKind: resolved.matchKind, areaM2: hatch.areaM2, plantsPerM2, plantCount,
        unitPrice: resolved.selected?.unitPrice, subtotal: item.subtotal,
      })
    }
  }

  if (debugRows.length > 0) {
    console.group('[工程估價] DXF 植物名稱 → 規格／連工帶料單價／株數 配對結果')
    console.table(debugRows)
    console.groupEnd()
  }

  return items
}

function buildItem(args: {
  id: string; zoneId: string; plantName: string; rawBlockName: string; category: EstimateCategory
  quantity: number; unit: '株' | '㎡'
  dxfSpec?: string
  resolved: { status: 'priced' | 'missing_price' | 'ambiguous_spec'; selected?: PlantPrice; matchKind: PriceMatchKind; candidateNote?: string; candidates: PlantPrice[] }
  areaM2?: number; plantsPerM2?: number; plantCount?: number
}): EstimateItem {
  const { id, zoneId, plantName, rawBlockName, category, quantity, unit, dxfSpec, resolved, areaM2, plantsPerM2, plantCount } = args
  const price = resolved.selected
  const unitPrice = price?.unitPrice
  const base = {
    id, zoneId, plantName, rawBlockName, category, specification: price?.specification, quantity, unit,
    unitPrice, priceId: price?.id, priceSource: price?.priceSource, priceSourceType: price?.sourceType,
    isProvisional: price?.isProvisional,
    areaM2, plantsPerM2, plantCount, dxfSpec, priceMatchKind: resolved.matchKind, candidateNote: resolved.candidateNote,
    ambiguousCandidates: resolved.status === 'ambiguous_spec' ? resolved.candidates : undefined,
  }

  // 規格不明確（多筆不同規格候選、沒有一筆跟圖面規格相符）：禁止跨規格計價，不自動選價，
  // 交給使用者在 UI 手動挑選或自訂單價。
  if (resolved.status === 'ambiguous_spec') {
    return { ...base, unitPrice: undefined, subtotal: undefined, pricingStatus: 'ambiguous_spec' }
  }

  // 灌木/地被目前是用 HATCH 面積(㎡)解析，但價格是「元/株」計價時，不能直接拿面積去乘
  // 單株價格——需要換算成株數才能計價（優先用 DXF 索引表的株/M2；沒有株數換算結果時
  // 才標示「待設定種植密度」）。
  const unitMismatch = unit === '㎡' && price?.pricingUnit === 'plant'
  if (unitMismatch) {
    if (plantCount === undefined) {
      return { ...base, subtotal: undefined, pricingStatus: 'missing_density' }
    }
    return {
      ...base,
      subtotal: unitPrice !== undefined ? plantCount * unitPrice : undefined,
      pricingStatus: unitPrice !== undefined ? 'priced' : 'missing_price',
    }
  }

  const subtotal = unitPrice !== undefined ? quantity * unitPrice : undefined
  return { ...base, subtotal, pricingStatus: unitPrice !== undefined ? 'priced' : 'missing_price' }
}

/** 計價實際採用的數量基礎：有換算出株數（plantCount）就用株數，否則用 quantity
 *  （株或㎡，視項目而定）。 */
function pricingQuantity(item: EstimateItem): number {
  return item.plantCount ?? item.quantity
}

/** 單一項目的估價金額——「待設定種植密度」「規格不明確」的項目不可用面積/原始數量
 *  直接乘單價，回傳 0（不計入任何金額），避免灌入錯誤的放大數字。
 *  匯出（PDF 匯出等）需要跟畫面顯示的金額 100% 一致時，直接呼叫這個函式，
 *  不要另外用 item.subtotal 重算。 */
export function itemAmount(item: EstimateItem): number {
  if (item.pricingStatus === 'missing_density' || item.pricingStatus === 'ambiguous_spec') return 0
  return (item.unitPrice ?? 0) * pricingQuantity(item)
}

/** 重新計算單一分區彙總（合計；供價格編輯後即時更新用） */
export function computeZoneSummary(zoneId: string, items: EstimateItem[]): EstimateZoneSummary {
  const zoneItems = items.filter(i => i.zoneId === zoneId)
  const total = zoneItems.reduce((s, i) => s + itemAmount(i), 0)
  const pricedCount = zoneItems.filter(i => i.pricingStatus === 'priced').length
  return {
    zoneId,
    items: zoneItems,
    total,
    pricedCount,
    totalCount: zoneItems.length,
  }
}

/** 全案估價彙總，加總所有分區 */
export function computeCaseSummary(items: EstimateItem[]): EstimateCaseSummary {
  const zoneIds = [...new Set(items.map(i => i.zoneId))]
  const zones = zoneIds.map(zoneId => computeZoneSummary(zoneId, items))
  const total = zones.reduce((s, z) => s + z.total, 0)
  const pricedCount = zones.reduce((s, z) => s + z.pricedCount, 0)
  const totalCount = zones.reduce((s, z) => s + z.totalCount, 0)

  const categoryTotal: Record<EstimateCategory, number> = { tree: 0, shrub: 0, groundcover: 0, grass: 0 }
  for (const item of items) {
    categoryTotal[item.category] += itemAmount(item)
  }

  return { zones, total, pricedCount, totalCount, categoryTotal }
}
