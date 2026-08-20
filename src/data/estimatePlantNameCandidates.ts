// ── 工程估價專用：市場價格商品名稱 ↔ 資料庫標準植物名稱 候選對應表 ──────────────
// 刻意跟全域植物別名系統（src/utils/plantNameMatch.ts 的 ALIAS_GROUPS/PLANT_ALIAS_MAP）
// 分開：那套是「已確認同一種植物、可以安全互換」的正式別名，會影響 DXF 辨識/植物資料庫
// 比對等全站流程；這裡只是「價格比對找不到完全同名時，可以嘗試看看的候選商品名稱」，
// 命中後 UI 必須明確標示「候選對應」，不能當成資料庫植物名稱互換使用（見規格八）。
//
// 只用在 estimatePriceStore.ts 的 resolvePlantPrice()：完全同名比對失敗時才會查這張表。

export interface PlantPriceNameCandidate {
  dbName: string          // 資料庫／DXF 標準植物名稱
  candidateName: string   // 市場價格 CSV 裡實際使用的商品名稱
  note: string            // 候選對應說明，供 UI 顯示
}

export const PLANT_PRICE_NAME_CANDIDATES: PlantPriceNameCandidate[] = [
  { dbName: '越橘葉蔓榕', candidateName: '越橘蔓榕', note: '網站商品名為「越橘蔓榕」，對應資料庫「越橘葉蔓榕」，視為同一植物的別名對應。' },
]

/** 回傳某個標準植物名稱可以嘗試的候選商品名稱清單（含說明） */
export function findPriceNameCandidates(dbName: string): PlantPriceNameCandidate[] {
  return PLANT_PRICE_NAME_CANDIDATES.filter(c => c.dbName === dbName)
}

// ── 硬別名（確定同一種植物，不需要人工確認）────────────────────────────────────
// 跟上面的「候選對應」不同：這些已經由使用者明確指示「直接視為相同」，比對時直接
// 正規化成資料庫標準名稱，UI 不顯示候選/確認提示。key 是價格 CSV 或圖面可能出現的
// 名稱寫法，value 是資料庫標準名稱。只做「已知硬別名」的精確比對，不做模糊猜測。
export const PLANT_PRICE_HARD_ALIASES: Record<string, string> = {
  '厚葉石斑木': '石斑木',
  '平戶杜鵑': '杜鵑',
  '光臘樹': '光蠟',
  '沿階草': '沿街草',
}

/** 套用硬別名正規化；查不到就原樣傳回 */
export function normalizeHardAliasPlantName(name: string): string {
  return PLANT_PRICE_HARD_ALIASES[name] ?? name
}
