// ── 複層配置空間分析 ──────────────────────────────────────────────────────────

import type {
  DxfPolygon, DxfText, DxfInsert, MappedItem,
  MultiLayerResult, MultiLayerJudgment, ZoneHit, ZoneType,
  DetectedZone, ZonePlantList, ZoneTreeBlock, ZonePlantArea,
  BlockExtent,
} from '@/types/dxf'
import type { CsvPlantRecord } from '@/types/csvPlant'

// ── Ray-casting point-in-polygon ──────────────────────────────────────────────

export function pointInPolygon(px: number, py: number, polygon: Array<{ x: number; y: number }>): boolean {
  let inside = false
  const n = polygon.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const { x: xi, y: yi } = polygon[i]
    const { x: xj, y: yj } = polygon[j]
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
      inside = !inside
    }
  }
  return inside
}

// ── Tolerance: check if point is within `tol` units of a polygon edge ─────────

function distSqToSegment(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const dx = bx - ax; const dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return (px - ax) ** 2 + (py - ay) ** 2
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq))
  return (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
}

function pointNearPolygonEdge(
  px: number, py: number,
  polygon: Array<{ x: number; y: number }>,
  tol: number,
): boolean {
  const tolSq = tol * tol
  const n = polygon.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    if (distSqToSegment(px, py, polygon[j].x, polygon[j].y, polygon[i].x, polygon[i].y) <= tolSq) return true
  }
  return false
}

export function pointInPolygonWithTolerance(
  px: number, py: number,
  polygon: Array<{ x: number; y: number }>,
  tol: number,
): boolean {
  return pointInPolygon(px, py, polygon) || pointNearPolygonEdge(px, py, polygon, tol)
}

// ── Polygon bounding box ──────────────────────────────────────────────────────

export function polygonBBox(vertices: Array<{ x: number; y: number }>): {
  minX: number; maxX: number; minY: number; maxY: number; width: number; height: number
} {
  const xs = vertices.map(v => v.x)
  const ys = vertices.map(v => v.y)
  const minX = Math.min(...xs); const maxX = Math.max(...xs)
  const minY = Math.min(...ys); const maxY = Math.max(...ys)
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY }
}

// ── Zone label for display ────────────────────────────────────────────────────

const ZONE_LABELS: Record<ZoneType, string> = {
  shrub:           '灌木區',
  lawn:            '草皮區',
  groundcover:     '地被區',
  high_irrigation: '高澆灌區',
  low_irrigation:  '低澆灌區',
  tree:            '喬木種植區',
  unknown:         '未分類範圍',
}

export function zoneLabel(t: ZoneType): string {
  return ZONE_LABELS[t] ?? '未知區域'
}

// ── Zone label detection ──────────────────────────────────────────────────────

// 寬鬆版 zone 文字判斷（支援 "A區" / "A 區" / "A-區" / "A區域" / "A区"）
function normalizeZoneName(raw: string): string | null {
  const t = raw.trim()
  // 含「區」字的常見格式：A區 / B 區 / 一區 / 甲區 / A-區 / A區域
  const m = t.match(/^([A-Z一二三四五六七八九十甲乙丙丁戊己庚辛壬癸]{1,3})\s*[-－]?\s*[區区]/)
  if (m) return m[1] + '區'
  // 景觀 / 植栽 / 分區 前綴
  if (/^(景觀|植栽|分區)[A-Z0-9一二三四五六]/.test(t)) return t.slice(0, 3)
  return null
}

// 合併鄰近的拆分文字片段（例如 "A" + "區" 分兩個 TEXT 實體）
function buildCandidateTexts(texts: DxfText[]): Array<{ name: string; x: number; y: number }> {
  const candidates: Array<{ name: string; x: number; y: number }> = []
  const seen = new Set<string>()

  // 1. 直接判斷每個文字
  for (const t of texts) {
    const name = normalizeZoneName(t.content)
    if (name && !seen.has(name)) {
      seen.add(name)
      candidates.push({ name, x: t.x, y: t.y })
    }
  }

  // 2. 拆分文字合併：找含「區」字的文字，再找鄰近的字母/數字前綴
  const zoneCharTexts = texts.filter(t => /[區区]/.test(t.content))
  for (const zt of zoneCharTexts) {
    // 用 HATCH 邊界範圍的 1% 作為鄰近半徑（最小 50 單位）
    const nearRadius = 200
    const prefixTexts = texts.filter(t =>
      t !== zt &&
      Math.hypot(t.x - zt.x, t.y - zt.y) <= nearRadius &&
      /^[A-Z一二三四五六七八九十甲乙丙丁]$/.test(t.content.trim())
    )
    for (const prefix of prefixTexts) {
      const merged = prefix.content.trim() + zt.content.trim()
      const name = normalizeZoneName(merged)
      if (name && !seen.has(name)) {
        seen.add(name)
        candidates.push({
          name,
          x: (prefix.x + zt.x) / 2,
          y: (prefix.y + zt.y) / 2,
        })
      }
    }
  }

  // 3. 孤立的大寫單字母（A / B / C），若落在封閉多邊形內也視為候選
  // （放到 detectZonesFromText 中做 point-in-polygon 判斷）
  return candidates
}

