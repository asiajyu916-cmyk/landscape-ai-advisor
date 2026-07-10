// ── plantCsvMerge.ts — CSV 合併匯入：比對 / 預覽 / 套用 ───────────────────────
// 預設匯入模式為「合併更新」：先比對現有資料庫，已存在的植物只覆蓋新 CSV 有值
// 的欄位，資料庫裡新 CSV 沒提到的植物一律保留。只有使用者明確選擇「完全取代」
// 並再次確認後，才會清空重建。

import type { CsvPlantRecord } from '@/types/csvPlant'
import type { ImportResult } from '@/types/csvPlant'
import type { ImportMode, MergeRow, MergePreview, MergeApplyResult, FieldDiff } from '@/types/plantMerge'
import { MERGE_DISPLAY_FIELDS } from '@/types/plantMerge'
import { normalizeForCompare, normalizeScientificName, resolveAlias } from './plantNameMatch'

// ── 比對現有資料庫：學名 → 中文名稱 → 別名（依此優先順序）────────────────────
function findMatch(
  incoming: CsvPlantRecord,
  existing: CsvPlantRecord[],
): { plant: CsvPlantRecord; matchType: 'scientific_name' | 'chinese_name' | 'alias' } | null {
  const incSci = incoming.scientificName ? normalizeScientificName(incoming.scientificName) : ''
  const incName = normalizeForCompare(incoming.name)
  const incAlias = normalizeForCompare(resolveAlias(incoming.name))

  // 1. 學名完全相同（雙方都要有學名，避免兩筆都空字串誤判為相同）
  if (incSci) {
    const bySci = existing.find(p => p.scientificName && normalizeScientificName(p.scientificName) === incSci)
    if (bySci) return { plant: bySci, matchType: 'scientific_name' }
  }
  // 2. 中文名稱完全相同（正規化後）
  const byName = existing.find(p => normalizeForCompare(p.name) === incName)
  if (byName) return { plant: byName, matchType: 'chinese_name' }
  // 3. 常用別名相同（查表雙向）
  const byAlias = existing.find(p =>
    normalizeForCompare(resolveAlias(p.name)) === incAlias ||
    normalizeForCompare(resolveAlias(p.name)) === incName,
  )
  if (byAlias) return { plant: byAlias, matchType: 'alias' }

  return null
}

/** 判斷是否為「疑似重複但無法確認」：中文名稱相似（去空白後幾乎相同）但學名衝突。
 *  例如同名異物：CSV 寫「沿階草」學名 A，資料庫裡「沿階草」學名是 B ——
 *  名稱像，但學名不同，不能自動判定是同一種，需要人工確認。 */
function isAmbiguousConflict(incoming: CsvPlantRecord, existing: CsvPlantRecord): boolean {
  const nameMatches = normalizeForCompare(incoming.name) === normalizeForCompare(existing.name)
  const bothHaveSci = !!incoming.scientificName && !!existing.scientificName
  const sciDiffers = bothHaveSci &&
    normalizeScientificName(incoming.scientificName) !== normalizeScientificName(existing.scientificName)
  return nameMatches && sciDiffers
}

/** 產生「新 CSV 覆蓋現有記錄」時，實際會變動的欄位清單（只列新值非空且與舊值不同的欄位）*/
function computeFieldDiffs(existing: CsvPlantRecord, incoming: CsvPlantRecord): FieldDiff[] {
  const diffs: FieldDiff[] = []
  for (const { key } of MERGE_DISPLAY_FIELDS) {
    const newVal = incoming[key]
    const oldVal = existing[key]
    if (typeof newVal !== 'string' || typeof oldVal !== 'string') continue
    if (!newVal.trim()) continue           // 新 CSV 沒填 → 不覆蓋
    if (newVal.trim() === oldVal.trim()) continue
    diffs.push({ field: key, oldValue: oldVal, newValue: newVal })
  }
  return diffs
}

/** 用新 CSV 的資料合併進現有記錄：只覆蓋新 CSV 有值的欄位，空欄位保留舊值 */
function mergeRecord(existing: CsvPlantRecord, incoming: CsvPlantRecord): CsvPlantRecord {
  const merged: CsvPlantRecord = { ...existing }
  for (const key of Object.keys(incoming) as Array<keyof CsvPlantRecord>) {
    const val = incoming[key]
    if (typeof val === 'string') {
      if (val.trim()) (merged as any)[key] = val
    } else if (Array.isArray(val)) {
      if (val.length > 0) (merged as any)[key] = val
    }
    // 其餘型別（boolean / 物件）維持既有的自動判定值，不由 CSV 覆蓋
  }
  merged.id = existing.id   // 保留原本的 id，避免下游以 id 追蹤的資料（例如已加入的配置）失聯
  return merged
}

