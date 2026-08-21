// ── 植栽「連工帶料單價」請款單 匯出／匯入 ──────────────────────────────────────
// 目的：把目前植物資料庫（喬木/灌木/地被/草皮）整理成一份 CSV，交給景觀公司填寫
// 連工帶料單價，再整批匯入回估價系統。不建立第二套植物資料庫——完整植物清單
// 一律讀自既有的 loadPlantsWithCsvMerge()（跟植栽資料庫頁面同一份），這裡只負責
// 「規格統一」跟「CSV 讀寫」。

import type { CsvPlantRecord } from '@/types/csvPlant'
import type { EstimateCategory, PlantPrice } from '@/types/estimate'
import { selectPreferredPlantPrice } from '@/lib/estimatePriceStore'
import { normalizeForCompare } from '@/utils/plantNameMatch'

// 目前系統唯一有把「草皮」跟「地被」分開登記過的兩個品種（見 estimatePriceSeedGov112Full.ts
// 的 category:'grass'）。植物資料庫本身沒有草皮/地被的欄位級區分（見規格七的資料庫調查），
// 不額外用名稱猜其他品種是不是草皮，避免把地被誤判成草皮。
const KNOWN_GRASS_NAMES = new Set(['台北草', '地毯草'])

// 喬木特殊規格（優先於一般喬木 12cm 規則）
const TREE_SPEC_OVERRIDES: Record<string, string> = {
  '山櫻花': '米徑 8cm',
  '緬梔': '米徑 10cm',
  '桂花': '米徑 8cm',
}
const DEFAULT_TREE_SPEC = '米徑 12cm'

export interface PriceRequestRow {
  plantName: string
  category: EstimateCategory
  specification: string   // 統一估價規格；灌木/地被/草皮若資料庫沒有既有規格則為空字串
  pricingUnit: '株' | '㎡' | ''  // 空字串＝資料庫沒有既有規格，單位也留給景觀公司決定
  unitPrice: string        // 匯出時固定留空；匯入時是景觀公司填的連工帶料單價
  note: string
  priceSource: string
  updatedAt: string
}

function toGroundOrGrass(name: string): EstimateCategory {
  return KNOWN_GRASS_NAMES.has(name) ? 'grass' : 'groundcover'
}

/** 決定一個植物在請款單裡的分類——直接沿用植物資料庫的 normalizedCategory，
 *  只在「地被 vs 草皮」這一層用目前系統已知的草皮名單做最後區分（見規格四）。
 *  例外：喬木特殊規格清單（山櫻花/緬梔/桂花，見規格三）一律以喬木＋米徑計價——
 *  資料庫裡「桂花」目前登記成灌木（四季桂盆花型態），但使用者指定的是喬木型態
 *  的桂花報價，兩者是不同的採購品項，不能沿用資料庫的灌木分類。 */
function resolveCategory(plant: CsvPlantRecord): EstimateCategory {
  if (plant.name in TREE_SPEC_OVERRIDES) return 'tree'
  if (plant.normalizedCategory === 'tree') return 'tree'
  if (plant.normalizedCategory === 'shrub') return 'shrub'
  return toGroundOrGrass(plant.name)
}

/** 喬木的統一估價規格：特殊植物優先，其餘一律 12cm（見規格三）。 */
function treeSpec(plantName: string): string {
  return TREE_SPEC_OVERRIDES[plantName] ?? DEFAULT_TREE_SPEC
}

/** 灌木/地被/草皮：規格與計價單位沿用「目前資料庫已有」的價格紀錄（依既有的來源優先序
 *  挑一筆代表），完全沒有價格紀錄的就留空，不自行推測不存在的規格（見規格四）。 */
function nonTreeSpecAndUnit(plantName: string, prices: PlantPrice[]): { spec: string; unit: '株' | '㎡' | '' } {
  const key = normalizeForCompare(plantName)
  const candidates = prices.filter(p => normalizeForCompare(p.plantName) === key)
  const chosen = selectPreferredPlantPrice(candidates)
  if (!chosen) return { spec: '', unit: '' }
  const unit = chosen.pricingUnit === 'm2' ? '㎡' : chosen.pricingUnit === 'plant' ? '株' : ''
  return { spec: chosen.specification ?? '', unit }
}