// 計算多邊形中心點
function polygonCenter(vertices: Array<{ x: number; y: number }>): { x: number; y: number } {
  const n = vertices.length
  return {
    x: vertices.reduce((s, v) => s + v.x, 0) / n,
    y: vertices.reduce((s, v) => s + v.y, 0) / n,
  }
}

export function detectZonesFromText(
  texts: DxfText[],
  polygons: DxfPolygon[],
): DetectedZone[] {
  const zones: DetectedZone[] = []
  const seenNames = new Set<string>()
  const closedPolygons = polygons.filter(p => p.closed && p.vertices.length >= 3)

  // ── Step 1: 從文字（包含合併片段）找分區標籤 ───────────────────────────────
  const candidates = buildCandidateTexts(texts)
  for (const cand of candidates) {
    if (seenNames.has(cand.name)) continue
    seenNames.add(cand.name)

    const containingPoly = closedPolygons.find(p =>
      pointInPolygon(cand.x, cand.y, p.vertices)
    )

    zones.push({
      name: cand.name,
      labelPosition: { x: cand.x, y: cand.y },
      boundary: containingPoly,
      confidence: containingPoly ? 'high' : 'medium',
      source: containingPoly ? 'text-in-polygon' : 'text-only',
    })
  }

  // ── Step 2: 孤立大寫字母落在封閉多邊形內 → 視為 zone 候選 ──────────────────
  for (const t of texts) {
    const letter = t.content.trim()
    if (!/^[A-Z]$/.test(letter)) continue
    const zoneName = letter + '區'
    if (seenNames.has(zoneName)) continue

    const containingPoly = closedPolygons.find(p =>
      pointInPolygon(t.x, t.y, p.vertices)
    )
    if (containingPoly) {
      seenNames.add(zoneName)
      zones.push({
        name: zoneName,
        labelPosition: { x: t.x, y: t.y },
        boundary: containingPoly,
        confidence: 'medium',
        source: 'text-in-polygon',
      })
    }
  }

  return zones
}

// ── ZonePlantList ─────────────────────────────────────────────────────────────

function polygonsOverlap(a: DxfPolygon, b: DxfPolygon): boolean {
  // 任意頂點落入另一多邊形即視為重疊
  return (
    a.vertices.some(v => pointInPolygon(v.x, v.y, b.vertices)) ||
    b.vertices.some(v => pointInPolygon(v.x, v.y, a.vertices))
  )
}

// ── World bbox center 計算（套用 INSERT 的 scale + rotation + translation）────

function computeWorldCenter(
  insertX: number, insertY: number,
  scaleX: number, scaleY: number,
  rotationDeg: number,
  extent: BlockExtent,
): { x: number; y: number } {
  const dx = extent.localCx - extent.baseX
  const dy = extent.localCy - extent.baseY
  const rad = rotationDeg * Math.PI / 180
  const cos = Math.cos(rad); const sin = Math.sin(rad)
  return {
    x: insertX + dx * scaleX * cos - dy * scaleY * sin,
    y: insertY + dx * scaleX * sin + dy * scaleY * cos,
  }
}

// ── 判斷單一插入點是否屬於某分區（依優先順序）────────────────────────────────

interface PositionCheckResult {
  inZone: boolean
  method: 'bbox-center' | 'insert-point' | 'none'
  bboxCenter?: { x: number; y: number }
}

