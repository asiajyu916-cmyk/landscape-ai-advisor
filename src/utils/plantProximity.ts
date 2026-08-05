// ── 空間鄰近式植栽衝突檢討 ──────────────────────────────────────────────────────
//
// 取代「同一分區內所有已比對植物全組合比較」（見 plantEvaluator.ts 舊有整區
// min/max 落差比較）：改為分區篩選 → 空間鄰近篩選 → 植物特性衝突判斷。
// 每一個灌木／地被／草皮 HATCH 依 DXF entity handle 分組，視為獨立種植區——
// 即使名稱相同，不同、不相連的 HATCH 也不合併成同一個幾何範圍（見
// spatialAnalysis.ts 的 assignAreasToZones，使用其 pre-dedup 結果）。

import polygonClipping from 'polygon-clipping'
import type { Polygon as PcPolygon } from 'polygon-clipping'
import type {
  DxfParseResult, DxfInsert, DetectedZone, MappedItem, BlockExtent, DrawingUnit, ZoneType,
  ProximityLevel, NearBand, SpatialInstanceKind, SpatialPlantInstance, PlantConflictResult,
  RiskLevel, TreeInventoryItem, LayerOverrideAction,
} from '@/types/dxf'
import type { CsvPlantRecord } from '@/types/csvPlant'
import {
  pointInPolygon, polygonBBox, distToPolygonEdge, polygonMinDistance,
  canopyWorldRadius, computeWorldCenter, checkPositionInZone, pointInScope,
  assignAreasToZones, type AnalysisScope,
} from '@/utils/spatialAnalysis'
import {
  groupHatchLoopsByHandle, classifyOuterAndHoles, toRing,
  CM_PER_DRAWING_UNIT, AREA_EPS, multiPolygonArea,
} from '@/utils/zoneStatistics'
import { findPlantsByLayerName, normalizeLayerToken } from '@/utils/plantNameMatch'
import { evaluatePlantPair } from '@/utils/plantEvaluator'
import type { IssueDetail } from '@/utils/plantEvaluator'
import { isExcludedFromPlantingEvaluation } from '@/utils/compatibilityLevels'
import { detectSiteDrainageEvidence } from '@/utils/siteDrainageContext'

/** 本模組只需要 DxfParseResult 的幾何三個欄位，呼叫端不必組出完整的 DxfParseResult */
export type SpatialDxfSource = Pick<DxfParseResult, 'inserts' | 'polygons' | 'blockExtents'>

// ── 鄰近等級設定 ─────────────────────────────────────────────────────────────

export interface ProximityConfig {
  adjacentCm: number   // 0~此值：直接相鄰
  reviewCm: number      // 此值以內：進行檢討；超過視為 far，不比較
  touchEpsCm: number    // 邊界距離在此值以內視為「相接」（touching）
}

export const DEFAULT_PROXIMITY_CONFIG: ProximityConfig = { adjacentCm: 50, reviewCm: 100, touchEpsCm: 2 }

export function classifyDistanceCm(
  distCm: number,
  cfg: ProximityConfig = DEFAULT_PROXIMITY_CONFIG,
): { level: ProximityLevel; nearBand?: NearBand } {
  if (distCm <= 0) return { level: 'overlap' }
  if (distCm <= cfg.touchEpsCm) return { level: 'touching' }
  if (distCm <= cfg.reviewCm) return { level: 'near', nearBand: distCm <= cfg.adjacentCm ? 'adjacent' : 'influence' }
  return { level: 'far' }
}

// ── 喬木冠幅 buffer ───────────────────────────────────────────────────────────

/** 解析 CsvPlantRecord.crownWidth（如 "3-5m"、"300cm"）為半徑（公尺），解析不到回傳 undefined */
export function parseCrownRadiusM(crownWidth: string | undefined): number | undefined {
  if (!crownWidth) return undefined
  const nums = crownWidth.match(/\d+(\.\d+)?/g)
  if (!nums || nums.length === 0) return undefined
  const maxVal = Math.max(...nums.map(Number))
  const isCm = /cm|公分/i.test(crownWidth)
  const diameterM = isCm ? maxVal / 100 : maxVal
  return diameterM / 2   // crownWidth 為冠幅直徑，buffer 半徑取一半
}