/** 組出請款單的每一列。plants 應該是 loadPlantsWithCsvMerge() 讀到的完整植物清單
 *  （喬木/灌木/地被/草皮全部一起，不重新建立第二套清單）；prices 是目前估價系統
 *  既有的價格資料（拿來當灌木/地被/草皮規格的參考來源，見規格四）。 */
export function buildPriceRequestRows(plants: CsvPlantRecord[], prices: PlantPrice[]): PriceRequestRow[] {
  return plants.map(plant => {
    const category = resolveCategory(plant)
    if (category === 'tree') {
      return {
        plantName: plant.name,
        category,
        specification: treeSpec(plant.name),
        pricingUnit: '株',
        unitPrice: '',
        note: '',
        priceSource: '',
        updatedAt: '',
      }
    }
    const { spec, unit } = nonTreeSpecAndUnit(plant.name, prices)
    const legacy = selectPreferredPlantPrice(prices.filter(p => normalizeForCompare(p.plantName) === normalizeForCompare(plant.name)))
    const legacyPrice = legacy?.legacyMaterialPrice ?? legacy?.unitPrice
    return {
      plantName: plant.name,
      category,
      specification: spec,
      pricingUnit: unit,
      unitPrice: '',
      note: legacyPrice !== undefined ? `系統參考材料價：NT$${legacyPrice}（${legacy?.priceSource ?? legacy?.sourceType ?? ''}），僅供比對，非連工帶料價` : '',
      priceSource: '',
      updatedAt: '',
    }
  })
}

const CSV_HEADERS = ['植物名稱', '分類', '統一估價規格', '單位', '連工帶料單價', '備註', '價格來源', '更新日期']
const CATEGORY_LABEL: Record<EstimateCategory, string> = { tree: '喬木', shrub: '灌木', groundcover: '地被', grass: '草皮' }
const CATEGORY_FROM_LABEL: Record<string, EstimateCategory> = { 喬木: 'tree', 灌木: 'shrub', 地被: 'groundcover', 草皮: 'grass' }

function csvEscape(v: string): string {
  return `"${v.replace(/"/g, '""')}"`
}

export function rowsToCsv(rows: PriceRequestRow[]): string {
  const lines = [CSV_HEADERS, ...rows.map(r => [
    r.plantName, CATEGORY_LABEL[r.category], r.specification, r.pricingUnit, r.unitPrice, r.note, r.priceSource, r.updatedAt,
  ])]
  return lines.map(row => row.map(v => csvEscape(String(v))).join(',')).join('\n')
}

