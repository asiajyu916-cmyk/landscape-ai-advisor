// ── plantCloudService.ts — Supabase 植物雲端資料庫 CRUD ────────────────────────
// 搜尋順序第二層：CSV 本地資料查無時，先查這裡；查到就停止，不呼叫 Claude API / web_search。
// AI 或指定網站查詢成功、使用者按下「確認並新增至植栽資料庫」後，寫入這裡永久保存。

import { supabase, isSupabaseConfigured } from '@/lib/supabase'
import { normalizeForCompare, normalizeScientificName, getAliasGroup } from '@/utils/plantNameMatch'
import type { CsvPlantRecord } from '@/types/csvPlant'
import type { PlantDataSource } from '@/types/plantSearch'

const TABLE = 'plants'

interface CloudPlantRow {
  id: string
  name: string
  normalized_name: string
  scientific_name: string
  aliases: string[]
  data_source: PlantDataSource
  source_url: string
  full_record: CsvPlantRecord
  created_at: string
  is_ai_generated: boolean
  is_verified: boolean
}

/** DB row → 前端使用的 CsvPlantRecord（帶上雲端來源標記） */
function rowToRecord(row: CloudPlantRow): CsvPlantRecord & { cloudDataSource: PlantDataSource; cloudSourceUrl: string } {
  return {
    ...row.full_record,
    id: row.full_record?.id || `cloud-${row.id}`,
    name: row.name,
    scientificName: row.scientific_name,
    cloudDataSource: row.data_source,
    cloudSourceUrl: row.source_url,
  }
}

export interface CloudSearchResult {
  found: boolean
  record?: CsvPlantRecord & { cloudDataSource: PlantDataSource; cloudSourceUrl: string }
  matchType?: 'exact_name' | 'normalized_name' | 'alias' | 'scientific_name'
}

/** 未設定 Supabase 時的降級結果 */
const NOT_CONFIGURED: CloudSearchResult = { found: false }

/**
 * 第二層搜尋：查 Supabase 雲端植物資料庫。
 * 依序嘗試：正規化名稱完全比對 → 別名比對（含查詢名稱的別名組全部寫法）→ 學名比對。
 * 找到就回傳，呼叫端應立即停止後續（指定網站 / AI 網路搜尋）查詢。
 */
export async function searchCloudPlant(
  queryName: string,
  scientificNameHint?: string,
): Promise<CloudSearchResult> {
  if (!supabase || !isSupabaseConfigured) return NOT_CONFIGURED

  const qNorm = normalizeForCompare(queryName)
  if (!qNorm) return NOT_CONFIGURED

  // 1. 正規化名稱完全比對
  {
    const { data, error } = await supabase.from(TABLE).select('*').eq('normalized_name', qNorm).limit(1)
    if (!error && data && data.length > 0) {
      return { found: true, record: rowToRecord(data[0] as CloudPlantRow), matchType: 'normalized_name' }
    }
  }

  // 2. 別名比對：查詢名稱所屬別名組的每個寫法，任一命中即可（雙向）
  {
    const aliasGroup = getAliasGroup(queryName).map(normalizeForCompare).filter(Boolean)
    const { data, error } = await supabase.from(TABLE).select('*').overlaps('aliases', [qNorm, ...aliasGroup])
    if (!error && data && data.length > 0) {
      return { found: true, record: rowToRecord(data[0] as CloudPlantRow), matchType: 'alias' }
    }
  }

  // 3. 學名比對
  if (scientificNameHint) {
    const sciNorm = normalizeScientificName(scientificNameHint)
    if (sciNorm) {
      const { data, error } = await supabase
        .from(TABLE).select('*')
        .ilike('scientific_name', sciNorm)
        .limit(1)
      if (!error && data && data.length > 0) {
        return { found: true, record: rowToRecord(data[0] as CloudPlantRow), matchType: 'scientific_name' }
      }
    }
  }

  return { found: false }
}

export interface DuplicateCheckResult {
  duplicate: boolean
  existingName?: string
}

/**
 * 新增前防重複比對（需求六）：中文名稱 / normalizedName / 學名 / 別名。
 * 若已有相同或高度相似植物，回傳 duplicate: true，呼叫端應顯示提示、禁止重複建立。
 */
export async function checkCloudDuplicate(
  name: string,
  scientificName?: string,
): Promise<DuplicateCheckResult> {
  if (!supabase || !isSupabaseConfigured) return { duplicate: false }
  const res = await searchCloudPlant(name, scientificName)
  if (res.found && res.record) {
    return { duplicate: true, existingName: res.record.name }
  }
  return { duplicate: false }
}

export interface InsertCloudPlantResult {
  ok: boolean
  reason?: string
}

/**
 * 使用者按下「確認並新增至植栽資料庫」後呼叫：永久寫入 Supabase。
 * 寫入前一定再次檢查重複（防止同時間多個分頁 / 重複點擊造成重複資料）。
 */
export async function insertCloudPlant(
  record: CsvPlantRecord,
  dataSource: PlantDataSource,
  sourceUrl: string,
): Promise<InsertCloudPlantResult> {
  if (!supabase || !isSupabaseConfigured) {
    return { ok: false, reason: 'Supabase 尚未設定，無法永久儲存，本次新增僅會存在本機瀏覽器。' }
  }

  const dup = await checkCloudDuplicate(record.name, record.scientificName)
  if (dup.duplicate) {
    return { ok: false, reason: `資料庫已有相同或高度相似植物（「${dup.existingName}」），已略過重複新增。` }
  }

  const normalizedName = normalizeForCompare(record.name)
  const aliasGroup = getAliasGroup(record.name).map(normalizeForCompare).filter(Boolean)
  const aliases = Array.from(new Set([normalizedName, ...aliasGroup]))

  const { error } = await supabase.from(TABLE).insert({
    name: record.name,
    normalized_name: normalizedName,
    scientific_name: record.scientificName || '',
    normalized_scientific_name: record.scientificName ? normalizeScientificName(record.scientificName) : '',
    aliases,
    plant_type: record.category || '',
    normalized_category: record.normalizedCategory || '',
    height: record.height || '',
    crown_width: record.crownWidth || '',
    sun_requirement: record.sunRequirement || '',
    water_requirement: record.waterRequirement || '',
    drought_tolerance: record.droughtTolerance || '',
    wet_tolerance: record.wetTolerance || '',
    soil_requirement: record.soilTexture || '',
    maintenance_level: record.maintenanceLevel || '',
    landscape_use: record.remarks || '',
    data_source: dataSource,
    source_url: sourceUrl || record.officialUrl || '',
    full_record: record,
    is_ai_generated: true,
    is_verified: true,
  })

  if (error) {
    return { ok: false, reason: `寫入 Supabase 失敗：${error.message}` }
  }
  return { ok: true }
}

/**
 * 使用者在「新增植栽資料確認視窗」按下確認後呼叫。
 * 若這筆資料本來就是從 Supabase 命中的（dataSource === 'cloud_db'），代表已經存在雲端，
 * 不需要（也不應該）重複寫入；其餘來源（指定網站 / 一般 AI 網路搜尋）才需要永久寫入。
 */
export async function persistConfirmedPlant(
  record: CsvPlantRecord,
  dataSource: PlantDataSource,
  sourceUrl: string,
): Promise<InsertCloudPlantResult> {
  if (dataSource === 'cloud_db') return { ok: true }
  return insertCloudPlant(record, dataSource, sourceUrl)
}