function checkPositionInZone(
  pos: { x: number; y: number },
  ins: DxfInsert | undefined,
  extent: BlockExtent | undefined,
  bv: Array<{ x: number; y: number }>,
  tol: number,
): PositionCheckResult {
  // 1. 有 block extent → 先用 world bbox center 判斷
  if (ins && extent) {
    const center = computeWorldCenter(ins.x, ins.y, ins.scaleX, ins.scaleY, ins.rotation, extent)
    if (pointInPolygonWithTolerance(center.x, center.y, bv, tol)) {
      return { inZone: true, method: 'bbox-center', bboxCenter: center }
    }
    // 2. bbox center 不在 → 再用 INSERT point
    if (pointInPolygonWithTolerance(pos.x, pos.y, bv, tol)) {
      return { inZone: true, method: 'insert-point', bboxCenter: center }
    }
    return { inZone: false, method: 'none', bboxCenter: center }
  }
  // 無 extent：直接用 INSERT point（含 tolerance）
  if (pointInPolygonWithTolerance(pos.x, pos.y, bv, tol)) {
    return { inZone: true, method: 'insert-point' }
  }
  return { inZone: false, method: 'none' }
}

export function buildZonePlantList(
  zones: DetectedZone[],
  mappings: MappedItem[],
  polygons: DxfPolygon[],
  inserts?: DxfInsert[],
  blockExtents?: Record<string, BlockExtent>,
): ZonePlantList[] {
  // 建立 INSERT 快速查詢表：blockName → INSERT 清單（按座標匹配）
  const insertsByBlock = new Map<string, DxfInsert[]>()
  for (const ins of (inserts ?? [])) {
    const arr = insertsByBlock.get(ins.blockName) ?? []
    arr.push(ins)
    insertsByBlock.set(ins.blockName, arr)
  }

  return zones.map(zone => {
    const bv = zone.boundary?.vertices ?? []

    // tolerance = 1% of zone diagonal（最小 0.5 單位）
    const tol = bv.length >= 3 ? (() => {
      const bb = polygonBBox(bv)
      return Math.max(0.5, Math.hypot(bb.width, bb.height) * 0.01)
    })() : 0

    // 落在此區的圖塊
    const treeBlocks: ZoneTreeBlock[] = []
    if (bv.length >= 3) {
      const blockInsList = insertsByBlock  // alias for closure
      for (const m of mappings) {
        const extent  = blockExtents?.[m.blockName]
        const insList = blockInsList.get(m.blockName) ?? []

        let inZoneCount = 0
        for (const pos of m.positions) {
          // 找對應的 INSERT（座標精確匹配，容差 0.001）
          const matchedIns = insList.find(ins =>
            Math.abs(ins.x - pos.x) < 0.001 && Math.abs(ins.y - pos.y) < 0.001
          )
          const result = checkPositionInZone(pos, matchedIns, extent, bv, tol)
          if (result.inZone) inZoneCount++
        }
        if (inZoneCount > 0) {
          treeBlocks.push({
            blockName: m.blockName,
            layer: m.layer,
            plantName: m.plantName,
            detectedType: m.detectedType,
            positionsInZone: inZoneCount,
            totalCount: m.count,
          })
        }
      }
    }
    // 若無邊界 → 無法空間判斷，treeBlocks 保持空陣列

    // 與此區重疊的 polygon（灌木 / 草皮 / 地被 / 未知）
    const shrubAreas: ZonePlantArea[] = []
    const lawnAreas: ZonePlantArea[] = []
    const groundcoverAreas: ZonePlantArea[] = []
    const unknownAreas: ZonePlantArea[] = []

    if (zone.boundary) {
      for (const poly of polygons) {
        if (poly === zone.boundary) continue
        if (!poly.closed || poly.vertices.length < 3) continue
        if (!polygonsOverlap(zone.boundary, poly)) continue

        const n = poly.vertices.length
        const cx = poly.vertices.reduce((s, v) => s + v.x, 0) / n
        const cy = poly.vertices.reduce((s, v) => s + v.y, 0) / n
        const area: ZonePlantArea = {
          layer: poly.layer,
          zoneType: poly.zoneType,
          source: poly.source,
          vertexCount: n,
          centerX: cx,
          centerY: cy,
          hatchPattern: poly.hatchPattern,  // 傳遞 HATCH pattern name 供圖例對照
        }
        switch (poly.zoneType) {
          case 'shrub':
          case 'tree':
            shrubAreas.push(area); break
          case 'lawn':
            lawnAreas.push(area); break
          case 'groundcover':
            groundcoverAreas.push(area); break
          default:
            unknownAreas.push(area); break
        }
      }
    }

    return { zone, treeBlocks, shrubAreas, lawnAreas, groundcoverAreas, unknownAreas }
  })
}

