// ── compatibilityLevels.ts — 程度差距判定共用函式 ──────────────────────────────
// 目的：日照／澆水／排水／養護強度等「1～5 級程度值」條件，過去在各處各自訂了
// 不同的門檻（csvParser.ts 的 sunConflictLevel／drainageConflictLevel／waterScore、
// plantEvaluator.ts 內建的 maintenanceLevel 高低比較……），標準不一致，導致「條件
// 只是不同，不是真的衝突」也被判定為警示或高風險。這裡統一成單一規則：
//
//   差距 0～2 級：通過（綠）——不列入問題、不扣分
//   差距 3 級　　：提醒（藍）——列入提醒事項，僅輕微影響評分，不可顯示為衝突/高風險
//   差距 4 級以上：嚴重（紅）——列入主要問題與高風險項目
//
// 注意：這只適用於「本質上是程度值、差距越大代表條件越極端」的屬性。有毒植物／
// 帶刺植物／喬木與建築距離／根系冠幅空間／法規／安全禁忌等「非程度性」判斷，
// 不透過這裡的 gap 規則，仍須各自的規則判斷（不在本檔案範圍內）。

export type GapSeverity = 'pass' | 'caution' | 'danger'

export const GAP_SEVERITY_LABEL: Record<GapSeverity, string> = {
  pass: '通過',
  caution: '提醒',
  danger: '嚴重',
}

// 色彩統一對照：嚴重＝紅、提醒＝藍、通過＝綠。集中在這裡，UI 元件的顏色 class
// 一律從這裡取，不要各自硬寫 amber/orange，避免同一個 caution 等級在不同頁面
// 顯示不同顏色。
export const GAP_SEVERITY_COLOR: Record<GapSeverity, { text: string; bg: string; border: string; dot: string }> = {
  pass:    { text: 'text-green-700', bg: 'bg-green-50',  border: 'border-green-200',  dot: 'bg-green-500' },
  caution: { text: 'text-blue-700',  bg: 'bg-blue-50',   border: 'border-blue-200',   dot: 'bg-blue-500' },
  danger:  { text: 'text-red-700',   bg: 'bg-red-50',    border: 'border-red-200',    dot: 'bg-red-500' },
}

/** 純數字差距 → 通過／提醒／嚴重，是所有判定的唯一入口，門檻只在這裡定義一次 */
export function gapSeverity(gap: number): GapSeverity {
  const g = Math.abs(gap)
  if (g <= 2) return 'pass'
  if (g === 3) return 'caution'
  return 'danger'
}

/** 一組程度值（已轉換為 1～5 數字，undefined 代表「待查」等不列入比較的值）
 *  → 取最大差距後判定等級；少於 2 個有效值時視為通過（沒有東西可比較）。 */
export function levelsGapSeverity(levels: Array<number | undefined>): { severity: GapSeverity; gap: number } {
  const valid = levels.filter((v): v is number => v !== undefined)
  if (valid.length < 2) return { severity: 'pass', gap: 0 }
  const gap = Math.max(...valid) - Math.min(...valid)
  return { severity: gapSeverity(gap), gap }
}

// ── 各屬性的 1～5 級對照表 ──────────────────────────────────────────────────────
// 數值本身沒有絕對意義，只用來算「差距」；級距由現有欄位的可能值語意排序決定。
// 「待查」一律不參與比較（沒有足夠資訊判斷，比較了也只是雜訊）。

/** 日照需求。注意：目前資料庫的日照欄位只有 4 個類別（全日照／全日照至半日照／
 *  半日照／半日照至遮陰），沒有獨立的「全耐陰」類別，所以日照這條差距軸最大只能
 *  到 3 級（提醒），無法觸發「嚴重」——這是資料模型本身的限制，不是判定邏輯漏做；
 *  若未來資料庫加入更細的耐陰分級，把新類別加進這個表即可。 */
export const SUN_LEVEL: Record<string, number> = {
  '全日照': 5,
  '全日照至半日照': 4,
  '半日照': 3,
  '半日照至遮陰': 2,
}

/** 澆水需求：欄位本身就是 5 級，直接對應 */
export const WATER_LEVEL: Record<string, number> = {
  '低': 1,
  '低至中': 2,
  '中': 3,
  '中至高': 4,
  '高': 5,
}

/** 排水／耐濕：欄位只有 3 個類別，均勻分布到 1～5，讓「不耐積水」與「耐濕」
 *  這兩個真正相反的極端維持有意義的差距（4 級＝嚴重），中間的「稍耐濕」
 *  對兩端都只差 2 級（通過），不會被誤判為衝突。 */
export const WET_LEVEL: Record<string, number> = {
  '不耐積水': 1,
  '稍耐濕': 3,
  '耐濕': 5,
}

/** 養護強度：欄位只有 3 個類別，同樣均勻分布 */
export const MAINTENANCE_LEVEL: Record<string, number> = {
  '低': 1,
  '中': 3,
  '高': 5,
}

export function sunLevelOf(v: string | undefined): number | undefined { return v ? SUN_LEVEL[v] : undefined }
export function waterLevelOf(v: string | undefined): number | undefined { return v ? WATER_LEVEL[v] : undefined }
export function wetLevelOf(v: string | undefined): number | undefined { return v ? WET_LEVEL[v] : undefined }
export function maintenanceLevelOf(v: string | undefined): number | undefined { return v ? MAINTENANCE_LEVEL[v] : undefined }

// ── 喬木排除規則（產品規則：喬木不納入配置評估）───────────────────────────────
// 喬木只保留在圖面辨識／數量統計／位置顯示（既有的 TreeInventoryItem／喬木盤點
// 系統已經是「空間事實盤點，不做兩兩相容性衝突卡」，見 plantProximity.ts 的
// computeZoneTreeInventory）。這裡是唯一的「這是不是喬木、要不要排除」判斷入口
// ——不管是日照/耐旱/耐濕/配置相容性衝突計算、問題群組、AI 修正方案或替代植栽
// 候選，一律先呼叫這個函式過濾，不要各自在 UI 層各寫一次「不要顯示喬木」，
// 底層資料如果還是把喬木算進去，換一個顯示位置遲早又漏出來。
//
// 兩種輸入形狀都支援：
//   - CsvPlantRecord／SelectedCsvPlant（植栽資料庫紀錄）→ 看 normalizedCategory
//   - SpatialPlantInstance（DXF 空間圖層）→ 看 kind
// plantProximity.ts 的 computeZoneProximityPairs 已經用 kind==='tree' 排除喬木
// 配對，維持不動；這個函式主要補上 plantEvaluator.ts 全區 evaluate() 呼叫（供
// AI 修正方案替代植栽用）原本沒有做這層過濾的缺口。
export function isExcludedFromPlantingEvaluation(
  item: { normalizedCategory?: string } | { kind?: string } | undefined | null,
): boolean {
  if (!item) return false
  if ('normalizedCategory' in item && item.normalizedCategory) return item.normalizedCategory === 'tree'
  if ('kind' in item && item.kind) return item.kind === 'tree'
  return false
}
