import { useState, useRef, useCallback, useMemo, useEffect } from 'react'
import {
  Upload, FileText, AlertTriangle, CheckCircle, HelpCircle,
  ChevronDown, X, ArrowRight, Layers, Trash2, BookOpen, Table2, FileOutput, FileDown,
} from 'lucide-react'
import { parseDxf, detectPlantSchedule, findNearbyTexts } from '@/utils/dxfParser'
import { analyzeMultiLayer, zoneLabel, detectZonesFromText, buildZonePlantList, buildZoneAssignDebug, polygonBBox, pointInPolygon, detectAnalysisScope } from '@/utils/spatialAnalysis'
import type { ZoneAssignDebug } from '@/utils/spatialAnalysis'
import { exportZoneReviewPdf } from '@/utils/exportReviewPdf'
import type { ZoneReviewPdfData } from '@/utils/exportReviewPdf'
import { evaluate } from '@/utils/plantEvaluator'
import type { EvalResult } from '@/utils/plantEvaluator'
import { loadPlantsFromStorage, savePlantsToStorage } from '@/data/plantStore'
import { searchOfficialPlantData, searchResultToDraft } from '@/utils/plantSearchClient'
import { existsExactInLocalDatabase } from '@/utils/plantNameMatch'
import type { PlantSearchResult, DraftPlantRecord } from '@/types/plantSearch'
import PlantAutoAddModal from '@/components/modals/PlantAutoAddModal'
import {
  loadDxfRules, upsertDxfRule, deleteDxfRule, clearAllDxfRules,
  loadSessionRules, upsertSessionRule,
  isNonPlant, readDxfWithEncoding,
} from '@/data/dxfMappingStore'
import type { DxfParseResult, DxfText, MappedItem, MatchStatus, MultiLayerResult, MultiLayerJudgment, PlantSchedule, PlantScheduleEntry, ZoneType, DetectedZone, ZonePlantList } from '@/types/dxf'
import type { CsvPlantRecord, SelectedCsvPlant } from '@/types/csvPlant'
import type { DxfBlockRule } from '@/data/dxfMappingStore'

// ── Plant matching ────────────────────────────────────────────────────────────

// 從 block name 提取 3 位以上數字代號，例如 TREE-994 → "994"
function extractBlockCode(blockName: string): string {
  const m = blockName.match(/(\d{3,})/)
  return m ? m[1] : ''
}

// 從 block name / layer 識別圖塊類型（不代表已知植物）
function detectBlockType(blockName: string, layer: string): string {
  const t = (blockName + ' ' + layer).toLowerCase()
  if (/tree|喬木|乔木/.test(t))    return '喬木圖塊'
  if (/shrub|灌木|灌叢/.test(t))   return '灌木圖塊'
  if (/lawn|草皮|草坪|turf/.test(t)) return '草皮圖塊'
  if (/ground|地被|cover/.test(t)) return '地被圖塊'
  if (/plant|植栽|植物/.test(t))   return '植物圖塊'
  return ''
}

export type PlantSourceType = 'saved_rule' | 'block' | 'attribute' | 'legend' | 'text' | 'unidentified'

interface MatchResult {
  plant: CsvPlantRecord | null
  status: MatchStatus
  confidence: number
  reason: string
  scheduleEntry?: PlantScheduleEntry
  detectedType: string
  possiblePlantCode: string
  evidence: string[]
  sourceType: PlantSourceType
  detectedPlantName: string  // 最終辨識的植物名稱（可能不在 DB 中）
}

// ── 植栽辨識優先順序 ──────────────────────────────────────────────────────────
// 1. 已儲存規則（使用者確認過）
// 2. Block Attribute（ATTRIB 實體，直接連結到 INSERT）
// 3. Block Name（中文 / 代號 / 英文含植物名）
// 4. Legend（植栽索引表）比對代號或名稱
// 5. 附近文字（鄰近標註）
// 6. 未辨識植栽（Layer 不作為植栽名稱）
//
// Layer 僅用於：detectBlockType（喬木/灌木/草皮 類型輔助），永遠不決定植物名稱。
function matchPlant(
  blockName: string,
  layer: string,
  count: number,
  plants: CsvPlantRecord[],
  savedRules: DxfBlockRule[],
  schedule: PlantScheduleEntry[],
  nearbyTexts: string[],
  blockAttribs: import('@/types/dxf').DxfAttrib[],
): MatchResult {
  const bn = blockName.toLowerCase().trim()
  // detectBlockType 僅用 block name，layer 不參與植物名稱判斷
  const detectedType = detectBlockType(blockName, '')
  const possibleCode = extractBlockCode(blockName)
  const ev: string[] = []
  if (detectedType) ev.push(`圖塊類型推測：${detectedType}`)

  const ok = (
    confidence: number,
    plant: CsvPlantRecord | null,
    reason: string,
    sourceType: PlantSourceType,
    detectedPlantName: string,
    sched?: PlantScheduleEntry,
    code = possibleCode,
  ): MatchResult => ({
    plant,
    status: confidence >= 70 ? 'matched' : confidence >= 30 ? 'partial' : 'unmatched',
    confidence, reason, scheduleEntry: sched,
    detectedType, possiblePlantCode: code,
    evidence: [...ev],
    sourceType, detectedPlantName,
  })

  // ── P0. 已儲存規則（使用者手動確認，最高優先）───────────────────────────────
  const rule = savedRules.find(r => r.blockName === blockName)
  if (rule) {
    const plant = plants.find(p => p.name === rule.plantName) ?? null
    ev.push(`已儲存規則：${rule.plantName}`)
    return ok(95, plant, `已儲存規則（${rule.plantName}）`, 'saved_rule', rule.plantName)
  }

  // ── P1. Block Attribute（ATTRIB 實體）────────────────────────────────────────
  // DXF INSERT → ATTRIB → SEQEND；ATTRIB 的 value 是最可靠的植物名稱來源
  for (const attr of blockAttribs) {
    const val = attr.value.trim()
    if (!val || val.length < 2) continue

    // P1a. ATTRIB value 完全等於 DB 中的植物名稱
    const exactDbPlant = plants.find(p => p.name === val)
    if (exactDbPlant) {
      ev.push(`Block屬性 [${attr.tag}]="${val}" → 資料庫植物名稱完全吻合`)
      return ok(92, exactDbPlant, `Block屬性「${val}」（資料庫確認）`, 'attribute', val)
    }

    // P1b. ATTRIB value 對應索引表植物名稱
    const schedByAttrName = schedule.find(s => s.plantName === val)
    if (schedByAttrName) {
      const plant = plants.find(p => p.name === val) ?? null
      ev.push(`Block屬性 [${attr.tag}]="${val}" → 索引表植物名稱吻合`)
      return ok(90, plant, `Block屬性對應索引表「${val}」`, 'attribute', val, schedByAttrName)
    }

    // P1c. ATTRIB value 對應索引表代號
    const schedByAttrCode = schedule.find(s => s.code && s.code === val)
    if (schedByAttrCode) {
      const plant = plants.find(p => p.name === schedByAttrCode.plantName) ?? null
      ev.push(`Block屬性 [${attr.tag}]="${val}" → 索引表代號 ${schedByAttrCode.code}（${schedByAttrCode.plantName}）`)
      return ok(88, plant, `Block屬性代號對應索引表「${schedByAttrCode.plantName}」`, 'attribute', schedByAttrCode.plantName, schedByAttrCode)
    }

    // P1d. ATTRIB value 包含中文且 DB 中有子字串命中
    if (/[一-鿿]{2,}/.test(val)) {
      const subPlant = plants.find(p => p.name.length >= 2 && val.includes(p.name))
      if (subPlant) {
        ev.push(`Block屬性 [${attr.tag}]="${val}" 含植物名稱「${subPlant.name}」`)
        return ok(80, subPlant, `Block屬性包含植物名稱「${subPlant.name}」`, 'attribute', subPlant.name)
      }
      // P1e. ATTRIB value 是中文但 DB 未收錄 → 仍以 ATTRIB 為準，不讓 layer 覆蓋
      ev.push(`Block屬性 [${attr.tag}]="${val}" 含中文，以屬性值為植栽名稱（DB 未收錄，請確認）`)
      return ok(60, null, `Block屬性「${val}」（DB 未收錄，請確認）`, 'attribute', val)
    }
  }

  // ── P2. Block Name 含植物資訊 ─────────────────────────────────────────────
  // P2a. Block name 完全等於 DB 植物名稱
  const exactDbBlock = plants.find(p => /[一-鿿]/.test(p.name) && p.name === blockName.trim())
  if (exactDbBlock) {
    ev.push(`圖塊名稱「${blockName}」完全符合資料庫植物名稱`)
    return ok(88, exactDbBlock, `圖塊名稱即植物名稱「${exactDbBlock.name}」`, 'block', exactDbBlock.name)
  }

  // P2b. Block name 就是索引表代號（完全相等）
  const schedByBlockCode = schedule.find(e => e.code && e.code.toLowerCase() === bn)
  if (schedByBlockCode) {
    ev.push(`圖塊名稱「${blockName}」= 索引表代號 ${schedByBlockCode.code}（${schedByBlockCode.plantName}）`)
    const plant = plants.find(p => p.name === schedByBlockCode.plantName) ?? null
    return ok(88, plant, `圖塊名稱對應索引表代號「${schedByBlockCode.plantName}」`, 'block', schedByBlockCode.plantName, schedByBlockCode, schedByBlockCode.code)
  }

  // P2c. Block name 包含 DB 植物名稱子字串（2字以上中文）
  const subDbBlock = plants.find(p => p.name.length >= 2 && /[一-鿿]{2}/.test(p.name) && blockName.includes(p.name))
  if (subDbBlock) {
    ev.push(`圖塊名稱「${blockName}」包含植物名稱「${subDbBlock.name}」（資料庫確認）`)
    return ok(75, subDbBlock, `圖塊名稱包含植物名稱「${subDbBlock.name}」`, 'block', subDbBlock.name)
  }

  // P2d. Block name 本身含中文（DB 未收錄）→ 直接用作植栽名稱，優先於 Layer
  if (/[一-鿿]{2,}/.test(blockName)) {
    ev.push(`圖塊名稱「${blockName}」含中文，以圖塊名稱為植栽名稱（DB 未收錄，請確認）`)
    return ok(55, null, `圖塊名稱「${blockName}」（DB 未收錄，請確認）`, 'block', blockName)
  }

  // P2e. Block name 含數字代號 → 查索引表
  if (possibleCode) {
    const schedByNum = schedule.find(e => {
      const ec = e.code.trim()
      return ec !== '' && (ec === possibleCode || parseInt(ec, 10) === parseInt(possibleCode, 10))
    })
    if (schedByNum) {
      ev.push(`圖塊名稱含數字代號 ${possibleCode}，索引表有對應記錄（${schedByNum.plantName}）`)
      const plant = plants.find(p => p.name === schedByNum.plantName) ?? null
      const qtyOk = schedByNum.quantity !== undefined &&
        Math.abs(count - schedByNum.quantity) <= Math.max(1, Math.round(count * 0.15))
      if (qtyOk) ev.push(`圖塊數量 ${count} ≈ 索引表數量 ${schedByNum.quantity}`)
      const conf = qtyOk ? 78 : 50
      return ok(conf, plant, `代號 ${possibleCode} 索引表推測「${schedByNum.plantName}」${qtyOk ? '，數量符合' : '，請確認'}`, 'legend', schedByNum.plantName, schedByNum)
    }
    if (schedule.length > 0) ev.push(`代號 ${possibleCode} 未在索引表找到對應`)
  }

  // ── P3. 附近文字 → 索引表代號 ────────────────────────────────────────────────
  for (const text of nearbyTexts) {
    const t = text.trim()
    const e = schedule.find(s => s.code && s.code === t)
    if (e) {
      ev.push(`附近文字「${t}」= 索引表代號 ${e.code}（${e.plantName}）`)
      const plant = plants.find(p => p.name === e.plantName) ?? null
      return ok(85, plant, `附近文字對應索引表代號「${e.plantName}」`, 'text', e.plantName, e, e.code)
    }
  }

  // ── P4. 附近文字 → 索引表植物名稱 ───────────────────────────────────────────
  for (const text of nearbyTexts) {
    const e = schedule.find(s => text.includes(s.plantName) && s.plantName.length >= 2)
    if (e) {
      ev.push(`附近文字「${text}」包含索引表植物名稱「${e.plantName}」`)
      const plant = plants.find(p => p.name === e.plantName) ?? null
      return ok(78, plant, `附近文字對應索引表植物名稱「${e.plantName}」`, 'text', e.plantName, e)
    }
  }

  // ── P5. 附近文字 → 直接命中植栽資料庫 ───────────────────────────────────────
  for (const text of nearbyTexts) {
    const plant = plants.find(p => p.name.length >= 2 && /[一-鿿]/.test(p.name) && text.includes(p.name))
    if (plant) {
      ev.push(`附近文字「${text}」直接命中資料庫植物名稱「${plant.name}」`)
      return ok(72, plant, `附近文字直接對應植物名稱「${plant.name}」`, 'text', plant.name)
    }
  }

  // ── P6. 未辨識植栽 ───────────────────────────────────────────────────────────
  // Layer 含植物名稱 → 僅記錄在 evidence，不作為辨識結果
  const ln = layer.toLowerCase()
  const layerPlant = plants.find(p => p.name.length >= 2 && /[一-鿿]/.test(p.name) && ln.includes(p.name.toLowerCase()))
  if (layerPlant) {
    ev.push(`[Layer參考] 圖層「${layer}」含植物名稱「${layerPlant.name}」，但 Layer 不作為辨識來源`)
  } else if (layer) {
    ev.push(`[Layer參考] ${layer}（不作為植栽辨識依據）`)
  }

  // 有偵測到圖塊類型但無植栽名稱 → partial
  if (detectedType) {
    ev.push('類型已識別但缺乏植栽名稱依據，請人工確認')
    return ok(30, null, `${detectedType}，植栽名稱未辨識，請確認`, 'unidentified', '')
  }

  ev.push('Block / Attribute / Legend / 附近文字 均無法辨識植栽')
  return {
    plant: null, status: 'unmatched', confidence: 0,
    reason: '未辨識植栽',
    detectedType, possiblePlantCode: possibleCode,
    evidence: ev,
    sourceType: 'unidentified', detectedPlantName: '',
  }
}

function calcDrawingRadius(blockGroups: DxfParseResult['blockGroups']): number {
  const allPos = blockGroups.flatMap(g => g.positions)
  if (allPos.length === 0) return 1000
  const xs = allPos.map(p => p.x); const ys = allPos.map(p => p.y)
  const diag = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
  const r = diag * 0.03
  return r < 10 ? 1000 : r
}

function buildMappings(
  blockGroups: DxfParseResult['blockGroups'],
  texts: DxfParseResult['texts'],
  plants: CsvPlantRecord[],
  savedRules: DxfBlockRule[],
  schedule: PlantScheduleEntry[],
  radius: number,
): { active: MappedItem[]; excluded: MappedItem[] } {
  const active: MappedItem[] = []
  const excluded: MappedItem[] = []

  for (const grp of blockGroups) {
    const item: MappedItem = {
      blockName: grp.blockName,
      layer: grp.layer,
      count: grp.count,
      positions: grp.positions,
      matchStatus: 'unmatched',
    }

    if (isNonPlant(grp.blockName, grp.layer)) {
      excluded.push(item)
      continue
    }

    // 彙整每個插入點的附近文字（取第一個位置，足夠用於植栽標籤偵測）
    const nearby = grp.positions.length > 0
      ? findNearbyTexts(grp.positions[0], texts, radius)
      : []

    const result = matchPlant(
      grp.blockName, grp.layer, grp.count,
      plants, savedRules, schedule,
      nearby,
      grp.attributes,   // Block ATTRIB 直接連結，不依賴 nearby text
    )

    // 植物名稱解析：DB名稱 > detectedPlantName（block/attribute/text）> 索引表名稱
    // Layer 名稱永遠不作為 plantName
    const resolvedName =
      result.plant?.name ||
      (result.detectedPlantName || undefined) ||
      result.scheduleEntry?.plantName

    item.matchStatus       = result.status
    item.confidenceScore   = result.confidence
    item.plantName         = resolvedName
    item.plantCategory     = result.plant?.category
    item.plantSubCategory  = result.plant?.subCategory
    item.matchReason       = result.reason
    item.scheduleEntry     = result.scheduleEntry
    item.nearbyTexts       = nearby.slice(0, 5)
    item.detectedType      = result.detectedType
    item.possiblePlantCode = result.possiblePlantCode
    item.evidence          = result.evidence
    item.sourceType        = result.sourceType
    item.attributes        = grp.attributes

    // ── Debug：結構化輸出每株植物辨識結果 ───────────────────────────────────
    const confidenceLabel =
      result.confidence >= 85 ? 'High' :
      result.confidence >= 60 ? 'Medium' :
      result.confidence >= 30 ? 'Low' : 'None'
    const legendEntry = result.scheduleEntry
    console.debug(
      `[DXF植栽辨識]\n` +
      `  Plant      : ${resolvedName ?? '未辨識植栽'}\n` +
      `  Source     : ${result.sourceType}\n` +
      `  BlockName  : ${grp.blockName}\n` +
      `  LayerName  : ${grp.layer}\n` +
      `  Attributes : ${grp.attributes.map(a => `${a.tag}=${a.value}`).join(', ') || '（無）'}\n` +
      `  Legend     : ${legendEntry ? `Matched → ${legendEntry.code} ${legendEntry.plantName}` : 'Not matched'}\n` +
      `  Confidence : ${result.confidence} (${confidenceLabel})\n` +
      `  Evidence   : ${result.evidence.join(' | ')}`
    )

    active.push(item)
  }

  return { active, excluded }
}

// ── Badges ────────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: MatchStatus }) {
  if (status === 'matched') return (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-semibold">
      <CheckCircle size={11} />已確認對應
    </span>
  )
  if (status === 'partial') return (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-amber-50 border border-amber-200 text-amber-700 text-xs font-semibold">
      <AlertTriangle size={11} />系統推測
    </span>
  )
  return (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-red-50 border border-red-200 text-red-700 text-xs font-semibold">
      <HelpCircle size={11} />未對應
    </span>
  )
}

function MultiLayerBadge({ judgment }: { judgment: MultiLayerJudgment }) {
  if (judgment === 'conflict') return (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-red-100 border border-red-300 text-red-700 text-xs font-bold">
      🔴 配置衝突
    </span>
  )
  if (judgment === 'caution') return (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-amber-100 border border-amber-300 text-amber-700 text-xs font-bold">
      🟡 需注意
    </span>
  )
  if (judgment === 'unclear') return (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-stone-100 border border-stone-300 text-stone-600 text-xs font-bold">
      ⬜ 無法精準判斷
    </span>
  )
  return (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-100 border border-emerald-300 text-emerald-700 text-xs font-bold">
      🟢 合理複層配置
    </span>
  )
}

// ── Zone review ───────────────────────────────────────────────────────────────

type ZoneReviewStatus = '可審查' | '植物待確認' | '無法審查'

// ── PatternSignature：從任何圖元（HATCH / LWPOLYLINE / LINE）提取的圖案特徵 ──
interface PatternSignature {
  entityType: 'HATCH' | 'LWPOLYLINE_GROUP' | 'LINE_GROUP' | 'UNKNOWN'
  layer: string
  color: number | null      // ACI color
  bbox: { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number }
  lineCount: number         // 頂點數（HATCH 的近似線段數）
  hatchPattern: string | null
  hatchScale: number | null
  hatchAngle: number | null
  density: number           // lineCount / bbox area（粗略密度）
  geometryHash: string      // pattern+scale+angle+color 的簡易指紋
}

// ── FinalReviewResult：每個分區最終審查結果（UI / PDF / 報告唯一來源）─────────
export interface FinalReviewResult {
  zoneName: string
  matchedPlantName: string | null
  matchedLegendRow: string | null     // 索引表代號
  detectedPatternType: string         // HATCH / LWPOLYLINE_GROUP / etc.
  matchScore: number                  // 0–100
  confidence: 'high' | 'medium' | 'low'
  matchReason: string
  reviewStatus: ZoneReviewStatus
  noMatchReasons?: string[]           // reviewStatus = 無法審查 時才有
}

/** 從 ZonePlantArea 提取 PatternSignature */
function extractPatternSignature(area: import('@/types/dxf').ZonePlantArea): PatternSignature {
  const verts = area.vertices ?? []
  const xs = verts.map(v => v.x); const ys = verts.map(v => v.y)
  const minX = xs.length ? Math.min(...xs) : 0; const maxX = xs.length ? Math.max(...xs) : 0
  const minY = ys.length ? Math.min(...ys) : 0; const maxY = ys.length ? Math.max(...ys) : 0
  const w = maxX - minX; const h = maxY - minY
  const area_ = w * h || 1
  const lineCount = area.vertexCount
  const density = lineCount / area_

  const entityType: PatternSignature['entityType'] =
    area.source === 'HATCH' ? 'HATCH' :
    (area.source === 'LWPOLYLINE' || area.source === 'POLYLINE') ? 'LWPOLYLINE_GROUP' : 'UNKNOWN'

  const gHash = [area.hatchPattern ?? '', area.hatchScale?.toFixed(2) ?? '', (area.hatchAngle ?? 0).toFixed(1), area.hatchColor ?? 0].join('|')

  return {
    entityType, layer: area.layer, color: area.hatchColor ?? null,
    bbox: { minX, minY, maxX, maxY, width: w, height: h },
    lineCount, hatchPattern: area.hatchPattern ?? null,
    hatchScale: area.hatchScale ?? null, hatchAngle: area.hatchAngle ?? null,
    density, geometryHash: gHash,
  }
}

/** 計算兩個 PatternSignature 的相似度分數（0–100）*/
function computeSignatureSimilarity(
  zone: PatternSignature,
  legend: PatternSignature,
): { score: number; reasons: string[] } {
  const reasons: string[] = []
  let score = 0

  // 1. HATCH pattern name（最強特徵，30分）
  if (zone.hatchPattern && legend.hatchPattern) {
    if (zone.hatchPattern.trim() === legend.hatchPattern.trim()) {
      score += 30; reasons.push('pattern 相同(+30)')
    }
  }
  // 2. color（10分）
  if (zone.color !== null && legend.color !== null) {
    if (zone.color === legend.color) { score += 10; reasons.push('color 相同(+10)') }
    else reasons.push(`color 不同(zone=${zone.color} legend=${legend.color})`)
  }
  // 3. scale（15分）
  if (zone.hatchScale !== null && legend.hatchScale !== null) {
    const diff = Math.abs(zone.hatchScale - legend.hatchScale)
    if (diff < 0.05) { score += 15; reasons.push('scale 相同(+15)') }
    else if (diff < 0.2)  { score += 7;  reasons.push(`scale 接近(+7 diff=${diff.toFixed(2)})`) }
    else reasons.push(`scale 差異大(${diff.toFixed(2)})`)
  } else { score += 7; reasons.push('scale 無法比對，給一半分(+7)') }
  // 4. angle（15分）
  if (zone.hatchAngle !== null && legend.hatchAngle !== null) {
    const diff = Math.abs((zone.hatchAngle - legend.hatchAngle + 360) % 360)
    if (diff < 1) { score += 15; reasons.push('angle 相同(+15)') }
    else if (diff < 5)  { score += 7;  reasons.push(`angle 接近(+7 diff=${diff.toFixed(1)}°)`) }
    else reasons.push(`angle 差異大(${diff.toFixed(1)}°)`)
  } else { score += 7; reasons.push('angle 無法比對，給一半分(+7)') }
  // 5. entity type 一致（10分）
  if (zone.entityType === legend.entityType) { score += 10; reasons.push('entityType 相同(+10)') }
  // 6. density 接近（10分）
  if (zone.density > 0 && legend.density > 0) {
    const ratio = Math.min(zone.density, legend.density) / Math.max(zone.density, legend.density)
    if (ratio > 0.5) { score += Math.round(ratio * 10); reasons.push(`density 接近(+${Math.round(ratio * 10)})`) }
  }
  // 7. layer 輔助（5分）
  if (zone.layer && legend.layer && zone.layer === legend.layer) { score += 5; reasons.push('layer 相同(+5)') }

  return { score: Math.min(100, score), reasons }
}

// 分區內每個圖塊的摘要（含未對應植物）
interface ZoneBlockEntry {
  blockName: string
  plantName?: string        // 若已對應植栽資料庫
  detectedType?: string     // 喬木圖塊 / 灌木圖塊 等
  count: number             // 此分區內數量
  matchStatus: 'db-matched' | 'name-only' | 'unmatched'
}

// 地被/鋪面 HATCH 判讀結果（正式 UI 資料來源）
interface HatchPlantItem {
  plantName: string
  legendCode: string | null    // 索引表代號（990 等）
  confidence: number           // matchScore 0~100
  source: string               // 'HATCH 圖例比對' 等
}

interface ZoneReviewResult {
  zoneName: string
  plants: SelectedCsvPlant[]         // 完整 DB 資料（可評分）
  blockEntries: ZoneBlockEntry[]     // 所有圖塊（含未對應）
  unmatchedBlocks: string[]          // 純未對應 blockName 清單（向下相容）
  areaTypes: string[]
  areaLayerNotes: string[]
  status: ZoneReviewStatus
  evalResult?: EvalResult
  finalReviewResults: FinalReviewResult[]  // 最終審查結果（UI/PDF 唯一來源）
  hatchPlants: {
    confirmed: HatchPlantItem[]      // score >= 70
    candidates: HatchPlantItem[]     // score 40~69
    unmatchedCount: number           // score < 40 的 HATCH 數
  }
}

function uid() { return Math.random().toString(36).slice(2) }

// 植物名稱比對：優先完全匹配，fallback 到 trim / 忽略空白的模糊比對
function findInDB(name: string | undefined, db: CsvPlantRecord[]): CsvPlantRecord | undefined {
  if (!name) return undefined
  const n = name.trim()
  return db.find(p => p.name === n)                           // 完全相等
    ?? db.find(p => p.name.trim() === n)                      // trim 後相等
    ?? db.find(p => p.name.replace(/\s/g, '') === n.replace(/\s/g, ''))  // 忽略空白
}

/** Legend / site HATCH lookup key — pattern name if present, else stable geometry fingerprint */
function legendSymbolLookupKey(poly: import('@/types/dxf').DxfPolygon, cx: number, cy: number): string {
  const pattern = poly.hatchPattern?.trim()
  if (pattern) return pattern
  return `${poly.source}@${Math.round(cx * 10) / 10}_${Math.round(cy * 10) / 10}`
}

/** HATCH（含無 pattern）與圖例列內的小型 LWPOLYLINE / POLYLINE 符號 */
function buildLegendSymbolCenters(
  polygons: import('@/types/dxf').DxfPolygon[],
  maxSymbolArea: number,
) {
  return polygons
    .filter(p => {
      if (!p.closed || p.vertices.length < 3) return false
      if (p.source === 'HATCH') return true
      if (p.source === 'LWPOLYLINE' || p.source === 'POLYLINE') {
        const bb = polygonBBox(p.vertices)
        return bb.width > 0 && bb.height > 0 && bb.width * bb.height <= maxSymbolArea
      }
      return false
    })
    .map(p => {
      const n = p.vertices.length
      const cx = p.vertices.reduce((s, v) => s + v.x, 0) / n
      const cy = p.vertices.reduce((s, v) => s + v.y, 0) / n
      return { poly: p, cx, cy, lookupKey: legendSymbolLookupKey(p, cx, cy) }
    })
}

function lookupLegendPlant(
  map: Map<string, string>,
  patternKey: string | undefined,
): string | undefined {
  if (!patternKey) return undefined
  const trimmed = patternKey.trim()
  return map.get(patternKey) ?? (trimmed !== patternKey ? map.get(trimmed) : undefined)
}