/** 樹冠 buffer 半徑（圖面單位）：優先採用資料庫 crownWidth，解析不到才 fallback 用 block bbox 幾何半徑 */
export function resolveTreeCanopyRadiusDU(
  record: CsvPlantRecord | undefined,
  ins: DxfInsert,
  extent: BlockExtent | undefined,
  unit: DrawingUnit,
): number {
  const radiusM = parseCrownRadiusM(record?.crownWidth)
  if (radiusM !== undefined) return (radiusM * 100) / CM_PER_DRAWING_UNIT[unit]
  if (extent) return canopyWorldRadius(ins, extent)
  return 0
}

// ── 圓（樹冠 buffer）↔ 多邊形／圓 距離 ─────────────────────────────────────────

function circleToPolygonDistanceDU(
  center: { x: number; y: number }, radiusDU: number,
  polygon: Array<{ x: number; y: number }>,
): number {
  if (pointInPolygon(center.x, center.y, polygon)) return -radiusDU
  return distToPolygonEdge(center.x, center.y, polygon) - radiusDU
}

function circleToCircleDistanceDU(
  c1: { x: number; y: number }, r1: number,
  c2: { x: number; y: number }, r2: number,
): number {
  return Math.hypot(c2.x - c1.x, c2.y - c1.y) - r1 - r2
}

// ── HATCH 精確重疊判斷（polygon-clipping 真交集，取代粗略的頂點內外測試）─────────

function ringsOverlap(
  ringsA: Array<Array<{ x: number; y: number }>>,
  ringsB: Array<Array<{ x: number; y: number }>>,
): boolean {
  try {
    const polyA: PcPolygon = ringsA.map(toRing)
    const polyB: PcPolygon = ringsB.map(toRing)
    const result = polygonClipping.intersection([polyA], [polyB])
    return multiPolygonArea(result) > AREA_EPS
  } catch {
    return false
  }
}

// ── 逐一實體空間植栽單位建構 ───────────────────────────────────────────────────

function centroidOf(vertices: Array<{ x: number; y: number }>): { x: number; y: number } {
  const n = vertices.length
  return {
    x: vertices.reduce((s, v) => s + v.x, 0) / n,
    y: vertices.reduce((s, v) => s + v.y, 0) / n,
  }
}

function hatchInstanceKind(zt: ZoneType): SpatialInstanceKind {
  if (zt === 'shrub') return 'shrub-hatch'
  if (zt === 'lawn') return 'lawn-hatch'
  if (zt === 'groundcover') return 'groundcover-hatch'
  return 'unknown-hatch'
}

function resolvePlantNameForHatchLayer(
  layer: string,
  keywordMap: Map<string, string[]>,
  plantDB: CsvPlantRecord[],
): string {
  const candidates = findPlantsByLayerName(layer, keywordMap)
  if (candidates.length === 0) {
    const norm = normalizeLayerToken(layer)
    return norm || layer || '(無圖層名稱)'
  }
  return candidates.find(name => plantDB.some(p => p.name === name)) ?? candidates[0]
}

/** 依 reading order（由上而下、由左而右）指派種植區塊標籤，如 "H-12" */
function assignLocationLabels(zoneName: string, instances: SpatialPlantInstance[]): void {
  const prefix = zoneName.charAt(0) || 'Z'
  const sorted = [...instances].sort((a, b) => (b.bbox.maxY - a.bbox.maxY) || (a.bbox.minX - b.bbox.minX))
  sorted.forEach((inst, i) => { inst.label = `${prefix}-${i + 1}` })
}

/** 逐一實體建構每個分區的空間植栽單位（樹＝逐一 INSERT；灌木/地被/草皮＝逐一 HATCH handle-group，不合併） */
/** 人工確認來源批次分類：key 為 `${zoneName}::${normalizeLayerToken(layer)}` */
export function layerOverrideKey(zoneName: string, layer: string): string {
  return `${zoneName}::${normalizeLayerToken(layer)}`
}

