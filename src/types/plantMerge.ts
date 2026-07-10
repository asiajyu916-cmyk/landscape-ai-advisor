// ── plantMerge.ts — CSV 合併匯入：型別定義 ────────────────────────────────────

import type { CsvPlantRecord } from './csvPlant'

export type ImportMode = 'merge' | 'replace'

export type MergeRowAction =
  | 'add'           // 新植物，直接新增
  | 'update'        // 比對到現有植物，用新資料更新（只覆蓋新 CSV 有值的欄位）
  | 'duplicate'      // 疑似重複但無法確認，列入人工確認，不自動新增
  | 'error'         // 資料本身有問題（例如缺必要欄位），此列被跳過

export interface FieldDiff {
  field: keyof CsvPlantRecord
  oldValue: string
  newValue: string
}

export interface MergeRow {
  rowIndex: number              // CSV 中的原始列號（供人工核對）
  incoming: CsvPlantRecord      // 這次 CSV 解析出的資料
  action: MergeRowAction
  matchedExisting?: CsvPlantRecord   // action === 'update' | 'duplicate' 時，比對到的現有植物
  matchType?: 'scientific_name' | 'chinese_name' | 'alias'
  fieldDiffs?: FieldDiff[]      // action === 'update' 時，實際會被覆蓋的欄位清單
  errorReason?: string          // action === 'error' 時的原因
}

export interface MergePreview {
  mode: ImportMode
  existingCount: number
  incomingCount: number
  toAddCount: number
  toUpdateCount: number
  duplicateCount: number
  errorCount: number
  newFieldCount: number         // 這次 CSV 帶入、資料庫原本沒有正式欄位承接的新欄位數
  conflictFieldCount: number    // 新舊資料同一欄位有不同值的欄位數（跨所有 update 列加總的「有差異」欄位種類數）
  willDeleteExisting: boolean   // mode === 'replace' 時為 true
  rows: MergeRow[]
  missingColumns: string[]
  skippedRows: number
}

export interface MergeApplyResult {
  addedCount: number
  updatedCount: number
  keptCount: number             // 舊資料庫中保留、未被異動的筆數
  skippedCount: number
  failedCount: number
  fieldErrors: string[]
  finalPlants: CsvPlantRecord[]
}

// ── 欄位中文標籤（供預覽/結果畫面顯示差異用）──────────────────────────────────
export const MERGE_DISPLAY_FIELDS: Array<{ key: keyof CsvPlantRecord; label: string }> = [
  { key: 'scientificName', label: '學名' },
  { key: 'category', label: '分類' },
  { key: 'subCategory', label: '細分類' },
  { key: 'sunRequirement', label: '日照需求' },
  { key: 'waterRequirement', label: '水分需求' },
  { key: 'droughtTolerance', label: '耐旱性' },
  { key: 'wetTolerance', label: '耐濕性' },
  { key: 'soilPh', label: '土壤酸鹼性' },
  { key: 'soilPhRange', label: 'pH範圍' },
  { key: 'soilTexture', label: '土壤質地' },
  { key: 'minimumPlantSpacing', label: '最小種植間距' },
  { key: 'leafDropStatus', label: '是否容易落葉' },
  { key: 'toxicity', label: '有無毒性' },
  { key: 'plantSafetyNote', label: '植栽安全備註' },
  { key: 'maintenanceNote', label: '維護管理' },
  { key: 'price', label: '價格資訊' },
]
