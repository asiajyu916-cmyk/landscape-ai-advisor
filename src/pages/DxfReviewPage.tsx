import { useState, useRef, useCallback, useMemo, useEffect } from 'react'
import {
  Upload, FileText, AlertTriangle, CheckCircle, HelpCircle,
  ChevronDown, X, ArrowRight, Layers, Trash2, BookOpen, Table2, FileOutput,
} from 'lucide-react'
import { parseDxf, detectPlantSchedule, findNearbyTexts } from '@/utils/dxfParser'
import { analyzeMultiLayer, zoneLabel, detectZonesFromText, buildZonePlantList, buildZoneAssignDebug, polygonBBox } from '@/utils/spatialAnalysis'
import type { ZoneAssignDebug } from '@/utils/spatialAnalysis'
import { exportZoneReviewPdf } from '@/utils/exportReviewPdf'
import type { ZoneReviewPdfData } from '@/utils/exportReviewPdf'
import { evaluate } from '@/utils/plantEvaluator'
import type { EvalResult } from '@/utils/plantEvaluator'
import { loadPlantsFromStorage } from '@/data/plantStore'
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

interface MatchResult {
  plant: CsvPlantRecord | null
  status: MatchStatus
  confidence: number
  reason: string
  scheduleEntry?: PlantScheduleEntry
  detectedType: string
  possiblePlantCode: string
  evidence: string[]
}