export function buildAllSpatialInstances(
  zones: DetectedZone[],
  dxf: SpatialDxfSource,
  mappings: MappedItem[],
  plantDB: CsvPlantRecord[],
  keywordMap: Map<string, string[]>,
  scope: AnalysisScope | undefined,
  unit: DrawingUnit,
  layerOverrides?: Map<string, LayerOverrideAction>,
): Map<string, SpatialPlantInstance[]> {
  const instancesByZone = new Map<string, SpatialPlantInstance[]>()
  for (const z of zones) instancesByZone.set(z.name, [])

  // ── 樹（逐一 INSERT）──
  const mappingIndex = new Map<string, MappedItem>()
  for (const m of mappings) mappingIndex.set(`${m.blockName}||${m.layer}`, m)

  const zoneEdgeTol = new Map<string, number>()
  for (const zone of zones) {
    if (!zone.boundary || zone.boundary.vertices.length < 3) continue
    const bb = polygonBBox(zone.boundary.vertices)
    zoneEdgeTol.set(zone.name, Math.max(1e-6, Math.hypot(bb.width, bb.height) * 0.001))
  }

  let treeSeq = 0
  for (const ins of dxf.inserts) {
    const item = mappingIndex.get(`${ins.blockName}||${ins.layer}`)
    if (!item) continue
    const isTree = (item.plantCategory?.includes('喬木') ?? false) || item.detectedType === '喬木圖塊'
    if (!isTree) continue
    if (!pointInScope(ins.x, ins.y, scope)) continue

    const extent = dxf.blockExtents[ins.blockName]
    let assignedZone: DetectedZone | undefined
    for (const z of zones) {
      if (!z.boundary || z.boundary.vertices.length < 3) continue
      const check = checkPositionInZone({ x: ins.x, y: ins.y }, ins, extent, z.boundary.vertices, zoneEdgeTol.get(z.name) ?? 0)
      if (check.inZone) { assignedZone = z; break }
    }
    if (!assignedZone) continue

    const plantName = item.plantName ?? ins.blockName
    const record = plantDB.find(p => p.name === plantName)
    const canopyRadius = resolveTreeCanopyRadiusDU(record, ins, extent, unit)
    const center = extent ? computeWorldCenter(ins.x, ins.y, ins.scaleX, ins.scaleY, ins.rotation, extent) : { x: ins.x, y: ins.y }

    treeSeq++
    instancesByZone.get(assignedZone.name)!.push({
      id: `tree-${ins.handle ?? treeSeq}`,
      kind: 'tree',
      zoneName: assignedZone.name,
      label: '',
      plantName,
      center,
      bbox: { minX: center.x - canopyRadius, maxX: center.x + canopyRadius, minY: center.y - canopyRadius, maxY: center.y + canopyRadius },
      canopyRadius,
      sourceHandles: ins.handle ? [ins.handle] : [],
    })
  }

  // ── 灌木/地被/草皮（逐一 HATCH handle-group，pre-dedup）──
  const { areaAssign } = assignAreasToZones(zones, dxf.polygons, scope)
  const hatchPolys = dxf.polygons.filter(p => p.source === 'HATCH' && p.closed && p.vertices.length >= 3)
  const handleGroups = groupHatchLoopsByHandle(hatchPolys)

  let hatchSeq = 0
  for (const hg of handleGroups) {
    const islands = classifyOuterAndHoles(hg.loops)
    for (const island of islands) {
      const asns = areaAssign.get(island.outer)
      if (!asns || asns.length === 0) continue
      for (const asn of asns) {
        const zone = zones[asn.zoneIdx]
        if (!zone) continue

        // 使用者在「AI 審查回覆」批次確認過的圖層：灌木/地被/草皮強制改判類型；
        // 排除/暫時忽略則整個實體從分析中拿掉（不產生任何配對）——立即生效，
        // 不需另外重跑上傳流程，見 layerOverrideKey()。
        const override = layerOverrides?.get(layerOverrideKey(zone.name, island.outer.layer))
        if (override === 'exclude') continue
        const effectiveZoneType: ZoneType = override ?? island.outer.zoneType

        const rings = [island.outer.vertices, ...island.holes.map(h => h.vertices)]
        const bb = polygonBBox(island.outer.vertices)
        const plantName = resolvePlantNameForHatchLayer(island.outer.layer, keywordMap, plantDB)
        hatchSeq++
        instancesByZone.get(zone.name)!.push({
          id: `hatch-${hg.handle ?? hatchSeq}-${zone.name}`,
          kind: hatchInstanceKind(effectiveZoneType),
          zoneName: zone.name,
          label: '',
          plantName,
          center: centroidOf(island.outer.vertices),
          bbox: { minX: bb.minX, maxX: bb.maxX, minY: bb.minY, maxY: bb.maxY },
          polygonRings: rings,
          sourceHandles: hg.handle ? [hg.handle] : [],
          sourceLayer: island.outer.layer,
          hatchPattern: island.outer.hatchPattern,
        })
      }
    }
  }

  for (const [zoneName, instances] of instancesByZone) assignLocationLabels(zoneName, instances)
  return instancesByZone
}

