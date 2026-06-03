/**
 * calculations.ts
 * 所有面積 / 容積計算邏輯集中在此。
 * 純函式，無副作用，方便單元測試。
 */

import type {
  FloorData, FloorDefinition, FloorsById, FloorStats,
  FloorSummaryRow, ProjectInfo, ProjectSummary,
} from '@/types'

// ─── 數值格式化 ──────────────────────────────────────────

export const fmt = (n: number | null | undefined, d = 2): string => {
  if (n == null || isNaN(Number(n))) return '-'
  return Number(n).toFixed(d)
}

// ─── 單層統計（當層自動檢討用）──────────────────────────

export function computeFloorStats(floorData: FloorData): FloorStats {
  const priv   = floorData.privateItems ?? []
  const shared = floorData.sharedItems  ?? []

  const privateIndoor      = priv.reduce((s, r) => s + Number(r.indoor      || 0), 0)
  const privateBalcony     = priv.reduce((s, r) => s + Number(r.balcony     || 0), 0)
  const privateBalconyOver = priv.reduce((s, r) => s + Number(r.balconyOver || 0), 0)
  const privateSubtotal    = priv.reduce((s, r) => s + Number(r.subtotal    || 0), 0)

  const sharedTotal = shared.reduce((s, r) => s + Number(r.area || 0), 0)
  const hallArea    = Number(shared.find(r => r.rule === '梯廳10%')?.area ?? 0)
  const art162Total = shared
    .filter(r => r.rule === '第162條')
    .reduce((s, r) => s + Number(r.area || 0), 0)

  const floorArea   = privateSubtotal + sharedTotal
  const limit10     = floorArea * 0.10
  const limit15     = floorArea * 0.15
  const combinedSum = privateBalcony + hallArea
  const over15      = Math.max(0, combinedSum - limit15)
  const farArea     = floorArea - hallArea - art162Total + over15

  return {
    privateIndoor, privateBalcony, privateBalconyOver, privateSubtotal,
    sharedTotal, hallArea, art162Total,
    floorArea, limit10, limit15, combinedSum, over15, farArea,
  }
}

// ─── 大總表列計算 ─────────────────────────────────────────

/**
 * getFloorSummary
 * 從樓層定義 + 樓層資料計算大總表所需的一列欄位。
 */
export function getFloorSummary(
  floorDef: FloorDefinition,
  floorData: FloorData
): FloorSummaryRow {
  const priv   = floorData.privateItems ?? []
  const shared = floorData.sharedItems  ?? []

  const privateIndoor   = priv.reduce((s, r) => s + Number(r.indoor      || 0), 0)
  const balconyArea     = priv.reduce((s, r) => s + Number(r.balcony     || 0), 0)
  const balconyOver2m   = priv.reduce((s, r) => s + Number(r.balconyOver || 0), 0)
  const privateSubtotal = priv.reduce((s, r) => s + Number(r.subtotal    || 0), 0)

  const sharedInFloor  = shared.filter(r => r.inFloor === '是')
  const sharedTotal    = sharedInFloor.reduce((s, r) => s + Number(r.area || 0), 0)
  const hallArea       = Number(shared.find(r => r.rule === '梯廳10%')?.area ?? 0)
  const article162Area = shared
    .filter(r => r.rule === '第162條')
    .reduce((s, r) => s + Number(r.area || 0), 0)

  const floorArea   = privateSubtotal + sharedTotal
  const limit15     = floorArea * 0.15
  const combinedSum = balconyArea + hallArea
  const over15      = Math.max(0, combinedSum - limit15)
  const floorVolume = floorArea - hallArea - article162Area + over15

  return {
    floorId:       floorDef.id,
    floorName:     floorDef.name,
    usage:         floorDef.usage,
    height:        floorDef.height,
    floorArea,
    privateIndoor,
    balconyArea,
    balconyOver2m,
    article162Area,
    hallArea,
    floorVolume,
    over15,
    isOverridden:  floorData.isOverridden,
    sourceFloor:   floorData.sourceFloor,
  }
}

/**
 * getAllFloorSummaries
 * 依樓層定義順序，對所有樓層呼叫 getFloorSummary。
 * dependency: floorsById — 任何一層變動都觸發全量重算。
 */
export function getAllFloorSummaries(
  floorDefs: FloorDefinition[],
  floorsById: FloorsById
): FloorSummaryRow[] {
  return floorDefs.map(def => getFloorSummary(def, floorsById[def.id]))
}

// ─── 全案總量計算 ─────────────────────────────────────────

/**
 * calculateProjectSummary
 * 加總所有樓層計算全案容積總量與法規檢核狀態。
 */
export function calculateProjectSummary(
  floorDefs: FloorDefinition[],
  floorsById: FloorsById,
  projectInfo: ProjectInfo
): ProjectSummary {
  const rows = getAllFloorSummaries(floorDefs, floorsById)

  const totalFloorArea      = rows.reduce((s, r) => s + r.floorArea,       0)
  const totalBalconyArea    = rows.reduce((s, r) => s + r.balconyArea,     0)
  const totalGreenArea      = rows.reduce((s, r) => s + r.balconyOver2m,   0)
  const totalArticle162Area = rows.reduce((s, r) => s + r.article162Area,  0)
  const totalFloorVolume    = rows.reduce((s, r) => s + r.floorVolume,     0)

  const legalBaseVolume  = projectInfo.siteArea * projectInfo.legalFloorAreaRatio / 100
  const bonusVolume      = projectInfo.bonusVolume ?? 0
  const maxAllowedVolume = legalBaseVolume + bonusVolume

  const remainingVolume = maxAllowedVolume - totalFloorVolume
  const exceededVolume  = Math.max(0, totalFloorVolume - maxAllowedVolume)
  const usageRate = maxAllowedVolume > 0
    ? Math.min(999, (totalFloorVolume / maxAllowedVolume) * 100)
    : 0
  const actualFAR = projectInfo.siteArea > 0
    ? (totalFloorVolume / projectInfo.siteArea) * 100
    : 0

  const status: ProjectSummary['status'] =
    remainingVolume < 0    ? '超量'    :
    remainingVolume <= 100 ? '接近上限' : '符合'

  return {
    totalFloorArea, totalBalconyArea, totalGreenArea, totalArticle162Area,
    totalFloorVolume, legalBaseVolume, bonusVolume, maxAllowedVolume,
    remainingVolume, exceededVolume, usageRate, actualFAR, status,
  }
}

// ─── 工具 ─────────────────────────────────────────────────

/** 深層複製，確保切斷所有 reference（用於複製樓層） */
export function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj))
}