/** 觸發瀏覽器下載——跟專案裡其他 CSV 匯出（LandscapeAdvisorPage.tsx）同一套做法。 */
export function downloadPriceRequestCsv(rows: PriceRequestRow[]): void {
  const bom = '﻿'
  const blob = new Blob([bom + rowsToCsv(rows)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `植栽連工帶料單價請款單_${rows.length}筆_${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// ── 匯入 ──────────────────────────────────────────────────────────────────────

/** 簡易 CSV 逐列解析（支援雙引號包欄位、欄位內逗號/換行、"" 轉義），
 *  一般試算表軟體（Excel/Numbers/Google試算表）另存 CSV 都是這個格式。 */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  const src = text.replace(/^﻿/, '')
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++ } else { inQuotes = false }
      } else {
        field += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field); field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some(v => v.trim() !== '')) rows.push(row)
      row = []
    } else {
      field += c
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); if (row.some(v => v.trim() !== '')) rows.push(row) }
  return rows
}

export interface ImportedPriceRow {
  plantName: string
  category: EstimateCategory | null   // null＝CSV 分類欄位無法辨識（不是喬木/灌木/地被/草皮）
  specification: string
  pricingUnit: '株' | '㎡' | ''
  unitPrice: number | null            // null＝這一列連工帶料單價欄位是空的，略過（不當成 0）
  note: string
  priceSource: string
}

/** 解析景觀公司填好的 CSV，欄位順序跟匯出時一致（依表頭文字比對，不是死板依欄位順序，
 *  避免使用者在 Excel 裡調過欄位順序就整份解析失敗）。 */
export function parsePriceRequestCsv(text: string): ImportedPriceRow[] {
  const table = parseCsvRows(text)
  if (table.length === 0) return []
  const header = table[0].map(h => h.trim())
  const idx = (name: string) => header.indexOf(name)
  const iName = idx('植物名稱'), iCategory = idx('分類'), iSpec = idx('統一估價規格')
  const iUnit = idx('單位'), iPrice = idx('連工帶料單價'), iNote = idx('備註')
  const iSource = idx('價格來源')
  if (iName === -1 || iPrice === -1) return []

  const rows: ImportedPriceRow[] = []
  for (const cols of table.slice(1)) {
    const plantName = (cols[iName] ?? '').trim()
    if (!plantName) continue
    const categoryLabel = (iCategory !== -1 ? cols[iCategory] : '')?.trim() ?? ''
    const priceRaw = (iPrice !== -1 ? cols[iPrice] : '')?.trim() ?? ''
    const unitRaw = (iUnit !== -1 ? cols[iUnit] : '')?.trim() ?? ''
    rows.push({
      plantName,
      category: CATEGORY_FROM_LABEL[categoryLabel] ?? null,
      specification: (iSpec !== -1 ? cols[iSpec] : '')?.trim() ?? '',
      pricingUnit: unitRaw === '株' || unitRaw === '㎡' ? unitRaw : '',
      unitPrice: priceRaw === '' ? null : (isNaN(Number(priceRaw)) ? null : Number(priceRaw)),
      note: (iNote !== -1 ? cols[iNote] : '')?.trim() ?? '',
      priceSource: (iSource !== -1 ? cols[iSource] : '')?.trim() ?? '',
    })
  }
  return rows
}

export interface PriceImportResult {
  updatedPrices: PlantPrice[]
  matchedCount: number
  skippedEmptyCount: number     // 連工帶料單價欄位是空的，略過不處理
  unmatched: ImportedPriceRow[] // 植物名稱不在目前資料庫清單裡，列入待確認，不自動新增
}

/**
 * 把景觀公司填好的匯入資料套用回價格資料庫。
 * 比對主鍵：植物名稱 + 分類 + 統一估價規格 + 單位（見規格五）。
 * 只有「植物名稱在目前資料庫清單裡」才會建立/更新價格紀錄——分類/規格/單位如果
 * 跟系統當初匯出的不完全一樣，仍然視為這筆植物的一種計價方式正常收下（例如景觀公司
 * 對某個灌木改填了不同規格），但完全不認得的植物名稱一律歸類「待確認」，不自動新增，
 * 也不會覆蓋錯的植物。
 */
export function applyPriceRequestImport(
  existingPrices: PlantPrice[],
  importedRows: ImportedPriceRow[],
  knownPlantNames: Set<string>,   // 目前植物資料庫的完整名稱集合（normalizeForCompare 過）
): PriceImportResult {
  let updatedPrices = [...existingPrices]
  let matchedCount = 0
  let skippedEmptyCount = 0
  const unmatched: ImportedPriceRow[] = []
  const now = new Date().toISOString()

  for (const row of importedRows) {
    if (row.unitPrice === null) { skippedEmptyCount++; continue }
    const nameKey = normalizeForCompare(row.plantName)
    if (!knownPlantNames.has(nameKey)) { unmatched.push(row); continue }

    const category = row.category ?? 'shrub'  // 分類欄位萬一空白時的保底值，不影響是否「已知植物」的判斷
    const existing = updatedPrices.find(p =>
      normalizeForCompare(p.plantName) === nameKey
      && p.category === category
      && (p.specification ?? '') === row.specification
      && p.pricingUnit === (row.pricingUnit === '㎡' ? 'm2' : 'plant'))

    const base: PlantPrice = existing ?? {
      id: `company-quote__${row.plantName}__${row.specification}__${Date.now()}__${matchedCount}`,
      plantName: row.plantName,
      category,
      specification: row.specification || undefined,
      pricingUnit: row.pricingUnit === '㎡' ? 'm2' : 'plant',
      sourceType: 'manual',
    }
    updatedPrices = existing
      ? updatedPrices.map(p => p === existing ? { ...p, unitPrice: row.unitPrice!, quotedByCompany: true, updatedAt: now, checkedAt: now, note: row.note || p.note, priceSource: row.priceSource || p.priceSource } : p)
      : [...updatedPrices, { ...base, unitPrice: row.unitPrice, quotedByCompany: true, updatedAt: now, checkedAt: now, note: row.note || undefined, priceSource: row.priceSource || '景觀公司連工帶料報價' }]
    matchedCount++
  }

  return { updatedPrices, matchedCount, skippedEmptyCount, unmatched }
}