// ── Debug helper: zone assignment summary ─────────────────────────────────────

export interface InstanceDebug {
  blockName: string
  insertX: number
  insertY: number
  bboxCenterX?: number
  bboxCenterY?: number
  scaleX?: number
  scaleY?: number
  rotation?: number
  layer: string
  assignedZone: string   // 分區名稱 或 '未歸區'
  method: 'bbox-center' | 'insert-point' | 'none'
  reason: string
}

export interface ZoneAssignDebug {
  totalInserts: number
  totalMappings: number
  assignedCount: number
  instances: InstanceDebug[]   // 每一棵樹（每個 INSERT 實例）
  unassigned: Array<{
    blockName: string
    layer: string
    count: number
    detectedType?: string
    samplePositions: Array<{ x: number; y: number }>
  }>
  perZone: Array<{
    name: string
    hasBoundary: boolean
    bbox?: { minX: number; maxX: number; minY: number; maxY: number; width: number; height: number }
    vertexCount: number
    blockCount: number
    blocks: Array<{ blockName: string; positionsInZone: number; totalCount: number }>
  }>
}

export function buildZoneAssignDebug(
  zones: DetectedZone[],
  zonePlantLists: ZonePlantList[],
  mappings: MappedItem[],
  inserts?: DxfInsert[],
  blockExtents?: Record<string, BlockExtent>,
): ZoneAssignDebug {
  const assignedBlockNames = new Set<string>()
  for (const zpl of zonePlantLists) {
    for (const tb of zpl.treeBlocks) assignedBlockNames.add(tb.blockName)
  }

  // ── per-instance debug（每一棵樹的歸區詳情）─────────────────────────────────
  const instances: InstanceDebug[] = []

  const insertsByBlock = new Map<string, DxfInsert[]>()
  for (const ins of (inserts ?? [])) {
    const arr = insertsByBlock.get(ins.blockName) ?? []
    arr.push(ins)
    insertsByBlock.set(ins.blockName, arr)
  }

  for (const m of mappings) {
    const extent  = blockExtents?.[m.blockName]
    const insList = insertsByBlock.get(m.blockName) ?? []

    for (const pos of m.positions) {
      const matchedIns = insList.find(ins =>
        Math.abs(ins.x - pos.x) < 0.001 && Math.abs(ins.y - pos.y) < 0.001
      )

      // 找哪個分區包含此位置
      let assignedZone = '未歸區'
      let method: InstanceDebug['method'] = 'none'
      let reason = '未落入任何分區 polygon'
      let bboxCx: number | undefined; let bboxCy: number | undefined

      for (const zpl of zonePlantLists) {
        const bv = zpl.zone.boundary?.vertices ?? []
        if (bv.length < 3) { reason = '分區無邊界 polygon'; continue }
        const tol = (() => {
          const bb = polygonBBox(bv)
          return Math.max(0.5, Math.hypot(bb.width, bb.height) * 0.01)
        })()

        const result = checkPositionInZone(pos, matchedIns, extent, bv, tol)
        if (result.bboxCenter) { bboxCx = result.bboxCenter.x; bboxCy = result.bboxCenter.y }
        if (result.inZone) {
          assignedZone = zpl.zone.name
          method = result.method
          reason = method === 'bbox-center'
            ? `bbox center (${result.bboxCenter!.x.toFixed(1)}, ${result.bboxCenter!.y.toFixed(1)}) 落在 polygon 內`
            : `INSERT point (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}) 落在 polygon 內（含 tol ${tol.toFixed(1)}）`
          break
        }
      }

      if (assignedZone === '未歸區' && zones.length > 0) {
        // 計算到最近分區 bbox 的距離，輔助診斷
        let minDist = Infinity
        let nearestZone = ''
        for (const zpl of zonePlantLists) {
          const bv = zpl.zone.boundary?.vertices
          if (!bv || bv.length < 3) continue
          const bb = polygonBBox(bv)
          const cx = (bb.minX + bb.maxX) / 2; const cy = (bb.minY + bb.maxY) / 2
          const d = Math.hypot(pos.x - cx, pos.y - cy)
          if (d < minDist) { minDist = d; nearestZone = zpl.zone.name }
        }
        if (nearestZone) {
          reason = `最近分區 ${nearestZone} bbox 中心距離 ${minDist.toFixed(1)} 單位`
        }
      }

      instances.push({
        blockName: m.blockName,
        insertX: pos.x, insertY: pos.y,
        bboxCenterX: bboxCx, bboxCenterY: bboxCy,
        scaleX: matchedIns?.scaleX, scaleY: matchedIns?.scaleY,
        rotation: matchedIns?.rotation,
        layer: m.layer,
        assignedZone, method, reason,
      })
    }
  }

  const unassigned = mappings
    .filter(m => !assignedBlockNames.has(m.blockName))
    .map(m => ({
      blockName: m.blockName,
      layer: m.layer,
      count: m.count,
      detectedType: m.detectedType,
      samplePositions: m.positions.slice(0, 5),
    }))

  const perZone = zonePlantLists.map(zpl => {
    const bv = zpl.zone.boundary?.vertices
    return {
      name: zpl.zone.name,
      hasBoundary: !!bv,
      bbox: bv ? polygonBBox(bv) : undefined,
      vertexCount: bv?.length ?? 0,
      blockCount: zpl.treeBlocks.length,
      blocks: zpl.treeBlocks.map(tb => ({
        blockName: tb.blockName,
        positionsInZone: tb.positionsInZone,
        totalCount: tb.totalCount,
      })),
    }
  })

  return {
    totalInserts: (inserts ?? []).length,
    totalMappings: mappings.length,
    assignedCount: assignedBlockNames.size,
    instances,
    unassigned,
    perZone,
  }
}