function buildZoneReviews(
  zonePlantLists: ZonePlantList[],
  plantDB: CsvPlantRecord[],
  schedule: PlantScheduleEntry[],
  texts: DxfText[] = [],
  drawingRadius = 1000,
  polygons: import('@/types/dxf').DxfPolygon[] = [],
  layerColors: Record<string, number> = {},
): ZoneReviewResult[] {
  // ── effectiveColor：ByLayer(256)/ByBlock(0)/null 時改讀 LAYER 表顏色 ─────
  // 回傳 null = 真正無法取得顏色（colorUnknown）
  const effectiveColor = (rawColor: number | null | undefined, layerName: string | undefined): number | null => {
    if (rawColor !== null && rawColor !== undefined && rawColor !== 0 && rawColor !== 256) return rawColor
    const lc = layerName ? layerColors[layerName.trim()] : undefined
    return lc !== undefined ? lc : null
  }
  // ── 建立 HATCH pattern → 植物名稱 對照表 ──────────────────────────────────
  //
  // 策略：從「植物名稱文字位置」出發找鄰近的 HATCH（圖例格子），取得 pattern name。
  // 這比「最小 HATCH 找附近文字」更可靠，因為圖例格子不一定是最小面積。
  //
  // 流程：
  //   A. 對每個索引表 / 植栽資料庫的植物名稱，找圖面中該名稱文字的座標
  //   B. 從文字位置向外搜尋一定半徑，找最近的 HATCH
  //   C. 取得那個 HATCH 的 pattern name，建立 pattern → 植物名稱 的對照
  //   D. Fallback：舊法（最小 HATCH 向外找文字），捕捉 A–C 遺漏的 pattern
  const hatchPatternToPlant = new Map<string, string>()

  // 計算圖面整體範圍（用文字位置，比只看 block 更準確）
  const drawingExtentRadius = (() => {
    if (texts.length < 2) return drawingRadius * 10
    const xs = texts.map(t => t.x); const ys = texts.map(t => t.y)
    return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
  })()
  // 圖例格子通常緊貼植物名稱文字，搜尋半徑 = 圖面範圍的 3%（最小 200 單位）
  const legendCellRadius = Math.max(200, drawingExtentRadius * 0.03)

  // ── 所有 HATCH polygon 一覽（含 pattern name）──────────────────────────────
  const allHatchPolys = polygons.filter(p => p.source === 'HATCH')
  const hatchPatternSet = [...new Set(allHatchPolys.map(p => p.hatchPattern ?? '(無pattern)'))]
  console.group('[HATCH Debug] 圖面中所有 HATCH polygons')
  console.debug(`總計 ${allHatchPolys.length} 個 HATCH，含 pattern name 的有 ${allHatchPolys.filter(p => p.hatchPattern).length} 個`)
  console.debug('Pattern 清單：', hatchPatternSet)
  for (const p of allHatchPolys) {
    const n = p.vertices.length
    const cx = (p.vertices.reduce((s, v) => s + v.x, 0) / n).toFixed(0)
    const cy = (p.vertices.reduce((s, v) => s + v.y, 0) / n).toFixed(0)
    const xs = p.vertices.map(v => v.x); const ys = p.vertices.map(v => v.y)
    const bboxW = (Math.max(...xs) - Math.min(...xs)).toFixed(0)
    const bboxH = (Math.max(...ys) - Math.min(...ys)).toFixed(0)
    console.debug(`  pattern="${p.hatchPattern ?? '(無)'}" layer="${p.layer}" center=(${cx},${cy}) bbox=${bboxW}×${bboxH} vertices=${n}`)
  }
  console.groupEnd()

  // A–C：文字→鄰近 HATCH（Legend Mapping 建立）
  // 搜索索引表植物名稱 + DB 植物名稱
  const schedPlantNames = schedule.map(e => e.plantName).filter(n => n && n.length >= 2)

  // 圖例符號候選：HATCH（含無 pattern）+ 圖例列內小型 polyline
  const legendSymbolMaxArea = Math.max(legendCellRadius * legendCellRadius * 4, 250_000)
  const legendSymbolCenters = buildLegendSymbolCenters(polygons, legendSymbolMaxArea)

  // 向後相容：僅含具 pattern 的 HATCH（debug / D-fallback 用）
  const hatchCenters = legendSymbolCenters.filter(hc => hc.poly.source === 'HATCH' && hc.poly.hatchPattern)

  // ── 索引表列 Y 中心對照表（用於 row-bbox 搜尋）────────────────────────────
  // 對每個索引表植物名稱，計算其文字的平均 Y 位置（= 列中心 Y）
  const schedRowYMap = new Map<string, number>()  // plantName → avg Y
  const schedRowXMap = new Map<string, number>()  // plantName → avg X（文字右側邊界）
  for (const entry of schedule) {
    if (!entry.plantName || entry.plantName.length < 2) continue
    const ys = texts.filter(t => t.content.includes(entry.plantName)).map(t => t.y)
    const xs = texts.filter(t => t.content.includes(entry.plantName)).map(t => t.x)
    if (ys.length > 0) {
      schedRowYMap.set(entry.plantName, ys.reduce((s, y) => s + y, 0) / ys.length)
      schedRowXMap.set(entry.plantName, xs.reduce((s, x) => s + x, 0) / xs.length)
    }
  }
  // 計算相鄰列 Y 間距 → 決定 rowHalfHeight（不超出本列範圍）
  const sortedRowYs = [...new Set(schedRowYMap.values())].sort((a, b) => a - b)
  const rowSpacings = sortedRowYs.slice(1).map((y, i) => Math.abs(y - sortedRowYs[i])).filter(d => d > 10)
  const rowHalfHeight = rowSpacings.length > 0 ? Math.min(...rowSpacings) * 0.45 : legendCellRadius * 0.5

  // ── Table-based Legend Parser：依「圖例」欄 X 定位 symbol 欄，逐列配對 HATCH ──
  // 步驟：1. 找表頭行，取得 symbol 欄 X  2. 逐列在 (symbolColX±halfW, rowY±halfH) bbox 找 HATCH

  // 1. 偵測表頭行（多個表頭 text 在同一 Y 附近）
  const legendHeaderKws = ['圖例', '符號', '圖式', '植物名稱', '植栽名稱', '名稱', '項次', '代號', '編號', '數量', '單位', '備註']
  const allHeaderTexts = texts.filter(t => legendHeaderKws.some(kw => t.content.includes(kw)))
  // group by Y（±50 容忍），取包含最多表頭的行
  const headerYGroups = new Map<number, Array<typeof texts[0]>>()
  for (const ht of allHeaderTexts) {
    const existing = [...headerYGroups.entries()].find(([y]) => Math.abs(y - ht.y) < 50)
    if (existing) existing[1].push(ht)
    else headerYGroups.set(ht.y, [ht])
  }
  const bestHeaderRow = [...headerYGroups.values()].sort((a, b) => b.length - a.length)[0] ?? []

  // 2. 從表頭行取得 symbol 欄 X 和估算欄寬
  const symHeader = bestHeaderRow.find(t => ['圖例', '符號', '圖式'].some(kw => t.content.includes(kw)))
  let symbolColX   = symHeader?.x ?? NaN
  let symbolColHalfW = legendCellRadius * 2  // 預設值
  if (symHeader) {
    const otherDists = bestHeaderRow
      .filter(t => t !== symHeader)
      .map(t => Math.abs(t.x - symbolColX))
      .filter(d => d > 0)
    if (otherDists.length > 0) symbolColHalfW = Math.min(...otherDists) * 0.55
  }

  // 3. 逐列建立 legendItems + 寫入 hatchPatternToPlant
  interface LegendItem {
    rowNo: string; plantName: string
    quantity: number | undefined; unit: string | undefined
    hatchPattern: string | null
    hatchScale: number | null; hatchAngle: number | null; hatchColor: number | null
    compositeKey: string | null  // pattern@scale@angle，用於精確比對
    symbolBBox: string | null
    candidatesCount: number; confidence: 'high' | 'medium' | 'low'; reason?: string
  }
  const legendItems: LegendItem[] = []

  for (const entry of schedule) {
    if (!entry.plantName || entry.plantName.length < 2) continue
    const rowCenterY = schedRowYMap.get(entry.plantName)
    if (rowCenterY === undefined) {
      legendItems.push({ rowNo: entry.code ?? `row${entry.rowIndex}`, plantName: entry.plantName, quantity: entry.quantity, unit: entry.unit, hatchPattern: null, hatchScale: null, hatchAngle: null, hatchColor: null, compositeKey: null, symbolBBox: null, candidatesCount: 0, confidence: 'low', reason: '找不到植物名稱文字' })
      continue
    }
    const rowTop  = rowCenterY + rowHalfHeight
    const rowBot  = rowCenterY - rowHalfHeight
    const symXMin = isNaN(symbolColX) ? -Infinity : symbolColX - symbolColHalfW
    const symXMax = isNaN(symbolColX) ?  Infinity : symbolColX + symbolColHalfW

    const candidates = legendSymbolCenters.filter(hc =>
      hc.cy >= rowBot && hc.cy <= rowTop && hc.cx >= symXMin && hc.cx <= symXMax
    )
    // Y 最接近列中心者優先
    let bestH: typeof legendSymbolCenters[0] | null = null; let bestD = Infinity
    for (const hc of candidates) {
      const d = Math.abs(hc.cy - rowCenterY)
      if (d < bestD) { bestD = d; bestH = hc }
    }

    const hxs = bestH?.poly.vertices.map(v => v.x) ?? []
    const hys = bestH?.poly.vertices.map(v => v.y) ?? []
    const tableLookupKey = bestH?.lookupKey ?? null
    const bPoly = bestH?.poly
    const bPat  = bPoly?.hatchPattern?.trim() ?? null
    const bSc   = bPoly?.hatchScale
    const bAng  = bPoly?.hatchAngle ?? 0
    // effectiveColor：ByLayer/ByBlock 時 fallback 到 LAYER 表顏色
    const bEffClr = bPoly ? effectiveColor(bPoly.hatchColor, bPoly.layer) : null
    const bClr  = bEffClr ?? 0
    // compositeKey 有兩個版本：含 color（最精確）和不含（fallback）
    const compositeKeyFull = bPat && bSc !== undefined
      ? `${bPat}@${bSc.toFixed(2)}@${bAng.toFixed(1)}@c${bClr}`
      : null
    const compositeKey = bPat && bSc !== undefined
      ? `${bPat}@${bSc.toFixed(2)}@${bAng.toFixed(1)}`
      : null
    legendItems.push({
      rowNo: entry.code ?? `row${entry.rowIndex}`, plantName: entry.plantName,
      quantity: entry.quantity, unit: entry.unit,
      hatchPattern: bPat,
      hatchScale: bSc ?? null,
      // color / angle 不依賴 scale 存在與否 — 只要有找到圖例符號就保存（供 composite 比對）
      // hatchColor 存 effectiveColor（ByLayer 已解析為圖層色；null = colorUnknown）
      hatchAngle: bPoly ? bAng : null,
      hatchColor: bEffClr,
      compositeKey: compositeKeyFull ?? compositeKey,
      symbolBBox: bestH ? `(${Math.min(...hxs).toFixed(0)},${Math.min(...hys).toFixed(0)})~(${Math.max(...hxs).toFixed(0)},${Math.max(...hys).toFixed(0)})` : null,
      candidatesCount: candidates.length,
      confidence: bestH ? (bPat ? 'high' : 'medium') : 'low',
      reason: bestH ? (bPat ? undefined : '圖例符號已匹配（LWPOLYLINE 或無 pattern HATCH）') : '文字已讀到，但圖例符號未匹配',
    })

    // 寫入 hatchPatternToPlant：三個 key（精確→fallback）
    if (compositeKeyFull && !hatchPatternToPlant.has(compositeKeyFull))
      hatchPatternToPlant.set(compositeKeyFull, entry.plantName)
    if (compositeKey && !hatchPatternToPlant.has(compositeKey))
      hatchPatternToPlant.set(compositeKey, entry.plantName)
    if (tableLookupKey && !hatchPatternToPlant.has(tableLookupKey))
      hatchPatternToPlant.set(tableLookupKey, entry.plantName)
    // 索引表代號輔助 key（供無 pattern 的圖例符號對照）
    if (entry.code?.trim() && tableLookupKey) {
      const codeKey = `__code__${entry.code.trim()}`
      if (!hatchPatternToPlant.has(codeKey)) {
        hatchPatternToPlant.set(codeKey, entry.plantName)
      }
    }
    // 僅在成功建立 pattern 對照時才標記 resolved，否則 A–C 半徑 fallback 仍可接手
    if (tableLookupKey && hatchPatternToPlant.get(tableLookupKey) === entry.plantName) {
      hatchPatternToPlant.set('__resolved__' + entry.plantName, '1')
    }
  }

  // ── Debug Table 1: legendItems signatures ────────────────────────────────
  console.group('📋 Debug Table 1: legendItems')
  console.debug(`symbolColX=${isNaN(symbolColX) ? '(未找到圖例欄標頭)' : symbolColX.toFixed(0)}  symbolColHalfW=${symbolColHalfW.toFixed(0)}  rowHalfHeight=${rowHalfHeight.toFixed(0)}`)
  console.table(legendItems.map(item => ({
    plantName:   item.plantName,
    legendCode:  item.rowNo,
    pattern:     item.hatchPattern ?? '(無)',
    scale:       item.hatchScale ?? null,
    angle:       item.hatchAngle ?? null,
    color:       item.hatchColor ?? null,
    compositeKey: item.compositeKey ?? '(無)',
    entityType:  item.hatchPattern ? 'HATCH' : '(LWPOLYLINE/無)',
    bbox:        item.symbolBBox ?? '(無)',
    confidence:  item.confidence,
  })))
  console.groupEnd()

  // 追蹤每個 pattern 的 legend 配對證據（供最終報告使用）
  interface LegendEvidence {
    pattern: string
    nearbyText: string      // 找到的文字內容
    textPos: string         // 文字座標
    matchedPlant: string
    distance: number
    buildKey: string        // 寫入 Map 的原始 key（未 trim / 轉換）
    confidence: 'high' | 'medium' | 'low'
    via: 'A-C-strategy' | 'D-fallback'
  }
  interface LegendMiss {
    pattern: string
    closestText?: string
    closestTextPos?: string
    closestDist?: number
    reason: string
  }
  const legendEvidence = new Map<string, LegendEvidence>()
  const legendMisses   = new Map<string, LegendMiss>()   // 每個 pattern 只記一次

  const allPlantNames = [
    ...schedPlantNames,
    ...plantDB.map(p => p.name).filter(n => n.length >= 2),
  ]

  for (const plantName of allPlantNames) {
    if (hatchPatternToPlant.has('__resolved__' + plantName)) continue
    const nameTexts = texts.filter(t => t.content.includes(plantName) && plantName.length >= 2)
    if (nameTexts.length === 0) continue

    let bestDist = Infinity
    let bestHatch: import('@/types/dxf').DxfPolygon | null = null
    let bestTextContent = ''; let bestTextPos = ''
    let closestDistOfAll = Infinity
    let closestPatOfAll = ''; let closestTextOfAll = ''; let closestTextPosOfAll = ''

    // 處理尚未被 table parser 成功對照 pattern 的植物（含索引表與 DB 名稱）
    for (const nt of nameTexts) {
      for (const { poly, cx, cy, lookupKey } of legendSymbolCenters) {
        const dist = Math.hypot(cx - nt.x, cy - nt.y)
        if (dist < closestDistOfAll) {
          closestDistOfAll = dist
          closestPatOfAll  = lookupKey
          closestTextOfAll = nt.content
          closestTextPosOfAll = `(${nt.x.toFixed(0)},${nt.y.toFixed(0)})`
        }
        if (dist <= legendCellRadius && dist < bestDist) {
          bestDist = dist; bestHatch = poly
          bestTextContent = nt.content; bestTextPos = `(${nt.x.toFixed(0)},${nt.y.toFixed(0)})`
        }
      }
    }

    if (bestHatch) {
      const n = bestHatch.vertices.length
      const cx = bestHatch.vertices.reduce((s, v) => s + v.x, 0) / n
      const cy = bestHatch.vertices.reduce((s, v) => s + v.y, 0) / n
      const buildKey = legendSymbolLookupKey(bestHatch, cx, cy)
      if (!hatchPatternToPlant.has(buildKey)) {
        hatchPatternToPlant.set(buildKey, plantName)
        const conf: LegendEvidence['confidence'] =
          bestDist < legendCellRadius * 0.3 ? 'high' :
          bestDist < legendCellRadius * 0.7 ? 'medium' : 'low'
        legendEvidence.set(buildKey, {
          pattern: buildKey, nearbyText: bestTextContent, textPos: bestTextPos,
          matchedPlant: plantName, distance: bestDist,
          buildKey, confidence: conf, via: 'A-C-strategy',
        })
      }
      if (hatchPatternToPlant.get(buildKey) === plantName) {
        hatchPatternToPlant.set('__resolved__' + plantName, '1')
      }
    } else if (closestPatOfAll && !legendEvidence.has(closestPatOfAll) && !legendMisses.has(closestPatOfAll)) {
      legendMisses.set(closestPatOfAll, {
        pattern: closestPatOfAll,
        closestText: closestTextOfAll, closestTextPos: closestTextPosOfAll,
        closestDist: closestDistOfAll,
        reason: `Plant="${plantName}" 文字距 HATCH 超出半徑（距離${closestDistOfAll.toFixed(0)} > legendCellRadius=${legendCellRadius.toFixed(0)}，差${(closestDistOfAll - legendCellRadius).toFixed(0)}）`,
      })
    }
  }

  // D Fallback：最小面積 HATCH 向外找文字（補捉 A–C 未覆蓋的 pattern）
  if (polygons.length > 0) {
    const smallest = new Map<string, { cx: number; cy: number; area: number }>()
    for (const poly of polygons) {
      if (poly.source !== 'HATCH' || !poly.hatchPattern) continue
      if (hatchPatternToPlant.has(poly.hatchPattern)) continue
      const pat = poly.hatchPattern
      const n = poly.vertices.length
      const cx = poly.vertices.reduce((s, v) => s + v.x, 0) / n
      const cy = poly.vertices.reduce((s, v) => s + v.y, 0) / n
      const xs = poly.vertices.map(v => v.x), ys = poly.vertices.map(v => v.y)
      const bboxArea = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))
      const ex = smallest.get(pat)
      if (!ex || bboxArea < ex.area) smallest.set(pat, { cx, cy, area: bboxArea })
    }
    const fallbackRadius = Math.max(500, drawingExtentRadius * 0.05)
    for (const [pattern, { cx, cy }] of smallest) {
      const nearTexts = findNearbyTexts({ x: cx, y: cy }, texts, fallbackRadius)
      let fbText = ''; let fbPlant = ''
      for (const txt of nearTexts) {
        const fromDB = plantDB.find(p => p.name.length >= 2 && txt.includes(p.name))
        if (fromDB) { hatchPatternToPlant.set(pattern, fromDB.name); fbText = txt; fbPlant = fromDB.name; break }
        const fromSched = schedule.find(e => e.plantName && e.plantName.length >= 2 && txt.includes(e.plantName))
        if (fromSched) { hatchPatternToPlant.set(pattern, fromSched.plantName); fbText = txt; fbPlant = fromSched.plantName; break }
        if (/^[一-鿿]{2,}/.test(txt.trim())) { hatchPatternToPlant.set(pattern, txt.trim()); fbText = txt; fbPlant = txt.trim(); break }
      }
      if (fbPlant) {
        legendEvidence.set(pattern, {
          pattern, nearbyText: fbText, textPos: `center=(${cx.toFixed(0)},${cy.toFixed(0)})`,
          matchedPlant: fbPlant, distance: -1,
          buildKey: pattern, confidence: 'low', via: 'D-fallback',
        })
      }
    }
  }

  // 清理輔助 key（保留 __code__ 供代號對照）
  for (const k of [...hatchPatternToPlant.keys()]) {
    if (k.startsWith('__resolved__')) hatchPatternToPlant.delete(k)
  }

  // ── Legend Parser 最終報告（per-pattern）────────────────────────────────────
  // 列出圖面中每個 HATCH pattern 的配對結果
  const allPatternsInDrawing = [...new Set(
    polygons.filter(p => p.source === 'HATCH' && p.hatchPattern).map(p => p.hatchPattern!)
  )]

  console.group(`══ Legend Parser Report (legendCellRadius=${legendCellRadius.toFixed(0)}) ══`)
  console.debug(`圖面 HATCH pattern 數：${allPatternsInDrawing.length}，已建立 Mapping：${hatchPatternToPlant.size} 筆`)

  for (const pat of allPatternsInDrawing) {
    const ev = legendEvidence.get(pat)
    const miss = legendMisses.get(pat)

    if (ev) {
      // ── 命中 ──────────────────────────────────────────────────────────────
      const distStr = ev.distance >= 0 ? ev.distance.toFixed(0) : 'N/A (D-fallback)'
      const confEmoji = ev.confidence === 'high' ? '🟢' : ev.confidence === 'medium' ? '🟡' : '🔴'
      console.group(`✅  Pattern : ${pat}`)
      console.debug(`    Legend Text  : "${ev.nearbyText}"  @ ${ev.textPos}`)
      console.debug(`    Matched Plant: ${ev.matchedPlant}`)
      console.debug(`    Distance     : ${distStr}`)
      console.debug(`    Build Key    : "${ev.buildKey}"  (原始字串，無 trim/大小寫轉換)`)
      console.debug(`    Confidence   : ${confEmoji} ${ev.confidence}  (via ${ev.via})`)
      console.groupEnd()
    } else if (miss) {
      // ── 未命中（有找到最近 HATCH 但距離超出半徑）───────────────────────────
      const gap = miss.closestDist !== undefined ? (miss.closestDist - legendCellRadius).toFixed(0) : '?'
      console.group(`❌  Pattern : ${pat}`)
      console.debug(`    Legend Text  : "${miss.closestText ?? '(無)'}"  @ ${miss.closestTextPos ?? ''}`)
      console.debug(`    Matched Plant: null`)
      console.debug(`    Distance     : ${miss.closestDist?.toFixed(0) ?? '?'}  (半徑 ${legendCellRadius.toFixed(0)}，超出 +${gap} 單位)`)
      console.debug(`    Build Key    : N/A (未寫入 Map)`)
      console.debug(`    Confidence   : ❌ none`)
      console.debug(`    Reason       : ${miss.reason}`)
      console.groupEnd()
    } else {
      // ── 完全未找到任何候選文字 ────────────────────────────────────────────
      console.group(`⚠️  Pattern : ${pat}`)
      console.debug(`    Legend Text  : (無 — 圖面中找不到任何包含索引表植物名稱的文字)`)
      console.debug(`    Matched Plant: null`)
      console.debug(`    Distance     : N/A`)
      console.debug(`    Build Key    : N/A (未寫入 Map)`)
      console.debug(`    Confidence   : ❌ none`)
      console.debug(`    Reason       : 索引表植物名稱文字與此 pattern 的 HATCH 都相距超過半徑，或索引表為空`)
      console.groupEnd()
    }
  }

  console.group('📋  Lookup Key 一致性確認')
  console.debug('  build key = lookup key 應完全一致（原始字串，無轉換）')
  for (const [k, v] of hatchPatternToPlant) {
    console.debug(`  Map.set("${k}", "${v}")  → Map.get("${k}") = "${hatchPatternToPlant.get(k)}"`)
  }
  console.groupEnd()

  console.groupEnd() // end Legend Parser Report

  // ── Map 狀態快照（return 前）── 確認 map 在進入 zone lookup 前仍有內容 ──────
  console.group('🗺  legendMap 狀態（return zonePlantLists.map 前）')
  console.debug(`legendMap.size = ${hatchPatternToPlant.size}`)
  console.debug(`legendMap.keys() = [${[...hatchPatternToPlant.keys()].join(' | ')}]`)
  for (const [k, v] of hatchPatternToPlant) {
    console.debug(`  "${k}" → "${v}"`)
  }
  if (hatchPatternToPlant.size === 0) {
    console.warn('⚠️  Map 為空！Legend Mapping 未成功或已被清除。')
  }
  console.groupEnd()

  return zonePlantLists.map(zpl => {
    const confirmed: SelectedCsvPlant[] = []
    const blockEntries: ZoneBlockEntry[] = []
    const seenNames = new Set<string>()

    // ── 1. 走遍此區所有圖塊 ────────────────────────────────────────────────
    for (const tb of zpl.treeBlocks) {
      const dbP = findInDB(tb.plantName, plantDB)

      if (dbP && !seenNames.has(dbP.name)) {
        seenNames.add(dbP.name)
        const ps = dbP.wetTolerance === '不耐積水' && dbP.droughtTolerance === '不耐旱' ? '需注意' as const : '可用' as const
        confirmed.push({ ...dbP, instanceId: uid(), status: ps })
        blockEntries.push({ blockName: tb.blockName, plantName: dbP.name, detectedType: tb.detectedType, count: tb.positionsInZone, matchStatus: 'db-matched' })
      } else if (tb.plantName) {
        blockEntries.push({ blockName: tb.blockName, plantName: tb.plantName, detectedType: tb.detectedType, count: tb.positionsInZone, matchStatus: 'name-only' })
      } else {
        blockEntries.push({ blockName: tb.blockName, detectedType: tb.detectedType, count: tb.positionsInZone, matchStatus: 'unmatched' })
      }
    }

    // ── 2. 面狀植栽：掃描 HATCH 附近文字 + 圖層名稱比對植物名稱 ──────────
    // 優先策略：
    //   A. HATCH 附近的 TEXT/MTEXT 標注直接含有植物名稱
    //   B. HATCH 圖層名稱本身含有植物名稱（例如「地被-麥門冬」）
    //   C. 若都找不到 → 記錄到 areaLayerNotes 提示使用者

    const allAreas = [...zpl.shrubAreas, ...zpl.lawnAreas, ...zpl.groundcoverAreas, ...zpl.unknownAreas]
    const areaLayerNotes: string[] = []

    // ── Debug Table 2: zoneHatches（每個分區的 HATCH 特徵清單）────────────────
    {
      const zoneHatchRows = allAreas.map((a, i) => {
        const ck = a.hatchPattern?.trim() && a.hatchScale !== undefined
          ? `${a.hatchPattern.trim()}@${a.hatchScale.toFixed(2)}@${(a.hatchAngle ?? 0).toFixed(1)}@c${a.hatchColor ?? 0}`
          : null
        return {
          zoneName:  zpl.zone.name,
          areaId:    `${a.source[0]}${i + 1}`,
          source:    a.source,
          pattern:   a.hatchPattern ?? '(無)',
          scale:     a.hatchScale ?? null,
          angle:     a.hatchAngle ?? null,
          color:     a.hatchColor ?? null,
          layer:     a.layer || '(無)',
          compositeKey: ck ?? '(無 composite)',
          center:    `(${a.centerX.toFixed(0)},${a.centerY.toFixed(0)})`,
        }
      })
      console.group(`🗺 Debug Table 2: zoneHatches — ${zpl.zone.name}（rawHatchesInZone=${zoneHatchRows.length}，legendHatchItems=${legendItems.filter(li => li.hatchPattern !== null || li.hatchColor !== null).length}）`)
      if (zoneHatchRows.length > 0) console.table(zoneHatchRows)
      else console.log('（此分區無面狀圖元）')
      console.groupEnd()
    }

    // 注：pre-processing HATCH 對應結果表已移除，避免與 Table 3 (matches) 衝突。
    // 最終對應結果請看 Debug Table 3: matches（在 zone 處理完畢後輸出）。

    for (const area of allAreas) {
      const layerName = (area.layer || '').trim()
      let matched = false

      // ── D-1. 喬木圖層的 HATCH = 樹冠裝飾填充，不是地被 → 靜默跳過 ─────────
      // （喬木已由 INSERT 圖塊計數；樹冠 ANSI31 若進圖例比對會錯配成別的植物）
      if (area.source === 'HATCH' && /喬木|TREE|乔木/i.test(layerName)) {
        matched = true
        continue
      }

      // ── D-2（已降級）：圖層名稱比對移至 Section A 之後 ──────────────────
      // 依審查優先序：legend HATCH → HATCH 特徵 → nearby TEXT → layer（僅輔助）
      // 原本 layer 比對在圖例比對之前，導致過度依賴 layer；現移到文字搜尋之後。

      // ── D. HATCH pattern 圖例對照（最優先：pattern name → 索引表植物名稱）──
      // 即使植栽不在 DB，也要標記為 matched，不讓 Layer 名稱覆蓋辨識結果
      if (!matched && area.source === 'HATCH') {
        const _aPat = area.hatchPattern?.trim()
        const _aSc  = area.hatchScale
        const _aAng = area.hatchAngle ?? 0
        const _aClr = area.hatchColor ?? 0
        // 三個 key：完整 composite（pattern+scale+angle+color）→ 無 color（pattern+scale+angle）→ pattern-only
        const drawingCompositeKeyFull = _aPat && _aSc !== undefined
          ? `${_aPat}@${_aSc.toFixed(2)}@${_aAng.toFixed(1)}@c${_aClr}`
          : null
        const drawingCompositeKey = _aPat && _aSc !== undefined
          ? `${_aPat}@${_aSc.toFixed(2)}@${_aAng.toFixed(1)}`
          : null
        const lookupKeys = [
          drawingCompositeKeyFull,      // 1st: pattern+scale+angle+color（完整比對）
          drawingCompositeKey,          // 2nd: pattern+scale+angle（無 color）
          area.hatchPattern,            // 3rd: pattern only（fallback）
          legendSymbolLookupKey(
            {
              layer: area.layer,
              vertices: area.vertices ?? [],
              closed: true,
              zoneType: area.zoneType,
              source: 'HATCH',
              hatchPattern: area.hatchPattern,
            },
            area.centerX,
            area.centerY,
          ),                            // 3rd: geometry fingerprint
        ]
        let legendPlant: string | undefined
        let matchedLookupKey: string | undefined
        for (const key of lookupKeys) {
          if (key === null) continue
          const hit = lookupLegendPlant(hatchPatternToPlant, key ?? undefined)
          if (hit) {
            legendPlant = hit
            matchedLookupKey = (key ?? '').trim() || (key ?? undefined)
            break
          }
        }
        // ── per-polygon lookup log：若無 match，診斷比對失敗原因 ──
        if (!legendPlant) {
          console.group(`❌ [HATCH noMatch] zone="${zpl.zone.name}"  pattern="${area.hatchPattern ?? '(無)'}"`)
          console.log('  drawing HATCH signature:', {
            pattern: area.hatchPattern ?? null,
            scale: area.hatchScale ?? null,
            angle: area.hatchAngle ?? null,
            color: area.hatchColor ?? null,
            layer: area.layer || null,
            compositeKeyFull: drawingCompositeKeyFull,
            compositeKey: drawingCompositeKey,
          })
          // 對每個 legendItem 計算比對分數，明確說明為何 no match
          const diagRows = legendItems.map(li => {
            const patMatch   = li.hatchPattern !== null && li.hatchPattern === area.hatchPattern?.trim()
            const scaleMatch = li.hatchScale !== null && area.hatchScale !== undefined
              ? Math.abs(li.hatchScale - area.hatchScale) < 0.05
              : null  // null = 無法比對
            const angleMatch = li.hatchAngle !== null && area.hatchAngle !== undefined
              ? Math.abs(li.hatchAngle - (area.hatchAngle ?? 0)) < 1
              : null
            const colorMatch = li.hatchColor !== null
              ? li.hatchColor === (area.hatchColor ?? 0)
              : null
            const score = [patMatch, scaleMatch, angleMatch, colorMatch]
              .filter(v => v !== null).reduce((s, v) => s + (v ? 25 : 0), 0)
            const reasons: string[] = []
            if (!patMatch)            reasons.push('pattern 不同: drawing=' + (area.hatchPattern ?? '(無)') + ' legend=' + (li.hatchPattern ?? '(無)'))
            if (scaleMatch === false)  reasons.push(`scale 不同: drawing=${area.hatchScale} legend=${li.hatchScale}`)
            if (angleMatch === false)  reasons.push(`angle 不同: drawing=${area.hatchAngle ?? 0} legend=${li.hatchAngle}`)
            if (colorMatch === false)  reasons.push(`color 不同: drawing=${area.hatchColor ?? 0} legend=${li.hatchColor}`)
            if (li.hatchPattern === null) reasons.push('legend parser 未抓到此植物的 HATCH pattern')
            return { plantName: li.plantName, matchScore: score, noMatchReasons: reasons.join(' | ') || '(無法比對 scale/angle/color)' }
          })
          console.table(diagRows)
          console.log('  hatchPatternToPlant keys:', [...hatchPatternToPlant.keys()].filter(k => !k.startsWith('__')))
          if (legendItems.length === 0) console.warn('  ⚠️ legendItems 為空 — legend parser 未成功建立索引表')

          // ── Composite score matching：不要求 pattern 完全相同 ─────────────
          // 權重：pattern +25 / color +30（最強特徵）/ layer +10 / angle +10 / scale +10
          // score >= 70 → confirmed；40~69 → candidate（需人工確認）；< 40 → unmatched
          {
            let bestScore = 0; let bestPlant: string | null = null; let bestCode: string | null = null
            for (const li of legendItems) {
              // 圖例列完全沒有任何 HATCH 特徵 → 無法比對
              if (li.hatchPattern === null && li.hatchColor === null) continue
              let score = 0
              // pattern name（+25）
              if (li.hatchPattern && area.hatchPattern &&
                  li.hatchPattern === area.hatchPattern.trim()) score += 25
              // color（+30，最強特徵）— 使用 effectiveColor：
              // ByLayer/ByBlock 已透過 LAYER 表解析成實際圖層色，只有真正取不到才算未知
              {
                const liC = li.hatchColor  // 圖例 effectiveColor（建表時已解析）
                const arC = effectiveColor(area.hatchColor, area.layer)
                if (liC !== null && arC !== null) {
                  if (liC === arC) score += 30
                  // 明確不同色 → 0 分（這是區分植物的關鍵特徵）
                } else {
                  score += 15  // 任一側 colorUnknown → 半分
                }
              }
              // angle（+10；未知給半分 +5）
              if (li.hatchAngle !== null && area.hatchAngle !== undefined) {
                if (Math.abs(li.hatchAngle - (area.hatchAngle ?? 0)) < 1) score += 10
              } else score += 5
              // scale（+10；未知給半分 +5）
              if (li.hatchScale !== null && area.hatchScale !== undefined) {
                if (Math.abs(li.hatchScale - area.hatchScale) < 0.05) score += 10
              } else score += 5
              // layer 相近（+10）：分區 HATCH 圖層名含植物名或圖例列代號
              if (layerName && (layerName.includes(li.plantName) ||
                  (li.rowNo && layerName.includes(li.rowNo)))) score += 10
              if (score > bestScore) { bestScore = score; bestPlant = li.plantName; bestCode = li.rowNo }
            }
            const _dbgColor = () => {
              const raw = area.hatchColor ?? null
              const lc = area.layer ? layerColors[area.layer.trim()] ?? null : null
              const eff = effectiveColor(area.hatchColor, area.layer)
              return `rawColor=${raw ?? 'null'} layer="${area.layer ?? ''}" layerColor=${lc ?? 'null'} effectiveColor=${eff ?? 'unknown'}`
            }
            if (bestPlant && bestScore >= 70) {
              legendPlant = bestPlant
              matchedLookupKey = `score:${bestScore}`
              console.log(`✅ [HATCH ScoreMatch] zone="${zpl.zone.name}" pattern="${area.hatchPattern ?? '(無)'}" ${_dbgColor()} → "${bestPlant}"(${bestCode}) score=${bestScore}`)
            } else if (bestPlant && bestScore >= 40) {
              // 候選：進 blockEntries 但標記需人工確認，不進 confirmed
              if (!seenNames.has(bestPlant)) {
                seenNames.add(bestPlant)
                blockEntries.push({
                  blockName: `[HATCH候選] score:${bestScore} ${bestCode ?? ''}`,
                  plantName: bestPlant,
                  detectedType: zoneLabel(area.zoneType),
                  count: 1,
                  matchStatus: 'name-only',
                })
              }
              matched = true
              console.log(`🟡 [HATCH Candidate] zone="${zpl.zone.name}" pattern="${area.hatchPattern ?? '(無)'}" ${_dbgColor()} → "${bestPlant}"(${bestCode}) score=${bestScore}（40~69 需人工確認）`)
            } else {
              console.log(`❌ [HATCH unmatch] zone="${zpl.zone.name}" pattern="${area.hatchPattern ?? '(無)'}" ${_dbgColor()} scale=${area.hatchScale ?? '?'} angle=${area.hatchAngle ?? '?'} bestScore=${bestScore}${bestPlant ? ` (最接近: ${bestPlant})` : ''}`)
            }
          }
          console.groupEnd()
          if (matched) continue
        } else {
          const whichKey = drawingCompositeKeyFull && hatchPatternToPlant.has(drawingCompositeKeyFull) ? 'composite+color'
            : drawingCompositeKey && hatchPatternToPlant.has(drawingCompositeKey) ? 'composite'
            : 'pattern-only'
          console.log(`✅ [HATCH Match] zone="${zpl.zone.name}"  pattern="${area.hatchPattern}"  →  "${legendPlant}"  via=${whichKey}`)
        }
        if (legendPlant) {
          const nameKey = legendPlant
          const alreadySeen = seenNames.has(nameKey)
          console.debug(`  ├─ seenNames.has("${nameKey}") = ${alreadySeen}  (seenNames=[${[...seenNames].join(', ')}])`)
          if (!alreadySeen) {
            seenNames.add(nameKey)
            const dbP = findInDB(legendPlant, plantDB)
            console.debug(`  ├─ findInDB("${legendPlant}") = ${dbP ? `"${dbP.name}" (DB命中)` : 'null (DB未收錄)'}`)
            if (dbP) {
              const ps = dbP.wetTolerance === '不耐積水' && dbP.droughtTolerance === '不耐旱' ? '需注意' as const : '可用' as const
              confirmed.push({ ...dbP, instanceId: uid(), status: ps })
              blockEntries.push({ blockName: `[HATCH圖例] ${matchedLookupKey ?? area.hatchPattern ?? 'symbol'}`, plantName: dbP.name, detectedType: zoneLabel(area.zoneType), count: 1, matchStatus: 'db-matched' })
            } else {
              blockEntries.push({ blockName: `[HATCH圖例] ${matchedLookupKey ?? area.hatchPattern ?? 'symbol'}`, plantName: legendPlant, detectedType: zoneLabel(area.zoneType), count: 1, matchStatus: 'name-only' })
            }
            console.debug(`  └─ ✅ PlantEntity PUSHED`, {
              sourceType: 'HATCH',
              entityName: `[HATCH圖例] ${matchedLookupKey ?? area.hatchPattern ?? 'symbol'}`,
              plantName: dbP?.name ?? legendPlant,
              legendMatchedPlantName: legendPlant,
              hatchPattern: area.hatchPattern,
              matchStatus: dbP ? 'db-matched' : 'name-only',
            })
            console.debug(`     blockEntries.length = ${blockEntries.length}`)
          } else {
            console.debug(`  └─ ⚠️  seenNames 已含 "${nameKey}"，跳過（同區重複）`)
          }
          matched = true
        }
      }
      if (matched) continue

      // ── A. 文字搜尋：HATCH + LWPOLYLINE/POLYLINE 皆可（後者只限 DB/索引表命名，不用 raw 中文）──
      if (area.source === 'HATCH' || area.source === 'LWPOLYLINE' || area.source === 'POLYLINE') {
        // 策略 A1：先收集 polygon 內部的所有文字（最可靠，引線標注也在此）
        // 策略 A2：再從幾何中心向外擴大半徑搜尋（覆蓋外部標注、引線）
        const polyVerts = area.vertices ?? []
        const insideTexts = polyVerts.length >= 3
          ? texts.filter(t => pointInPolygon(t.x, t.y, polyVerts))
          : []
        // 半徑：polygon 對角線的 20%（最小 200 單位），涵蓋外部標注
        const polyBBoxDiag = polyVerts.length >= 3 ? (() => {
          const xs = polyVerts.map(v => v.x); const ys = polyVerts.map(v => v.y)
          return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
        })() : 0
        const nearRadius = Math.max(200, Math.max(polyBBoxDiag * 0.20, drawingRadius * 0.08))
        const nearbyTexts = findNearbyTexts({ x: area.centerX, y: area.centerY }, texts, nearRadius)
        // 合併（優先 inside，再 nearby；以 content 去重）
        const candidateTexts = [
          ...insideTexts.map(t => t.content),
          ...nearbyTexts.filter(c => !insideTexts.some(t => t.content === c)),
        ]

        if (insideTexts.length > 0 || nearbyTexts.length > 0) {
          console.debug(`[面狀文字搜尋] layer="${layerName}" center=(${area.centerX.toFixed(0)},${area.centerY.toFixed(0)}) inside=${insideTexts.length} nearby=${nearbyTexts.length} radius=${nearRadius.toFixed(0)}`)
        }

        for (const txt of candidateTexts) {
          // 直接比對 DB 植物名稱
          const fromDB = plantDB.find(p =>
            p.name.length >= 2 && txt.includes(p.name) && !seenNames.has(p.name)
          )
          if (fromDB) {
            seenNames.add(fromDB.name)
            const ps = fromDB.wetTolerance === '不耐積水' && fromDB.droughtTolerance === '不耐旱' ? '需注意' as const : '可用' as const
            confirmed.push({ ...fromDB, instanceId: uid(), status: ps })
            blockEntries.push({ blockName: `[面狀] ${layerName || area.zoneType}`, plantName: fromDB.name, detectedType: zoneLabel(area.zoneType), count: 1, matchStatus: 'db-matched' })
            matched = true; break
          }
          // 比對索引表植物名稱（不需在 DB 中）
          const fromSched = schedule.find(e =>
            e.plantName && e.plantName.length >= 2 &&
            txt.includes(e.plantName) && !seenNames.has(e.plantName)
          )
          if (fromSched) {
            seenNames.add(fromSched.plantName)
            const dbP = findInDB(fromSched.plantName, plantDB)
            if (dbP) {
              const ps = dbP.wetTolerance === '不耐積水' && dbP.droughtTolerance === '不耐旱' ? '需注意' as const : '可用' as const
              confirmed.push({ ...dbP, instanceId: uid(), status: ps })
              blockEntries.push({ blockName: `[面狀] ${layerName || area.zoneType}`, plantName: dbP.name, detectedType: zoneLabel(area.zoneType), count: 1, matchStatus: 'db-matched' })
            } else {
              blockEntries.push({ blockName: `[面狀] ${layerName || area.zoneType}`, plantName: fromSched.plantName, detectedType: zoneLabel(area.zoneType), count: 1, matchStatus: 'name-only' })
            }
            matched = true; break
          }
          // 比對索引表代號（文字「003」→ 索引表代號 003 → 植物名稱）
          const fromCode = schedule.find(e =>
            e.code && txt.trim() === e.code.trim() && !seenNames.has(e.plantName)
          )
          if (fromCode) {
            seenNames.add(fromCode.plantName)
            const dbP = findInDB(fromCode.plantName, plantDB)
            if (dbP) {
              const ps = dbP.wetTolerance === '不耐積水' && dbP.droughtTolerance === '不耐旱' ? '需注意' as const : '可用' as const
              confirmed.push({ ...dbP, instanceId: uid(), status: ps })
              blockEntries.push({ blockName: `[面狀代號] ${fromCode.code}`, plantName: dbP.name, detectedType: zoneLabel(area.zoneType), count: 1, matchStatus: 'db-matched' })
            } else {
              blockEntries.push({ blockName: `[面狀代號] ${fromCode.code}`, plantName: fromCode.plantName, detectedType: zoneLabel(area.zoneType), count: 1, matchStatus: 'name-only' })
            }
            matched = true; break
          }
          // 純中文文字（2字以上，不在索引表）→ 只允許 HATCH，LWPOLYLINE/POLYLINE 跳過
          if (area.source === 'HATCH' && !matched && /^[一-鿿]{2,}$/.test(txt.trim()) && !seenNames.has(txt.trim())) {
            const chName = txt.trim()
            const dbP = findInDB(chName, plantDB)
            if (dbP) {
              seenNames.add(dbP.name)
              const ps = dbP.wetTolerance === '不耐積水' && dbP.droughtTolerance === '不耐旱' ? '需注意' as const : '可用' as const
              confirmed.push({ ...dbP, instanceId: uid(), status: ps })
              blockEntries.push({ blockName: `[面狀文字] ${chName}`, plantName: dbP.name, detectedType: zoneLabel(area.zoneType), count: 1, matchStatus: 'db-matched' })
              matched = true; break
            }
          }
        }
      } // end Section A (HATCH only)
      if (matched) continue

      // ── B. Layer 輔助比對（第 4 順位：legend → HATCH 特徵 → nearby text 都失敗才用）──
      // layer 只能輔助，不可作為主判斷；比對結果標記 layer-assisted 供 UI 顯示信心
      if (!matched && area.source === 'HATCH' && layerName) {
        const layerPlant =
          schedule.find(e => e.plantName && e.plantName.length >= 2 && layerName.includes(e.plantName))?.plantName
          ?? plantDB.find(p => p.name.length >= 2 && layerName.includes(p.name))?.name
        if (layerPlant) {
          console.log(`🟡 [HATCH LayerAssist] zone="${zpl.zone.name}" layer="${layerName}" → "${layerPlant}"（圖層名輔助，前 3 順位皆未命中）`)
          if (!seenNames.has(layerPlant)) {
            seenNames.add(layerPlant)
            const dbP = findInDB(layerPlant, plantDB)
            if (dbP) {
              const ps = dbP.wetTolerance === '不耐積水' && dbP.droughtTolerance === '不耐旱' ? '需注意' as const : '可用' as const
              confirmed.push({ ...dbP, instanceId: uid(), status: ps })
              blockEntries.push({ blockName: `[HATCH候選] score:50 layer:${layerName}`, plantName: dbP.name, detectedType: zoneLabel(area.zoneType), count: 1, matchStatus: 'db-matched' })
            } else {
              blockEntries.push({ blockName: `[HATCH候選] score:50 layer:${layerName}`, plantName: layerPlant, detectedType: zoneLabel(area.zoneType), count: 1, matchStatus: 'name-only' })
            }
          }
          matched = true
          continue
        }
      }

      // ── E. LWPOLYLINE / POLYLINE 繼承重疊 HATCH 的植物名稱 ───────────────
      // 當面積多邊形是 LWPOLYLINE（CAD 封閉折線）且 Legend Mapping 有值，
      // 嘗試找與此 LWPOLYLINE 幾何重疊的 HATCH → 繼承其植物名稱。
      // 原因：AutoCAD 常見做法是 LWPOLYLINE 框出範圍，HATCH 填充顏色/圖案，
      //        兩個實體共用同一邊界。LWPOLYLINE 本身沒有 hatchPattern，
      //        但透過重疊的 HATCH 可以得到植物名稱。
      if (!matched && area.source !== 'HATCH' && (area.vertices?.length ?? 0) >= 3) {
        const polyVerts = area.vertices!
        let inheritedPlant: string | null = null
        let inheritedPattern: string | null = null

        // 找與此 LWPOLYLINE 幾何重疊且已有 Legend Mapping 的 HATCH
        for (const poly of polygons) {
          if (poly.source !== 'HATCH') continue
          const n = poly.vertices.length
          const hx = poly.vertices.reduce((s, v) => s + v.x, 0) / n
          const hy = poly.vertices.reduce((s, v) => s + v.y, 0) / n
          const mappedPlant = lookupLegendPlant(hatchPatternToPlant, poly.hatchPattern)
            ?? lookupLegendPlant(hatchPatternToPlant, legendSymbolLookupKey(poly, hx, hy))
          if (!mappedPlant) continue
          // 用 point-in-polygon 做重疊檢測
          const hatchCenter = (() => {
            const n = poly.vertices.length
            return { x: poly.vertices.reduce((s, v) => s + v.x, 0) / n, y: poly.vertices.reduce((s, v) => s + v.y, 0) / n }
          })()
          const overlap = pointInPolygon(hatchCenter.x, hatchCenter.y, polyVerts) ||
            poly.vertices.some(v => pointInPolygon(v.x, v.y, polyVerts)) ||
            polyVerts.some(v => pointInPolygon(v.x, v.y, poly.vertices))
          if (overlap) {
            inheritedPlant = mappedPlant
            inheritedPattern = poly.hatchPattern ?? legendSymbolLookupKey(poly, hx, hy)
            break
          }
        }

        if (inheritedPlant && !seenNames.has(inheritedPlant)) {
          seenNames.add(inheritedPlant)
          const dbP = findInDB(inheritedPlant, plantDB)
          if (dbP) {
            const ps = dbP.wetTolerance === '不耐積水' && dbP.droughtTolerance === '不耐旱' ? '需注意' as const : '可用' as const
            confirmed.push({ ...dbP, instanceId: uid(), status: ps })
            blockEntries.push({ blockName: `[HATCH繼承] ${inheritedPattern}`, plantName: dbP.name, detectedType: zoneLabel(area.zoneType), count: 1, matchStatus: 'db-matched' })
          } else {
            blockEntries.push({ blockName: `[HATCH繼承] ${inheritedPattern}`, plantName: inheritedPlant, detectedType: zoneLabel(area.zoneType), count: 1, matchStatus: 'name-only' })
          }
          matched = true
          console.debug(`[Section E] ${area.source} layer="${area.layer}" 繼承重疊 HATCH pattern="${inheritedPattern}" → plantName="${inheritedPlant}"`, {
            legendItems: schedule.map(e => ({ code: e.code, plantName: e.plantName })),
            matchedLegendItem: schedule.find(e => e.plantName === inheritedPlant),
            legendPlantName: inheritedPlant,
            entityLayer: area.layer,
            entityType: area.source,
            finalPlantName: dbP?.name ?? inheritedPlant,
            confidence: 'medium',
          })
        } else if (inheritedPlant && seenNames.has(inheritedPlant)) {
          matched = true  // 已在同區加入，不重複
        } else {
          // 找不到重疊 HATCH，輸出 debug
          console.debug(`[Section E] ${area.source} layer="${area.layer}" center=(${area.centerX.toFixed(0)},${area.centerY.toFixed(0)}) 找不到重疊的已知 HATCH`, {
            legendItems: schedule.map(e => ({ code: e.code, plantName: e.plantName })),
            matchedLegendItem: null,
            legendPlantName: null,
            entityLayer: area.layer,
            entityType: area.source,
            finalPlantName: '未辨識',
            confidence: 'none',
            hatchPatternMap: Object.fromEntries(hatchPatternToPlant),
          })
        }
      }
      if (matched) continue

      // ── F. 索引表 m² 候選植栽（最後手段）────────────────────────────────────
      // 當 HATCH/LWPOLYLINE 無法用 pattern / 文字 / 重疊對應時，
      // 把索引表中單位為 m²、尚未出現在本分區的植栽列為候選，讓使用者確認。
      // 不加到 confirmed（需人工確認），不加到 seenNames（另一區塊可再候選）。
      {
        const existingInZone = new Set(blockEntries.map(b => b.plantName).filter(Boolean) as string[])
        const m2Candidates = schedule.filter(e =>
          e.plantName && e.plantName.length >= 2 &&
          !existingInZone.has(e.plantName) &&
          (e.unit === 'm²' || e.unit === '㎡' || e.unit === 'm2' || e.unit === 'M²')
        )
        if (m2Candidates.length > 0) {
          const cand = m2Candidates[0]  // 取索引表第一個尚未對應的 m² 植栽
          const dbP = findInDB(cand.plantName, plantDB)
          blockEntries.push({
            blockName: `[m²候選] ${area.source} layer=${layerName || '無'}`,
            plantName: dbP?.name ?? cand.plantName,
            detectedType: zoneLabel(area.zoneType),
            count: 1,
            matchStatus: 'name-only',
          })
          matched = true
          console.log(
            `[Section F] zone="${zpl.zone.name}" ${area.source} layer="${layerName}" → m²候選: "${cand.plantName}" (代號:${cand.code ?? '—'})`,
            { reason: 'schedule-m2-candidate', totalM2Candidates: m2Candidates.length, source: area.source }
          )
        }
      }
      if (matched) continue

      // ── C. 無法識別 → 結構化 debug + areaLayerNotes ─────────────────────
      const legendPlantForDebug = area.source === 'HATCH'
        ? hatchPatternToPlant.get(area.hatchPattern ?? '')
        : undefined

      const zoneBoundaryLayer = zpl.zone.boundary?.layer ?? '(無邊界polygon)'
      const hatchLayer        = area.layer || '(無)'
      const hatchPattern      = area.hatchPattern ?? '(無)'
      const sourceType        = area.source   // HATCH | LWPOLYLINE | POLYLINE

      // ── reason 分類（供 debug 快速定位）──────────────────────────────────────
      const reason = area.source === 'HATCH'
        ? (area.hatchPattern
            ? (hatchPatternToPlant.size === 0
                ? 'noLegendMap'            // Map 完全為空
                : 'noMatchedLegend')       // Map 有內容但無此 pattern
            : 'noHatchPattern')            // HATCH 實體本身缺少 pattern name
        : 'lwpolylineNoBoundaryHatch'      // LWPOLYLINE/POLYLINE 找不到重疊 HATCH

      console.log(
        `[面狀未辨識] zone="${zpl.zone.name}"  source=${sourceType}  hatchPattern="${hatchPattern}"`,
        { reason, hatchLayer, center: `(${area.centerX.toFixed(0)},${area.centerY.toFixed(0)})`, legendMapSize: hatchPatternToPlant.size }
      )

      if (area.source === 'HATCH') {
        blockEntries.push({
          blockName: `[未辨識 HATCH] pattern=${hatchPattern}`,
          plantName: undefined,
          detectedType: zoneLabel(area.zoneType),
          count: 1,
          matchStatus: 'unmatched',
        })
        areaLayerNotes.push(
          `未辨識 HATCH | pattern="${hatchPattern}" hatchLayer="${hatchLayer}" zoneLayer="${zoneBoundaryLayer}" | ${zoneLabel(area.zoneType)} 中心(${area.centerX.toFixed(0)},${area.centerY.toFixed(0)})`
        )
      } else {
        // LWPOLYLINE / POLYLINE — 無對應 HATCH，標記為未辨識面狀區域
        blockEntries.push({
          blockName: `[未辨識面狀區域] sourceType=${sourceType} layer=${hatchLayer}`,
          plantName: undefined,
          detectedType: zoneLabel(area.zoneType),
          count: 1,
          matchStatus: 'unmatched',
        })
        areaLayerNotes.push(
          `未辨識面狀區域 | sourceType="${sourceType}" layer="${hatchLayer}" zoneLayer="${zoneBoundaryLayer}" | confidence=low | ${zoneLabel(area.zoneType)} 中心(${area.centerX.toFixed(0)},${area.centerY.toFixed(0)})`
        )
      }
    }

    const areaLabels = [
      ...zpl.shrubAreas.map(() => '灌木區'),
      ...zpl.lawnAreas.map(() => '草皮區'),
      ...zpl.groundcoverAreas.map(() => '地被區'),
      ...zpl.unknownAreas.map(() => '待確認範圍'),
    ]

    // ── 3. 決定審查狀態 ────────────────────────────────────────────────────
    const unmatchedBlocks = blockEntries.filter(b => b.matchStatus === 'unmatched').map(b => b.blockName)
    const hasAnyBlock = blockEntries.length > 0

    let status: ZoneReviewStatus = '無法審查'
    let evalResult: EvalResult | undefined
    if (confirmed.length >= 1) {
      status = '可審查'
      evalResult = evaluate(confirmed, plantDB)
    } else if (hasAnyBlock) {
      status = '植物待確認'
    }

    // ── ZoneReview 資料流：blockEntries 最終內容 ─────────────────────────
    console.group(`═══ ZoneReview 最終結果：${zpl.zone.name} ═══`)
    console.debug(`status = "${status}"   confirmed.length = ${confirmed.length}   blockEntries.length = ${blockEntries.length}`)
    for (const b of blockEntries) {
      const tag = b.matchStatus === 'db-matched' ? '✅ DB' : b.matchStatus === 'name-only' ? '🟡 名稱' : '❌ 未識別'
      const src = b.blockName.startsWith('[HATCH') ? 'HATCH' : b.blockName.startsWith('[面狀') ? 'HATCH/poly' : 'INSERT'
      console.debug(`  ${tag} sourceType=${src}  plantName="${b.plantName ?? '(無)'}"  matchStatus="${b.matchStatus}"  blockName="${b.blockName}"`)
    }
    if (blockEntries.length === 0) console.debug('  (blockEntries 為空)')
    console.debug('→ 上方 HATCH 植栽已在 blockEntries，但 ZonePlantList.treeBlocks 無此資料（不同資料結構）')
    console.groupEnd()

    // ── Debug Table 3: matches（每個分區的對應結果）────────────────────────
    {
      const matchRows = blockEntries.map(b => {
        const src = b.blockName.startsWith('[HATCH圖例]')  ? 'legend hatch'
          : b.blockName.startsWith('[HATCH繼承]')          ? 'LWPOLYLINE→HATCH inherit'
          : b.blockName.startsWith('[面狀代號]')            ? 'nearby text (code)'
          : b.blockName.startsWith('[面狀文字]')            ? 'nearby text (Chinese)'
          : b.blockName.startsWith('[面狀]')                ? 'nearby text (DB/schedule)'
          : b.blockName.startsWith('[m²候選]')              ? 'schedule m² candidate ⚠️'
          : b.blockName.startsWith('[未辨識')               ? 'unmatched ❌'
          : 'INSERT block'
        const score = b.matchStatus === 'db-matched' ? 100 : b.matchStatus === 'name-only' ? 65 : 0
        return {
          zoneName:    zpl.zone.name,
          plantName:   b.plantName ?? '(未對應)',
          matchSource: src,
          matchScore:  score,
          matchStatus: b.matchStatus,
          blockName:   b.blockName,
        }
      })
      console.group(`✅ Debug Table 3: matches — ${zpl.zone.name}（共 ${matchRows.length} 筆）`)
      if (matchRows.length > 0) console.table(matchRows)
      else console.log('（此分區無植栽 blockEntries）')
      console.groupEnd()
    }

    // ── FinalReviewResult 建構 ───────────────────────────────────────────────
    // UI / PDF 的唯一資料來源。從 blockEntries 和 unmatched areas 建立。
    const legendSigs = legendItems
      .filter(li => li.hatchPattern)
      .map(li => {
        const sig: PatternSignature = {
          entityType: 'HATCH', layer: '', color: li.hatchColor,
          bbox: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
          lineCount: 0, hatchPattern: li.hatchPattern, hatchScale: li.hatchScale,
          hatchAngle: li.hatchAngle, density: 0, geometryHash: li.compositeKey ?? li.hatchPattern ?? '',
        }
        return { sig, plantName: li.plantName, legendCode: li.rowNo }
      })

    const zoneResults: FinalReviewResult[] = []

    // 1. 成功配對的 blockEntries → FinalReviewResult
    for (const b of blockEntries) {
      if (!b.plantName || b.matchStatus === 'unmatched') continue
      const src = b.blockName.startsWith('[HATCH圖例]') || b.blockName.includes('ScoreMatch')
        ? 'HATCH'
        : b.blockName.startsWith('[HATCH繼承]') ? 'HATCH(繼承)'
        : b.blockName.startsWith('[m²候選]') ? 'LWPOLYLINE_GROUP'
        : b.blockName.startsWith('[面狀') ? 'NEARBY_TEXT'
        : 'INSERT'
      const matchReason = b.blockName.includes('score:')
        ? `索引表 HATCH 圖例 pattern 相同，score-based 比對成功`
        : b.blockName.startsWith('[HATCH圖例]')
          ? `索引表 HATCH 圖例比對（legend hatch）`
          : b.blockName.startsWith('[HATCH繼承]')
            ? `LWPOLYLINE 重疊的 HATCH 繼承索引表植物名稱`
            : b.blockName.startsWith('[m²候選]')
              ? `索引表 m² 候選植物（LWPOLYLINE 無法直接比對，需人工確認）`
              : b.blockName.startsWith('[面狀')
                ? `附近文字標注比對`
                : `INSERT 圖塊比對`
      const rawScore = b.matchStatus === 'db-matched' ? 95 : 65
      // 若有 score-based match，從 blockName 取得分數
      const scoreMatch = b.blockName.match(/score:(\d+)/)
      const matchScore = scoreMatch ? parseInt(scoreMatch[1]) : rawScore
      const confidence: FinalReviewResult['confidence'] =
        matchScore >= 80 ? 'high' : matchScore >= 60 ? 'medium' : 'low'

      zoneResults.push({
        zoneName: zpl.zone.name,
        matchedPlantName: b.plantName,
        matchedLegendRow: legendItems.find(li => li.plantName === b.plantName)?.rowNo ?? null,
        detectedPatternType: src,
        matchScore,
        confidence,
        matchReason,
        reviewStatus: status,
      })
    }

    // 2. 完全 unmatched 的面狀區域 → FinalReviewResult（失敗理由）
    const unmatchedAreas = allAreas.filter(a => {
      const matched = blockEntries.some(b =>
        b.plantName && (
          b.blockName.includes(a.layer || '') ||
          b.blockName.includes(a.hatchPattern ?? '__never__')
        )
      )
      return !matched && a.source !== 'HATCH'  // HATCH unmatched 已有 blockEntry
    })

    if (blockEntries.filter(b => b.matchStatus === 'unmatched').length > 0 || unmatchedAreas.length > 0) {
      const noMatchReasons: string[] = []
      if (allAreas.length === 0)        noMatchReasons.push('分區內未找到可比對鋪面圖案')
      if (legendItems.length === 0)     noMatchReasons.push('索引表圖例無法解析')
      if (legendSigs.length === 0)      noMatchReasons.push('索引表 HATCH 圖例無 pattern 特徵')
      const hatchCount = allAreas.filter(a => a.source === 'HATCH').length
      if (hatchCount > 0)               noMatchReasons.push(`${hatchCount} 個 HATCH 區域圖案相似度低於門檻`)
      const lwpolyCount = allAreas.filter(a => a.source !== 'HATCH').length
      if (lwpolyCount > 0)              noMatchReasons.push(`${lwpolyCount} 個 LWPOLYLINE 區域無法直接比對（需人工確認）`)

      if (zoneResults.length === 0) {
        zoneResults.push({
          zoneName: zpl.zone.name,
          matchedPlantName: null,
          matchedLegendRow: null,
          detectedPatternType: allAreas.map(a => a.source).join('/') || 'UNKNOWN',
          matchScore: 0,
          confidence: 'low',
          matchReason: '',
          reviewStatus: '無法審查',
          noMatchReasons: noMatchReasons.length > 0 ? noMatchReasons : ['比對邏輯失敗，請查 Console'],
        })
      }
    }

    // ── Debug Table 4: finalReviewResults ──────────────────────────────────
    console.group(`🏁 Debug Table 4: finalReviewResults — ${zpl.zone.name}`)
    console.table(zoneResults.map(r => ({
      zoneName: r.zoneName, matchedPlantName: r.matchedPlantName ?? '(無)',
      detectedPatternType: r.detectedPatternType, matchScore: r.matchScore,
      confidence: r.confidence, reviewStatus: r.reviewStatus,
      matchReason: r.matchReason.slice(0, 60),
      noMatchReasons: r.noMatchReasons?.join(' / ') ?? '',
    })))
    console.groupEnd()

    // ── hatchPlants 組裝：blockEntries 的 HATCH 條目 → confirmed / candidates ──
    const scoreOf = (b: ZoneBlockEntry): number => {
      const m = b.blockName.match(/score:(\d+)/)
      if (m) return parseInt(m[1])
      // exact key match（無 score: 前綴）視為高信心
      return b.matchStatus === 'db-matched' ? 95 : 75
    }
    const legendCodeOf = (name: string): string | null =>
      legendItems.find(li => li.plantName === name)?.rowNo ?? null
    const hatchEntries = blockEntries.filter(b =>
      b.plantName && (b.blockName.startsWith('[HATCH') || b.blockName.startsWith('[面狀')))
    const hatchConfirmed: HatchPlantItem[] = []
    const hatchCandidates: HatchPlantItem[] = []
    for (const b of hatchEntries) {
      const sc = scoreOf(b)
      const item: HatchPlantItem = {
        plantName: b.plantName!,
        legendCode: legendCodeOf(b.plantName!),
        confidence: sc,
        source: b.blockName.startsWith('[HATCH候選]')
          ? 'HATCH 圖例比對（候選），使用 effectiveColor / pattern / layer 綜合判斷'
          : 'HATCH 圖例比對，使用 effectiveColor / pattern / layer 綜合判斷',
      }
      if (b.blockName.startsWith('[HATCH候選]') || sc < 70) hatchCandidates.push(item)
      else hatchConfirmed.push(item)
    }
    const hatchUnmatchedCount = blockEntries.filter(b =>
      !b.plantName && b.blockName.startsWith('[未辨識 HATCH')).length

    console.log(`📊 ${zpl.zone.name} hatchPlants: confirmed=${hatchConfirmed.length} candidates=${hatchCandidates.length} unmatched=${hatchUnmatchedCount}`,
      { confirmed: hatchConfirmed, candidates: hatchCandidates })

    return {
      zoneName: zpl.zone.name,
      plants: confirmed,
      blockEntries,
      unmatchedBlocks,
      areaTypes: [...new Set(areaLabels)],
      areaLayerNotes,
      status,
      evalResult,
      hatchPlants: { confirmed: hatchConfirmed, candidates: hatchCandidates, unmatchedCount: hatchUnmatchedCount },
      finalReviewResults: zoneResults,
    }
  })
}