// ── 空間鄰近配對 ─────────────────────────────────────────────────────────────

interface ProximityPair {
  a: SpatialPlantInstance
  b: SpatialPlantInstance
  level: ProximityLevel
  nearBand?: NearBand
  distanceCm: number
}

function bboxesOverlap(
  a: { minX: number; maxX: number; minY: number; maxY: number },
  b: { minX: number; maxX: number; minY: number; maxY: number },
): boolean {
  return !(a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY)
}

function computePairDistanceDU(a: SpatialPlantInstance, b: SpatialPlantInstance): { distDU: number; isOverlap: boolean } {
  if (a.kind === 'tree' && b.kind === 'tree') {
    const d = circleToCircleDistanceDU(a.center, a.canopyRadius ?? 0, b.center, b.canopyRadius ?? 0)
    return { distDU: Math.max(0, d), isOverlap: d <= 0 }
  }
  if (a.kind === 'tree' && b.polygonRings) {
    const d = circleToPolygonDistanceDU(a.center, a.canopyRadius ?? 0, b.polygonRings[0])
    return { distDU: Math.max(0, d), isOverlap: d <= 0 }
  }
  if (b.kind === 'tree' && a.polygonRings) {
    const d = circleToPolygonDistanceDU(b.center, b.canopyRadius ?? 0, a.polygonRings[0])
    return { distDU: Math.max(0, d), isOverlap: d <= 0 }
  }
  if (a.polygonRings && b.polygonRings) {
    if (ringsOverlap(a.polygonRings, b.polygonRings)) return { distDU: 0, isOverlap: true }
    return { distDU: polygonMinDistance(a.polygonRings[0], b.polygonRings[0]), isOverlap: false }
  }
  return { distDU: Infinity, isOverlap: false }
}

/** 分區內全對全配對，bbox 粗篩後才做精確距離計算；far 直接丟棄 */
export function computeZoneProximityPairs(
  instances: SpatialPlantInstance[],
  unit: DrawingUnit,
  cfg: ProximityConfig = DEFAULT_PROXIMITY_CONFIG,
): ProximityPair[] {
  const cmPerDU = CM_PER_DRAWING_UNIT[unit]
  const padDU = cfg.reviewCm / cmPerDU
  const out: ProximityPair[] = []

  for (let i = 0; i < instances.length; i++) {
    for (let j = i + 1; j < instances.length; j++) {
      const a = instances[i]; const b = instances[j]
      const paddedA = { minX: a.bbox.minX - padDU, maxX: a.bbox.maxX + padDU, minY: a.bbox.minY - padDU, maxY: a.bbox.maxY + padDU }
      if (!bboxesOverlap(paddedA, b.bbox)) continue   // 粗篩：bbox 都不重疊必為 far，不跑精確計算

      const { distDU, isOverlap } = computePairDistanceDU(a, b)
      if (!isFinite(distDU)) continue
      const distanceCm = distDU * cmPerDU
      if (isOverlap) { out.push({ a, b, level: 'overlap', distanceCm: 0 }); continue }
      const { level, nearBand } = classifyDistanceCm(distanceCm, cfg)
      if (level === 'far') continue
      out.push({ a, b, level, nearBand, distanceCm })
    }
  }
  return out
}

// ── 風險分級（純呈現層推導，不是新的衝突判斷邏輯）─────────────────────────────────
// high/medium/low 依 judgment × proximity 交叉決定；unmatched＝空間上確實鄰近/
// 相接/重疊，但至少一邊植物名稱比對不到資料庫，無法判斷相容性——不可整筆丟棄。