// ── Conflict judgment per tree × zone combination ────────────────────────────

type ConflictLevel = 'ok' | 'caution' | 'conflict'

function escalate(current: ConflictLevel, next: ConflictLevel): ConflictLevel {
  if (next === 'conflict') return 'conflict'
  if (next === 'caution' && current !== 'conflict') return 'caution'
  return current
}

function judgeZone(
  zone: ZoneHit,
  plant: CsvPlantRecord | undefined,
  reasons: string[],
  suggestions: string[],
  current: ConflictLevel,
): ConflictLevel {
  const name = plant?.name ?? '（未對應植物）'
  const waterReq = plant?.waterRequirement ?? ''
  const wetTol = plant?.wetTolerance ?? ''
  const drought = plant?.droughtTolerance ?? ''
  const sun = plant?.sunRequirement ?? ''

  switch (zone.zoneType) {

    // ── Shrub / groundcover: normal multi-layer, almost always OK ──────────
    case 'shrub':
    case 'groundcover':
      // Only raise caution if plant is known to cause root competition
      // For POC just mark as OK
      break

    // ── Lawn zone: roots vs lawn, shading concerns ────────────────────────
    case 'lawn': {
      const lvl: ConflictLevel = 'caution'
      current = escalate(current, lvl)
      reasons.push('喬木插入點落於草皮區，成熟後根系擴展可能壓縮草皮生長空間')
      suggestions.push('確認選用淺根系樹種，或在樹穴周圍設置根系隔板')
      if (sun.includes('全日照')) {
        reasons.push('全日照喬木樹冠成熟後可能造成草皮遮蔭，影響草皮光合作用')
        suggestions.push('選用半日照耐陰草種，或將喬木位置調整至草皮邊緣')
      }
      break
    }

    // ── High irrigation: risk for drought-tolerant or poorly-drained trees ─
    case 'high_irrigation': {
      if (wetTol === '不耐積水') {
        current = escalate(current, 'conflict')
        reasons.push(`${name} 屬不耐積水樹種，配置於高澆灌區易造成根部積水腐爛`)
        suggestions.push('將該植物移至低澆灌區，或改選耐濕樹種（如水黃皮、水柳）')
      } else if (drought.includes('耐旱') && !drought.includes('不耐旱') && !drought.includes('稍')) {
        current = escalate(current, 'caution')
        reasons.push(`${name} 為耐旱植物，長期置於高澆灌區可能因過度澆灌抑制根系氧氣交換`)
        suggestions.push('可降低此區澆灌頻率，或考慮置換為較耐濕的同類植物')
      }
      break
    }

    // ── Low irrigation: risk for high-water-demand trees ──────────────────
    case 'low_irrigation': {
      if (waterReq === '高' || waterReq === '中至高') {
        current = escalate(current, 'conflict')
        reasons.push(`${name} 水分需求高（${waterReq}），配置於低澆灌區，乾旱期間水分嚴重不足`)
        suggestions.push('移至高澆灌區，或更換耐旱樹種（如台灣欒樹、茄苳）')
      } else if (waterReq === '中') {
        current = escalate(current, 'caution')
        reasons.push(`${name} 水分需求中等，低澆灌區在夏季乾旱時可能不足`)
        suggestions.push('建議設置補充澆灌點或選用水分需求低至中的替代樹種')
      }
      break
    }

    default:
      break
  }

  return current
}