// ── Confidence badge ──────────────────────────────────────────────────────────

function ConfidenceBadge({ score }: { score?: number }) {
  if (score === undefined) return null
  const cls = score >= 70 ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
    : score >= 40        ? 'bg-amber-50 text-amber-700 border-amber-200'
    :                      'bg-red-50 text-red-700 border-red-200'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-xs font-semibold ${cls}`}>
      {score}分
    </span>
  )
}

// ── Types ─────────────────────────────────────────────────────────────────────

type ViewTab = 'zonereview' | 'zoneplan' | 'blocks' | 'zones' | 'multilayer' | 'texts' | 'unmatched' | 'excluded' | 'rules' | 'schedule'

// Dropdown state: which block is open, optional pre-selected plant
interface DropdownState { blockName: string; key: string }

// ── Main Page ─────────────────────────────────────────────────────────────────

// ── 可匯入項目型別 ────────────────────────────────────────────────────────────

interface ImportableItem {
  plantName: string
  quantity: number
  source: 'block-matched' | 'block-partial' | 'schedule'
  confidence: number
  blockName?: string
  code?: string
  quantityNote?: string  // '數量待確認' 等備注
}

interface UnimportableItem {
  label: string   // 顯示名稱（blockName 或 code）
  reason: string
}

function buildImportList(
  mappings: MappedItem[],
  schedule: PlantScheduleEntry[],
): { importable: ImportableItem[]; unimportable: UnimportableItem[] } {
  const importable: ImportableItem[] = []
  const unimportable: UnimportableItem[] = []
  const seenNames = new Set<string>()

  // 1. 圖塊對應：只有「已確認對應（matched）」才可匯入
  //    「系統推測（partial）」需使用者先在圖塊對應表確認植物
  for (const m of mappings) {
    if (m.matchStatus === 'unmatched') {
      unimportable.push({ label: m.blockName, reason: '未對應，無植物名稱' })
      continue
    }
    if (m.matchStatus === 'partial') {
      const plantHint = m.plantName ? `推測：${m.plantName}` : '植物未知'
      const codeHint  = m.possiblePlantCode ? `代號 ${m.possiblePlantCode}` : ''
      unimportable.push({
        label: m.blockName,
        reason: `系統推測（${[plantHint, codeHint].filter(Boolean).join('，')}）——請在圖塊對應表點擊「本次」確認後可匯入`,
      })
      continue
    }
    if (!m.plantName) {
      unimportable.push({ label: m.blockName, reason: '已對應但植物名稱遺失' })
      continue
    }
    if (seenNames.has(m.plantName)) continue
    seenNames.add(m.plantName)
    importable.push({
      plantName: m.plantName,
      quantity: m.count,
      source: 'block-matched',
      confidence: m.confidenceScore ?? 0,
      blockName: m.blockName,
      code: m.scheduleEntry?.code ?? m.possiblePlantCode,
    })
  }

  // 2. 索引表已比對到資料庫、但尚未在圖塊對應出現的植物
  for (const e of schedule) {
    if (!e.dbMatched) {
      if (e.plantName) {
        unimportable.push({
          label: e.code ? `代號 ${e.code}（${e.plantName}）` : e.plantName,
          reason: '植物名稱未在植栽資料庫中找到',
        })
      }
      continue
    }
    if (seenNames.has(e.plantName)) continue
    seenNames.add(e.plantName)
    importable.push({
      plantName: e.plantName,
      quantity: e.quantity ?? 1,
      source: 'schedule',
      confidence: e.confidence === 'high' ? 90 : 70,
      code: e.code,
      // 優先使用索引表解析時標記的備注，否則自行補充
      quantityNote: e.quantityNote ?? (e.quantity == null ? '數量待確認（預設 1）' : undefined),
    })
  }

  return { importable, unimportable }
}

export default function DxfReviewPage({
  activeTab = 'dxf',
  onTabChange,
  onImport,
}: {
  activeTab?: 'pdf' | 'landscape' | 'dxf'
  onTabChange?: (tab: 'pdf' | 'landscape' | 'dxf') => void
  onImport?: (plantNames: string[]) => void
} = {}) {
  const [parseResult, setParseResult]     = useState<DxfParseResult | null>(null)
  const [mappings, setMappings]           = useState<MappedItem[]>([])
  const [excluded, setExcluded]           = useState<MappedItem[]>([])
  const [allPlants, setAllPlants]         = useState<CsvPlantRecord[]>([])
  const [tab, setTab]                     = useState<ViewTab>('blocks')
  const [dragOver, setDragOver]           = useState(false)
  const [fileName, setFileName]           = useState('')
  const [detectedEnc, setDetectedEnc]     = useState('')
  const [parseError, setParseError]       = useState('')
  const [savedRules, setSavedRules]       = useState<DxfBlockRule[]>(() => loadDxfRules())
  const [dropdown, setDropdown]           = useState<DropdownState | null>(null)
  const [plantSchedule, setPlantSchedule] = useState<PlantSchedule>({ entries: [], detected: false, textCount: 0 })
  const [drawingRadius, setDrawingRadius] = useState(1000)
  const [showImportPreview, setShowImportPreview] = useState(false)
  const [zonePlantLists, setZonePlantLists] = useState<ZonePlantList[]>([])
  const [detectedZones, setDetectedZones] = useState<DetectedZone[]>([])
  const [zoneReviews, setZoneReviews] = useState<ZoneReviewResult[]>([])
  const [pdfHtml, setPdfHtml] = useState<string | null>(null)

  // 每次 zoneReviews 更新就持久化到 localStorage，供 AI配植頁與 PDF 讀取
  const saveZoneReviews = (reviews: ZoneReviewResult[], caller = 'unknown') => {
    console.group(`📥 saveZoneReviews called [${caller}]  zones=${reviews.length}`)
    for (const r of reviews) {
      const hatchEntries = r.blockEntries.filter(b => b.blockName.includes('HATCH'))
      const insertEntries = r.blockEntries.filter(b => !b.blockName.includes('HATCH') && !b.blockName.includes('面狀') && !b.blockName.includes('未辨識'))
      console.debug(`  Zone "${r.zoneName}": total blockEntries=${r.blockEntries.length}`)
      for (const b of r.blockEntries) {
        const tag = b.matchStatus === 'db-matched' ? '✅' : b.matchStatus === 'name-only' ? '🟡' : '❌'
        console.debug(`    ${tag} plantName="${b.plantName ?? '(無)'}"  blockName="${b.blockName}"  matchStatus="${b.matchStatus}"`)
      }
      if (hatchEntries.length === 0) console.debug(`    ⚠️  無 HATCH 植栽 entry`)
    }
    console.groupEnd()
    setZoneReviews(reviews)
    try {
      const full = reviews.map(r => ({
        zoneName:    r.zoneName,
        status:      r.status,
        plantCount:  r.blockEntries.reduce((s, b) => s + b.count, 0),
        score:       r.evalResult?.score,
        compatLevel: r.evalResult?.compatLevel,
        issueCount:  r.evalResult?.issues.filter(i => i.level !== 'ok').length ?? 0,
        dangerCount: r.evalResult?.issues.filter(i => i.level === 'danger').length ?? 0,
        mainIssues:  r.evalResult?.issues.filter(i => i.level !== 'ok').map(i => i.category) ?? [],
        // 完整評估資料（供 AI配植頁顯示分區詳細）
        categories:     r.evalResult?.categories,
        issues:         r.evalResult?.issues.filter(i => i.level !== 'ok'),
        aiSuggestion:   r.evalResult?.aiSuggestion,
        adjustmentPlan: r.evalResult?.adjustmentPlan,
        reviewText:     r.evalResult?.reviewText,
      }))
      // sessionStorage：同一 tab 有效，關閉 tab 或新開 session 自動清除
      sessionStorage.setItem('dxf-zone-review-full', JSON.stringify(full))
      sessionStorage.setItem('dxf-zone-review-summary', JSON.stringify(
        full.map(({ zoneName, status, plantCount, score, compatLevel, issueCount, dangerCount, mainIssues }) =>
          ({ zoneName, status, plantCount, score, compatLevel, issueCount, dangerCount, mainIssues }))
      ))
      // 清除舊版 localStorage（避免殘留舊資料被其他邏輯讀取）
      localStorage.removeItem('dxf-zone-review-full')
      localStorage.removeItem('dxf-zone-review-summary')
    } catch { /* quota exceeded */ }
  }
  const [zoneDebug, setZoneDebug] = useState<ZoneAssignDebug | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const plants = allPlants.length > 0 ? allPlants : (loadPlantsFromStorage() ?? [])

  // ── 缺漏植栽自動補資料：確認新增 → 寫入資料庫 → 自動重新評估 ─────────────────
  // 「重新評估」不需要額外程式碼：下面既有的 useEffect 已經監看 [plants, ...]，
  // plants 一變動就會自動重跑 buildZoneReviews，覆蓋目前所有分區的審查結果。
  const handlePlantAdded = useCallback((record: CsvPlantRecord) => {
    setAllPlants(prev => {
      // 新增前先檢查資料庫是否已有完全同名（或同學名）的植物 —— 避免「這個名字之前
      // 已經被 CSV 合併或其他管道加進資料庫，但畫面當時還沒即時更新」導致重複寫入。
      if (existsExactInLocalDatabase(record.name, prev, record.scientificName)) {
        window.alert(`「${record.name}」資料庫裡已經有相同名稱的植物了，不會重複新增。請至「植栽資料庫」頁面確認既有資料。`)
        return prev
      }
      const next = [...prev, record]
      const saved = savePlantsToStorage(next)
      if (!saved) {
        // 跟 CSV 合併匯入共用同一個儲存函式，同樣可能因瀏覽器儲存空間已滿而寫入失敗。
        // 這裡沒有像 CSV 匯入那樣的結果畫面可以顯示警示，先用 alert 確保使用者不會
        // 誤以為「新增植栽資料確認」按下去就一定成功了。
        window.alert(
          `「${record.name}」新增失敗：瀏覽器儲存空間可能已滿（常見原因：植栽照片累積過多）。\n` +
          '建議先到「補圖管理」清理不必要的大尺寸照片，再重新嘗試新增。',
        )
        return prev   // 存檔失敗就不採用這筆變動，避免畫面顯示已新增但實際沒存到
      }
      return next
    })
  }, [])

  // ── 當 plants 或 zonePlantLists 改變時重算分區審查 ──────────────────────────
  // 解決「DXF 上傳時 DB 尚未載入 → 分數為空」的問題
  useEffect(() => {
    if (zonePlantLists.length === 0 || plants.length === 0) return
    saveZoneReviews(
      buildZoneReviews(zonePlantLists, plants, plantSchedule.entries, parseResult?.texts ?? [], drawingRadius, parseResult?.polygons ?? [], parseResult?.layerColors ?? {}),
      `useEffect [polygons=${parseResult?.polygons?.length ?? 0} texts=${parseResult?.texts?.length ?? 0}]`
    )
  }, [plants, zonePlantLists, plantSchedule.entries])

  const multiLayerResults = useMemo<MultiLayerResult[]>(() => {
    if (!parseResult || mappings.length === 0) return []
    return analyzeMultiLayer(mappings, parseResult.polygons, plants)
  }, [parseResult, mappings, plants])

  // ── File handling ──────────────────────────────────────────────────────────

  const handleFile = useCallback(async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.dxf')) {
      setParseError('請上傳 .dxf 格式的 CAD 檔案')
      return
    }
    setParseError('')
    setFileName(file.name)
    try {
      const { text, encoding } = await readDxfWithEncoding(file)
      setDetectedEnc(encoding)
      const result = parseDxf(text)
      setParseResult(result)
      const loaded = loadPlantsFromStorage() ?? []
      setAllPlants(loaded)
      const permRules = loadDxfRules()
      const sessRules = loadSessionRules(file.name)
      const allRules = [...permRules, ...sessRules.filter(s => !permRules.some(p => p.blockName === s.blockName))]
      setSavedRules(allRules)

      // 偵測植栽索引表 + 與資料庫比對
      const sched = detectPlantSchedule(result.texts)
      sched.entries.forEach(e => { e.dbMatched = loaded.some(p => p.name === e.plantName) })
      setPlantSchedule(sched)

      // 計算附近文字搜尋半徑
      const radius = calcDrawingRadius(result.blockGroups)
      setDrawingRadius(radius)

      const { active, excluded: exc } = buildMappings(
        result.blockGroups, result.texts, loaded, allRules, sched.entries, radius
      )
      setMappings(active)
      setExcluded(exc)

      // 分區空間識別（固定流程：評估範圍 → 排除索引表區 → 分區 polyline → 區內 entity）
      const scope = detectAnalysisScope(result.texts, result.polygons)
      const zones = detectZonesFromText(result.texts, result.polygons, scope)
      setDetectedZones(zones)
      const zpl = buildZonePlantList(zones, active, result.polygons, result.inserts, result.blockExtents, scope)
      setZonePlantLists(zpl)
      saveZoneReviews(buildZoneReviews(zpl, loaded, sched.entries, result.texts, radius, result.polygons, result.layerColors ?? {}), 'handleFile [polygons=' + result.polygons.length + ']')
      setZoneDebug(buildZoneAssignDebug(zones, zpl, active, result.inserts, result.blockExtents))

      // ── Debug：資料流追蹤 ──────────────────────────────────────────────────
      console.group('[DXF Zone Setup]')
      console.debug('Total texts:', result.texts.length)
      console.debug('First 30 texts:', result.texts.slice(0, 30).map(t => ({ content: t.content, x: t.x, y: t.y, layer: t.layer })))
      console.debug('Texts containing 蔓:', result.texts.filter(t => t.content.includes('蔓')))
      console.debug('Total polygons:', result.polygons.length)
      console.debug('Detected zones:', zones.map(z => z.name))
      console.groupEnd()

      // ── ZonePlantList 資料流：每區的 INSERT / HATCH 各有哪些 ────────────────
      console.group('═══ ZonePlantList 資料流（buildZonePlantList 輸出）═══')
      for (const zone of zpl) {
        const zoneName = zone.zone.name
        const insertPlants = zone.treeBlocks.map((tb: import('@/types/dxf').ZoneTreeBlock) => ({
          blockName: tb.blockName,
          plantName: tb.plantName ?? '(未識別)',
          positionsInZone: tb.positionsInZone,
        }))
        const allAreas = [
          ...zone.shrubAreas.map((a: import('@/types/dxf').ZonePlantArea) => ({ srcType: 'HATCH/SHRUB', pattern: a.hatchPattern ?? '(無)', layer: a.layer })),
          ...zone.lawnAreas.map((a: import('@/types/dxf').ZonePlantArea) => ({ srcType: 'HATCH/LAWN', pattern: a.hatchPattern ?? '(無)', layer: a.layer })),
          ...zone.groundcoverAreas.map((a: import('@/types/dxf').ZonePlantArea) => ({ srcType: 'HATCH/GCOVER', pattern: a.hatchPattern ?? '(無)', layer: a.layer })),
          ...zone.unknownAreas.map((a: import('@/types/dxf').ZonePlantArea) => ({ srcType: 'HATCH/UNKNOWN', pattern: a.hatchPattern ?? '(無)', layer: a.layer })),
        ]

        console.group(`Zone: ${zoneName}`)
        for (const p of insertPlants) {
          console.debug(`  push INSERT: "${p.plantName}"  blockName=${p.blockName}  count=${p.positionsInZone}`)
        }
        if (insertPlants.length === 0) console.debug('  INSERT: (無)')
        for (const h of allAreas) {
          console.debug(`  HATCH area  : pattern="${h.pattern}" layer="${h.layer}" srcType=${h.srcType}`)
          console.debug(`    ↳ plantName 在此為 undefined，將在 buildZoneReviews 解析`)
        }
        if (allAreas.length === 0) console.debug('  HATCH area: (無)')
        console.debug(`  ZonePlantList.treeBlocks=${insertPlants.length}  HATCH_areas=${allAreas.length}`)
        console.groupEnd()
      }
      console.groupEnd()

      // 永遠先顯示分區配置診斷，讓使用者確認分區辨識狀態
      setTab('zoneplan')
    } catch {
      setParseError('DXF 解析失敗，請確認檔案格式是否正確')
    }
  }, [])

  // ── Mapping actions ────────────────────────────────────────────────────────

  const rebuildMappings = (rules: DxfBlockRule[], plantList: CsvPlantRecord[]) => {
    if (!parseResult) return
    const { active, excluded: exc } = buildMappings(
      parseResult.blockGroups, parseResult.texts, plantList, rules, plantSchedule.entries, drawingRadius
    )
    setMappings(active)
    setExcluded(exc)
    const zpl2 = buildZonePlantList(detectedZones, active, parseResult.polygons, parseResult.inserts, parseResult.blockExtents, detectAnalysisScope(parseResult.texts, parseResult.polygons))
    setZonePlantLists(zpl2)
    saveZoneReviews(buildZoneReviews(zpl2, plantList, plantSchedule.entries, parseResult.texts, drawingRadius, parseResult.polygons, parseResult.layerColors ?? {}), 'rebuildMappings [polygons=' + parseResult.polygons.length + ']')
    setZoneDebug(buildZoneAssignDebug(detectedZones, zpl2, active, parseResult.inserts, parseResult.blockExtents))
  }

  const applyOnce = (blockName: string, plantName: string) => {
    const plant = plants.find(p => p.name === plantName)
    setMappings(prev => prev.map(m => m.blockName !== blockName ? m : {
      ...m, manualOverride: plantName, matchStatus: 'matched',
      plantName: plant?.name, plantCategory: plant?.category,
      plantSubCategory: plant?.subCategory, matchReason: '本次人工指定',
    }))
    setDropdown(null)
  }

  const applyPermanent = (blockName: string, plantName: string) => {
    const newRules = upsertDxfRule(blockName, plantName)
    setSavedRules(newRules)
    rebuildMappings(newRules, plants)
    setDropdown(null)
  }

  const applyProject = (blockName: string, plantName: string) => {
    if (!fileName) return
    upsertSessionRule(blockName, plantName, fileName)
    const sessRules = loadSessionRules(fileName)
    const permRules = loadDxfRules()
    const merged = [...permRules, ...sessRules.filter(s => !permRules.some(p => p.blockName === s.blockName))]
    setSavedRules(merged)
    rebuildMappings(merged, plants)
    setDropdown(null)
  }

  const removeRule = (blockName: string) => {
    const newRules = deleteDxfRule(blockName)
    setSavedRules(newRules)
    rebuildMappings(newRules, plants)
  }

  const clearAllRules = () => {
    clearAllDxfRules()
    setSavedRules([])
    rebuildMappings([], plants)
  }

  const restoreExcluded = (item: MappedItem) => {
    setExcluded(prev => prev.filter(e => e.blockName !== item.blockName || e.layer !== item.layer))
    const r3 = matchPlant(item.blockName, item.layer, item.count, plants, savedRules, plantSchedule.entries, [], item.attributes ?? [])
    setMappings(prev => [...prev, {
      ...item, matchStatus: r3.status, confidenceScore: r3.confidence,
      plantName: r3.plant?.name || r3.scheduleEntry?.plantName,
      plantCategory: r3.plant?.category, plantSubCategory: r3.plant?.subCategory,
      matchReason: r3.reason, detectedType: r3.detectedType,
      possiblePlantCode: r3.possiblePlantCode, evidence: r3.evidence,
    }])
  }

  // ── Derived data ───────────────────────────────────────────────────────────

  const matched   = mappings.filter(m => m.matchStatus === 'matched')
  const partial   = mappings.filter(m => m.matchStatus === 'partial')
  const unmatched = mappings.filter(m => m.matchStatus === 'unmatched')

  // ── Upload screen ──────────────────────────────────────────────────────────

  if (!parseResult) {
    return (
      <div className="min-h-screen flex flex-col" style={{ background: 'radial-gradient(circle at 85% 15%, rgba(121,190,140,0.16) 0%, transparent 30%), radial-gradient(circle at 20% 85%, rgba(183,220,190,0.18) 0%, transparent 35%), linear-gradient(135deg, #f7faf5 0%, #eef6ef 48%, #e5f1e8 100%)' }}>
        <main className="flex-1 flex flex-col items-center justify-center px-8 py-8">
          {/* Step guide */}
          <div className="flex items-center gap-3 mb-10 text-sm text-stone-500 flex-wrap justify-center">
            {['① 上傳 .dxf 檔案', '② 系統解析圖塊', '③ 對應植栽資料庫', '④ 確認並匯入審查'].map((s, i) => (
              <div key={i} className="flex items-center gap-3">
                {i > 0 && <ArrowRight size={14} className="text-stone-300 flex-shrink-0" />}
                <span className={i === 0 ? 'font-semibold text-green-700' : ''}>{s}</span>
              </div>
            ))}
          </div>

          <div
            onDragOver={e => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f) }}
            onClick={() => fileRef.current?.click()}
            className={`w-full max-w-2xl border-2 border-dashed rounded-2xl p-16 text-center cursor-pointer transition-all ${
              dragOver ? 'border-green-400 bg-green-50' : 'border-stone-300 hover:border-green-400 hover:bg-stone-50'
            }`}>
            <Upload size={48} className="mx-auto text-stone-300 mb-4" />
            <p className="text-xl font-semibold text-stone-700 mb-2">拖放或點擊上傳 DXF 檔案</p>
            <p className="text-stone-400 text-sm">支援 AutoCAD .dxf 格式・自動偵測 UTF-8 / Big5 / GBK 編碼</p>
            <input ref={fileRef} type="file" accept=".dxf" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = '' }} />
          </div>

          {parseError && (
            <div className="mt-6 flex items-center gap-3 px-5 py-3 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm">
              <AlertTriangle size={16} />{parseError}
            </div>
          )}
          {plants.length === 0 && (
            <div className="mt-6 flex items-center gap-3 px-5 py-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-700 text-sm max-w-2xl">
              <AlertTriangle size={16} className="flex-shrink-0" />
              尚未載入植栽資料庫，對應功能將受限。請先至「AI 配植評估」頁面匯入 CSV 資料庫。
            </div>
          )}
          {savedRules.length > 0 && (
            <div className="mt-6 flex items-center gap-3 px-5 py-3 bg-green-50 border border-green-200 rounded-xl text-green-700 text-sm max-w-2xl">
              <BookOpen size={16} className="flex-shrink-0" />
              已儲存 {savedRules.length} 條圖塊對應規則，上傳 DXF 後將自動套用。
            </div>
          )}
        </main>
      </div>
    )
  }

  // ── Results screen ─────────────────────────────────────────────────────────

  const { stats, texts, polygons } = parseResult

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'radial-gradient(circle at 85% 15%, rgba(121,190,140,0.16) 0%, transparent 30%), radial-gradient(circle at 20% 85%, rgba(183,220,190,0.18) 0%, transparent 35%), linear-gradient(135deg, #f7faf5 0%, #eef6ef 48%, #e5f1e8 100%)' }}>

      {/* ── 工具列（原 Header 內容，移至內容區） ── */}
      <div className="border-b border-stone-200 bg-white/80 backdrop-blur-sm">
        <div className="max-w-[1536px] mx-auto px-4 md:px-8 py-2 flex items-center justify-between gap-2 md:gap-4 flex-wrap">
          <p className="text-xs text-stone-500 truncate">
            {fileName}
            {detectedEnc && <span className="ml-2 px-1.5 py-0.5 rounded bg-stone-100 text-stone-500 text-xs">編碼：{detectedEnc}</span>}
            <span className="ml-2 text-stone-400">・圖塊 {stats.uniqueBlocks} 種・共 {stats.totalInserts} 個・已排除 {excluded.length} 個非植栽圖層</span>
          </p>
          <div className="flex items-center gap-2 flex-shrink-0">
            {zoneReviews.length > 0 && (
              <button
                onClick={() => {
                  const pdfData: ZoneReviewPdfData[] = zoneReviews.map(r => ({
                    zoneName: r.zoneName,
                    status: r.status,
                    blockEntries: r.blockEntries,
                    plants: r.plants,
                    evalResult: r.evalResult,
                  }))
                  const html = exportZoneReviewPdf(pdfData, fileName, { returnHtml: true })
                  if (typeof html === 'string') setPdfHtml(html)
                }}
                className="flex items-center gap-2 px-3.5 py-1.5 rounded-lg bg-[#1a4731] text-white text-xs font-bold hover:bg-[#2d6a4f] transition-colors whitespace-nowrap">
                <FileOutput size={13} />匯出分區審查 PDF
              </button>
            )}
            <button onClick={() => { setParseResult(null); setFileName(''); setMappings([]); sessionStorage.removeItem('dxf-zone-review-full'); sessionStorage.removeItem('dxf-zone-review-summary') }}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-stone-300 text-xs text-stone-600 hover:bg-stone-100 transition-colors whitespace-nowrap">
              <X size={12} />重新上傳
            </button>
          </div>
        </div>
        {/* Stats bar */}
        <div className="flex gap-1.5 md:gap-2 pb-2 px-4 md:px-8 flex-wrap">
          {[
            { label: '✅ 已自動對應', count: matched.length,  cls: 'bg-green-50 text-green-700 border-green-200' },
            { label: '⚠ 部分符合',   count: partial.length,  cls: 'bg-amber-50 text-amber-700 border-amber-200' },
            { label: '❌ 未對應',     count: unmatched.length, cls: 'bg-red-50 text-red-700 border-red-200' },
            { label: '🚫 已排除',     count: excluded.length,  cls: 'bg-stone-50 text-stone-500 border-stone-200' },
            { label: '🗺 範圍多邊形', count: stats.totalPolygons, cls: 'bg-blue-50 text-blue-700 border-blue-200' },
          ].map(s => (
            <div key={s.label} className={`flex items-center gap-2 px-3 py-1 rounded-lg border text-xs font-medium ${s.cls}`}>
              {s.label} <span className="font-bold">{s.count}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Unmatched warning */}
      {unmatched.length > 0 && (
        <div className="bg-red-50 border-b border-red-200 px-4 md:px-8 py-3 flex items-center gap-3">
          <AlertTriangle size={18} className="text-red-500 flex-shrink-0" />
          <p className="text-sm text-red-700 font-medium">
            有 <strong>{unmatched.length}</strong> 個圖塊無法自動對應，請至「未對應項目」分頁確認。
          </p>
          <button onClick={() => setTab('unmatched')}
            className="ml-auto px-4 py-1.5 rounded-lg bg-red-600 text-white text-xs font-semibold hover:bg-red-700">
            前往確認
          </button>
        </div>
      )}

      {/* ── Tab nav ── */}
      <div className="bg-white border-b border-stone-200 px-2 md:px-6 flex gap-0 overflow-x-auto shadow-sm">
        {([
          { id: 'zonereview', label: `分區審查（${zoneReviews.filter(r => r.evalResult).length}/${zoneReviews.length}）`, highlight: zoneReviews.some(r => r.evalResult) },
          { id: 'zoneplan',   label: `分區配置（${detectedZones.length}）`, highlight: detectedZones.length > 0 },
          { id: 'schedule',   label: `索引表（${plantSchedule.entries.length}）`, highlight: plantSchedule.detected },
          { id: 'blocks',     label: `圖塊對應（${mappings.length}）` },
          { id: 'zones',      label: `植栽範圍（${stats.totalPolygons}）`, highlight: stats.totalPolygons > 0 },
          { id: 'multilayer', label: `複層分析（${multiLayerResults.length}）` },
          { id: 'texts',      label: `文字（${texts.length}）` },
          { id: 'unmatched',  label: `未對應（${unmatched.length}）`, urgent: unmatched.length > 0 },
          { id: 'excluded',   label: `已排除（${excluded.length}）` },
          { id: 'rules',      label: `規則庫（${savedRules.length}）` },
        ] as { id: ViewTab; label: string; urgent?: boolean; highlight?: boolean }[]).map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-4 py-3 text-xs font-medium border-b-2 transition-colors whitespace-nowrap ${
              tab === t.id
                ? 'border-[#1a4731] text-[#1a4731] font-semibold'
                : t.urgent
                  ? 'border-transparent text-red-600 hover:text-red-700'
                  : t.highlight
                    ? 'border-transparent text-[#2d6a4f] hover:text-[#1a4731] font-semibold'
                    : 'border-transparent text-stone-500 hover:text-stone-700'
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Content ── */}
      <main className="flex-1 px-4 md:px-8 py-4 md:py-6">

        {/* ── Schedule tab ── */}
        {tab === 'schedule' && (
          <ScheduleTab schedule={plantSchedule} mappings={mappings} plants={plants} onPlantAdded={handlePlantAdded} />
        )}

        {/* ── Zone review tab ── */}
        {tab === 'zonereview' && (
          <ZoneReviewTab reviews={zoneReviews} onAskAI={q => {
            try { sessionStorage.setItem('advisor-prefill', q) } catch { /* ignore */ }
            onTabChange?.('landscape')
          }} />
        )}

        {/* ── Zone plan tab ── */}
        {tab === 'zoneplan' && (
          <ZonePlanTab
            zonePlantLists={zonePlantLists}
            detectedZones={detectedZones}
            texts={parseResult?.texts ?? []}
            polygons={parseResult?.polygons ?? []}
            mappings={mappings}
            totalInserts={parseResult?.stats.totalInserts ?? 0}
            zoneDebug={zoneDebug}
            zoneReviews={zoneReviews}
          />
        )}

        {/* ── Zones tab ── */}
        {tab === 'zones' && (
          <ZonesTab polygons={polygons} />
        )}

        {/* ── Blocks tab ── */}
        {tab === 'blocks' && (
          <BlocksTable
            mappings={mappings} plants={plants} savedRules={savedRules}
            dropdown={dropdown} setDropdown={setDropdown}
            onApplyOnce={applyOnce} onApplyPermanent={applyPermanent} onApplyProject={applyProject}
            onClearManual={blockName => {
              if (!parseResult) return
              const rules = loadDxfRules()
              const item = mappings.find(m => m.blockName === blockName)
              const nearby = item?.positions.length
                ? findNearbyTexts(item.positions[0], parseResult.texts, drawingRadius) : []
              const r2 = matchPlant(blockName, item?.layer ?? '', item?.count ?? 0, plants, rules, plantSchedule.entries, nearby, item?.attributes ?? [])
              setMappings(prev => prev.map(m => m.blockName !== blockName ? m : {
                ...m, manualOverride: undefined, matchStatus: r2.status,
                confidenceScore: r2.confidence, scheduleEntry: r2.scheduleEntry,
                detectedType: r2.detectedType, possiblePlantCode: r2.possiblePlantCode,
                evidence: r2.evidence,
                plantName: r2.plant?.name, plantCategory: r2.plant?.category,
                plantSubCategory: r2.plant?.subCategory, matchReason: r2.reason,
              }))
            }}
          />
        )}

        {/* ── Multi-layer tab ── */}
        {tab === 'multilayer' && (
          <MultiLayerTab
            results={multiLayerResults}
            polygons={polygons}
            stats={stats}
          />
        )}

        {/* ── Texts tab ── */}
        {tab === 'texts' && (
          <TextsTab texts={texts} />
        )}

        {/* ── Unmatched tab ── */}
        {tab === 'unmatched' && (
          <UnmatchedTab
            unmatched={unmatched} plants={plants} savedRules={savedRules}
            dropdown={dropdown} setDropdown={setDropdown}
            onApplyOnce={applyOnce} onApplyPermanent={applyPermanent} onApplyProject={applyProject}
          />
        )}

        {/* ── Excluded tab ── */}
        {tab === 'excluded' && (
          <ExcludedTab excluded={excluded} onRestore={restoreExcluded} />
        )}

        {/* ── Rules tab ── */}
        {tab === 'rules' && (
          <RulesTab savedRules={savedRules} onDelete={removeRule} onClearAll={clearAllRules} />
        )}
      </main>

      {/* Footer */}
      {mappings.length > 0 && (() => {
        const { importable, unimportable } = buildImportList(mappings, plantSchedule.entries)
        return (
          <div className="sticky bottom-0 bg-white border-t border-stone-200">
            {/* Import preview panel */}
            {showImportPreview && (
              <div className="px-8 py-5 border-b border-stone-100 max-h-72 overflow-y-auto">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-sm font-semibold text-stone-700">
                    匯入預覽 — 即將匯入 <strong className="text-green-700">{importable.length}</strong> 種植物
                  </p>
                  <button onClick={() => setShowImportPreview(false)}
                    className="text-stone-400 hover:text-stone-600"><X size={14} /></button>
                </div>

                {importable.length > 0 && (
                  <div className="mb-4 space-y-1">
                    {importable.map((item, i) => (
                      <div key={i} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-emerald-50 border border-emerald-100">
                        <CheckCircle size={13} className="text-emerald-500 flex-shrink-0" />
                        <span className="font-semibold text-stone-800 text-sm flex-1">{item.plantName}</span>
                        <span className="text-xs text-stone-500">
                          {item.quantity} {item.quantityNote ? <span className="text-amber-500">({item.quantityNote})</span> : '株'}
                        </span>
                        <span className="text-xs text-stone-400">
                          {item.source === 'block-matched' ? '圖塊精確對應'
                           : item.source === 'block-partial' ? '圖塊部分符合'
                           : '索引表'}
                        </span>
                        <ConfidenceBadge score={item.confidence} />
                      </div>
                    ))}
                  </div>
                )}

                {unimportable.length > 0 && (
                  <details className="mt-1">
                    <summary className="text-xs text-stone-400 cursor-pointer select-none">
                      無法匯入項目（{unimportable.length} 筆）
                    </summary>
                    <div className="mt-2 space-y-1">
                      {unimportable.map((item, i) => (
                        <div key={i} className="flex items-center gap-3 px-3 py-1.5 rounded-lg bg-stone-50 border border-stone-100">
                          <HelpCircle size={12} className="text-stone-300 flex-shrink-0" />
                          <span className="text-xs text-stone-500 flex-1">{item.label}</span>
                          <span className="text-xs text-red-400">{item.reason}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                )}

                {importable.length > 0 ? (
                  <button
                    onClick={() => {
                      onImport?.(importable.map(i => i.plantName))
                      onTabChange?.('landscape')
                    }}
                    className="mt-4 w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-green-700 text-white text-sm font-bold hover:bg-green-800">
                    <ArrowRight size={15} />確認匯入 {importable.length} 種植物至 AI 配植評估
                  </button>
                ) : (
                  <div className="mt-3 p-3 rounded-xl bg-red-50 border border-red-200 text-sm text-red-700">
                    目前無可匯入項目。請至「未對應項目」分頁手動指定植物，或確認植栽資料庫已載入。
                  </div>
                )}
              </div>
            )}

            {/* Footer bar */}
            <div className="px-8 py-4 flex items-center justify-between">
              <div className="text-sm text-stone-500">
                已對應 <strong className="text-green-700">{matched.length + partial.length}</strong> 種・
                未對應 <strong className="text-red-600">{unmatched.length}</strong> 種・
                索引表 {plantSchedule.entries.filter(e => existsExactInLocalDatabase(e.plantName, plants, e.scientificName)).length} 筆已比對
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-stone-400">
                  可匯入 {buildImportList(mappings, plantSchedule.entries).importable.length} 種
                </span>
                <button
                  onClick={() => setShowImportPreview(v => !v)}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-green-700 text-white text-sm font-semibold hover:bg-green-800">
                  <ArrowRight size={14} />
                  {showImportPreview ? '收起預覽' : '匯入已對應植物至配植評估'}
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Close dropdown overlay */}
      {dropdown && <div className="fixed inset-0 z-40" onClick={() => setDropdown(null)} />}

      {/* PDF 已產生 Modal */}
      {pdfHtml && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden">
            <div className="px-6 pt-6 pb-4 flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center">
                <FileOutput size={20} className="text-green-700" />
              </div>
              <div>
                <p className="text-base font-bold text-stone-800">PDF 已產生完成</p>
                <p className="text-xs text-stone-400">請選擇預覽或下載</p>
              </div>
            </div>
            <div className="px-6 pb-6 flex flex-col gap-3">
              <button
                onClick={() => {
                  try {
                    console.log('[DXF-PDF-Preview] pdfHtml 長度:', pdfHtml?.length)
                    const win = window.open('', '_blank', 'width=900,height=700')
                    console.log('[DXF-PDF-Preview] window.open 結果:', win)
                    if (!win) {
                      console.error('[DXF-PDF-Preview] window.open 回傳 null')
                      alert('彈出視窗被封鎖，請改用「下載 HTML 報告」。')
                      return
                    }
                    win.document.open()
                    win.document.write(pdfHtml!)
                    win.document.close()
                    console.log('[DXF-PDF-Preview] document.write 完成')
                    setTimeout(() => {
                      try { win.print() }
                      catch (e) { console.error('[DXF-PDF-Preview] win.print() 例外：', e) }
                    }, 800)
                    setPdfHtml(null)
                  } catch (err) {
                    console.error('[DXF-PDF-Preview] 例外：', err)
                    alert(`預覽失敗：${err instanceof Error ? err.message : String(err)}`)
                  }
                }}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-[#1a4731] text-white font-semibold text-sm hover:bg-[#2d6a4f] transition-colors">
                <FileOutput size={16} />預覽 PDF（可列印）
              </button>
              <button
                onClick={() => {
                  try {
                    console.log('[DXF-PDF-Download] 建立 Blob...')
                    const blob = new Blob([pdfHtml!], { type: 'text/html;charset=utf-8' })
                    const url = URL.createObjectURL(blob)
                    console.log('[DXF-PDF-Download] Blob URL:', url)
                    const a = document.createElement('a')
                    a.href = url; a.download = `DXF分區審查報告_${fileName || 'report'}.html`; a.click()
                    URL.revokeObjectURL(url)
                    setPdfHtml(null)
                  } catch (err) {
                    console.error('[DXF-PDF-Download] 例外：', err)
                    alert(`下載失敗：${err instanceof Error ? err.message : String(err)}`)
                  }
                }}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-xl border border-stone-200 text-stone-700 font-medium text-sm hover:bg-stone-50 transition-colors">
                <FileDown size={16} />下載 HTML 報告
              </button>
              <button onClick={() => setPdfHtml(null)}
                className="text-xs text-stone-400 hover:text-stone-600 text-center py-1">
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

interface PlantDropdownProps {
  blockName: string
  dropKey: string
  plants: CsvPlantRecord[]
  currentPlantName?: string
  savedRules: DxfBlockRule[]
  manualOverride?: string
  dropdown: DropdownState | null
  setDropdown: (v: DropdownState | null) => void
  onApplyOnce: (blockName: string, plantName: string) => void
  onApplyProject: (blockName: string, plantName: string) => void
  onApplyPermanent: (blockName: string, plantName: string) => void
  onClearManual?: (blockName: string) => void
}

function PlantDropdown({
  blockName, dropKey, plants, currentPlantName, savedRules, manualOverride,
  dropdown, setDropdown, onApplyOnce, onApplyProject, onApplyPermanent, onClearManual,
}: PlantDropdownProps) {
  const isOpen = dropdown?.blockName === blockName && dropdown.key === dropKey
  const rule = savedRules.find(r => r.blockName === blockName)

  return (
    <div className="relative">
      <button onClick={() => setDropdown(isOpen ? null : { blockName, key: dropKey })}
        className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-stone-200 text-xs text-stone-600 hover:bg-stone-50 whitespace-nowrap">
        指定植物 <ChevronDown size={11} />
      </button>
      {isOpen && (
        <div className="absolute right-0 top-9 z-50 w-80 bg-white border border-stone-200 rounded-xl shadow-xl overflow-hidden">
          <div className="px-3 py-2 bg-stone-50 border-b border-stone-100 text-xs text-stone-500">
            選擇植物後，選擇套用方式
          </div>
          {manualOverride && onClearManual && (
            <div className="border-b border-stone-100">
              <button onClick={() => { onClearManual(blockName); setDropdown(null) }}
                className="w-full text-left px-4 py-2 text-xs text-stone-400 hover:bg-stone-50 flex items-center gap-2">
                <X size={10} />清除本次人工指定
              </button>
            </div>
          )}
          {/* Legend */}
          <div className="px-3 pt-2 pb-1 flex gap-2 text-[10px] text-stone-400 border-b border-stone-100 flex-wrap">
            <span className="px-1.5 py-0.5 rounded bg-stone-100">本次</span>僅此次
            <span className="px-1.5 py-0.5 rounded bg-amber-50 text-amber-600">此圖面</span>本次開啟有效
            <span className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-600">永久</span>永遠儲存
          </div>
          <div className="max-h-64 overflow-y-auto">
            {plants.map(p => {
              const isCurrent = p.name === currentPlantName
              const isRuled   = rule?.plantName === p.name
              return (
                <div key={p.id}
                  className={`flex items-center border-b border-stone-50 last:border-0 ${isCurrent ? 'bg-green-50' : 'hover:bg-stone-50'}`}>
                  <div className="flex-1 px-3 py-1.5 min-w-0">
                    <span className={`text-sm font-medium ${isCurrent ? 'text-green-700' : 'text-stone-700'}`}>
                      {p.name}
                    </span>
                    {isRuled && <span className="ml-1 text-[10px] text-blue-500">📌已儲存</span>}
                    <span className="ml-1 text-xs text-stone-400">{p.subCategory || p.category}</span>
                  </div>
                  <button onClick={() => onApplyOnce(blockName, p.name)}
                    className="px-2 py-2 text-[11px] font-medium text-stone-600 hover:bg-stone-100 border-l border-stone-100 whitespace-nowrap">
                    本次
                  </button>
                  <button onClick={() => onApplyProject(blockName, p.name)}
                    className="px-2 py-2 text-[11px] font-medium text-amber-600 hover:bg-amber-50 border-l border-stone-100 whitespace-nowrap">
                    此圖面
                  </button>
                  <button onClick={() => onApplyPermanent(blockName, p.name)}
                    className="px-2 py-2 text-[11px] font-medium text-blue-600 hover:bg-blue-50 border-l border-stone-100 whitespace-nowrap">
                    永久
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Blocks table ──────────────────────────────────────────────────────────────

interface BlocksTableProps {
  mappings: MappedItem[]
  plants: CsvPlantRecord[]
  savedRules: DxfBlockRule[]
  dropdown: DropdownState | null
  setDropdown: (v: DropdownState | null) => void
  onApplyOnce: (blockName: string, plantName: string) => void
  onApplyProject: (blockName: string, plantName: string) => void
  onApplyPermanent: (blockName: string, plantName: string) => void
  onClearManual: (blockName: string) => void
}

function BlocksTable({ mappings, plants, savedRules, dropdown, setDropdown, onApplyOnce, onApplyProject, onApplyPermanent, onClearManual }: BlocksTableProps) {
  return (
    <div>
      <p className="text-sm text-stone-500 mb-4">
        共 {mappings.length} 種圖塊（已自動排除非植栽圖層），依數量排序。
        信心分數 ≥70 自動對應；40–69 建議確認；&lt;40 需人工指定。
      </p>
      <div className="bg-white rounded-2xl border border-stone-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-stone-50 border-b border-stone-200">
              {['#', '圖塊名稱', '識別類型', '推測代號', '推測植物', '狀態／信心', '判斷依據', '操作'].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-stone-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {mappings.map((m, idx) => (
              <tr key={`${m.blockName}-${m.layer}`}
                className={`border-b border-stone-100 last:border-0 ${
                  m.matchStatus === 'unmatched' ? 'bg-red-50/30' :
                  m.matchStatus === 'partial'   ? 'bg-amber-50/20' : ''
                }`}>
                <td className="px-4 py-3 text-stone-400 text-xs">{idx + 1}</td>
                {/* 圖塊名稱 */}
                <td className="px-4 py-3">
                  <p className="font-mono font-semibold text-stone-800">{m.blockName}</p>
                  <p className="text-xs text-stone-400 font-mono">{m.layer || '—'}</p>
                  <div className="flex gap-1 mt-0.5 flex-wrap">
                    {m.manualOverride && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">本次指定</span>}
                    {savedRules.find(r => r.blockName === m.blockName) && <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-600">已儲存規則</span>}
                    {m.scheduleEntry && <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-600">索引表</span>}
                  </div>
                </td>
                {/* 識別類型（從 block/layer 名稱推斷，不代表植物）*/}
                <td className="px-4 py-3">
                  {m.detectedType
                    ? <span className="text-xs px-2 py-0.5 rounded-full bg-stone-100 border border-stone-200 text-stone-600">{m.detectedType}</span>
                    : <span className="text-stone-300 text-xs">未識別</span>}
                  <p className="text-xs text-stone-400 mt-1">×{m.count}</p>
                </td>
                {/* 從 block name 提取的數字代號 */}
                <td className="px-4 py-3">
                  {m.possiblePlantCode
                    ? <span className="font-mono font-semibold text-stone-700 bg-stone-100 px-2 py-0.5 rounded text-sm">{m.possiblePlantCode}</span>
                    : <span className="text-stone-300 text-xs">—</span>}
                </td>
                {/* 推測植物（植物名稱 + 索引表數量/單位）*/}
                <td className="px-4 py-3">
                  {m.plantName
                    ? <div>
                        <p className="font-semibold text-stone-800">{m.plantName}</p>
                        {m.scheduleEntry
                          ? <p className="text-xs text-stone-500 mt-0.5">
                              索引表：{m.scheduleEntry.quantity != null ? m.scheduleEntry.quantity : '?'}
                              {m.scheduleEntry.unit ? ` ${m.scheduleEntry.unit}` : ''}
                              {m.scheduleEntry.quantity != null && m.scheduleEntry.quantity !== m.count
                                ? <span className="text-amber-500 ml-1">（圖塊 {m.count}，數量不一致）</span>
                                : null}
                            </p>
                          : <p className="text-xs text-stone-400">圖塊 {m.count} 個</p>}
                        {m.scheduleEntry?.spec && <p className="text-xs text-stone-300 truncate max-w-[140px]">{m.scheduleEntry.spec}</p>}
                        {(m.plantSubCategory || m.plantCategory) &&
                          <p className="text-xs text-stone-300">{m.plantSubCategory || m.plantCategory}</p>}
                        {m.matchStatus === 'partial' &&
                          <p className="text-xs text-amber-500 mt-0.5">⚠ 需人工確認</p>}
                      </div>
                    : <span className="text-stone-300 text-xs">—</span>}
                </td>
                {/* 狀態 + 信心分數 */}
                <td className="px-4 py-3">
                  <div className="flex flex-col gap-1">
                    <StatusBadge status={m.matchStatus} />
                    <ConfidenceBadge score={m.confidenceScore} />
                  </div>
                </td>
                {/* 判斷依據清單 */}
                <td className="px-4 py-3 text-xs text-stone-400 max-w-[180px]">
                  {m.evidence && m.evidence.length > 0
                    ? <ul className="space-y-0.5">
                        {m.evidence.map((ev, i) => (
                          <li key={i} className="flex items-start gap-1">
                            <span className="text-stone-300 flex-shrink-0">·</span>
                            <span>{ev}</span>
                          </li>
                        ))}
                      </ul>
                    : <span className="text-stone-300">{m.matchReason}</span>}
                </td>
                <td className="px-4 py-3">
                  <PlantDropdown
                    blockName={m.blockName} dropKey={`block-${idx}`}
                    plants={plants} currentPlantName={m.plantName}
                    savedRules={savedRules} manualOverride={m.manualOverride}
                    dropdown={dropdown} setDropdown={setDropdown}
                    onApplyOnce={onApplyOnce} onApplyProject={onApplyProject}
                    onApplyPermanent={onApplyPermanent} onClearManual={onClearManual}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Multi-layer tab ───────────────────────────────────────────────────────────

function MultiLayerTab({ results, polygons, stats }: {
  results: MultiLayerResult[]
  polygons: DxfParseResult['polygons']
  stats: DxfParseResult['stats']
}) {
  return (
    <div>
      {stats.totalPolygons > 0 && (
        <div className="mb-5 p-4 bg-blue-50 border border-blue-200 rounded-2xl">
          <p className="text-sm font-semibold text-blue-800 mb-2 flex items-center gap-2">
            <Layers size={14} />
            偵測到 {stats.totalPolygons} 個範圍多邊形（{stats.classifiedPolygons} 個已識別種植區域）
          </p>
          <div className="flex flex-wrap gap-2">
            {(['shrub', 'lawn', 'groundcover', 'high_irrigation', 'low_irrigation'] as const).map(zt => {
              const cnt = polygons.filter(p => p.zoneType === zt).length
              return cnt === 0 ? null : (
                <span key={zt} className="text-xs px-2.5 py-1 rounded-full bg-white border border-blue-200 text-blue-700">
                  {zoneLabel(zt)} × {cnt}
                </span>
              )
            })}
            {polygons.filter(p => p.zoneType === 'unknown').length > 0 && (
              <span className="text-xs px-2.5 py-1 rounded-full bg-stone-100 text-stone-500">
                未分類 × {polygons.filter(p => p.zoneType === 'unknown').length}
              </span>
            )}
          </div>
        </div>
      )}

      {stats.totalPolygons === 0 && (
        <div className="mb-5 p-4 bg-amber-50 border border-amber-200 rounded-2xl flex items-start gap-3">
          <AlertTriangle size={18} className="text-amber-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-amber-800">此 DXF 未偵測到封閉範圍多邊形</p>
            <p className="text-sm text-amber-600 mt-1">
              複層分析需要封閉的 LWPOLYLINE 或 HATCH 定義種植範圍。
              請確認圖面中種植範圍是否使用封閉多邊形，或圖層名稱包含「灌木」「草皮」「澆灌」等關鍵字。
            </p>
          </div>
        </div>
      )}

      {results.length === 0 && stats.totalPolygons > 0 && (
        <div className="mb-5 p-4 bg-stone-50 border border-stone-200 rounded-2xl flex items-start gap-3">
          <HelpCircle size={18} className="text-stone-400 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-stone-700">未能識別喬木圖塊</p>
            <p className="text-sm text-stone-500 mt-1">
              複層分析需要圖塊對應到植栽資料庫中類型為「喬木」的植物，或圖塊/圖層名稱包含「喬木」「tree」等關鍵字。
              請至「圖塊對應表」手動指定喬木類植物後重新分析。
            </p>
          </div>
        </div>
      )}

      {results.length > 0 && (
        <>
          <p className="text-sm text-stone-500 mb-4">
            共分析 {results.length} 組喬木 × 種植範圍空間關係。景觀複層配置本為正常設計，僅針對澆灌差異、積水風險等提示。
          </p>
          <div className="space-y-3">
            {results.map((r, idx) => (
              <div key={idx} className={`rounded-2xl border-2 p-5 ${
                r.judgment === 'conflict' ? 'border-red-300 bg-red-50/30' :
                r.judgment === 'caution'  ? 'border-amber-300 bg-amber-50/20' :
                'border-emerald-200 bg-emerald-50/20'}`}>
                <div className="flex items-start justify-between gap-4 mb-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 flex-wrap mb-1">
                      <span className="font-bold text-stone-800 text-base">{r.treePlantName ?? r.treeBlockName}</span>
                      {r.treePlantName && r.treePlantName !== r.treeBlockName && (
                        <span className="text-xs font-mono text-stone-400">({r.treeBlockName})</span>
                      )}
                      <MultiLayerBadge judgment={r.judgment} />
                    </div>
                    <p className="text-xs text-stone-400">
                      圖層：{r.treeLayer || '未指定'} ・此類型共 {r.totalCount} 株 ・分析點位 #{r.positionIndex}
                    </p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3 mb-3 text-sm">
                  <div className="bg-white rounded-xl px-4 py-2.5 border border-stone-100">
                    <p className="text-xs text-stone-400 mb-1">所在範圍</p>
                    <p className="font-semibold text-stone-700">{r.underlayerDesc}</p>
                  </div>
                  <div className="bg-white rounded-xl px-4 py-2.5 border border-stone-100">
                    <p className="text-xs text-stone-400 mb-1">下層植栽類型</p>
                    <p className="font-semibold text-stone-700">{r.zones.map(z => zoneLabel(z.zoneType)).join('、')}</p>
                  </div>
                </div>
                <div className="space-y-1.5 mb-3">
                  {r.riskReasons.map((reason, i) => (
                    <div key={i} className="flex items-start gap-2 text-sm">
                      <span className="flex-shrink-0">{r.judgment === 'conflict' ? '🔴' : r.judgment === 'caution' ? '🟡' : '🟢'}</span>
                      <span className="text-stone-700">{reason}</span>
                    </div>
                  ))}
                </div>
                {r.suggestions.some(s => !s.includes('維持現有')) && (
                  <div className="bg-white rounded-xl px-4 py-3 border border-stone-100">
                    <p className="text-xs font-semibold text-stone-500 mb-1.5">修正建議</p>
                    {r.suggestions.map((s, i) => (
                      <p key={i} className="text-sm text-stone-700 flex items-start gap-1.5">
                        <ArrowRight size={12} className="flex-shrink-0 mt-1 text-stone-400" />{s}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ── Texts tab ─────────────────────────────────────────────────────────────────

function TextsTab({ texts }: { texts: DxfParseResult['texts'] }) {
  return (
    <div>
      <p className="text-sm text-stone-500 mb-4">DXF 中的 TEXT / MTEXT 文字元素，可作為圖說文字或植物代碼參考。</p>
      {texts.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-stone-400">
          <FileText size={32} className="mb-3 opacity-40" /><p>未偵測到文字元素</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-stone-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-stone-50 border-b border-stone-200">
                {['#', '類型', '圖層', '文字內容', 'X 座標', 'Y 座標'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-stone-500 uppercase">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {texts.slice(0, 200).map((t, idx) => (
                <tr key={idx} className="border-b border-stone-100 last:border-0 hover:bg-stone-50">
                  <td className="px-4 py-2.5 text-stone-400 text-xs">{idx + 1}</td>
                  <td className="px-4 py-2.5"><span className="px-2 py-0.5 rounded-full bg-stone-100 text-stone-600 text-xs">{t.type}</span></td>
                  <td className="px-4 py-2.5 text-stone-500 text-xs font-mono">{t.layer || '—'}</td>
                  <td className="px-4 py-2.5 text-stone-800 font-medium max-w-xs truncate">{t.content}</td>
                  <td className="px-4 py-2.5 text-stone-400 text-xs font-mono">{t.x.toFixed(1)}</td>
                  <td className="px-4 py-2.5 text-stone-400 text-xs font-mono">{t.y.toFixed(1)}</td>
                </tr>
              ))}
              {texts.length > 200 && (
                <tr><td colSpan={6} className="px-4 py-3 text-center text-xs text-stone-400">顯示前 200 筆，共 {texts.length} 筆</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Unmatched tab ─────────────────────────────────────────────────────────────

interface UnmatchedTabProps {
  unmatched: MappedItem[]
  plants: CsvPlantRecord[]
  savedRules: DxfBlockRule[]
  dropdown: DropdownState | null
  setDropdown: (v: DropdownState | null) => void
  onApplyOnce: (blockName: string, plantName: string) => void
  onApplyProject: (blockName: string, plantName: string) => void
  onApplyPermanent: (blockName: string, plantName: string) => void
}

function UnmatchedTab({ unmatched, plants, savedRules, dropdown, setDropdown, onApplyOnce, onApplyProject, onApplyPermanent }: UnmatchedTabProps) {
  if (unmatched.length === 0) return (
    <div className="flex flex-col items-center justify-center py-20 text-stone-400">
      <CheckCircle size={40} className="mb-3 text-green-400" />
      <p className="text-lg font-medium text-stone-600">所有圖塊都已對應植栽資料庫</p>
    </div>
  )

  return (
    <>
      <div className="flex items-start gap-4 p-5 bg-red-50 border border-red-200 rounded-2xl mb-6">
        <AlertTriangle size={22} className="text-red-500 flex-shrink-0 mt-0.5" />
        <div>
          <p className="font-bold text-red-800 text-base">需要人工確認 — {unmatched.length} 個圖塊無法自動對應</p>
          <p className="text-sm text-red-600 mt-1">
            選擇「本次」只套用此次，選擇「永久」將儲存規則下次自動套用。
          </p>
        </div>
      </div>
      <div className="space-y-3">
        {unmatched.map((m, idx) => (
          <div key={`${m.blockName}-${m.layer}-${idx}`}
            className="bg-white rounded-2xl border-2 border-red-200 p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <div className="flex items-center gap-3 mb-1 flex-wrap">
                  <span className="text-lg font-bold font-mono text-stone-800">{m.blockName}</span>
                  <StatusBadge status={m.matchStatus} />
                  <span className="text-sm font-bold text-red-600">{m.count} 株</span>
                </div>
                <div className="flex gap-4 text-sm text-stone-500">
                  <span>圖層：<strong className="font-mono">{m.layer || '未指定'}</strong></span>
                  <span>原因：{m.matchReason}</span>
                </div>
                <div className="mt-1 text-xs text-stone-400">
                  位置範例：{m.positions.slice(0, 3).map((p, i) => (
                    <span key={i} className="mr-2 font-mono">({p.x.toFixed(0)}, {p.y.toFixed(0)})</span>
                  ))}
                </div>
              </div>
              <PlantDropdown
                blockName={m.blockName} dropKey={`unmatched-${idx}`}
                plants={plants} currentPlantName={m.plantName}
                savedRules={savedRules}
                dropdown={dropdown} setDropdown={setDropdown}
                onApplyOnce={onApplyOnce} onApplyProject={onApplyProject}
                onApplyPermanent={onApplyPermanent}
              />
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

// ── Excluded tab ──────────────────────────────────────────────────────────────

function ExcludedTab({ excluded, onRestore }: { excluded: MappedItem[]; onRestore: (item: MappedItem) => void }) {
  return (
    <div>
      <div className="flex items-start gap-4 p-5 bg-stone-50 border border-stone-200 rounded-2xl mb-5">
        <AlertTriangle size={18} className="text-stone-400 flex-shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-semibold text-stone-700">以下圖塊 / 圖層已被系統自動排除（非植栽元素）</p>
          <p className="text-xs text-stone-500 mt-1">
            判斷依據：圖層或圖塊名稱包含「Defpoints」「圖框」「標註」「尺寸」「家具」等非植栽關鍵字。
            若有誤判，可點擊「還原」將其加回對應表。
          </p>
        </div>
      </div>

      {excluded.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-stone-400">
          <CheckCircle size={32} className="mb-3 text-green-400" />
          <p>沒有被排除的項目</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-stone-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-stone-50 border-b border-stone-200">
                {['圖塊名稱', '圖層', '數量', '排除原因', '操作'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-stone-500 uppercase">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {excluded.map((m, idx) => (
                <tr key={idx} className="border-b border-stone-100 last:border-0 bg-stone-50/50">
                  <td className="px-4 py-3 font-mono text-stone-500">{m.blockName}</td>
                  <td className="px-4 py-3 text-stone-400 text-xs font-mono">{m.layer || '—'}</td>
                  <td className="px-4 py-3 text-stone-500">{m.count}</td>
                  <td className="px-4 py-3 text-xs text-stone-400">圖層/圖塊名稱符合非植栽關鍵字</td>
                  <td className="px-4 py-3">
                    <button onClick={() => onRestore(m)}
                      className="px-3 py-1.5 rounded-lg border border-stone-200 text-xs text-stone-600 hover:bg-white">
                      還原至對應表
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Zone Review tab ───────────────────────────────────────────────────────────

const COMPAT_CLS: Record<string, string> = {
  '配置良好':       'bg-emerald-50 border-emerald-300 text-emerald-800',
  '可行但需補充說明': 'bg-amber-50 border-amber-300 text-amber-800',
  '需調整配置':     'bg-orange-50 border-orange-300 text-orange-800',
  '高風險不建議':   'bg-red-50 border-red-300 text-red-800',
}
const ISSUE_CLS: Record<string, string> = {
  danger:  'border-l-4 border-red-400 bg-red-50',
  caution: 'border-l-4 border-amber-400 bg-amber-50',
  ok:      'border-l-4 border-emerald-300 bg-emerald-50',
}

function ZoneReviewTab({ reviews, onAskAI }: { reviews: ZoneReviewResult[]; onAskAI?: (q: string) => void }) {
  const [activeTab, setActiveTab] = useState<string>('overview')

  if (reviews.length === 0) return (
    <div className="flex flex-col items-center justify-center py-20 text-stone-400 gap-3">
      <Layers size={36} className="opacity-30" />
      <p className="text-base font-medium text-stone-500">尚未建立分區審查</p>
      <p className="text-sm text-stone-400 text-center max-w-md">
        請先至「分區配置」tab 確認 A/B/C 分區是否正確偵測，並確認各區植物已對應索引表。
      </p>
    </div>
  )

  const reviewable = reviews.filter(r => r.status === '可審查')
  const pending    = reviews.filter(r => r.status !== '可審查')
  const activeReview = reviews.find(r => r.zoneName === activeTab) ?? null

  // 風險等級 badge 顏色
  const riskBadgeCls = (r: ZoneReviewResult) => {
    const dangerCnt = r.evalResult?.issues.filter(i => i.level === 'danger').length ?? 0
    if (dangerCnt > 0) return 'bg-red-100 text-red-700 border-red-300'
    const cautionCnt = r.evalResult?.issues.filter(i => i.level === 'caution').length ?? 0
    if (cautionCnt > 0) return 'bg-amber-100 text-amber-700 border-amber-300'
    if (r.evalResult) return 'bg-emerald-100 text-emerald-700 border-emerald-300'
    return 'bg-stone-100 text-stone-500 border-stone-200'
  }
  const riskLabel = (r: ZoneReviewResult) => {
    const dangerCnt = r.evalResult?.issues.filter(i => i.level === 'danger').length ?? 0
    if (dangerCnt > 0) return '高風險'
    const cautionCnt = r.evalResult?.issues.filter(i => i.level === 'caution').length ?? 0
    if (cautionCnt > 0) return '中風險'
    if (r.evalResult) return '低風險'
    return r.status === '植物待確認' ? '待確認' : '無資料'
  }
  const plantCount = (r: ZoneReviewResult) => r.blockEntries.reduce((s, b) => s + b.count, 0)

  return (
    <div className="space-y-4">
      {/* ── Tab 列 ── */}
      <div className="bg-white rounded-2xl border border-stone-200 overflow-hidden">
        <div className="flex overflow-x-auto border-b border-stone-200 scrollbar-none">
          {/* 總覽 tab */}
          <button
            onClick={() => setActiveTab('overview')}
            className={`flex-shrink-0 px-5 py-3 text-sm font-semibold border-b-2 transition-colors whitespace-nowrap ${
              activeTab === 'overview'
                ? 'border-green-600 text-green-700 bg-green-50'
                : 'border-transparent text-stone-500 hover:text-stone-700 hover:bg-stone-50'
            }`}>
            總覽
          </button>
          {/* 各分區 tab */}
          {reviews.map(r => {
            const cnt = plantCount(r)
            const dangerCnt = r.evalResult?.issues.filter(i => i.level === 'danger').length ?? 0
            const cautionCnt = r.evalResult?.issues.filter(i => i.level === 'caution').length ?? 0
            const isActive = activeTab === r.zoneName
            return (
              <button key={r.zoneName}
                onClick={() => setActiveTab(r.zoneName)}
                className={`flex-shrink-0 flex items-center gap-2 px-5 py-3 text-sm font-semibold border-b-2 transition-colors whitespace-nowrap ${
                  isActive
                    ? 'border-green-600 text-green-700 bg-green-50'
                    : 'border-transparent text-stone-500 hover:text-stone-700 hover:bg-stone-50'
                }`}>
                {r.zoneName}
                {cnt > 0 && <span className="text-xs font-normal text-stone-400">{cnt}株</span>}
                {dangerCnt > 0 && (
                  <span className="inline-block w-2 h-2 rounded-full bg-red-500" title="高風險" />
                )}
                {dangerCnt === 0 && cautionCnt > 0 && (
                  <span className="inline-block w-2 h-2 rounded-full bg-amber-400" title="中風險" />
                )}
                {dangerCnt === 0 && cautionCnt === 0 && r.evalResult && (
                  <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" title="低風險" />
                )}
              </button>
            )
          })}
        </div>

        {/* ── 總覽內容 ── */}
        {activeTab === 'overview' && (
          <div className="p-5 space-y-4">
            {/* 整體摘要列 */}
            <div className="flex gap-3 flex-wrap">
              <div className="px-4 py-2 rounded-xl border border-blue-200 bg-blue-50 text-blue-800 text-sm font-medium">
                共 {reviews.length} 個分區
              </div>
              <div className="px-4 py-2 rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-800 text-sm font-medium">
                已完成審查 {reviewable.length} 區
              </div>
              {pending.length > 0 && (
                <div className="px-4 py-2 rounded-xl border border-amber-200 bg-amber-50 text-amber-800 text-sm font-medium">
                  待確認 {pending.length} 區
                </div>
              )}
            </div>

            {/* 各區卡片（點擊跳至對應 tab）*/}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {reviews.map(r => {
                const dangerCnt  = r.evalResult?.issues.filter(i => i.level === 'danger').length ?? 0
                const cautionCnt = r.evalResult?.issues.filter(i => i.level === 'caution').length ?? 0
                const cnt = plantCount(r)
                return (
                  <button key={r.zoneName}
                    onClick={() => setActiveTab(r.zoneName)}
                    className="text-left p-4 rounded-xl border border-stone-200 hover:border-green-300 hover:bg-green-50/30 transition-colors group">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-lg font-bold text-stone-800 group-hover:text-green-800">{r.zoneName}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full border font-semibold ${riskBadgeCls(r)}`}>
                        {riskLabel(r)}
                      </span>
                    </div>
                    <div className="text-xs text-stone-500 space-y-1">
                      <div className="flex justify-between">
                        <span>植物數量</span>
                        <span className="font-semibold text-stone-700">{cnt} 株 / {r.blockEntries.length} 種</span>
                      </div>
                      {r.evalResult && (
                        <div className="flex justify-between">
                          <span>審查評分</span>
                          <span className="font-semibold text-stone-700">{r.evalResult.score}/100</span>
                        </div>
                      )}
                      {dangerCnt > 0 && (
                        <div className="flex justify-between text-red-600">
                          <span>高風險問題</span>
                          <span className="font-semibold">{dangerCnt} 項</span>
                        </div>
                      )}
                      {cautionCnt > 0 && (
                        <div className="flex justify-between text-amber-600">
                          <span>注意事項</span>
                          <span className="font-semibold">{cautionCnt} 項</span>
                        </div>
                      )}
                      <div className="flex justify-between">
                        <span>審查狀態</span>
                        <span className={`font-semibold ${r.status === '可審查' ? 'text-emerald-600' : r.status === '植物待確認' ? 'text-amber-600' : 'text-stone-400'}`}>
                          {r.status}
                        </span>
                      </div>
                    </div>
                    {r.evalResult?.aiSuggestion && (
                      <p className="mt-2 text-xs text-stone-500 line-clamp-2 border-t border-stone-100 pt-2">
                        {r.evalResult.aiSuggestion}
                      </p>
                    )}
                  </button>
                )
              })}
            </div>

            {/* ── 各區比較表 ── */}
            {reviews.some(r => r.evalResult) && (
              <div className="rounded-xl border border-stone-200 overflow-hidden">
                <div className="px-4 py-2.5 bg-stone-50 border-b border-stone-200">
                  <p className="text-xs font-bold text-stone-700 tracking-wide">各區審查比較</p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className="bg-[#f7faf5]">
                        <th className="px-4 py-2.5 text-left text-stone-600 font-semibold border-b border-stone-200 w-24">分區</th>
                        <th className="px-4 py-2.5 text-center text-stone-600 font-semibold border-b border-stone-200">分數</th>
                        <th className="px-4 py-2.5 text-center text-stone-600 font-semibold border-b border-stone-200">風險等級</th>
                        <th className="px-4 py-2.5 text-center text-stone-600 font-semibold border-b border-stone-200">問題數</th>
                        <th className="px-4 py-2.5 text-center text-stone-600 font-semibold border-b border-stone-200">高風險</th>
                        <th className="px-4 py-2.5 text-left text-stone-600 font-semibold border-b border-stone-200">主要問題</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reviews.map((r, i) => {
                        const dangerCnt  = r.evalResult?.issues.filter(i => i.level === 'danger').length ?? 0
                        const cautionCnt = r.evalResult?.issues.filter(i => i.level === 'caution').length ?? 0
                        const totalIssues = dangerCnt + cautionCnt
                        const mainIssues  = r.evalResult?.issues
                          .filter(i => i.level === 'danger' || i.level === 'caution')
                          .slice(0, 2).map(i => i.category).join('、') ?? '—'
                        const scoreColor = !r.evalResult ? 'text-stone-400'
                          : r.evalResult.score >= 80 ? 'text-emerald-700'
                          : r.evalResult.score >= 60 ? 'text-amber-700'
                          : 'text-red-700'
                        return (
                          <tr key={r.zoneName}
                            className={`border-b border-stone-100 cursor-pointer hover:bg-green-50/40 transition-colors ${i % 2 === 0 ? 'bg-white' : 'bg-stone-50/40'}`}
                            onClick={() => setActiveTab(r.zoneName)}>
                            <td className="px-4 py-3">
                              <span className="font-bold text-stone-800">{r.zoneName}</span>
                            </td>
                            <td className="px-4 py-3 text-center">
                              {r.evalResult
                                ? <span className={`text-base font-bold ${scoreColor}`}>{r.evalResult.score}<span className="text-xs font-normal text-stone-400">/100</span></span>
                                : <span className="text-stone-400 text-xs">—</span>
                              }
                            </td>
                            <td className="px-4 py-3 text-center">
                              <span className={`text-xs px-2 py-0.5 rounded-full border font-semibold ${riskBadgeCls(r)}`}>
                                {riskLabel(r)}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-center">
                              <span className={`font-semibold ${totalIssues > 0 ? 'text-amber-700' : 'text-stone-400'}`}>
                                {r.evalResult ? `${totalIssues} 項` : '—'}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-center">
                              <span className={`font-semibold ${dangerCnt > 0 ? 'text-red-600' : 'text-stone-400'}`}>
                                {r.evalResult ? (dangerCnt > 0 ? `${dangerCnt} 項` : '0') : '—'}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-stone-600 text-xs">
                              {r.evalResult ? (mainIssues || '無問題') : <span className="text-stone-400">待審查</span>}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="px-4 py-2 bg-stone-50 border-t border-stone-100 text-xs text-stone-400">
                  點擊任一列可切換查看該分區完整審查內容
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── 各分區內容 ── */}
        {activeReview && (() => {
          const r = activeReview

          // ── display helpers ──────────────────────────────────────────────
          // plantName / legendMatchedPlantName 有值時永遠優先顯示植物名稱。
          // blockName / layerName / entityType 只用於 debug，不作為植物名稱。
          const isHatchEntry    = (b: ZoneBlockEntry) => b.blockName.startsWith('[HATCH') || b.blockName.startsWith('[面狀') || b.blockName.startsWith('[未辨識 HATCH')
          const isPolyBoundary  = (b: ZoneBlockEntry) => b.blockName.startsWith('[未辨識 LWPOLYLINE') || b.blockName.startsWith('[未辨識 POLYLINE')
          // 正式版只顯示「有植物名稱」的條目；未知灌木/HATCH(ANSI31) 全部隱藏
          const visibleEntries  = r.blockEntries.filter(b => !!b.plantName)
          // debug 用：統計未辨識條目數
          const unmatchedHatch  = r.blockEntries.filter(b => !b.plantName && isHatchEntry(b)).length
          const unmatchedPoly   = r.blockEntries.filter(b => !b.plantName && isPolyBoundary(b)).length
          // 清理後的植物顯示名稱（供主列表使用）
          const plantDisplayName = (b: ZoneBlockEntry): string | null => {
            if (b.plantName) return b.plantName
            if (isHatchEntry(b)) return null   // HATCH 未識別 → 顯示專用提示
            return null                         // INSERT 未識別 → 顯示原有「未對應」
          }
          // 清理後的 source 標籤（替代 blockName）
          const sourceLabel = (b: ZoneBlockEntry): string => {
            if (b.blockName.startsWith('[HATCH圖例]'))    return `索引表 HATCH 圖例比對`
            if (b.blockName.startsWith('[HATCH候選]'))    return `HATCH 圖例候選（信心 40~69%，需人工確認）`
            if (b.blockName.startsWith('[HATCH繼承]'))    return `LWPOLYLINE 繼承 HATCH 圖例`
            if (b.blockName.startsWith('[面狀代號]'))     return `索引表代號`
            if (b.blockName.startsWith('[面狀文字]'))     return `附近文字標注`
            if (b.blockName.startsWith('[面狀]'))         return `HATCH 面狀植栽`
            if (b.blockName.startsWith('[m²候選]'))       return `索引表 m² 候選（需確認）`
            if (b.blockName.startsWith('[未辨識 HATCH]')) return `未能與索引表圖例穩定對應`
            if (b.blockName.startsWith('[未辨識面狀'))    return `未能辨識的面狀範圍`
            if (isPolyBoundary(b))                        return `空間範圍邊界`
            return b.blockName  // INSERT：直接顯示圖塊名稱
          }

          const nameOnlyBlocks = r.blockEntries.filter(b => b.matchStatus === 'name-only')
          const unmatchedBlks  = r.blockEntries.filter(b => b.matchStatus === 'unmatched')
          const totalCount     = plantCount(r)
          const dangerCnt      = r.evalResult?.issues.filter(i => i.level === 'danger').length ?? 0
          const cautionCnt     = r.evalResult?.issues.filter(i => i.level === 'caution').length ?? 0

          return (
            <div className="p-5 space-y-4">
              {/* 分區標題列 */}
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-2xl font-bold text-stone-800">{r.zoneName}</span>
                {onAskAI && (
                  <button
                    onClick={() => {
                      const trees = r.blockEntries.filter(b => b.plantName && !b.blockName.startsWith('[HATCH') && !b.blockName.startsWith('[面狀')).map(b => b.plantName)
                      const hatchP = (r.hatchPlants ? [...r.hatchPlants.confirmed, ...r.hatchPlants.candidates] : []).map(h => h.plantName)
                      onAskAI(`請分析 ${r.zoneName} 目前配置：喬木：${[...new Set(trees)].join('、') || '無'}；灌木/地被：${[...new Set(hatchP)].join('、') || '無'}。請判斷是否合理並提出修正建議。`)
                    }}
                    className="text-xs px-2.5 py-1 rounded-lg bg-[#1a4731] text-white font-medium hover:bg-[#2d6a4f] transition-colors">
                    詢問 AI
                  </button>
                )}

              {/* ── 索引表 HATCH 圖例對照結果（最優先顯示）── */}
              {r.finalReviewResults.length > 0 && (
                <div className="rounded-xl border border-blue-200 overflow-hidden bg-white">
                  <div className="px-4 py-2.5 bg-blue-50 border-b border-blue-100">
                    <p className="text-xs font-bold text-blue-900">植栽索引表判讀結果</p>
                  </div>
                  <div className="divide-y divide-stone-100">
                    {r.finalReviewResults.map((fr, i) => (
                      <div key={i} className={`px-4 py-3 ${fr.matchedPlantName ? '' : 'bg-amber-50/40'}`}>
                        {fr.matchedPlantName ? (
                          <>
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-sm font-bold text-stone-800">
                                偵測到{fr.detectedPatternType === 'INSERT' ? '植栽圖塊' : '鋪面/地被'}：{fr.matchedPlantName}
                              </span>
                              <span className={`text-xs px-1.5 py-0.5 rounded-full border font-medium ${
                                fr.confidence === 'high'   ? 'bg-emerald-50 border-emerald-200 text-emerald-700' :
                                fr.confidence === 'medium' ? 'bg-amber-50 border-amber-200 text-amber-700' :
                                                              'bg-red-50 border-red-200 text-red-600'
                              }`}>
                                {fr.confidence === 'high' ? '高信心' : fr.confidence === 'medium' ? '中信心' : '低信心'}
                              </span>
                            </div>
                            {fr.matchedLegendRow && (
                              <p className="text-xs text-stone-500">對應索引表：{fr.matchedLegendRow}</p>
                            )}
                            <p className="text-xs text-stone-500">
                              判讀依據：{fr.matchReason || '索引表 HATCH 圖例比對'}
                              {fr.matchScore > 0 && `（相似度 ${fr.matchScore}%）`}
                            </p>
                          </>
                        ) : (
                          <>
                            <p className="text-xs font-semibold text-amber-700">未能與索引表圖例穩定對應</p>
                            {fr.noMatchReasons && fr.noMatchReasons.length > 0 && (
                              <ul className="mt-1 space-y-0.5">
                                {fr.noMatchReasons.map((reason, j) => (
                                  <li key={j} className="text-xs text-amber-600">• {reason}</li>
                                ))}
                              </ul>
                            )}
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
                <span className={`text-xs px-2.5 py-1 rounded-full border font-medium ${
                  r.status === '可審查'     ? 'bg-emerald-50 border-emerald-200 text-emerald-700' :
                  r.status === '植物待確認' ? 'bg-amber-50 border-amber-200 text-amber-700' :
                                              'bg-stone-50 border-stone-200 text-stone-500'
                }`}>{r.status}</span>
                {r.evalResult && (
                  <span className={`text-sm px-3 py-1 rounded-full border font-semibold ${COMPAT_CLS[r.evalResult.compatLevel] ?? ''}`}>
                    {r.evalResult.score}/100 · {r.evalResult.compatLevel}
                  </span>
                )}
                {dangerCnt > 0  && <span className="text-xs px-2 py-0.5 rounded-full bg-red-50 border border-red-200 text-red-700 font-semibold">⚠ 高風險 {dangerCnt} 項</span>}
                {cautionCnt > 0 && <span className="text-xs px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-700 font-semibold">注意 {cautionCnt} 項</span>}
              </div>

              {/* ── 地被 / 鋪面 HATCH（正式資料來源：hatchPlants）── */}
              {(() => {
                const hp = r.hatchPlants
                if (!hp) return null
                const allItems = [...hp.confirmed, ...hp.candidates]
                const totalHatch = allItems.length + hp.unmatchedCount
                if (allItems.length > 0) {
                  return (
                    <div className="rounded-xl border border-emerald-300 overflow-hidden">
                      <div className="px-4 py-2.5 bg-emerald-600">
                        <p className="text-xs font-bold text-white">{r.zoneName}｜地被 / 鋪面 HATCH（{allItems.length} 種）</p>
                      </div>
                      <div className="divide-y divide-stone-100">
                        {hp.confirmed.map((h, i) => (
                          <div key={`c${i}`} className="px-4 py-2.5 flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-stone-800 text-sm">{h.plantName}</span>
                            {h.legendCode && <span className="text-xs text-stone-500">索引表 {h.legendCode}</span>}
                            <span className="text-xs text-emerald-700">信心度 {h.confidence}%</span>
                            <span className="text-xs text-stone-400">來源：{h.source}</span>
                          </div>
                        ))}
                        {hp.candidates.map((h, i) => (
                          <div key={`k${i}`} className="px-4 py-2.5 flex items-center gap-2 flex-wrap bg-amber-50/40">
                            <span className="font-semibold text-stone-800 text-sm">{h.plantName}</span>
                            {h.legendCode && <span className="text-xs text-stone-500">索引表 {h.legendCode}</span>}
                            <span className="text-xs text-amber-700">信心度 {h.confidence}%（候選，需人工確認）</span>
                            <span className="text-xs text-stone-400">來源：{h.source}</span>
                          </div>
                        ))}
                      </div>
                      {hp.unmatchedCount > 0 && (
                        <div className="px-4 py-1.5 bg-stone-50 border-t border-stone-100 text-xs text-stone-400">
                          另有 {hp.unmatchedCount} 個 HATCH 未能穩定對應索引表圖例
                        </div>
                      )}
                    </div>
                  )
                }
                if (totalHatch > 0) {
                  return (
                    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                      <p className="text-sm font-semibold text-amber-800">
                        本區有 HATCH {totalHatch} 個，但尚未能穩定對應索引表圖例
                      </p>
                    </div>
                  )
                }
                return null
              })()}

              {/* 本區已辨識植物（只顯示有植物名稱的條目）*/}
              {(() => {
                const plantMap = new Map(r.plants.map(p => [p.name, p]))
                return visibleEntries.length > 0 ? (
                  <div className="rounded-xl border border-stone-200 overflow-hidden">
                    <div className="px-4 py-2.5 bg-stone-50 border-b border-stone-100">
                      <p className="text-xs font-semibold text-stone-700">
                        {r.zoneName}｜已判讀植物（{visibleEntries.length} 種）
                      </p>
                    </div>
                    <div className="divide-y divide-stone-100">
                      {visibleEntries.map((b, i) => {
                        const dbPlant = b.plantName ? plantMap.get(b.plantName) : undefined
                        const legendRow = r.finalReviewResults.find(fr => fr.matchedPlantName === b.plantName)
                        return (
                          <div key={i} className="px-4 py-2.5">
                            <div className="flex items-start gap-3">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="font-semibold text-stone-800 text-sm">{b.plantName}</span>
                                  {legendRow?.matchedLegendRow && (
                                    <span className="text-xs text-stone-500">索引表 {legendRow.matchedLegendRow}</span>
                                  )}
                                  {legendRow?.matchScore != null && legendRow.matchScore > 0 && (
                                    <span className="text-xs text-stone-400">信心度 {legendRow.matchScore}%</span>
                                  )}
                                  <span className={`text-xs px-1.5 py-0.5 rounded-full border font-medium ${
                                    b.matchStatus === 'db-matched' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' :
                                    'bg-amber-50 border-amber-200 text-amber-600'
                                  }`}>
                                    {dbPlant?.subCategory || dbPlant?.category || b.detectedType || '面狀植栽'}
                                  </span>
                                </div>
                                {dbPlant && (
                                  <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-1 text-xs text-stone-500">
                                    {dbPlant.height && <span>樹高 {dbPlant.height}</span>}
                                    {dbPlant.sunRequirement && <span>日照 {dbPlant.sunRequirement}</span>}
                                    {dbPlant.waterRequirement && <span>需水 {dbPlant.waterRequirement}</span>}
                                    {dbPlant.maintenanceLevel && <span>維護 {dbPlant.maintenanceLevel}</span>}
                                  </div>
                                )}
                                <p className="text-xs text-stone-400 mt-0.5">{sourceLabel(b)}</p>
                              </div>
                              <div className="flex-shrink-0 text-right">
                                <span className="text-base font-bold text-stone-700">{b.count}</span>
                                <span className="text-xs text-stone-400 ml-0.5">株</span>
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                    {/* 未辨識統計（預設收合，供除錯）*/}
                    {(unmatchedHatch > 0 || unmatchedPoly > 0) && (
                      <details className="border-t border-stone-100">
                        <summary className="px-4 py-2 text-xs text-stone-400 cursor-pointer hover:text-stone-600">
                          顯示技術資料（未辨識：HATCH × {unmatchedHatch}，邊界 × {unmatchedPoly}）
                        </summary>
                        <div className="px-4 py-2 text-xs text-stone-400">
                          <p>• 未能與索引表圖例穩定對應的 HATCH：{unmatchedHatch} 個</p>
                          <p>• 空間邊界線（非植栽）：{unmatchedPoly} 個</p>
                          <p className="mt-1 text-stone-300">以上物件已排除於審查結果外，若需確認請查閱 DXF 原圖索引表。</p>
                        </div>
                      </details>
                    )}
                  </div>
                ) : (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                    <p className="text-sm font-semibold text-amber-800">本區尚未偵測到可穩定對應索引表的 HATCH 圖例。</p>
                    {(unmatchedHatch > 0 || unmatchedPoly > 0) && (
                      <details className="mt-2">
                        <summary className="text-xs text-amber-600 cursor-pointer">顯示技術資料</summary>
                        <div className="mt-1 text-xs text-amber-600 space-y-0.5">
                          <p>• 未辨識 HATCH：{unmatchedHatch} 個</p>
                          <p>• 空間邊界線：{unmatchedPoly} 個</p>
                        </div>
                      </details>
                    )}
                  </div>
                )
              })()}

              {/* AI 審查建議（置頂）*/}
              {r.evalResult && (
                <div className="p-4 bg-stone-50 border border-stone-200 rounded-xl">
                  <p className="text-xs font-semibold text-stone-600 mb-1">AI 審查建議</p>
                  <p className="text-sm text-stone-700">{r.evalResult.aiSuggestion}</p>
                </div>
              )}

              {/* 植物待確認提示 */}
              {r.status === '植物待確認' && (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-800">
                  {r.plants.length === 1
                    ? `僅找到 1 種已確認植物（${r.plants[0].name}），需 ≥ 2 種才能執行完整評分。`
                    : `本區有 ${unmatchedBlks.length} 個圖塊尚未對應植物名稱，請至「圖塊對應」tab 完成指定後可產生完整審查報告。`}
                  {nameOnlyBlocks.length > 0 && (
                    <span className="block mt-1">
                      索引表有名稱但 DB 無記錄：{nameOnlyBlocks.map(b => b.plantName).join('、')}（請匯入含這些植物的 CSV 資料庫）
                    </span>
                  )}
                </div>
              )}
              {r.status === '無法審查' && (
                <div className="p-3 bg-stone-50 border border-stone-200 rounded-xl text-xs text-stone-500">
                  此區尚無任何圖塊或分區邊界未偵測到，無法執行審查。
                </div>
              )}

              {/* 問題明細 */}
              {r.evalResult && r.evalResult.issues.filter(i => i.level !== 'ok').length > 0 && (
                <details open>
                  <summary className="text-xs font-semibold text-stone-600 cursor-pointer select-none mb-2">
                    問題明細（{r.evalResult.issues.filter(i => i.level !== 'ok').length} 項）
                  </summary>
                  <div className="space-y-2 mt-2">
                    {r.evalResult.issues.filter(i => i.level !== 'ok').map((iss, i) => (
                      <div key={i} className={`rounded-xl p-3 ${ISSUE_CLS[iss.level]}`}>
                        <div className="flex items-center gap-2 mb-1">
                          <AlertTriangle size={13} className={iss.level === 'danger' ? 'text-red-500' : 'text-amber-500'} />
                          <span className="text-xs font-bold text-stone-700">{iss.category}</span>
                        </div>
                        <p className="text-xs text-stone-700 mb-1"><strong>原因：</strong>{iss.cause}</p>
                        <p className="text-xs text-stone-600 mb-1"><strong>影響：</strong>{iss.impact}</p>
                        <p className="text-xs text-stone-600"><strong>建議：</strong>{iss.suggestion}</p>
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {/* 配置調整方案 */}
              {r.evalResult && r.evalResult.adjustmentPlan.length > 0 && (
                <div className="p-4 bg-blue-50 border border-blue-200 rounded-xl">
                  <p className="text-xs font-semibold text-blue-800 mb-2">配置調整方案</p>
                  <ul className="space-y-1">
                    {r.evalResult.adjustmentPlan.map((p, i) => (
                      <li key={i} className="text-xs text-blue-700 flex items-start gap-2">
                        <ArrowRight size={11} className="flex-shrink-0 mt-0.5" />{p}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* 植栽清單（可收合）*/}
              <details>
                <summary className="text-xs font-semibold text-stone-600 cursor-pointer select-none">
                  本區植栽清單（共 {totalCount} 株 / {r.blockEntries.length} 種）
                </summary>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full text-xs border-collapse">
                    <thead>
                      <tr className="bg-stone-50">
                        <th className="px-3 py-1.5 text-left text-stone-500 border border-stone-100">圖塊名稱</th>
                        <th className="px-3 py-1.5 text-left text-stone-500 border border-stone-100">植物名稱</th>
                        <th className="px-3 py-1.5 text-left text-stone-500 border border-stone-100">識別類型</th>
                        <th className="px-3 py-1.5 text-center text-stone-500 border border-stone-100">數量</th>
                        <th className="px-3 py-1.5 text-left text-stone-500 border border-stone-100">狀態</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleEntries.map((b, i) => (
                        <tr key={i} className={`border border-stone-100 ${
                          b.matchStatus === 'db-matched' ? 'bg-emerald-50/40' :
                          b.matchStatus === 'name-only'  ? 'bg-amber-50/40'   : 'bg-red-50/20'
                        }`}>
                          {/* 來源（替代原始 blockName，避免 DXF 技術字串污染 UI）*/}
                          <td className="px-3 py-1.5 text-xs text-stone-500">{sourceLabel(b)}</td>
                          <td className="px-3 py-1.5 font-medium text-stone-800">
                            {b.plantName
                              ?? (isHatchEntry(b)
                                ? <span className="text-stone-400 italic text-xs">未能與索引表圖例穩定對應</span>
                                : <span className="text-stone-400 italic text-xs">未對應</span>)}
                          </td>
                          <td className="px-3 py-1.5 text-stone-500">{b.detectedType ?? '—'}</td>
                          <td className="px-3 py-1.5 text-center font-semibold text-stone-700">{b.count}</td>
                          <td className="px-3 py-1.5">
                            {b.matchStatus === 'db-matched' && <span className="text-emerald-600 text-xs">✅ DB</span>}
                            {b.matchStatus === 'name-only'  && <span className="text-amber-600 text-xs">⚠ 索引表名稱</span>}
                            {b.matchStatus === 'unmatched'  && <span className="text-red-500 text-xs">❌ 未識別</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {r.areaTypes.length > 0 && (
                  <p className="mt-1.5 text-xs text-stone-400">面狀範圍：{r.areaTypes.join('、')}</p>
                )}
              </details>

              {/* 面狀植栽待補充 */}
              {r.areaLayerNotes.length > 0 && (
                <div className="p-2.5 bg-blue-50 border border-blue-200 rounded-xl text-xs text-blue-800">
                  <strong>📐 面狀植栽待補充：</strong>
                  以下 HATCH 有識別到種植範圍，但圖層名稱未含植物名稱，請確認：
                  <ul className="mt-1 space-y-0.5">
                    {r.areaLayerNotes.map((note, i) => (
                      <li key={i} className="font-mono">· {note}</li>
                    ))}
                  </ul>
                  <p className="mt-1 text-blue-600">
                    在 AutoCAD 將 HATCH 圖層改名為含植物名稱（例如「地被-麥門冬」）後重新上傳，系統可自動識別。
                  </p>
                </div>
              )}

              {/* 審查回覆文字（預設收合）*/}
              {r.evalResult && (
                <details className="rounded-xl border border-stone-200 overflow-hidden">
                  <summary className="px-4 py-2.5 bg-stone-50 text-xs font-semibold text-stone-600 cursor-pointer">
                    {r.zoneName} 審查回覆文字（可複製）
                  </summary>
                  <div className="px-4 py-3 text-xs text-stone-700 whitespace-pre-wrap leading-relaxed bg-white">
                    {r.evalResult.reviewText}
                  </div>
                </details>
              )}
            </div>
          )
        })()}
      </div>
    </div>
  )
}

// ── Zone Plan tab ────────────────────────────────────────────────────────────

// 用於顯示診斷的 zone label 正規式（與 spatialAnalysis.ts 一致）
const DIAG_ZONE_RE =
  /^([A-Z一二三四五六七八九十甲乙丙丁戊己庚辛壬癸]{1,3}[區区]|[A-Z0-9]{1,2}[區区]|景觀[A-Z0-9一二三四五六]|植栽[A-Z0-9一二三四五六]|分區[A-Z0-9一二三四五六])$/

function ZonePlanTab({
  zonePlantLists,
  detectedZones,
  texts,
  polygons,
  mappings,
  totalInserts,
  zoneDebug,
  zoneReviews,
}: {
  zonePlantLists: ZonePlantList[]
  detectedZones: DetectedZone[]
  texts: DxfParseResult['texts']
  polygons: DxfParseResult['polygons']
  mappings: MappedItem[]
  totalInserts: number
  zoneDebug: ZoneAssignDebug | null
  zoneReviews: ZoneReviewResult[]
}) {
  // ── 原始資料（不過任何 filter）──────────────────────────────────────────────
  const rawTextsWithZone = texts.filter(t => t.content.includes('區') || t.content.includes('区') ||
    t.content.includes('区') || /^[A-Z]$/.test(t.content.trim()))
  // ── 診斷：從所有文字中找含「區」字或像分區標籤的候選 ──────────────────────
  const zoneKeywordTexts = texts.filter(t => t.content.includes('區') || t.content.includes('区'))
  const matchedCandidates = texts.filter(t => DIAG_ZONE_RE.test(t.content.trim()))
  const nearMissCandidates = zoneKeywordTexts.filter(t => !DIAG_ZONE_RE.test(t.content.trim()))
  const withBoundary = detectedZones.filter(z => z.boundary).length
  const noBoundary   = detectedZones.length - withBoundary

  return (
    <div className="space-y-5">

      {/* ── 0. 原始資料 DEBUG（隱藏於正式版，需要時可在此展開）──────── */}
      {false && <details className="rounded-xl border border-stone-200 bg-stone-50 overflow-hidden">
        <summary className="px-4 py-2.5 text-xs font-semibold text-stone-500 cursor-pointer select-none hover:bg-stone-100 transition-colors">
          🔍 原始資料 Debug（資料流驗證）— 點擊展開
        </summary>
      <div className="p-4">
        <div className="grid grid-cols-2 gap-3 mb-3 text-sm">
          <div className={`px-3 py-2 rounded-xl border font-medium ${texts.length === 0 ? 'bg-red-50 border-red-300 text-red-700' : 'bg-white border-purple-200 text-purple-800'}`}>
            result.texts 長度：<strong>{texts.length}</strong>
            {texts.length === 0 && <span className="ml-2 text-xs">⚠️ Parser 回傳 0 個文字</span>}
          </div>
          <div className="px-3 py-2 rounded-xl border bg-white border-purple-200 text-purple-800 font-medium">
            polygons 長度：<strong>{polygons.length}</strong>
          </div>
          <div className={`px-3 py-2 rounded-xl border font-medium ${zoneKeywordTexts.length === 0 ? 'bg-amber-50 border-amber-300 text-amber-700' : 'bg-emerald-50 border-emerald-200 text-emerald-800'}`}>
            含「區」字文字（state）：<strong>{zoneKeywordTexts.length}</strong>
          </div>
          <div className={`px-3 py-2 rounded-xl border font-medium ${detectedZones.length === 0 ? 'bg-amber-50 border-amber-300 text-amber-700' : 'bg-emerald-50 border-emerald-200 text-emerald-800'}`}>
            detectedZones（state）：<strong>{detectedZones.length}</strong>
          </div>
        </div>

        {/* 前 20 個文字（不過任何 filter）*/}
        {texts.length > 0 && (
          <details>
            <summary className="text-xs font-semibold text-stone-500 cursor-pointer mb-1">
              前 {Math.min(texts.length, 30)} 個文字原始內容（共 {texts.length} 個，不過任何 filter）
            </summary>
            <div className="max-h-40 overflow-y-auto mt-1">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-purple-100 text-purple-700">
                    <th className="px-2 py-1 text-left">#</th>
                    <th className="px-2 py-1 text-left">內容（rawText）</th>
                    <th className="px-2 py-1 text-left">X</th>
                    <th className="px-2 py-1 text-left">Y</th>
                    <th className="px-2 py-1 text-left">圖層</th>
                    <th className="px-2 py-1 text-left">含區/A/B/C</th>
                  </tr>
                </thead>
                <tbody>
                  {texts.slice(0, 30).map((t, i) => {
                    const hasZone = t.content.includes('區') || t.content.includes('区')
                    const isLetter = /^[A-C]$/.test(t.content.trim())
                    const highlight = hasZone || isLetter
                    return (
                      <tr key={i} className={highlight ? 'bg-yellow-100 font-bold' : ''}>
                        <td className="px-2 py-0.5 text-stone-400">{i + 1}</td>
                        <td className="px-2 py-0.5 font-mono text-stone-800 max-w-[200px]">「{t.content}」</td>
                        <td className="px-2 py-0.5 font-mono text-stone-500">{t.x.toFixed(0)}</td>
                        <td className="px-2 py-0.5 font-mono text-stone-500">{t.y.toFixed(0)}</td>
                        <td className="px-2 py-0.5 text-stone-400">{t.layer || '—'}</td>
                        <td className="px-2 py-0.5">
                          {hasZone && <span className="text-emerald-600">✅ 含區</span>}
                          {isLetter && <span className="text-blue-600">🔤 字母</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </details>
        )}

        {/* detectedZones 原始結果 */}
        <div className="mt-2 text-xs">
          <span className="font-semibold text-purple-700">detectedZones state：</span>
          {detectedZones.length === 0
            ? <span className="text-amber-600 ml-1">空陣列（[]）— 尚未偵測到任何分區</span>
            : <span className="text-emerald-600 ml-1">{detectedZones.map(z => `${z.name}(${z.source})`).join(', ')}</span>}
        </div>

        {texts.length === 0 && (
          <div className="mt-2 p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-700">
            ⚠️ result.texts 為空陣列，代表 DXF parser 沒有解析到任何文字。可能原因：
            <ul className="mt-1 ml-3 space-y-0.5 list-disc">
              <li>*Model_Space block 沒有找到（block 命名不同）</li>
              <li>ENTITIES section 也是空的</li>
              <li>文字被 explode 成 LINE（不是文字實體）</li>
              <li>中文編碼轉換失敗導致空字串被過濾</li>
            </ul>
            <p className="mt-1">請開啟瀏覽器 F12 Console 查看 [DXF Zone Debug] 輸出，取得更多診斷資訊。</p>
          </div>
        )}
      </div>
      </details>}

      {/* ── 1. 分區辨識狀態摘要 ───────────────────────────────────────────── */}
      <div className="rounded-2xl border border-stone-200 bg-white p-5">
        <p className="text-sm font-semibold text-stone-700 mb-3">分區辨識狀態</p>
        <div className="grid grid-cols-2 gap-3 mb-4">
          {[
            { label: '已解析文字總數', value: texts.length, cls: texts.length === 0 ? 'bg-red-50 border-red-200 text-red-700' : 'bg-stone-50 border-stone-200 text-stone-700' },
            { label: '含「區」字文字', value: zoneKeywordTexts.length, cls: 'bg-stone-50 border-stone-200 text-stone-700' },
            { label: '符合分區命名格式', value: matchedCandidates.length, cls: 'bg-blue-50 border-blue-200 text-blue-800' },
            { label: '已偵測到分區標籤', value: detectedZones.length, cls: detectedZones.length > 0 ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-red-50 border-red-200 text-red-700' },
            { label: '找到邊界多邊形', value: withBoundary, cls: withBoundary > 0 ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-amber-50 border-amber-200 text-amber-700' },
            { label: '僅文字標籤（無邊界）', value: noBoundary, cls: noBoundary > 0 ? 'bg-amber-50 border-amber-200 text-amber-700' : 'bg-stone-50 border-stone-200 text-stone-400' },
            { label: '圖面 HATCH / 多邊形', value: polygons.length, cls: 'bg-stone-50 border-stone-200 text-stone-700' },
          ].map(s => (
            <div key={s.label} className={`flex items-center justify-between px-4 py-2.5 rounded-xl border text-sm font-medium ${s.cls}`}>
              <span>{s.label}</span>
              <span className="text-lg font-bold ml-3">{s.value}</span>
            </div>
          ))}
        </div>

        {/* 目前分區審查完成度說明 */}
        {detectedZones.length === 0 ? (
          <div className="flex items-start gap-3 p-4 bg-red-50 border border-red-200 rounded-xl">
            <AlertTriangle size={16} className="text-red-500 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-red-800">尚未完成分區空間對應</p>
              <ul className="text-xs text-red-600 mt-1 space-y-1">
                <li>✅ 已讀取植栽索引表</li>
                <li>✅ 已產生全區審查（請至 AI 配植頁面查看）</li>
                <li>❌ 未讀到 A區 / B區 / C區 文字標籤</li>
                <li>❌ 未完成 zonePlantList 分區對應</li>
                <li>❌ 尚未能產生每分區獨立審查報告</li>
              </ul>
            </div>
          </div>
        ) : withBoundary === 0 ? (
          <div className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-xl">
            <AlertTriangle size={16} className="text-amber-500 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-amber-800">已讀到分區文字，但未找到邊界多邊形</p>
              <ul className="text-xs text-amber-700 mt-1 space-y-1">
                <li>✅ 已讀取植栽索引表</li>
                <li>✅ 已讀到分區文字標籤（{detectedZones.map(z => z.name).join('、')}）</li>
                <li>⚠️ 分區邊界多邊形未找到：圖塊 / HATCH 無法判斷分屬哪一區</li>
                <li>❌ zonePlantList 空白，無法產生分區審查</li>
              </ul>
              <p className="text-xs text-amber-600 mt-2">
                請確認圖面中分區邊界是否為封閉 LWPOLYLINE 或 HATCH，且包覆對應的分區文字標籤。
              </p>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-3 p-4 bg-emerald-50 border border-emerald-200 rounded-xl">
            <CheckCircle size={16} className="text-emerald-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-emerald-800">分區空間對應進行中</p>
              <ul className="text-xs text-emerald-700 mt-1 space-y-1">
                <li>✅ 已讀取植栽索引表</li>
                <li>✅ 已讀到分區標籤：{detectedZones.map(z => z.name).join('、')}</li>
                <li>✅ {withBoundary} 個分區找到邊界多邊形</li>
                <li>✅ 已產生 zonePlantList（詳見下方各區卡片）</li>
                {noBoundary > 0 && <li>⚠️ {noBoundary} 個分區無邊界，無法判斷範圍內容</li>}
              </ul>
            </div>
          </div>
        )}
      </div>

      {/* ── 2. 所有 TEXT / MTEXT 原始內容 ────────────────────────────────── */}
      <details className="rounded-2xl border border-stone-200 bg-white overflow-hidden">
        <summary className="px-5 py-3.5 bg-stone-50 text-sm font-semibold text-stone-700 cursor-pointer select-none">
          所有 TEXT / MTEXT / ATTRIB（共 {texts.length} 個，點展開查看）
        </summary>
        <div className="px-5 py-4 max-h-72 overflow-y-auto">
          {texts.length === 0
            ? <p className="text-sm text-red-500">⚠️ 未解析到任何文字，可能是編碼問題或圖面無 TEXT/MTEXT/ATTRIB 實體。</p>
            : <table className="w-full text-xs">
                <thead>
                  <tr className="bg-stone-50 border-b border-stone-100">
                    <th className="px-2 py-1 text-left text-stone-500">圖層</th>
                    <th className="px-2 py-1 text-left text-stone-500">內容</th>
                    <th className="px-2 py-1 text-left text-stone-500">X</th>
                    <th className="px-2 py-1 text-left text-stone-500">Y</th>
                    <th className="px-2 py-1 text-left text-stone-500">含區字</th>
                  </tr>
                </thead>
                <tbody>
                  {texts.slice(0, 200).map((t, i) => {
                    const hasZone = t.content.includes('區') || t.content.includes('区')
                    return (
                      <tr key={i} className={`border-b border-stone-50 ${hasZone ? 'bg-blue-50' : ''}`}>
                        <td className="px-2 py-1 font-mono text-stone-400">{t.layer || '—'}</td>
                        <td className="px-2 py-1 font-medium text-stone-800 max-w-[180px] truncate">「{t.content}」</td>
                        <td className="px-2 py-1 font-mono text-stone-400">{t.x.toFixed(1)}</td>
                        <td className="px-2 py-1 font-mono text-stone-400">{t.y.toFixed(1)}</td>
                        <td className="px-2 py-1">{hasZone ? '✅' : ''}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>}
          {texts.length > 200 && <p className="text-xs text-stone-400 mt-2">顯示前 200 筆，共 {texts.length} 筆</p>}
        </div>
      </details>

      {/* ── 3. 所有 HATCH / polyline 詳情 ────────────────────────────────── */}
      <details className="rounded-2xl border border-stone-200 bg-white overflow-hidden">
        <summary className="px-5 py-3.5 bg-stone-50 text-sm font-semibold text-stone-700 cursor-pointer select-none">
          所有 HATCH / polyline（共 {polygons.length} 個，點展開查看）
        </summary>
        <div className="px-5 py-4 max-h-72 overflow-y-auto">
          {polygons.length === 0
            ? <p className="text-sm text-stone-400">未解析到 HATCH / polyline。</p>
            : <table className="w-full text-xs">
                <thead>
                  <tr className="bg-stone-50 border-b border-stone-100">
                    <th className="px-2 py-1 text-left text-stone-500">#</th>
                    <th className="px-2 py-1 text-left text-stone-500">來源</th>
                    <th className="px-2 py-1 text-left text-stone-500">圖層</th>
                    <th className="px-2 py-1 text-left text-stone-500">類型</th>
                    <th className="px-2 py-1 text-left text-stone-500">頂點數</th>
                    <th className="px-2 py-1 text-left text-stone-500">中心 X</th>
                    <th className="px-2 py-1 text-left text-stone-500">中心 Y</th>
                    <th className="px-2 py-1 text-left text-stone-500">封閉</th>
                    <th className="px-2 py-1 text-left text-stone-500">分區邊界</th>
                  </tr>
                </thead>
                <tbody>
                  {polygons.map((p, i) => {
                    const n = p.vertices.length
                    const cx = n > 0 ? p.vertices.reduce((s, v) => s + v.x, 0) / n : 0
                    const cy = n > 0 ? p.vertices.reduce((s, v) => s + v.y, 0) / n : 0
                    const isZoneBoundary = detectedZones.some(z => z.boundary === p)
                    const zoneForThis = detectedZones.find(z => z.boundary === p)
                    return (
                      <tr key={i} className={`border-b border-stone-50 ${isZoneBoundary ? 'bg-emerald-50' : ''}`}>
                        <td className="px-2 py-1 text-stone-400">{i + 1}</td>
                        <td className="px-2 py-1 font-mono text-stone-600">{p.source}</td>
                        <td className="px-2 py-1 font-mono text-stone-500">{p.layer || '—'}</td>
                        <td className="px-2 py-1 text-stone-500">{p.zoneType}</td>
                        <td className="px-2 py-1 text-stone-500">{n}</td>
                        <td className="px-2 py-1 font-mono text-stone-400">{cx.toFixed(0)}</td>
                        <td className="px-2 py-1 font-mono text-stone-400">{cy.toFixed(0)}</td>
                        <td className="px-2 py-1">{p.closed ? '✓' : '✕'}</td>
                        <td className="px-2 py-1">
                          {isZoneBoundary
                            ? <span className="text-emerald-600 font-semibold">✅ {zoneForThis?.name}</span>
                            : <span className="text-stone-300">—</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>}
        </div>
      </details>

      {/* ── 2b. 植栽歸區 debug 統計 ──────────────────────────────────────── */}
      {zoneDebug && (
        <details className="rounded-xl border border-stone-200 bg-stone-50 overflow-hidden">
          <summary className="px-4 py-2.5 text-xs font-semibold text-stone-500 cursor-pointer select-none hover:bg-stone-100 transition-colors">
            🔎 植栽歸區 Debug（對照 AutoCAD 原圖用）— 點擊展開
          </summary>
        <div className="p-4 space-y-3">
          <p className="text-sm font-bold text-stone-700">植栽歸區 Debug（對照 AutoCAD 原圖用）</p>

          {/* 總統計 */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: '全部 INSERT（圖塊）', value: totalInserts, cls: 'bg-white border-orange-200 text-orange-800' },
              { label: '系統識別為植栽', value: mappings.length, cls: 'bg-white border-blue-200 text-blue-800' },
              { label: '成功歸入分區', value: zoneDebug.assignedCount, cls: 'bg-white border-emerald-200 text-emerald-800' },
              { label: '未歸入任何分區', value: zoneDebug.unassigned.length, cls: zoneDebug.unassigned.length > 0 ? 'bg-red-50 border-red-300 text-red-700' : 'bg-white border-stone-200 text-stone-400' },
            ].map(s => (
              <div key={s.label} className={`flex items-center justify-between px-3 py-2 rounded-xl border text-sm font-medium ${s.cls}`}>
                <span className="text-xs">{s.label}</span>
                <span className="text-lg font-bold ml-2">{s.value}</span>
              </div>
            ))}
          </div>

          {/* 每分區 bbox + 圖塊清單 */}
          <div>
            <p className="text-xs font-bold text-orange-700 mb-2">每分區邊界 BBox 與歸入圖塊</p>
            <div className="space-y-2">
              {zoneDebug.perZone.map((z, i) => (
                <div key={i} className={`rounded-xl border p-3 text-xs ${z.hasBoundary ? 'bg-white border-emerald-200' : 'bg-amber-50 border-amber-300'}`}>
                  <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                    <span className="font-bold text-stone-800">{z.name}</span>
                    <span className={z.hasBoundary ? 'text-emerald-600' : 'text-amber-600'}>
                      {z.hasBoundary ? '✅ 有邊界' : '⚠️ 無邊界（無法 PiP）'}
                    </span>
                    <span className="text-stone-500">歸入圖塊種類：{z.blockCount}</span>
                  </div>
                  {z.bbox && (
                    <p className="font-mono text-stone-500 mb-1.5">
                      BBox: X [{z.bbox.minX.toFixed(1)} → {z.bbox.maxX.toFixed(1)}]
                      &nbsp; Y [{z.bbox.minY.toFixed(1)} → {z.bbox.maxY.toFixed(1)}]
                      &nbsp; 寬 {z.bbox.width.toFixed(1)}　高 {z.bbox.height.toFixed(1)}
                    </p>
                  )}
                  {z.blocks.length > 0
                    ? <div className="flex flex-wrap gap-1.5">
                        {z.blocks.map((b, j) => (
                          <span key={j} className="px-2 py-0.5 rounded-lg bg-stone-100 text-stone-700 font-mono">
                            {b.blockName} （區內 {b.positionsInZone} / 共 {b.totalCount}）
                          </span>
                        ))}
                      </div>
                    : <p className="text-amber-600">此區內無圖塊{z.hasBoundary ? '——座標可能落在邊界外，見下方未歸區清單' : ''}</p>}
                </div>
              ))}
            </div>
          </div>

          {/* 所有植栽圖塊分類清單 */}
          <details>
            <summary className="text-xs font-bold text-stone-600 cursor-pointer">
              所有圖塊分類清單（植栽 / 非植栽 / 歸區狀況）— {mappings.length + (totalInserts - mappings.length)} 個圖塊種類
            </summary>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="bg-orange-100 text-orange-800">
                    <th className="px-2 py-1.5 text-left">BLOCK 名稱</th>
                    <th className="px-2 py-1.5 text-center">總數</th>
                    <th className="px-2 py-1.5 text-left">是否植栽</th>
                    <th className="px-2 py-1.5 text-left">識別原因</th>
                    <th className="px-2 py-1.5 text-left">歸入分區</th>
                  </tr>
                </thead>
                <tbody>
                  {mappings.map((m, i) => {
                    const zones = zoneDebug.perZone
                      .filter(z => z.blocks.some(b => b.blockName === m.blockName))
                      .map(z => z.name)
                    return (
                      <tr key={i} className={`border-b border-orange-100 ${zones.length > 0 ? 'bg-emerald-50' : ''}`}>
                        <td className="px-2 py-1.5 font-mono text-stone-700">{m.blockName}</td>
                        <td className="px-2 py-1.5 text-center text-stone-600">{m.count}</td>
                        <td className="px-2 py-1.5">
                          <span className="px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">✅ 植栽</span>
                        </td>
                        <td className="px-2 py-1.5 text-stone-500 max-w-[160px]">
                          {m.detectedType || '—'}
                          {m.matchStatus === 'matched' ? ' · 已對應' : m.matchStatus === 'partial' ? ' · 推測中' : ' · 未對應'}
                        </td>
                        <td className="px-2 py-1.5">
                          {zones.length > 0
                            ? <span className="text-emerald-700 font-semibold">{zones.join('、')}</span>
                            : <span className="text-red-500">⚠️ 未歸區</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </details>

          {/* ── 每棵樹 per-instance debug 表格 ── */}
          {zoneDebug.instances.length > 0 && (
            <details>
              <summary className="text-xs font-bold text-stone-600 cursor-pointer">
                每棵樹 / 每個 INSERT 實例詳細歸區結果（共 {zoneDebug.instances.length} 個）
              </summary>
              <div className="mt-2 overflow-x-auto max-h-80 overflow-y-auto">
                <table className="w-full text-xs border-collapse">
                  <thead className="sticky top-0 z-10">
                    <tr className="bg-orange-100 text-orange-800">
                      <th className="px-2 py-1.5 text-left whitespace-nowrap">BLOCK 名稱</th>
                      <th className="px-2 py-1.5 text-left whitespace-nowrap">圖層</th>
                      <th className="px-2 py-1.5 whitespace-nowrap">Insert X</th>
                      <th className="px-2 py-1.5 whitespace-nowrap">Insert Y</th>
                      <th className="px-2 py-1.5 whitespace-nowrap">BBox Cx</th>
                      <th className="px-2 py-1.5 whitespace-nowrap">BBox Cy</th>
                      <th className="px-2 py-1.5 whitespace-nowrap">Scale</th>
                      <th className="px-2 py-1.5 whitespace-nowrap">Rot°</th>
                      <th className="px-2 py-1.5 whitespace-nowrap">歸屬分區</th>
                      <th className="px-2 py-1.5 whitespace-nowrap">判斷方法</th>
                      <th className="px-2 py-1.5 text-left">未歸區原因 / 說明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {zoneDebug.instances.map((inst, i) => (
                      <tr key={i} className={`border-b border-orange-50 ${
                        inst.assignedZone === '未歸區' ? 'bg-red-50' : 'bg-emerald-50/40'
                      }`}>
                        <td className="px-2 py-1 font-mono text-stone-700 whitespace-nowrap">{inst.blockName}</td>
                        <td className="px-2 py-1 text-stone-400 whitespace-nowrap">{inst.layer || '—'}</td>
                        <td className="px-2 py-1 font-mono text-stone-600 text-right">{inst.insertX.toFixed(1)}</td>
                        <td className="px-2 py-1 font-mono text-stone-600 text-right">{inst.insertY.toFixed(1)}</td>
                        <td className="px-2 py-1 font-mono text-blue-600 text-right">
                          {inst.bboxCenterX !== undefined ? inst.bboxCenterX.toFixed(1) : '—'}
                        </td>
                        <td className="px-2 py-1 font-mono text-blue-600 text-right">
                          {inst.bboxCenterY !== undefined ? inst.bboxCenterY.toFixed(1) : '—'}
                        </td>
                        <td className="px-2 py-1 text-stone-500 text-center">
                          {inst.scaleX !== undefined ? `${inst.scaleX.toFixed(2)}×${inst.scaleY?.toFixed(2)}` : '—'}
                        </td>
                        <td className="px-2 py-1 text-stone-500 text-center">
                          {inst.rotation !== undefined ? inst.rotation.toFixed(1) : '—'}
                        </td>
                        <td className="px-2 py-1 font-bold whitespace-nowrap">
                          {inst.assignedZone === '未歸區'
                            ? <span className="text-red-600">⚠ 未歸區</span>
                            : <span className="text-emerald-700">✅ {inst.assignedZone}</span>}
                        </td>
                        <td className="px-2 py-1 text-stone-500 whitespace-nowrap">
                          {inst.method === 'bbox-center' ? '🎯 bbox中心' :
                           inst.method === 'insert-point' ? '📍 插入點' : '—'}
                        </td>
                        <td className="px-2 py-1 text-stone-500 max-w-[200px]">{inst.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-orange-600 mt-2">
                BBox Cx/Cy = block 本地 bbox center 套用 scale/rotation 後的世界座標中心。
                若 BBox 欄顯示「—」代表此 block 沒有找到幾何定義（無 LWPOLYLINE/CIRCLE/HATCH），僅用插入點判斷。
              </p>
            </details>
          )}

          {/* 未歸區圖塊種類彙整 */}
          {zoneDebug.unassigned.length > 0 && (
            <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-xl">
              <p className="text-xs font-bold text-red-700 mb-2">
                ⚠️ 未歸入任何分區的圖塊種類（{zoneDebug.unassigned.length} 種）
              </p>
              <div className="space-y-1">
                {zoneDebug.unassigned.map((b, i) => (
                  <div key={i} className="text-xs font-mono text-red-800">
                    {b.blockName}（{b.count} 株）{b.detectedType ? ` · ${b.detectedType}` : ''}
                    <span className="text-red-500 ml-2">
                      首筆座標: ({b.samplePositions[0]?.x.toFixed(1)}, {b.samplePositions[0]?.y.toFixed(1)})
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-xs text-red-600 mt-2">
                請對照 per-instance 表格確認原因。若座標目視上在分區內卻未歸區，
                可能是 HATCH 邊界頂點錯誤（修正後重新上傳確認）。
              </p>
            </div>
          )}
        </div>
        </details>
      )}

      {/* ── 3. 各分區 zonePlantList ────────────────────────────────────────── */}
      {zonePlantLists.length === 0 && detectedZones.length === 0 ? null : (
        <div>
          <p className="text-sm font-semibold text-stone-700 mb-3">
            各分區植栽配置（{zonePlantLists.length} 區）
          </p>
          {zonePlantLists.length === 0 && (
            <p className="text-sm text-stone-400 italic">分區標籤已偵測，但 zonePlantList 為空——分區邊界可能未成功辨識。</p>
          )}
          {zonePlantLists.map((zpl, idx) => {
            const z = zpl.zone
            const totalPlants = zpl.treeBlocks.filter(tb => tb.plantName).length
            const totalAreas  = zpl.shrubAreas.length + zpl.lawnAreas.length +
                                zpl.groundcoverAreas.length + zpl.unknownAreas.length
            return (
              <div key={idx} className={`rounded-2xl border-2 p-5 mb-4 ${
                z.boundary ? 'border-blue-200 bg-blue-50/10' : 'border-amber-200 bg-amber-50/10'
              }`}>
                {/* 區名 + 狀態 */}
                <div className="flex items-center gap-3 mb-4 flex-wrap">
                  <span className="text-xl font-bold text-stone-800">{z.name}</span>
                  <span className={`text-xs px-2.5 py-1 rounded-full border font-medium ${
                    z.boundary ? 'bg-blue-50 border-blue-200 text-blue-700' : 'bg-amber-50 border-amber-200 text-amber-700'
                  }`}>
                    {z.boundary ? `有邊界（${z.boundary.source}，${z.boundary.vertices.length} 頂點，圖層：${z.boundary.layer || '未知'}）` : '無邊界多邊形'}
                  </span>
                  <span className="text-xs text-stone-500">
                    圖塊 {zpl.treeBlocks.length} 種・植栽範圍 {totalAreas} 個・已知植物 {totalPlants} 種
                  </span>
                </div>

                {!z.boundary && (
                  <div className="mb-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5">
                    ⚠️ 未找到包含「{z.name}」的封閉邊界多邊形——無法執行 point-in-polygon 判斷，圖塊 / HATCH 無法歸入此區。
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  {/* 圖塊 */}
                  <div className="bg-white rounded-xl border border-stone-100 p-3">
                    <p className="text-xs font-semibold text-stone-600 mb-2">
                      區內圖塊（INSERT）— {zpl.treeBlocks.length} 種
                    </p>
                    {zpl.treeBlocks.length === 0
                      ? <p className="text-xs text-stone-400">{z.boundary ? '邊界內無圖塊' : '無邊界，無法判斷'}</p>
                      : zpl.treeBlocks.map((tb, i) => (
                          <div key={i} className="flex items-center gap-2 mb-1">
                            <span className="font-mono text-xs bg-stone-100 px-1.5 py-0.5 rounded">{tb.blockName}</span>
                            {tb.plantName
                              ? <span className="text-xs font-medium text-green-700">{tb.plantName}</span>
                              : <span className="text-xs text-amber-500">植物未確認</span>}
                            <span className="text-xs text-stone-400 ml-auto">{tb.positionsInZone}/{tb.totalCount} 株</span>
                          </div>
                        ))}
                  </div>

                  {/* HATCH / 面狀範圍 */}
                  <div className="bg-white rounded-xl border border-stone-100 p-3">
                    <p className="text-xs font-semibold text-stone-600 mb-2">
                      區內 HATCH / polyline — {totalAreas} 個
                    </p>
                    {totalAreas === 0
                      ? <p className="text-xs text-stone-400">{z.boundary ? '邊界內無面狀範圍' : '無邊界，無法判斷'}</p>
                      : (() => {
                          // 從 zoneReviews 找此區已解析的植物名稱（HATCH 植栽）
                          const review = zoneReviews.find(r => r.zoneName === z.name)
                          // 根據 hatchPattern 或面積類型 lookup 已解析植物
                          const resolvedPlantForArea = (a: import('@/types/dxf').ZonePlantArea, typeLabel: string): string | null => {
                            if (!review) return null
                            // 優先：用 hatchPattern 精確比對
                            if (a.hatchPattern) {
                              const e = review.blockEntries.find(b =>
                                b.plantName && (b.blockName.includes(a.hatchPattern!) || b.blockName.includes(`[HATCH圖例] ${a.hatchPattern}`))
                              )
                              if (e?.plantName) return e.plantName
                            }
                            // 次：找同類型的面狀植栽 entry
                            const e = review.blockEntries.find(b =>
                              b.plantName && b.detectedType === typeLabel &&
                              (b.blockName.startsWith('[HATCH') || b.blockName.startsWith('[面狀'))
                            )
                            return e?.plantName ?? null
                          }
                          // 直接讀 review.hatchPlants（與分區審查 tab 同一資料來源）
                          const hp = review?.hatchPlants
                          const items = hp ? [...hp.confirmed, ...hp.candidates] : []
                          return items.length > 0 ? (
                            <>
                              {items.map((h, i) => (
                                <p key={i} className="text-xs text-green-700 font-medium">
                                  {h.plantName}
                                  {h.legendCode && <span className="text-stone-400 font-normal ml-1">索引表 {h.legendCode}</span>}
                                  <span className="text-stone-400 font-normal ml-1">{h.confidence}%</span>
                                </p>
                              ))}
                              {(hp?.unmatchedCount ?? 0) > 0 && (
                                <p className="text-xs text-stone-400">＋{hp!.unmatchedCount} 個未對應索引表</p>
                              )}
                            </>
                          ) : (
                            <p className="text-xs text-stone-400">尚未對應索引表圖例</p>
                          )
                        })()}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Zones tab ────────────────────────────────────────────────────────────────

const ZONE_STYLE: Record<string, { label: string; cls: string }> = {
  shrub:           { label: '灌木區',     cls: 'bg-green-50 border-green-200 text-green-800' },
  lawn:            { label: '草皮區',     cls: 'bg-lime-50 border-lime-200 text-lime-800' },
  groundcover:     { label: '地被區',     cls: 'bg-emerald-50 border-emerald-200 text-emerald-800' },
  tree:            { label: '喬木種植區', cls: 'bg-teal-50 border-teal-200 text-teal-800' },
  high_irrigation: { label: '高澆灌區',   cls: 'bg-blue-50 border-blue-200 text-blue-800' },
  low_irrigation:  { label: '低澆灌區',   cls: 'bg-cyan-50 border-cyan-200 text-cyan-800' },
  unknown:         { label: '未分類',     cls: 'bg-stone-50 border-stone-200 text-stone-500' },
}

function ZonesTab({ polygons }: { polygons: DxfParseResult['polygons'] }) {
  if (polygons.length === 0) return (
    <div className="flex flex-col items-center justify-center py-20 text-stone-400 gap-3">
      <Layers size={36} className="opacity-30" />
      <p className="text-base font-medium text-stone-500">未偵測到面狀植栽範圍</p>
      <p className="text-sm text-stone-400 text-center max-w-md">
        面狀範圍來自 HATCH（填充）或封閉 LWPOLYLINE 實體。
        若圖面沒有封閉多邊形或 HATCH，此區域不會有資料。
      </p>
    </div>
  )

  const groups = (Object.keys(ZONE_STYLE) as ZoneType[]).map(zt => ({
    zoneType: zt,
    items: polygons.filter(p => p.zoneType === zt),
  })).filter(g => g.items.length > 0)

  const knownZones  = groups.filter(g => g.zoneType !== 'unknown')
  const unknownZones = polygons.filter(p => p.zoneType === 'unknown')

  const hatchCount = polygons.filter(p => p.source === 'HATCH').length
  const lwCount    = polygons.filter(p => p.source === 'LWPOLYLINE').length
  const plCount    = polygons.filter(p => p.source === 'POLYLINE').length

  return (
    <div>
      {/* Summary */}
      <div className="flex gap-2 mb-5 flex-wrap">
        {hatchCount > 0 && (
          <span className="px-3 py-1.5 rounded-xl border border-stone-200 bg-stone-50 text-stone-600 text-xs font-medium">
            HATCH × {hatchCount}
          </span>
        )}
        {lwCount > 0 && (
          <span className="px-3 py-1.5 rounded-xl border border-stone-200 bg-stone-50 text-stone-600 text-xs font-medium">
            LWPOLYLINE × {lwCount}
          </span>
        )}
        {plCount > 0 && (
          <span className="px-3 py-1.5 rounded-xl border border-stone-200 bg-stone-50 text-stone-600 text-xs font-medium">
            POLYLINE × {plCount}
          </span>
        )}
        {groups.map(g => (
          <span key={g.zoneType}
            className={`px-3 py-1.5 rounded-xl border text-xs font-medium ${ZONE_STYLE[g.zoneType].cls}`}>
            {ZONE_STYLE[g.zoneType].label} × {g.items.length}
          </span>
        ))}
      </div>

      {/* Known zones */}
      {knownZones.map(({ zoneType, items }) => {
        const style = ZONE_STYLE[zoneType]
        return (
          <div key={zoneType} className="mb-5">
            <p className={`text-sm font-semibold mb-2 px-3 py-1.5 rounded-lg border inline-flex items-center gap-2 ${style.cls}`}>
              {style.label}（{items.length}）
            </p>
            <div className="bg-white rounded-2xl border border-stone-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-stone-50 border-b border-stone-200">
                    {['來源實體', '圖層', '頂點數', '封閉'].map(h => (
                      <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-stone-500 uppercase">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {items.map((p, idx) => (
                    <tr key={idx} className="border-b border-stone-100 last:border-0 hover:bg-stone-50">
                      <td className="px-4 py-2">
                        <span className="font-mono text-xs bg-stone-100 px-2 py-0.5 rounded">{p.source}</span>
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-stone-600">{p.layer || '（無）'}</td>
                      <td className="px-4 py-2 text-stone-500 text-xs">{p.vertices.length}</td>
                      <td className="px-4 py-2">
                        {p.closed
                          ? <span className="text-xs text-emerald-600">✓ 封閉</span>
                          : <span className="text-xs text-stone-400">開放</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      })}

      {/* Unknown zones */}
      {unknownZones.length > 0 && (
        <div className="mb-5">
          <div className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-2xl mb-3">
            <AlertTriangle size={16} className="text-amber-500 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-amber-800">待人工確認範圍（{unknownZones.length} 個）</p>
              <p className="text-xs text-amber-600 mt-1">
                以下 HATCH / 多邊形圖層名稱不含已知植栽關鍵字，無法自動分類為灌木區 / 草皮區等。
                若為植栽範圍，請確認圖層命名是否包含「灌木」「草皮」「地被」「喬木」等關鍵字。
              </p>
            </div>
          </div>
          <div className="bg-white rounded-2xl border border-stone-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-stone-50 border-b border-stone-200">
                  {['來源實體', '圖層', '頂點數', '封閉'].map(h => (
                    <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-stone-500 uppercase">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {unknownZones.map((p, idx) => (
                  <tr key={idx} className="border-b border-stone-100 last:border-0 hover:bg-stone-50">
                    <td className="px-4 py-2">
                      <span className="font-mono text-xs bg-stone-100 px-2 py-0.5 rounded">{p.source}</span>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-stone-500">{p.layer || '（無圖層名稱）'}</td>
                    <td className="px-4 py-2 text-stone-400 text-xs">{p.vertices.length}</td>
                    <td className="px-4 py-2">
                      {p.closed
                        ? <span className="text-xs text-emerald-600">✓ 封閉</span>
                        : <span className="text-xs text-stone-400">開放</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Schedule tab ─────────────────────────────────────────────────────────────

function ScheduleTab({ schedule, mappings, plants, onPlantAdded }: {
  schedule: PlantSchedule; mappings: MappedItem[]
  plants: CsvPlantRecord[]; onPlantAdded: (record: CsvPlantRecord) => void
}) {
  // ── 缺漏植栽自動補資料：每個索引表植物名稱各自的搜尋狀態 ────────────────────
  const [searchStates, setSearchStates] = useState<Record<string, 'idle' | 'searching' | 'failed'>>({})
  const [failureNotes, setFailureNotes] = useState<Record<string, string>>({})
  const [activeSearch, setActiveSearch] = useState<{
    queryName: string; result: PlantSearchResult; draft: DraftPlantRecord
  } | null>(null)

  const runAutoSearch = useCallback(async (e: PlantScheduleEntry) => {
    const key = e.plantName
    setSearchStates(prev => ({ ...prev, [key]: 'searching' }))
    setFailureNotes(prev => { const n = { ...prev }; delete n[key]; return n })
    const res = await searchOfficialPlantData(
      e.plantName, e.scientificName,
      e.code ? `索引表代號 ${e.code}` : undefined,
    )
    if (res.ok) {
      setActiveSearch({ queryName: key, result: res.result, draft: searchResultToDraft(res.result) })
      setSearchStates(prev => ({ ...prev, [key]: 'idle' }))
    } else {
      setSearchStates(prev => ({ ...prev, [key]: 'failed' }))
      setFailureNotes(prev => ({ ...prev, [key]: res.reason }))
    }
  }, [])

  if (!schedule.detected) return (
    <div className="flex flex-col items-center justify-center py-20 text-stone-400 gap-3">
      <Table2 size={36} className="opacity-30" />
      <p className="text-base font-medium text-stone-500">未偵測到植栽索引表</p>
      <p className="text-sm text-stone-400 text-center max-w-md">
        系統分析了 {schedule.textCount} 個文字元素，未找到符合植栽索引表格式的結構（含有代號、植物名稱、數量等欄位的多列表格）。
        圖面若未包含索引表，系統將改用圖塊名稱 + 附近文字進行植物推測。
      </p>
    </div>
  )

  // 計算哪些索引表代號已有圖塊對應（用於顯示空間對應狀態）
  const matchedCodes = new Set(
    mappings
      .filter(m => m.matchStatus !== 'unmatched' && m.scheduleEntry?.code)
      .map(m => m.scheduleEntry!.code.trim())
  )
  const matchedNames = new Set(
    mappings
      .filter(m => m.matchStatus !== 'unmatched' && m.plantName)
      .map(m => m.plantName!)
  )
  const isBlockMatched = (e: PlantScheduleEntry) =>
    (e.code && matchedCodes.has(e.code.trim())) || matchedNames.has(e.plantName)

  const isDbMatched      = (e: PlantScheduleEntry) => existsExactInLocalDatabase(e.plantName, plants, e.scientificName)
  const blockMatchedCount = schedule.entries.filter(isBlockMatched).length
  const noBlockCount      = schedule.entries.length - blockMatchedCount
  const dbCount           = schedule.entries.filter(isDbMatched).length
  const missingCount      = schedule.entries.length - dbCount

  return (
    <div>
      {/* Summary */}
      <div className="flex gap-3 mb-5 flex-wrap">
        <div className="px-4 py-2.5 rounded-xl border border-blue-200 bg-blue-50 text-blue-800 text-sm font-medium">
          索引表共 <strong>{schedule.entries.length}</strong> 筆
        </div>
        <div className="px-4 py-2.5 rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-800 text-sm font-medium">
          已對應圖塊 <strong>{blockMatchedCount}</strong> 筆
        </div>
        {noBlockCount > 0 && (
          <div className="px-4 py-2.5 rounded-xl border border-amber-200 bg-amber-50 text-amber-800 text-sm font-medium">
            尚未空間對應 <strong>{noBlockCount}</strong> 筆（待 HATCH / polyline）
          </div>
        )}
        <div className="px-4 py-2.5 rounded-xl border border-stone-200 bg-stone-50 text-stone-600 text-sm font-medium">
          植栽資料庫比對 {dbCount} 筆
        </div>
        {missingCount > 0 && (
          <div className="px-4 py-2.5 rounded-xl border border-amber-200 bg-amber-50 text-amber-800 text-sm font-medium">
            資料庫查無 <strong>{missingCount}</strong> 筆（可於下表逐筆自動搜尋官方資料補建）
          </div>
        )}
      </div>

      {schedule.headerRow && (
        <div className="mb-3 px-4 py-2 bg-stone-50 border border-stone-200 rounded-xl text-xs text-stone-400 font-mono">
          偵測表頭：{schedule.headerRow.join(' ｜ ')}
        </div>
      )}

      {/* 尚未空間對應提示 */}
      {noBlockCount > 0 && (
        <div className="mb-4 flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-2xl">
          <AlertTriangle size={15} className="text-amber-500 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-amber-800">
            有 <strong>{noBlockCount}</strong> 筆索引表植物（如腎蕨、麥門冬、金露花等地被 / 灌木 / 草皮）
            在圖面中未找到對應 INSERT 圖塊，可能以 HATCH 或封閉 polyline 呈現。
            這些項目已完整保留，待後續至「植栽範圍」tab 進行空間對應。
          </p>
        </div>
      )}

      <div className="bg-white rounded-2xl border border-stone-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-stone-50 border-b border-stone-200">
              {['代號/項次', '植物名稱', '類型', '規格', '數量', '單位', '空間對應狀態', '資料庫'].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-stone-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {schedule.entries.map((e, idx) => {
              const hasBlock = isBlockMatched(e)
              return (
              <tr key={idx} className={`border-b border-stone-100 last:border-0 hover:bg-stone-50 ${
                !hasBlock ? 'bg-amber-50/30' : ''
              }`}>
                {/* 代號/項次 */}
                <td className="px-4 py-2.5">
                  <span className="font-mono font-semibold text-stone-700 bg-stone-100 px-2 py-0.5 rounded">
                    {e.code || '—'}
                  </span>
                </td>
                {/* 植物名稱 */}
                <td className="px-4 py-2.5">
                  <p className="font-semibold text-stone-800">{e.plantName}</p>
                  {e.scientificName && <p className="text-xs text-stone-400 italic">{e.scientificName}</p>}
                </td>
                {/* 類型 */}
                <td className="px-4 py-2.5 text-stone-500 text-xs">{e.plantType || '—'}</td>
                {/* 規格 */}
                <td className="px-4 py-2.5 text-stone-500 text-xs max-w-[120px] truncate">{e.spec || '—'}</td>
                {/* 數量 */}
                <td className="px-4 py-2.5">
                  {e.quantity !== undefined
                    ? <span className="text-stone-800 font-semibold">{e.quantity}</span>
                    : <span className="text-amber-500 text-xs">{e.quantityNote ?? '待確認'}</span>
                  }
                </td>
                {/* 單位 */}
                <td className="px-4 py-2.5">
                  {e.unit
                    ? <span className="text-stone-600 text-xs">{e.unit}</span>
                    : <span className="text-stone-300 text-xs">—</span>
                  }
                  {e.unitNote && <p className="text-amber-500 text-[10px] mt-0.5">{e.unitNote}</p>}
                </td>
                {/* 空間對應狀態（新欄位：區分已圖塊對應 vs 待 HATCH 對應）*/}
                <td className="px-4 py-2.5">
                  {hasBlock
                    ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs">
                        <CheckCircle size={10} />已對應圖塊
                      </span>
                    : <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-700 text-xs">
                        <AlertTriangle size={10} />待 HATCH 對應
                      </span>}
                </td>
                {/* 資料庫對應 */}
                <td className="px-4 py-2.5">
                  {isDbMatched(e)
                    ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs">
                        <CheckCircle size={10} />已比對
                      </span>
                    : searchStates[e.plantName] === 'searching'
                    ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-50 border border-blue-200 text-blue-600 text-xs animate-pulse">
                        搜尋官方資料中…
                      </span>
                    : (
                      <div className="flex flex-col gap-1 items-start">
                        <button onClick={() => runAutoSearch(e)}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-stone-100 border border-stone-300 text-stone-600 text-xs hover:bg-stone-200 hover:border-stone-400">
                          <HelpCircle size={10} />未比對・自動搜尋
                        </button>
                        {searchStates[e.plantName] === 'failed' && (
                          <p className="text-[10px] text-amber-600 max-w-[160px]">{failureNotes[e.plantName]}</p>
                        )}
                      </div>
                    )}
                </td>
                {/* 信心 */}
                <td className="px-4 py-2.5">
                  <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${
                    e.confidence === 'high'   ? 'bg-emerald-50 border-emerald-200 text-emerald-700' :
                    e.confidence === 'medium' ? 'bg-amber-50 border-amber-200 text-amber-700'       :
                                                'bg-stone-50 border-stone-200 text-stone-400'
                  }`}>
                    {e.confidence === 'high' ? '高' : e.confidence === 'medium' ? '中' : '低'}
                  </span>
                  {(e.quantityNote || e.unitNote) &&
                    <p className="text-amber-500 text-[10px] mt-0.5 whitespace-nowrap">需人工確認</p>
                  }
                </td>
              </tr>
            )
            })}
          </tbody>
        </table>
      </div>
      {/* 新增植栽資料確認視窗 */}
      {activeSearch && (
        <PlantAutoAddModal
          queryName={activeSearch.queryName}
          result={activeSearch.result}
          draft={activeSearch.draft}
          onConfirm={(record) => {
            onPlantAdded(record)
            setActiveSearch(null)
          }}
          onSkip={() => setActiveSearch(null)}
          onClose={() => setActiveSearch(null)}
        />
      )}
    </div>
  )
}

// ── Rules tab ─────────────────────────────────────────────────────────────────

function RulesTab({ savedRules, onDelete, onClearAll }: {
  savedRules: DxfBlockRule[]
  onDelete: (blockName: string) => void
  onClearAll: () => void
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <div>
          <p className="text-sm font-semibold text-stone-700">已儲存的圖塊對應規則庫</p>
          <p className="text-xs text-stone-500 mt-0.5">這些規則會在下次上傳 DXF 時自動套用。</p>
        </div>
        {savedRules.length > 0 && (
          <button onClick={() => { if (confirm('確定要清除全部規則？')) onClearAll() }}
            className="flex items-center gap-2 px-4 py-2 rounded-xl border border-red-200 text-sm text-red-600 hover:bg-red-50">
            <Trash2 size={13} />清除全部規則
          </button>
        )}
      </div>

      {savedRules.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-stone-400">
          <BookOpen size={32} className="mb-3 opacity-40" />
          <p className="text-sm">尚無儲存規則</p>
          <p className="text-xs mt-1">在「圖塊對應表」或「未對應項目」中選擇植物並點擊「永久」即可建立規則</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-stone-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-stone-50 border-b border-stone-200">
                {['圖塊名稱', '對應植物', '儲存時間', '操作'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-stone-500 uppercase">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {savedRules.map((r, idx) => (
                <tr key={idx} className="border-b border-stone-100 last:border-0 hover:bg-stone-50">
                  <td className="px-4 py-3 font-mono font-semibold text-stone-800">{r.blockName}</td>
                  <td className="px-4 py-3">
                    <span className="px-2.5 py-1 rounded-full bg-green-50 border border-green-200 text-green-700 text-xs font-medium">
                      {r.plantName}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-stone-400 text-xs">
                    {new Date(r.savedAt).toLocaleString('zh-TW', { dateStyle: 'short', timeStyle: 'short' })}
                  </td>
                  <td className="px-4 py-3">
                    <button onClick={() => onDelete(r.blockName)}
                      className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-red-100 text-xs text-red-500 hover:bg-red-50">
                      <Trash2 size={11} />刪除規則
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