function deriveRiskLevel(judgment: PlantConflictResult['judgment'], proximity: ProximityLevel): RiskLevel {
  if (judgment === 'unmatched') return 'unmatched'
  const close = proximity === 'overlap' || proximity === 'touching'
  if (judgment === 'conflict') return close ? 'high' : 'medium'
  return close ? 'medium' : 'low'   // judgment === 'caution'（'ok' 已在上游被過濾，不會到這裡）
}

// ── 喬木盤點（純空間事實，不做兩兩相容性衝突卡，見規格第 8 點）───────────────────

/**
 * 樹種/數量/株距/樹冠重疊/遮蔭影響：全部從 computeZoneProximityPairs 的原始配對
 * 算出，不依賴植物資料庫比對是否成功（株距、樹冠是否重疊是幾何事實，不是植物
 * 特性比對結果）。
 */
export function computeZoneTreeInventory(
  instances: SpatialPlantInstance[],
  pairs: ProximityPair[],
): TreeInventoryItem[] {
  const trees = instances.filter(i => i.kind === 'tree')
  const byName = new Map<string, SpatialPlantInstance[]>()
  for (const t of trees) {
    const name = t.plantName ?? '(未命名喬木)'
    const arr = byName.get(name) ?? []
    arr.push(t)
    byName.set(name, arr)
  }

  const minSpacingById = new Map<string, number>()
  const overlapCountById = new Map<string, number>()
  const shadedById = new Map<string, Array<{ plantName: string; label: string }>>()

  for (const pair of pairs) {
    const bothTree = pair.a.kind === 'tree' && pair.b.kind === 'tree'
    const understoryKinds: SpatialInstanceKind[] = ['shrub-hatch', 'groundcover-hatch']
    const treeVsUnderstory =
      (pair.a.kind === 'tree' && understoryKinds.includes(pair.b.kind)) ||
      (pair.b.kind === 'tree' && understoryKinds.includes(pair.a.kind))

    if (bothTree) {
      for (const tree of [pair.a, pair.b]) {
        const prev = minSpacingById.get(tree.id)
        if (prev === undefined || pair.distanceCm < prev) minSpacingById.set(tree.id, pair.distanceCm)
        if (pair.level === 'overlap') overlapCountById.set(tree.id, (overlapCountById.get(tree.id) ?? 0) + 1)
      }
    } else if (treeVsUnderstory && pair.level === 'overlap') {
      const tree = pair.a.kind === 'tree' ? pair.a : pair.b
      const understory = pair.a.kind === 'tree' ? pair.b : pair.a
      const arr = shadedById.get(tree.id) ?? []
      arr.push({ plantName: understory.plantName ?? '(未命名)', label: understory.label })
      shadedById.set(tree.id, arr)
    }
  }

  const out: TreeInventoryItem[] = []
  for (const [plantName, group] of byName) {
    const spacings = group.map(t => minSpacingById.get(t.id)).filter((n): n is number => n !== undefined)
    const overlapCount = group.reduce((s, t) => s + (overlapCountById.get(t.id) ?? 0), 0)
    const shaded = group.flatMap(t => shadedById.get(t.id) ?? [])
    out.push({
      plantName,
      count: group.length,
      minSpacingCm: spacings.length > 0 ? Math.round(Math.min(...spacings)) : undefined,
      canopyOverlapCount: overlapCount,
      shadedUnderstory: shaded,
      buildingProximity: 'unsupported',
      drivewayProximity: 'unsupported',
    })
  }
  return out
}

// ── 管線入口 ─────────────────────────────────────────────────────────────────

/**
 * 空間鄰近式衝突檢討管線：分區篩選（zones 本身已是分區篩選結果）→ 空間鄰近篩選
 * （computeZoneProximityPairs，far 直接丟棄）→ 植物特性衝突判斷（evaluatePlantPair，
 * 只比對「這一對」植物，不做整區全組合比較）。
 *
 * 喬木不產生兩兩相容性衝突卡（規格第 8 點）：喬木相關的空間事實改走
 * computeZoneTreeInventory，resultsByZone 只包含灌木/地被/草皮 HATCH 之間的配對。
 *
 * 回傳三份 zoneName → 結果的對照表，instancesByZone 供「在圖面定位」查詢完整
 * 幾何，不再是算完即丟的內部中間產物。
 */