// ── Main analysis ─────────────────────────────────────────────────────────────

const TREE_KEYWORDS = ['喬木', 'tree', 'TREE', '樹', '木']

function isLikelyTree(item: MappedItem, plant: CsvPlantRecord | undefined): boolean {
  if (plant?.category === 'tree') return true
  const bn = item.blockName.toLowerCase()
  const ln = item.layer.toLowerCase()
  return TREE_KEYWORDS.some(kw => bn.includes(kw.toLowerCase()) || ln.includes(kw.toLowerCase()))
}

export function analyzeMultiLayer(
  mappings: MappedItem[],
  polygons: DxfPolygon[],
  plants: CsvPlantRecord[],
): MultiLayerResult[] {
  const results: MultiLayerResult[] = []

  // Only use closed polygons with known zones (excluding 'tree' and 'unknown')
  const validPolygons = polygons.filter(p =>
    p.closed && p.vertices.length >= 3 &&
    p.zoneType !== 'unknown' && p.zoneType !== 'tree'
  )

  // Identify tree mappings
  const treeMappings = mappings.filter(m => {
    const plant = plants.find(p => p.name === m.plantName)
    return isLikelyTree(m, plant)
  })

  // If no tree-classified mappings found, warn (return empty)
  if (treeMappings.length === 0) return []

  for (const treeItem of treeMappings) {
    const plant = plants.find(p => p.name === treeItem.plantName)

    // Analyse each insertion point (limit to 20 per block for performance)
    const positions = treeItem.positions.slice(0, 20)

    for (let posIdx = 0; posIdx < positions.length; posIdx++) {
      const pos = positions[posIdx]

      // Find all zones that contain this point
      const hits: ZoneHit[] = []
      for (const poly of validPolygons) {
        if (pointInPolygon(pos.x, pos.y, poly.vertices)) {
          // Avoid duplicate zone types from same layer
          if (!hits.some(h => h.layerName === poly.layer)) {
            hits.push({ zoneType: poly.zoneType, layerName: poly.layer })
          }
        }
      }

      // Skip points not in any zone
      if (hits.length === 0) continue

      // Determine judgment
      const reasons: string[] = []
      const suggestions: string[] = []
      let level: ConflictLevel = 'ok'

      for (const hit of hits) {
        level = judgeZone(hit, plant, reasons, suggestions, level)
      }

      const judgment: MultiLayerJudgment = level === 'ok' ? 'ok' : level

      // Build underlayer description
      const zoneNames = [...new Set(hits.map(h => zoneLabel(h.zoneType)))]
      const underlayerDesc = zoneNames.join('、') || '—'

      // Add default reasons for OK cases
      if (level === 'ok' && reasons.length === 0) {
        const underTypes = hits.map(h => h.zoneType)
        if (underTypes.some(t => t === 'shrub' || t === 'groundcover')) {
          reasons.push('喬木與下層灌木、地被形成合理複層植栽結構')
        }
      }

      results.push({
        treeBlockName: treeItem.blockName,
        treePlantName: treeItem.plantName,
        treeLayer: treeItem.layer,
        position: pos,
        positionIndex: posIdx + 1,
        totalCount: treeItem.count,
        zones: hits,
        judgment,
        underlayerDesc,
        riskReasons: reasons.length > 0 ? reasons : ['空間關係正常，無明顯衝突'],
        suggestions: suggestions.length > 0 ? suggestions : ['維持現有配置，定期觀察生長情況'],
      })
    }
  }

  // Deduplicate: keep worst judgment per treeBlock + zoneKey combo
  const deduped = new Map<string, MultiLayerResult>()
  for (const r of results) {
    const key = `${r.treeBlockName}||${r.zones.map(z => z.zoneType).sort().join(',')}`
    const existing = deduped.get(key)
    if (!existing) { deduped.set(key, r); continue }
    const rank = { conflict: 3, caution: 2, unclear: 1, ok: 0 }
    if (rank[r.judgment] > rank[existing.judgment]) deduped.set(key, r)
  }

  return Array.from(deduped.values()).sort((a, b) => {
    const rank: Record<MultiLayerJudgment, number> = { conflict: 3, caution: 2, unclear: 1, ok: 0 }
    return rank[b.judgment] - rank[a.judgment]
  })
}