/** 建立匯入預覽（不寫入任何資料）*/
export function buildMergePreview(
  importResult: ImportResult,
  existingPlants: CsvPlantRecord[],
  mode: ImportMode,
): MergePreview {
  const rows: MergeRow[] = []
  const usedExistingIds = new Set<string>()

  importResult.plants.forEach((incoming, i) => {
    if (mode === 'replace') {
      rows.push({ rowIndex: i + 2, incoming, action: 'add' })   // replace 模式下全部視為「新建」內容
      return
    }

    const match = findMatch(incoming, existingPlants)
    if (!match) {
      rows.push({ rowIndex: i + 2, incoming, action: 'add' })
      return
    }

    if (isAmbiguousConflict(incoming, match.plant)) {
      rows.push({
        rowIndex: i + 2, incoming, action: 'duplicate',
        matchedExisting: match.plant, matchType: match.matchType,
        errorReason: `名稱相同但學名不同（CSV：${incoming.scientificName || '（無）'}／資料庫：${match.plant.scientificName || '（無）'}），可能是同名異物`,
      })
      return
    }

    // 同一筆現有資料被多筆新 CSV 比對到，只有第一筆視為 update，其餘視為疑似重複避免蓋兩次
    if (usedExistingIds.has(match.plant.id)) {
      rows.push({
        rowIndex: i + 2, incoming, action: 'duplicate',
        matchedExisting: match.plant, matchType: match.matchType,
        errorReason: `此 CSV 中已有另一列比對到同一筆現有資料「${match.plant.name}」，需人工確認是否為重複列`,
      })
      return
    }
    usedExistingIds.add(match.plant.id)

    const fieldDiffs = computeFieldDiffs(match.plant, incoming)
    rows.push({
      rowIndex: i + 2, incoming, action: 'update',
      matchedExisting: match.plant, matchType: match.matchType, fieldDiffs,
    })
  })

  const toAddCount = rows.filter(r => r.action === 'add').length
  const toUpdateCount = rows.filter(r => r.action === 'update').length
  const duplicateCount = rows.filter(r => r.action === 'duplicate').length
  const errorCount = rows.filter(r => r.action === 'error').length

  // 新欄位數：這次 CSV 有值、但這些值分佈在「新增的 4 個欄位」上的植物數（衡量新資料涵蓋範圍）
  const NEW_FIELD_KEYS: Array<keyof CsvPlantRecord> = ['minimumPlantSpacing', 'leafDropStatus', 'toxicity', 'plantSafetyNote']
  const newFieldCount = NEW_FIELD_KEYS.filter(k =>
    importResult.plants.some(p => typeof p[k] === 'string' && (p[k] as string).trim()),
  ).length

  // 衝突欄位數：所有 update 列中，「舊值非空、新值非空、且不同」的欄位種類數（不重複計算同一欄位）
  const conflictFieldKeys = new Set<string>()
  for (const r of rows) {
    if (r.action !== 'update' || !r.fieldDiffs) continue
    for (const d of r.fieldDiffs) {
      if (d.oldValue.trim()) conflictFieldKeys.add(d.field)
    }
  }

  return {
    mode,
    existingCount: existingPlants.length,
    incomingCount: importResult.plants.length,
    toAddCount,
    toUpdateCount,
    duplicateCount,
    errorCount,
    newFieldCount,
    conflictFieldCount: conflictFieldKeys.size,
    willDeleteExisting: mode === 'replace',
    rows,
    missingColumns: importResult.missingColumns,
    skippedRows: importResult.skippedRows,
  }
}

/**
 * 套用合併預覽 → 產生最終植物清單。
 * 疑似重複（duplicate）列預設不寫入，直到使用者在確認畫面逐筆決定
 * （resolvedDuplicateRowIndexes 傳入使用者選擇「視為新增」的列號）。
 */
export function applyMerge(
  preview: MergePreview,
  existingPlants: CsvPlantRecord[],
  resolvedDuplicateRowIndexes: Set<number> = new Set(),
): MergeApplyResult {
  if (preview.mode === 'replace') {
    const finalPlants = preview.rows.map(r => r.incoming)
    return {
      addedCount: finalPlants.length,
      updatedCount: 0,
      keptCount: 0,
      skippedCount: 0,
      failedCount: 0,
      fieldErrors: [],
      finalPlants,
    }
  }

  let addedCount = 0
  let updatedCount = 0
  let skippedCount = 0
  const fieldErrors: string[] = []
  const byId = new Map(existingPlants.map(p => [p.id, p]))
  const touchedIds = new Set<string>()
  const toAppend: CsvPlantRecord[] = []

  for (const row of preview.rows) {
    if (row.action === 'add') {
      toAppend.push(row.incoming)
      addedCount++
      continue
    }
    if (row.action === 'update' && row.matchedExisting) {
      const merged = mergeRecord(row.matchedExisting, row.incoming)
      byId.set(merged.id, merged)
      touchedIds.add(merged.id)
      updatedCount++
      continue
    }
    if (row.action === 'duplicate') {
      if (resolvedDuplicateRowIndexes.has(row.rowIndex)) {
        toAppend.push(row.incoming)
        addedCount++
      } else {
        skippedCount++
      }
      continue
    }
    if (row.action === 'error') {
      skippedCount++
      if (row.errorReason) fieldErrors.push(`第 ${row.rowIndex} 列（${row.incoming.name || '（無名稱）'}）：${row.errorReason}`)
    }
  }

  const keptCount = existingPlants.filter(p => !touchedIds.has(p.id)).length
  const finalPlants = [...byId.values(), ...toAppend]

  return {
    addedCount, updatedCount, keptCount, skippedCount,
    failedCount: 0, fieldErrors, finalPlants,
  }
}