export function computeZonePlantConflicts(
  zones: DetectedZone[],
  dxf: SpatialDxfSource,
  mappings: MappedItem[],
  plantDB: CsvPlantRecord[],
  keywordMap: Map<string, string[]>,
  scope: AnalysisScope | undefined,
  unit: DrawingUnit,
  cfg: ProximityConfig = DEFAULT_PROXIMITY_CONFIG,
  layerOverrides?: Map<string, LayerOverrideAction>,
): {
  resultsByZone: Map<string, PlantConflictResult[]>
  instancesByZone: Map<string, SpatialPlantInstance[]>
  treeInventoryByZone: Map<string, TreeInventoryItem[]>
} {
  const instancesByZone = buildAllSpatialInstances(zones, dxf, mappings, plantDB, keywordMap, scope, unit, layerOverrides)
  const resultsByZone = new Map<string, PlantConflictResult[]>()
  const treeInventoryByZone = new Map<string, TreeInventoryItem[]>()
  let seq = 0

  for (const [zoneName, instances] of instancesByZone) {
    const pairs = computeZoneProximityPairs(instances, unit, cfg)
    treeInventoryByZone.set(zoneName, computeZoneTreeInventory(instances, pairs))

    // 排水衝突的「場地積水證據」是分區層級的判斷，不是逐對配對各自判斷——同一分區
    // 內所有配對共用同一個場地條件，只掃描一次。見 siteDrainageContext.ts。
    const siteDrainageEvidence = detectSiteDrainageEvidence([zoneName, ...instances.map(i => i.sourceLayer)])

    const results: PlantConflictResult[] = []
    for (const pair of pairs) {
      if (pair.a.kind === 'tree' || pair.b.kind === 'tree') continue   // 喬木走盤點，不產生衝突卡
      if (!pair.a.plantName || !pair.b.plantName) continue

      const recA = plantDB.find(p => p.name === pair.a.plantName)
      const recB = plantDB.find(p => p.name === pair.b.plantName)

      // 產品規則：喬木不納入配置評估。上面的 kind==='tree' 只排得掉「畫成獨立
      // 喬木符號」的實體——喬木樹種如果是用 HATCH 面狀畫（例如密植的喬木綠籬/
      // 遮蔽林帶），kind 會是 shrub-hatch 之類，逃過那道過濾。這裡改用比對到
      // 的植物資料庫紀錄（正確反映「這是不是喬木」的植物分類，不受畫法影響）
      // 再過濾一次，兩種訊號都要擋，缺一個都會讓喬木漏進衝突判定。
      if (isExcludedFromPlantingEvaluation(recA) || isExcludedFromPlantingEvaluation(recB)) continue

      let judgment: PlantConflictResult['judgment']
      let issues: IssueDetail[]
      if (!recA || !recB) {
        judgment = 'unmatched'   // 空間上已符合鄰近條件，但比對不到植物資料，不可整筆丟棄
        issues = []
      } else {
        const evalResult = evaluatePlantPair(recA, recB, plantDB, siteDrainageEvidence)
        judgment = evalResult.issues.some(i => i.level === 'danger') ? 'conflict'
          : evalResult.issues.some(i => i.level === 'caution') ? 'caution'
          : 'ok'
        if (judgment === 'ok') continue   // 相容，不需要檢討
        issues = evalResult.issues
      }

      seq++
      results.push({
        id: `conflict-${zoneName}-${seq}`,
        zoneName,
        locationLabel: `${zoneName}／種植區塊 ${pair.a.label}${pair.a.label !== pair.b.label ? `‑${pair.b.label}` : ''}`,
        plantA: { name: pair.a.plantName, label: pair.a.label, kind: pair.a.kind, instanceId: pair.a.id, sourceLayer: pair.a.sourceLayer },
        plantB: { name: pair.b.plantName, label: pair.b.label, kind: pair.b.kind, instanceId: pair.b.id, sourceLayer: pair.b.sourceLayer },
        proximity: pair.level,
        nearBand: pair.nearBand,
        distanceCm: Math.round(pair.distanceCm),
        judgment,
        riskLevel: deriveRiskLevel(judgment, pair.level),
        issues,
      })
    }
    resultsByZone.set(zoneName, results)
  }
  return { resultsByZone, instancesByZone, treeInventoryByZone }
}