function matchPlant(
  blockName: string,
  layer: string,
  count: number,
  plants: CsvPlantRecord[],
  savedRules: DxfBlockRule[],
  schedule: PlantScheduleEntry[],
  nearbyTexts: string[],
): MatchResult {
  const bn  = blockName.toLowerCase().trim()
  const ln  = layer.toLowerCase().trim()
  const detectedType    = detectBlockType(blockName, layer)
  const possibleCode    = extractBlockCode(blockName)
  const ev: string[]    = []
  if (detectedType) ev.push(detectedType)

  const ok = (
    confidence: number, plant: CsvPlantRecord | null, reason: string,
    sched?: PlantScheduleEntry, code = possibleCode
  ): MatchResult => ({
    plant, status: confidence >= 70 ? 'matched' : confidence >= 30 ? 'partial' : 'unmatched',
    confidence, reason, scheduleEntry: sched,
    detectedType, possiblePlantCode: code, evidence: [...ev],
  })

  // ── 0. 已儲存規則（最高優先，使用者確認過）──────────────────────────────────
  const rule = savedRules.find(r => r.blockName === blockName)
  if (rule) {
    const plant = plants.find(p => p.name === rule.plantName)
    if (plant) { ev.push('已儲存規則'); return ok(95, plant, '已儲存規則') }
  }

  // ── 1. block name 本身就是索引表 plantCode（完全相等）────────────────────────
  const schedExact = schedule.find(e => e.code && e.code.toLowerCase() === bn)
  if (schedExact) {
    ev.push(`圖塊名稱即索引表代號 ${schedExact.code}`)
    const plant = plants.find(p => p.name === schedExact.plantName) ?? null
    return ok(90, plant, `圖塊名稱即索引表代號 ${schedExact.code}（${schedExact.plantName}）`, schedExact, schedExact.code)
  }

  // ── 2. 附近文字明確標示索引表代號（最直接的圖面佐證）────────────────────────
  for (const text of nearbyTexts) {
    const t = text.trim()
    const e = schedule.find(s => s.code && s.code === t)
    if (e) {
      ev.push(`附近文字「${t}」= 索引表代號 ${e.code}`)
      const plant = plants.find(p => p.name === e.plantName) ?? null
      return ok(88, plant, `附近文字「${t}」符合索引表代號（${e.plantName}）`, e, e.code)
    }
  }

  // ── 3. 提取 block name 中的數字代號，查索引表 ────────────────────────────────
  //   僅有代號一項不足以高信心；需要數量或類型佐證才能升至已確認
  if (possibleCode) {
    // 比對時同時 trim + 嘗試整數比較，防止 DXF 文字帶空白或前置零
    const schedByExtracted = schedule.find(e => {
      const ec = e.code.trim()
      return ec !== '' && (ec === possibleCode || parseInt(ec, 10) === parseInt(possibleCode, 10))
    })
    if (schedByExtracted) {
      ev.push(`圖塊名稱含數字代號 ${possibleCode}，索引表有對應記錄（${schedByExtracted.plantName}）`)
      const plant = plants.find(p => p.name === schedByExtracted.plantName) ?? null

      // 佐證一：數量吻合（±15%或±1）
      const qtyOk = schedByExtracted.quantity !== undefined &&
        Math.abs(count - schedByExtracted.quantity) <= Math.max(1, Math.round(count * 0.15))
      if (qtyOk) ev.push(`圖塊數量 ${count} ≈ 索引表數量 ${schedByExtracted.quantity}`)
      else if (schedByExtracted.quantity !== undefined)
        ev.push(`圖塊數量 ${count} ≠ 索引表數量 ${schedByExtracted.quantity}（需確認）`)

      // 佐證二：圖層類型吻合
      const typeOk = !!(detectedType && schedByExtracted.plantType &&
        ((detectedType.includes('喬木') && /喬木/.test(schedByExtracted.plantType)) ||
         (detectedType.includes('灌木') && /灌木/.test(schedByExtracted.plantType))))
      if (typeOk) ev.push(`圖層類型吻合：${detectedType}`)

      if (qtyOk || typeOk) {
        return ok(78, plant, `代號 ${possibleCode} 索引表吻合，${qtyOk ? '數量符合' : '類型符合'}`, schedByExtracted)
      } else {
        // 只有代號吻合 → 系統推測（confidence 50 → partial，絕不是 unmatched）
        ev.push('代號相符但缺乏數量 / 類型佐證，請人工確認')
        return ok(50, plant, `代號 ${possibleCode} 與索引表相符，推測為「${schedByExtracted.plantName}」，請確認`, schedByExtracted)
      }
    }

    // possibleCode 存在但索引表查無此代號
    if (schedule.length > 0) {
      ev.push(`代號 ${possibleCode} 未在索引表中找到對應`)
    }
  }

  // ── 4. 附近文字含索引表植物名稱 ─────────────────────────────────────────────
  for (const text of nearbyTexts) {
    const e = schedule.find(s => s.dbMatched && text.includes(s.plantName))
    if (e) {
      ev.push(`附近文字包含索引表植物名稱「${e.plantName}」`)
      const plant = plants.find(p => p.name === e.plantName) ?? null
      return ok(80, plant, `附近文字對應索引表植物名稱（${e.plantName}）`, e)
    }
  }

  // ── 5. 附近文字直接命中植栽資料庫（中文植物名稱）───────────────────────────
  for (const text of nearbyTexts) {
    const plant = plants.find(p => p.name.length >= 2 && /[一-鿿]/.test(p.name) && text.includes(p.name))
    if (plant) {
      ev.push(`附近文字「${plant.name}」直接比對植栽資料庫`)
      return ok(75, plant, `附近文字直接對應植物名稱（${plant.name}）`)
    }
  }

  // ── 6. block name 完全等於中文植物名稱 ──────────────────────────────────────
  const exactChinese = plants.find(p => /[一-鿿]/.test(p.name) && p.name.toLowerCase() === bn)
  if (exactChinese) {
    ev.push('圖塊名稱即植物中文名稱')
    return ok(75, exactChinese, '圖塊名稱即植物名稱')
  }

  // ── 7. block name 包含中文植物名稱（2字以上）───────────────────────────────
  const chinesePlant = plants.find(p => p.name.length >= 2 && /[一-鿿]{2}/.test(p.name) && bn.includes(p.name.toLowerCase()))
  if (chinesePlant) {
    ev.push(`圖塊名稱含植物名稱「${chinesePlant.name}」`)
    return ok(60, chinesePlant, `圖塊名稱包含植物名稱「${chinesePlant.name}」（系統推測）`)
  }

  // ── 8. 僅識別出圖塊類型，無索引表佐證 ──────────────────────────────────────
  //   confidence 35（≥30）確保狀態是 partial 而非 unmatched
  if (detectedType) {
    ev.push('僅依圖塊 / 圖層命名識別類型，缺乏索引表或附近文字佐證')
    return ok(35, null, `識別為${detectedType}，尚無足夠依據，請人工確認`)
  }

  // ── 9. 圖層名稱含中文植物名稱 ───────────────────────────────────────────────
  const layerPlant = plants.find(p => p.name.length >= 2 && /[一-鿿]/.test(p.name) && ln.includes(p.name.toLowerCase()))
  if (layerPlant) {
    ev.push(`圖層名稱含植物名稱「${layerPlant.name}」`)
    return ok(40, layerPlant, `圖層名稱包含植物名稱「${layerPlant.name}」`)
  }

  ev.push('無足夠依據')
  return { plant: null, status: 'unmatched', confidence: 0,
    reason: '無足夠依據，請人工確認', detectedType, possiblePlantCode: possibleCode, evidence: ev }
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

    const nearby = grp.positions.length > 0
      ? findNearbyTexts(grp.positions[0], texts, radius)
      : []
    const result = matchPlant(grp.blockName, grp.layer, grp.count, plants, savedRules, schedule, nearby)
    // 植物名稱 fallback：CSV DB → 索引表植物名稱
    // 用 || 而非 ?? 確保空字串也能被 fallback 覆蓋
    const nameFromSchedule = result.scheduleEntry?.plantName
    item.matchStatus       = result.status
    item.confidenceScore   = result.confidence
    item.plantName         = result.plant?.name || nameFromSchedule || undefined
    item.plantCategory     = result.plant?.category
    item.plantSubCategory  = result.plant?.subCategory
    item.matchReason       = result.reason
    item.scheduleEntry     = result.scheduleEntry
    item.nearbyTexts       = nearby.slice(0, 5)
    item.detectedType      = result.detectedType
    item.possiblePlantCode = result.possiblePlantCode
    item.evidence          = result.evidence
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

// 分區內每個圖塊的摘要（含未對應植物）
interface ZoneBlockEntry {
  blockName: string
  plantName?: string        // 若已對應植栽資料庫
  detectedType?: string     // 喬木圖塊 / 灌木圖塊 等
  count: number             // 此分區內數量
  matchStatus: 'db-matched' | 'name-only' | 'unmatched'
}

interface ZoneReviewResult {
  zoneName: string
  plants: SelectedCsvPlant[]         // 完整 DB 資料（可評分）
  blockEntries: ZoneBlockEntry[]     // 所有圖塊（含未對應）
  unmatchedBlocks: string[]          // 純未對應 blockName 清單（向下相容）
  areaTypes: string[]
  areaLayerNotes: string[]           // 有 HATCH 但圖層名稱無法識別植物
  status: ZoneReviewStatus
  evalResult?: EvalResult
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

function buildZoneReviews(
  zonePlantLists: ZonePlantList[],
  plantDB: CsvPlantRecord[],
  schedule: PlantScheduleEntry[],
  texts: DxfText[] = [],
  drawingRadius = 1000,
): ZoneReviewResult[] {
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

    for (const area of allAreas) {
      const layerName = (area.layer || '').trim()
      let matched = false

      // ── A. 掃描 HATCH 幾何中心附近的文字標注 ──────────────────────────
      // 搜尋半徑：HATCH 中心 ± drawingRadius * 5%（最小 100 單位）
      const nearRadius = Math.max(100, drawingRadius * 0.05)
      const nearbyTexts = findNearbyTexts(
        { x: area.centerX, y: area.centerY },
        texts,
        nearRadius,
      )

      for (const txt of nearbyTexts) {
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
        // 比對索引表植物名稱
        const fromSched = schedule.find(e =>
          e.plantName && e.plantName.length >= 2 &&
          txt.includes(e.plantName) && !seenNames.has(e.plantName)
        )
        if (fromSched) {
          const dbP = findInDB(fromSched.plantName, plantDB)
          if (dbP && !seenNames.has(dbP.name)) {
            seenNames.add(dbP.name)
            const ps = dbP.wetTolerance === '不耐積水' && dbP.droughtTolerance === '不耐旱' ? '需注意' as const : '可用' as const
            confirmed.push({ ...dbP, instanceId: uid(), status: ps })
            blockEntries.push({ blockName: `[面狀] ${layerName || area.zoneType}`, plantName: dbP.name, detectedType: zoneLabel(area.zoneType), count: 1, matchStatus: 'db-matched' })
            matched = true; break
          }
        }
        // 比對索引表代號（例如文字「003」對應索引表代號 003 = 麥門冬）
        const fromCode = schedule.find(e =>
          e.code && txt.trim() === e.code.trim() && !seenNames.has(e.plantName)
        )
        if (fromCode) {
          const dbP = findInDB(fromCode.plantName, plantDB)
          if (dbP && !seenNames.has(dbP.name)) {
            seenNames.add(dbP.name)
            const ps = dbP.wetTolerance === '不耐積水' && dbP.droughtTolerance === '不耐旱' ? '需注意' as const : '可用' as const
            confirmed.push({ ...dbP, instanceId: uid(), status: ps })
            blockEntries.push({ blockName: `[面狀代號] ${fromCode.code}`, plantName: dbP.name, detectedType: zoneLabel(area.zoneType), count: 1, matchStatus: 'db-matched' })
            matched = true; break
          }
        }
      }
      if (matched) continue

      // ── B. 圖層名稱含植物名 ────────────────────────────────────────────
      if (layerName) {
        const fromLayer = plantDB.find(p =>
          p.name.length >= 2 && /[一-鿿]/.test(p.name) &&
          layerName.includes(p.name) && !seenNames.has(p.name)
        )
        if (fromLayer) {
          seenNames.add(fromLayer.name)
          const ps = fromLayer.wetTolerance === '不耐積水' && fromLayer.droughtTolerance === '不耐旱' ? '需注意' as const : '可用' as const
          confirmed.push({ ...fromLayer, instanceId: uid(), status: ps })
          blockEntries.push({ blockName: `[面狀] ${layerName}`, plantName: fromLayer.name, detectedType: zoneLabel(area.zoneType), count: 1, matchStatus: 'db-matched' })
          matched = true
        }
      }
      if (matched) continue

      // ── C. 無法識別 → 記錄提示 ──────────────────────────────────────────
      areaLayerNotes.push(
        `${layerName || '(無圖層)'}（${zoneLabel(area.zoneType)}，中心座標 ${area.centerX.toFixed(0)}, ${area.centerY.toFixed(0)}）`
      )
    }

    const areaLabels = [
      ...zpl.shrubAreas.map(() => '灌木區'),
      ...zpl.lawnAreas.map(() => '草皮區'),
      ...zpl.groundcoverAreas.map(() => '地被區'),
      ...zpl.unknownAreas.map(() => '待確認範圍'),
    ]

    // ── 3. 決定審查狀態 ────────────────────────────────────────────────────
    // 有 ≥ 1 種 DB 植物就執行評估（1 種時無跨植物衝突，分數通常偏高，但仍有意義）
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

    return {
      zoneName: zpl.zone.name,
      plants: confirmed,
      blockEntries,
      unmatchedBlocks,
      areaTypes: [...new Set(areaLabels)],
      areaLayerNotes,
      status,
      evalResult,
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
  const [zoneDebug, setZoneDebug] = useState<ZoneAssignDebug | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const plants = allPlants.length > 0 ? allPlants : (loadPlantsFromStorage() ?? [])

  // ── 當 plants 或 zonePlantLists 改變時重算分區審查 ──────────────────────────
  // 解決「DXF 上傳時 DB 尚未載入 → 分數為空」的問題
  useEffect(() => {
    if (zonePlantLists.length === 0 || plants.length === 0) return
    setZoneReviews(buildZoneReviews(zonePlantLists, plants, plantSchedule.entries, parseResult?.texts ?? [], drawingRadius))
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

      // 分區空間識別
      const zones = detectZonesFromText(result.texts, result.polygons)
      setDetectedZones(zones)
      const zpl = buildZonePlantList(zones, active, result.polygons, result.inserts, result.blockExtents)
      setZonePlantLists(zpl)
      setZoneReviews(buildZoneReviews(zpl, loaded, sched.entries, result.texts, radius))
      setZoneDebug(buildZoneAssignDebug(zones, zpl, active, result.inserts, result.blockExtents))

      // ── Debug：直接印出 raw 資料讓瀏覽器 console 可以看 ──────────────────
      console.group('[DXF Zone Debug]')
      console.log('Total texts:', result.texts.length)
      console.log('First 30 texts:', result.texts.slice(0, 30).map(t => ({ content: t.content, x: t.x, y: t.y, layer: t.layer })))
      console.log('Texts containing 區:', result.texts.filter(t => t.content.includes('區') || t.content.includes('区')))
      console.log('Total polygons:', result.polygons.length)
      console.log('Detected zones:', zones)
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
    const zpl2 = buildZonePlantList(detectedZones, active, parseResult.polygons, parseResult.inserts, parseResult.blockExtents)
    setZonePlantLists(zpl2)
    setZoneReviews(buildZoneReviews(zpl2, plantList, plantSchedule.entries, parseResult.texts, drawingRadius))
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
    const r3 = matchPlant(item.blockName, item.layer, item.count, plants, savedRules, plantSchedule.entries, [])
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
      <div className="min-h-screen bg-stone-50 flex flex-col">
        <header className="bg-white border-b border-stone-200 sticky top-0 z-40">
          <div className="max-w-[1536px] mx-auto px-8 h-16 flex items-center justify-between">
            <div>
              <h1 className="text-lg font-bold text-green-900 leading-tight">DXF / CAD 讀圖審查</h1>
              <p className="text-xs text-stone-400 leading-tight">上傳 AutoCAD .dxf 檔案，自動解析圖塊與植栽對應</p>
            </div>
            {onTabChange && (
              <div className="flex items-center bg-stone-100 rounded-xl p-1 gap-0.5">
                {([
                  { id: 'pdf'       as const, label: 'PDF 審圖' },
                  { id: 'landscape' as const, label: 'AI 配植評估' },
                  { id: 'dxf'       as const, label: 'DXF 審查' },
                ]).map(t => (
                  <button key={t.id} onClick={() => onTabChange(t.id)}
                    className={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                      activeTab === t.id ? 'bg-white text-green-900 shadow-sm' : 'text-stone-500 hover:text-stone-700'
                    }`}>
                    {t.label}
                  </button>
                ))}
              </div>
            )}
            <div />
          </div>
        </header>
        <main className="flex-1 flex flex-col items-center justify-center px-8 py-12">
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
    <div className="min-h-screen bg-stone-50 flex flex-col">

      {/* ── Header ── */}
      <header className="bg-white border-b border-stone-200 sticky top-0 z-30">
        <div className="max-w-[1536px] mx-auto px-8 h-16 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-green-900 leading-tight">DXF / CAD 讀圖審查</h1>
            <p className="text-xs text-stone-400 leading-tight">
              {fileName}
              {detectedEnc && <span className="ml-2 px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 text-xs border border-blue-100">編碼：{detectedEnc}</span>}
              <span className="ml-2">・圖塊 {stats.uniqueBlocks} 種・共 {stats.totalInserts} 個・已排除 {excluded.length} 個非植栽圖層</span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            {onTabChange && (
              <div className="flex items-center bg-stone-100 rounded-xl p-1 gap-0.5">
                {([
                  { id: 'pdf'       as const, label: 'PDF 審圖' },
                  { id: 'landscape' as const, label: 'AI 配植評估' },
                  { id: 'dxf'       as const, label: 'DXF 審查' },
                ]).map(t => (
                  <button key={t.id} onClick={() => onTabChange(t.id)}
                    className={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                      activeTab === t.id ? 'bg-white text-green-900 shadow-sm' : 'text-stone-500 hover:text-stone-700'
                    }`}>
                    {t.label}
                  </button>
                ))}
              </div>
            )}
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
                  exportZoneReviewPdf(pdfData, fileName)
                }}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-green-700 text-white text-sm font-semibold hover:bg-green-800">
                <FileOutput size={14} />匯出分區審查 PDF
              </button>
            )}
            <button onClick={() => { setParseResult(null); setFileName(''); setMappings([]) }}
              className="flex items-center gap-2 px-4 py-2 rounded-xl border border-stone-200 text-sm text-stone-600 hover:bg-stone-50">
              <X size={14} />重新上傳
            </button>
          </div>
        </div>

        {/* Stats bar */}
        <div className="flex gap-3 mt-3 flex-wrap">
          {[
            { label: '✅ 已自動對應', count: matched.length,  cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
            { label: '⚠ 部分符合',   count: partial.length,  cls: 'bg-amber-50 text-amber-700 border-amber-200' },
            { label: '❌ 未對應',     count: unmatched.length, cls: 'bg-red-50 text-red-700 border-red-200' },
            { label: '🚫 已排除',     count: excluded.length,  cls: 'bg-stone-50 text-stone-500 border-stone-200' },
            { label: '🗺 範圍多邊形', count: stats.totalPolygons, cls: 'bg-blue-50 text-blue-700 border-blue-200' },
          ].map(s => (
            <div key={s.label} className={`flex items-center gap-2 px-4 py-2 rounded-xl border text-sm font-medium ${s.cls}`}>
              {s.label} <span className="text-base font-bold">{s.count}</span>
            </div>
          ))}
        </div>
      </header>

      {/* Unmatched warning */}
      {unmatched.length > 0 && (
        <div className="bg-red-50 border-b border-red-200 px-8 py-3 flex items-center gap-3">
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
      <div className="bg-white border-b border-stone-200 px-8 flex gap-0 overflow-x-auto">
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
            className={`px-5 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
              tab === t.id
                ? 'border-green-600 text-green-700'
                : t.urgent
                  ? 'border-transparent text-red-600 hover:text-red-700'
                  : t.highlight
                    ? 'border-transparent text-blue-600 hover:text-blue-700 font-semibold'
                    : 'border-transparent text-stone-500 hover:text-stone-700'
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Content ── */}
      <main className="flex-1 px-8 py-6">

        {/* ── Schedule tab ── */}
        {tab === 'schedule' && (
          <ScheduleTab schedule={plantSchedule} mappings={mappings} />
        )}

        {/* ── Zone review tab ── */}
        {tab === 'zonereview' && (
          <ZoneReviewTab reviews={zoneReviews} />
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
              const r2 = matchPlant(blockName, item?.layer ?? '', item?.count ?? 0, plants, rules, plantSchedule.entries, nearby)
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
                索引表 {plantSchedule.entries.filter(e => e.dbMatched).length} 筆已比對
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

function ZoneReviewTab({ reviews }: { reviews: ZoneReviewResult[] }) {
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
          </div>
        )}

        {/* ── 各分區內容 ── */}
        {activeReview && (() => {
          const r = activeReview
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
                      {r.blockEntries.map((b, i) => (
                        <tr key={i} className={`border border-stone-100 ${
                          b.matchStatus === 'db-matched' ? 'bg-emerald-50/40' :
                          b.matchStatus === 'name-only'  ? 'bg-amber-50/40'   : 'bg-red-50/20'
                        }`}>
                          <td className="px-3 py-1.5 font-mono text-stone-700">{b.blockName}</td>
                          <td className="px-3 py-1.5 font-medium text-stone-800">
                            {b.plantName ?? <span className="text-stone-400 italic">未對應</span>}
                          </td>
                          <td className="px-3 py-1.5 text-stone-500">{b.detectedType ?? '—'}</td>
                          <td className="px-3 py-1.5 text-center font-semibold text-stone-700">{b.count}</td>
                          <td className="px-3 py-1.5">
                            {b.matchStatus === 'db-matched' && <span className="text-emerald-600 text-xs">✅ 已比對 DB</span>}
                            {b.matchStatus === 'name-only'  && <span className="text-amber-600 text-xs">⚠ 索引表名稱，DB 無記錄</span>}
                            {b.matchStatus === 'unmatched'  && <span className="text-red-500 text-xs">❌ 未對應，請至圖塊對應 tab 指定</span>}
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
}: {
  zonePlantLists: ZonePlantList[]
  detectedZones: DetectedZone[]
  texts: DxfParseResult['texts']
  polygons: DxfParseResult['polygons']
  mappings: MappedItem[]
  totalInserts: number
  zoneDebug: ZoneAssignDebug | null
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

      {/* ── 0. 原始資料 DEBUG（最優先顯示，不過任何 filter）──────────────── */}
      <div className="rounded-2xl border-2 border-purple-300 bg-purple-50 p-4">
        <p className="text-sm font-bold text-purple-800 mb-3">🔍 原始資料 Debug（資料流驗證）</p>
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
          <details open>
            <summary className="text-xs font-semibold text-purple-700 cursor-pointer mb-1">
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
        <div className="rounded-2xl border-2 border-orange-300 bg-orange-50 p-4 space-y-3">
          <p className="text-sm font-bold text-orange-800">🔎 植栽歸區 Debug（對照 AutoCAD 原圖用）</p>

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
          <details open>
            <summary className="text-xs font-bold text-orange-700 cursor-pointer">
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
            <details open>
              <summary className="text-xs font-bold text-orange-700 cursor-pointer">
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
                      : <>
                          {zpl.shrubAreas.map((a, i)    => <p key={`s${i}`} className="text-xs text-green-700">灌木區 · {a.layer || '無圖層'} · {a.source}</p>)}
                          {zpl.lawnAreas.map((a, i)     => <p key={`l${i}`} className="text-xs text-lime-700">草皮區 · {a.layer || '無圖層'} · {a.source}</p>)}
                          {zpl.groundcoverAreas.map((a, i) => <p key={`g${i}`} className="text-xs text-emerald-700">地被區 · {a.layer || '無圖層'} · {a.source}</p>)}
                          {zpl.unknownAreas.map((a, i)  => <p key={`u${i}`} className="text-xs text-amber-600">待確認 · {a.layer || '無圖層'} · {a.source}</p>)}
                        </>}
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

function ScheduleTab({ schedule, mappings }: { schedule: PlantSchedule; mappings: MappedItem[] }) {
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

  const blockMatchedCount = schedule.entries.filter(isBlockMatched).length
  const noBlockCount      = schedule.entries.length - blockMatchedCount
  const dbCount           = schedule.entries.filter(e => e.dbMatched).length

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
                  {e.dbMatched
                    ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs">
                        <CheckCircle size={10} />已比對
                      </span>
                    : <span className="text-xs text-stone-300">未比對</span>}
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
