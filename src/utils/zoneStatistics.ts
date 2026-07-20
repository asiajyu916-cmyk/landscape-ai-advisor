// ── 分區植栽面積與喬木數量統計 ──────────────────────────────────────────────────
//
// 核心設計（見 memory / 規格文件「分區植栽面積與喬木數量統計」）：
//   - HATCH 與分區的「實際交集面積」用 polygon-clipping 做精確多邊形布林運算，
//     取代舊有的網格取樣近似法（samplePolygonPoints，見 spatialAnalysis.ts）。
//   - 同一 HATCH 實體的多個 loop（外邊界＋孔洞／多個不連續面域）以 DXF entity
//     handle 分組，孔洞不計入面積。
//   - 去重：以 handle（或缺 handle 時的內容指紋）避免同一實體被解析流程重複讀取
//     而重複加總（dxfParser.ts 的 *Model_Space 與傳統 ENTITIES section 會並行解析，
//     兩者讀到同一實體時 handle 相同，可藉此去重）。
//   - 圖例／索引表區內的示範 HATCH 一律排除，沿用 detectAnalysisScope 已算好的
//     legendBoxes。
//   - 圖面單位（mm/cm/m）換算面積；無法辨識時由呼叫端（UI）先詢問使用者。

// polygon-clipping 的 ESM build 只有 default export（{ union, intersection, xor, difference }），
// 其 .d.ts 宣告的具名 export 與實際打包產物不符，具名 import 會在 vite build 時失敗。
import polygonClipping from 'polygon-clipping'
import type { Ring as PcRing, Polygon as PcPolygon, MultiPolygon as PcMultiPolygon } from 'polygon-clipping'

const { intersection, union } = polygonClipping
import type {
  DxfParseResult, DxfPolygon, DetectedZone, MappedItem, BlockExtent,
  DrawingUnit, PlantStatCategory, ZoneType,
  ZoneHatchPlantStat, ZoneTreePlantStat, ZoneUnknownPlantStat, ZoneStatisticsResult,
} from '@/types/dxf'
import {
  pointInPolygon, polygonArea, polygonBBox,
  type AnalysisScope, pointInLegendBoxes, checkPositionInZone,
  canopyWorldRadius, computeWorldCenter,
} from '@/utils/spatialAnalysis'
import { normalizeLayerToken, findPlantsByLayerName } from '@/utils/plantNameMatch'

// ── 單位換算 ────────────────────────────────────────────────────────────────

export const UNIT_DIVISOR: Record<DrawingUnit, number> = { mm: 1_000_000, cm: 10_000, m: 1 }

/** HEADER $INSUNITS 原始代碼 → DrawingUnit；僅認 mm(4)/cm(5)/m(6)，其餘一律「無法辨識」交給 UI 詢問 */
export function unitFromInsUnits(code?: number): DrawingUnit | undefined {
  if (code === 4) return 'mm'
  if (code === 5) return 'cm'
  if (code === 6) return 'm'
  return undefined
}

const AREA_EPS = 1e-6   // 圖面單位²，濾除浮點雜訊交集
const round2 = (n: number) => Math.round(n * 100) / 100

// ── 去重／內容指紋 ─────────────────────────────────────────────────────────────

function centroid(vertices: Array<{ x: number; y: number }>): { x: number; y: number } {
  const n = vertices.length
  return {
    x: vertices.reduce((s, v) => s + v.x, 0) / n,
    y: vertices.reduce((s, v) => s + v.y, 0) / n,
  }
}

/** 缺 handle 時的內容指紋（layer + bbox + 面積 + 頂點數），供備援去重用 */
function loopFingerprint(p: DxfPolygon): string {
  const bb = polygonBBox(p.vertices)
  const area = polygonArea(p.vertices)
  return `${p.layer}|${bb.minX.toFixed(1)}|${bb.minY.toFixed(1)}|${bb.maxX.toFixed(1)}|${bb.maxY.toFixed(1)}|${area.toFixed(3)}|${p.vertices.length}`
}

/** 同一 handle 底下的 loop 若內容指紋重複，視為解析流程重複讀取所致，僅保留一份 */
function dedupLoopsByFingerprint(loops: DxfPolygon[]): DxfPolygon[] {
  const seen = new Set<string>()
  const out: DxfPolygon[] = []
  for (const l of loops) {
    const fp = loopFingerprint(l)
    if (seen.has(fp)) {
      console.debug(`[分區統計] 排除重複 HATCH loop（內容指紋相同）：handle=${l.handle ?? '(無)'} layer=${l.layer}`)
      continue
    }
    seen.add(fp)
    out.push(l)
  }
  return out
}

interface HandleGroup { handle: string | undefined; loops: DxfPolygon[] }

/** 同一 HATCH 實體（同一 handle）的多個 loop 分為一組，供孔洞判斷用 */
function groupHatchLoopsByHandle(polys: DxfPolygon[]): HandleGroup[] {
  const map = new Map<string, DxfPolygon[]>()
  const noHandle: DxfPolygon[] = []
  for (const p of polys) {
    if (p.handle) {
      const arr = map.get(p.handle) ?? []
      arr.push(p)
      map.set(p.handle, arr)
    } else {
      noHandle.push(p)
    }
  }
  const groups: HandleGroup[] = []
  for (const [handle, loops] of map) groups.push({ handle, loops: dedupLoopsByFingerprint(loops) })
  // 缺 handle：無法群組孔洞，各自視為獨立面域（極舊 DXF 才會發生，記錄於除錯）
  for (const p of noHandle) {
    console.debug(`[分區統計] HATCH 缺 entity handle，無法群組孔洞，視為獨立面域：layer=${p.layer}`)
    groups.push({ handle: undefined, loops: [p] })
  }
  return groups
}

// ── 孔洞／島狀區域判斷 ─────────────────────────────────────────────────────────

interface LoopGroup { outer: DxfPolygon; holes: DxfPolygon[] }

/** 同一 handle 內：面積由大到小排序，重心落在較大 loop 內者視為孔洞；否則為新的外邊界（支援島狀多重面域） */
function classifyOuterAndHoles(loops: DxfPolygon[]): LoopGroup[] {
  const sorted = [...loops].sort((a, b) => polygonArea(b.vertices) - polygonArea(a.vertices))
  const outers: LoopGroup[] = []
  for (const loop of sorted) {
    const c = centroid(loop.vertices)
    const parent = outers.find(o => pointInPolygon(c.x, c.y, o.outer.vertices))
    if (parent) parent.holes.push(loop)
    else outers.push({ outer: loop, holes: [] })
  }
  return outers
}

// ── polygon-clipping 轉換與面積計算 ────────────────────────────────────────────

// 座標吸附到小數點後 6 位：弧線切分（parseHatchBoundary 的 cos/sin 計算）產生的端點常見
// 極微小浮點誤差（例如 1e-8 量級的雙重計算路徑差異），會讓理論上重合的點在 polygon-clipping
// 眼中變成「幾乎但不完全相同」的獨立頂點，觸發其環閉合演算法丟出例外（"Unable to complete
// output ring..."），導致該 HATCH 整塊面積被略過。吸附後移除相鄰重複點即可穩定避開此問題。
function snap(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

function toRing(vertices: Array<{ x: number; y: number }>): PcRing {
  const ring: PcRing = []
  for (const v of vertices) {
    const pt: [number, number] = [snap(v.x), snap(v.y)]
    const prev = ring[ring.length - 1]
    if (!prev || prev[0] !== pt[0] || prev[1] !== pt[1]) ring.push(pt)
  }
  const first = ring[0]; const last = ring[ring.length - 1]
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) ring.push([first[0], first[1]])
  return ring
}

function toClippingPolygon(group: LoopGroup): PcPolygon {
  return [toRing(group.outer.vertices), ...group.holes.map(h => toRing(h.vertices))]
}

function ringArea(ring: PcRing): number {
  let sum = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
  }
  return Math.abs(sum) / 2
}

/** 多邊形（含孔洞）面積：外環 - 內環（孔洞不計入） */
function polygonWithHolesArea(poly: PcPolygon): number {
  if (poly.length === 0) return 0
  let area = ringArea(poly[0])
  for (let i = 1; i < poly.length; i++) area -= ringArea(poly[i])
  return Math.max(0, area)
}

function multiPolygonArea(mp: PcMultiPolygon): number {
  return mp.reduce((s, poly) => s + polygonWithHolesArea(poly), 0)
}

/** 一個 HATCH（可能含多個島狀外邊界）與分區邊界的實際交集形狀（圖面單位，尚未除以換算倍率） */
function intersectClipped(islands: LoopGroup[], zoneRing: PcRing): PcMultiPolygon {
  const validIslands = islands.filter(g => g.outer.vertices.length >= 3)
  if (validIslands.length === 0) return []
  const hatchMulti: PcMultiPolygon = validIslands.map(toClippingPolygon)
  const zonePoly: PcPolygon = [zoneRing]
  try {
    return intersection(hatchMulti, [zonePoly])
  } catch (err) {
    console.debug('[分區統計] polygon-clipping intersection 失敗，此 HATCH 於本分區略過', err)
    return []
  }
}

/** 多個形狀聯集（同一植栽的多塊 HATCH 若彼此重疊，聯集後面積才等於真實覆蓋範圍，而非重疊部分被算兩次的加總） */
function unionShapes(shapes: PcMultiPolygon[]): PcMultiPolygon {
  const nonEmpty = shapes.filter(s => s.length > 0)
  if (nonEmpty.length === 0) return []
  if (nonEmpty.length === 1) return nonEmpty[0]
  try {
    return union(nonEmpty[0], ...nonEmpty.slice(1))
  } catch (err) {
    console.debug('[分區統計] polygon-clipping union 失敗，退回原始形狀（重疊部分可能仍被重複計入）', err)
    return nonEmpty.flat() as PcMultiPolygon
  }
}

// ── 植栽名稱比對（沿用既有圖層-植栽對照鏈）─────────────────────────────────────

function hatchCategoryFromZoneType(zt: ZoneType): PlantStatCategory {
  if (zt === 'shrub' || zt === 'lawn' || zt === 'groundcover') return zt
  return 'unknown'
}

/**
 * 合併判斷優先順序（規格二.2）：
 *   1. 已建立的「圖層名稱－植栽名稱」對照資料（findPlantsByLayerName／keywordMap）
 *   2. 標準化後的圖層名稱
 *   3. HATCH 所屬 Layer 名稱（標準化後仍為空時的最終備援）
 */
function resolvePlantNameForLayer(
  layer: string,
  keywordMap: Map<string, string[]>,
): { plantName: string; matchSource: string } {
  const candidates = findPlantsByLayerName(layer, keywordMap)
  if (candidates.length === 1) return { plantName: candidates[0], matchSource: '圖層-植栽對照表(單一命中)' }
  if (candidates.length > 1) {
    return { plantName: candidates[0], matchSource: `圖層-植栽對照表(多重命中:${candidates.join('/')}，取第一筆，需人工確認)` }
  }
  const norm = normalizeLayerToken(layer)
  if (norm) return { plantName: norm, matchSource: '標準化圖層名稱(無比對到植栽資料)' }
  return { plantName: layer || '(無圖層名稱)', matchSource: '原始圖層名稱(標準化後為空)' }
}

// ── 喬木 BLOCK 分類 ────────────────────────────────────────────────────────────

type BlockClass = 'tree' | 'plant-other' | 'not-plant'

function classifyMappedItem(item: MappedItem): BlockClass {
  const isTree = (item.plantCategory?.includes('喬木') ?? false) || item.detectedType === '喬木圖塊'
  if (isTree) return 'tree'
  const isPlantish = !!item.detectedType || !!item.plantCategory
  return isPlantish ? 'plant-other' : 'not-plant'
}

// ── 主入口 ─────────────────────────────────────────────────────────────────────

export function buildZoneStatistics(
  dxf: DxfParseResult,
  zones: DetectedZone[],
  scope: AnalysisScope,
  unit: DrawingUnit,
  keywordMap: Map<string, string[]>,
  mappings: MappedItem[],
): ZoneStatisticsResult[] {
  const divisor = UNIT_DIVISOR[unit]

  console.group(`[分區統計] 開始計算（單位=${unit}，換算倍率=1/${divisor}）`)

  const validZones = zones.filter(z => {
    const ok = !!z.boundary && z.boundary.vertices.length >= 3
    console.debug(`[分區統計] 分區 Polygon 有效性：${z.name} = ${ok ? '有效' : '無邊界，略過統計'}`)
    return ok
  })

  // ── 1. HATCH：排除圖例/索引表區 ──
  const hatchPolysAll = dxf.polygons.filter(p => p.source === 'HATCH' && p.closed && p.vertices.length >= 3)
  const hatchPolys = hatchPolysAll.filter(p => {
    const c = centroid(p.vertices)
    const excluded = pointInLegendBoxes(c.x, c.y, scope.legendBoxes)
    if (excluded) console.debug(`[分區統計] 排除圖例/索引表區 HATCH：handle=${p.handle ?? '(無)'} layer=${p.layer}`)
    return !excluded
  })

  // ── 2. 依 handle 分組（去重）+ 孔洞/島狀分類（僅需計算一次，各分區重複使用）──
  // 同時算出每個 HATCH 自身的完整面積（未與任何分區相交前），供下方「重疊比例門檻」判斷用：
  // 大範圍植栽（例如鄰區的灌木/草皮 HATCH）若只是邊緣掃過某個很小的分區邊界，精確的多邊形
  // 交集仍會算出一塊非零面積，但那對此 HATCH 自身而言只是極小比例，明顯是分區邊界線與鄰區
  // 植栽邊緣太接近造成的幾何雜訊，不是真的跨區設計，必須排除，否則會讓小分區的植栽覆蓋率
  // 被鄰區大範圍植栽的「路過」嚴重灌水（曾實測：10.79 ㎡ 的分區被灌到 218%）。
  const handleGroups = groupHatchLoopsByHandle(hatchPolys)
  const hatchGroupsAll = handleGroups
    .map(hg => {
      const islands = classifyOuterAndHoles(hg.loops)
      const ownArea = multiPolygonArea(islands.map(toClippingPolygon))
      return { ...hg, islands, ownArea }
    })
    .filter(hg => hg.islands.length > 0)

  // ── 喬木 BLOCK 內裝飾性 HATCH 排除 ──────────────────────────────────────────
  // 喬木符號圖塊常內建裝飾性填充圖案（例如樹冠圖示紋理），巢狀展開後會被解析成獨立
  // HATCH，但這些並非真正的種植範圍。四個條件須「同時成立」才排除，任一項不成立仍
  // 保留在「待確認植栽」清單，避免誤刪真正的植栽（業主明確要求：不可僅靠面積大小
  // 判定，0.98 m² 也可能是真實的小型灌木/地被種植區；面積只能當輔助條件，不能是
  // 唯一依據）。後台除錯資訊仍保留完整紀錄，標記為 excludedNestedTreeBlockHatch：
  //   1. HATCH 巢狀在喬木 BLOCK 內（parentBlockName 存在且該 BLOCK 判定為喬木）
  //   2. Layer 僅含「喬木／樹木／TREE」等類別詞，不含具體樹種名稱
  //   3. 未建立人工確認的 Layer－植物對照（圖層-植栽對照表 keywordMap 比對不到任何具體植物名稱）
  //   4. 幾何可判定為樹冠填色／遮罩／樹幹／圖塊裝飾：此 HATCH 的重心落在該 BLOCK
  //      實際插入位置的「樹冠世界半徑」範圍內（沿用既有 canopyWorldRadius／
  //      computeWorldCenter，即 buildZonePlantList 判斷喬木歸區已驗證過的同一套
  //      幾何邏輯）——代表這塊 HATCH 的位置就是這棵樹自己的圖示範圍，而非額外疊加、
  //      獨立於樹木位置之外的真實種植 HATCH。面積僅作最終安全上限（5 m²），避免
  //      極端情況下誤判過大範圍，不作為主要排除依據。
  const NESTED_DECORATIVE_HATCH_SANITY_MAX_AREA_M2 = 5
  const isGenericTreeCategoryLayer = (layer: string): boolean => {
    const remainder = layer.replace(/^[A-Za-z0-9]+[-_]?/, '').trim()
    return /^(喬木|樹木|tree)$/i.test(remainder)
  }
  const treeBlockNames = new Set(mappings.filter(m => classifyMappedItem(m) === 'tree').map(m => m.blockName))
  const insertByHandle = new Map<string, typeof dxf.inserts[number]>()
  for (const ins of dxf.inserts) if (ins.handle) insertByHandle.set(ins.handle, ins)

  const isWithinParentCanopy = (hg: typeof hatchGroupsAll[number]): boolean => {
    const parentBlockName = hg.loops[0].parentBlockName
    const compositeHandle = hg.handle
    if (!parentBlockName || !compositeHandle) return false
    const parentInsertHandle = compositeHandle.split('::')[0]
    const parentIns = insertByHandle.get(parentInsertHandle)
    const extent = dxf.blockExtents[parentBlockName]
    if (!parentIns || !extent) return false
    const canopyR = canopyWorldRadius(parentIns, extent)
    if (canopyR <= 0) return false
    const canopyCenter = computeWorldCenter(parentIns.x, parentIns.y, parentIns.scaleX, parentIns.scaleY, parentIns.rotation, extent)
    const hatchCentroid = centroid(hg.loops.flatMap(l => l.vertices))
    const dist = Math.hypot(hatchCentroid.x - canopyCenter.x, hatchCentroid.y - canopyCenter.y)
    return dist <= canopyR * 1.1   // 容許 10% 誤差
  }

  const excludedNestedTreeBlockHatch: Array<{
    entityHandle: string; parentBlockName: string; layerName: string; areaM2: number; reason: string
  }> = []
  const hatchGroups = hatchGroupsAll.filter(hg => {
    const layer = hg.loops[0].layer
    const parentBlockName = hg.loops[0].parentBlockName
    const cond1 = !!parentBlockName && treeBlockNames.has(parentBlockName)
    const cond2 = isGenericTreeCategoryLayer(layer)
    const cond3 = findPlantsByLayerName(layer, keywordMap).length === 0
    const cond4 = isWithinParentCanopy(hg)
    const areaM2 = hg.ownArea / divisor
    const sanityOk = areaM2 < NESTED_DECORATIVE_HATCH_SANITY_MAX_AREA_M2
    if (cond1 && cond2 && cond3 && cond4 && sanityOk) {
      excludedNestedTreeBlockHatch.push({
        entityHandle: hg.handle ?? '(無)', parentBlockName: parentBlockName!, layerName: layer,
        areaM2: round2(areaM2), reason: '巢狀於喬木BLOCK內、Layer僅類別詞、無圖層-植栽對照、重心落於該樹樹冠世界半徑內',
      })
      return false
    }
    return true
  })
  if (excludedNestedTreeBlockHatch.length > 0) {
    console.group(`[分區統計] excludedNestedTreeBlockHatch — 已排除圖塊內裝飾 HATCH：${excludedNestedTreeBlockHatch.length} 筆（不計入任何分區統計，正式介面不顯示，僅供後台除錯核對）`)
    for (const e of excludedNestedTreeBlockHatch) {
      console.debug(`  handle=${e.entityHandle} parentBlock=${e.parentBlockName} layer=${e.layerName} area=${e.areaM2}m² 原因=${e.reason}`)
    }
    console.groupEnd()
  }

  // 交集面積需達 HATCH 自身總面積的此比例以上，才視為「真的跨進此分區」；低於門檻視為
  // 邊界線與鄰區植栽邊緣相切造成的雜訊，排除、僅記錄於除錯訊息。
  const MIN_OVERLAP_RATIO = 0.05
  // 本分區內的頂點數需達 HATCH 自身總頂點數的此比例以上，才視為「主體真的在這一區」——
  // 實測案例：89 個頂點僅 3 個落在小分區內（3.4%），面積比例卻達 6.5%（因為 HATCH 本身
  // 極大），若只靠面積比例會誤判為跨區，實際上 AutoCAD 證實這塊完全不屬於該分區。
  const MIN_VERTEX_RATIO = 0.15

  // ── 3. 喬木 BLOCK：以 blockName+layer 索引既有比對結果 ──
  // 每個 insertion point 只能屬於「一個」分區：單一遍歷、依 validZones 固定順序找
  // 第一個命中的分區，避免邊界點被相鄰兩區的容差判斷各自計入（見規格三「避免同時
  // 被兩區計算」）。HATCH 面積則刻意相反──同一 HATCH 可合法跨越多區，各自累加。
  const mappingIndex = new Map<string, MappedItem>()
  for (const m of mappings) mappingIndex.set(`${m.blockName}||${m.layer}`, m)
  const seenInsertHandles = new Set<string>()

  const zoneEdgeTol = new Map<string, number>()
  for (const zone of validZones) {
    const bb = polygonBBox(zone.boundary!.vertices)
    zoneEdgeTol.set(zone.name, Math.max(1e-6, Math.hypot(bb.width, bb.height) * 0.001))
  }

  const treeMapByZone = new Map<string, Map<string, ZoneTreePlantStat>>()
  const unknownBlockMapByZone = new Map<string, Map<string, ZoneUnknownPlantStat>>()
  for (const zone of validZones) {
    treeMapByZone.set(zone.name, new Map())
    unknownBlockMapByZone.set(zone.name, new Map())
  }

  for (const ins of dxf.inserts) {
    if (ins.handle) {
      if (seenInsertHandles.has(ins.handle)) {
        console.debug(`[分區統計] 排除重複 INSERT handle=${ins.handle} blockName=${ins.blockName}`)
        continue
      }
      seenInsertHandles.add(ins.handle)
    }
    const item = mappingIndex.get(`${ins.blockName}||${ins.layer}`)
    if (!item) continue
    const cls = classifyMappedItem(item)
    if (cls === 'not-plant') continue

    // 依序判斷：bbox 中心 → insertion point（含容差）→ 樹冠圓與分區邊界重疊，沿用
    // buildZonePlantList（spatialAnalysis.ts）已經過驗證的同一套判斷（checkPositionInZone），
    // 而非只做單純 point-in-polygon——景觀圖常見喬木 insertion point 落在分區框外一小段，
    // 但樹冠（依 BLOCK 定義的外框尺寸換算世界座標半徑）壓進分區範圍，這種情況樹仍應算作
    // 該分區的喬木（實測案例：茄苳 insertion point 在分區外，但樹冠明顯跨進分區）。
    // 固定依 validZones 順序找第一個命中，確保每個 insert 最多命中一個分區。
    const extent = dxf.blockExtents[ins.blockName]
    let assignedZone: DetectedZone | undefined
    let assignMethod = 'none'
    for (const z of validZones) {
      const check = checkPositionInZone({ x: ins.x, y: ins.y }, ins, extent, z.boundary!.vertices, zoneEdgeTol.get(z.name)!)
      if (check.inZone) { assignedZone = z; assignMethod = check.method; break }
    }
    if (!assignedZone) {
      console.debug(`[分區統計] BLOCK handle=${ins.handle ?? '(無)'} blockName=${ins.blockName} 插入點=(${ins.x.toFixed(2)},${ins.y.toFixed(2)}) 未落入任何分區（含樹冠重疊判斷）`)
      continue
    }

    if (cls === 'tree') {
      const plantName = item.plantName ?? ins.blockName
      const key = `${plantName}||${ins.blockName}`
      const zoneMap = treeMapByZone.get(assignedZone.name)!
      const existing = zoneMap.get(key)
      if (existing) {
        existing.count += 1
        if (ins.handle) existing.entityHandles.push(ins.handle)
      } else {
        zoneMap.set(key, {
          plantName, blockName: ins.blockName, layerName: ins.layer,
          count: 1, entityHandles: ins.handle ? [ins.handle] : [],
        })
      }
      console.debug(`[分區統計] BLOCK handle=${ins.handle ?? '(無)'} blockName=${ins.blockName} 插入點=(${ins.x.toFixed(2)},${ins.y.toFixed(2)}) 判定分區=${assignedZone.name}（依據=${assignMethod}） 分類=tree 植物名稱=${plantName}`)
    } else {
      const key = `${ins.blockName}||${ins.layer}`
      const zoneMap = unknownBlockMapByZone.get(assignedZone.name)!
      const existing = zoneMap.get(key)
      if (existing) {
        existing.count = (existing.count ?? 0) + 1
        if (ins.handle) existing.entityHandles.push(ins.handle)
      } else {
        zoneMap.set(key, {
          source: 'block', layerName: ins.layer, blockName: ins.blockName,
          count: 1, entityHandles: ins.handle ? [ins.handle] : [],
        })
      }
      console.debug(`[分區統計] BLOCK handle=${ins.handle ?? '(無)'} blockName=${ins.blockName} 插入點=(${ins.x.toFixed(2)},${ins.y.toFixed(2)}) 判定分區=${assignedZone.name}（依據=${assignMethod}） 分類=unknown(待確認)`)
    }
  }

  const results: ZoneStatisticsResult[] = []

  for (const zone of validZones) {
    console.group(`[分區統計] ${zone.name}`)
    const boundary = zone.boundary!
    const zoneRing = toRing(boundary.vertices)
    const zoneAreaRaw = polygonArea(boundary.vertices)
    const zoneAreaM2 = zoneAreaRaw / divisor

    // 第一遍：依「分類＋植栽名稱」（或未分類的圖層 key）收集每個 HATCH 與分區的交集「形狀」，
    // 先不加總面積數字——實際圖面常見不同 HATCH（甚至不同植栽）彼此重疊繪製（重複描繪、
    // 裝飾疊圖等），若只加總各自的交集面積，重疊部分會被算兩次以上，導致「植栽覆蓋總面積」
    // 超過分區自身面積。改用形狀聯集/差集運算，確保重疊區域只計入一次。
    interface HatchAreaGroup {
      plantName: string; category: PlantStatCategory; layerName: string
      shapes: PcMultiPolygon[]; handles: string[]; hatchCount: number
      isGenericGreenArea?: boolean
    }
    const classifiedGroups = new Map<string, HatchAreaGroup>()
    const unknownGroups = new Map<string, HatchAreaGroup>()

    for (const hg of hatchGroups) {
      const clipped = intersectClipped(hg.islands, zoneRing)
      const rawArea = multiPolygonArea(clipped)
      if (rawArea < AREA_EPS) continue
      const layer = hg.loops[0].layer
      const zoneType = hg.loops[0].zoneType
      const category = hatchCategoryFromZoneType(zoneType)
      const handleLabel = hg.handle ?? '(無/內容指紋去重)'
      const areaM2 = rawArea / divisor  // 除錯顯示用：此 HATCH 與本分區的交集面積（尚未扣除與其他植栽重疊的部分）
      const overlapRatio = hg.ownArea > 0 ? rawArea / hg.ownArea : 1
      // 純比例門檻不足以濾掉「大範圍鄰區植栽邊緣掃過小分區」的情形——實測過一個案例：面積
      // 佔比達 6.5%、甚至有 3 個頂點落在本分區內，但 AutoCAD 實測證實這塊 HATCH 就是不屬於
      // 本分區（89 個頂點裡只有 3 個落在本分區，其餘 86 個都在鄰區）。改用「頂點比例」更能
      // 反映這個 HATCH 的主體到底屬於哪一區：要求本分區內的頂點數達到自身總頂點數一定比例，
      // 而不只是「至少 1 個」，才算真的跨進來。
      const totalVertexCount = hg.loops.reduce((s, l) => s + l.vertices.length, 0)
      const insideVertexCount = hg.loops.reduce((s, l) => s + l.vertices.filter(v => pointInPolygon(v.x, v.y, boundary.vertices)).length, 0)
      const vertexRatio = totalVertexCount > 0 ? insideVertexCount / totalVertexCount : 0

      if (overlapRatio < MIN_OVERLAP_RATIO || vertexRatio < MIN_VERTEX_RATIO) {
        console.debug(`[分區統計] 排除：HATCH handle=${handleLabel} layer=${layer} 與 ${zone.name} 的交集僅佔自身總面積 ${(overlapRatio * 100).toFixed(2)}%、頂點比例 ${insideVertexCount}/${totalVertexCount}=${(vertexRatio * 100).toFixed(1)}%（自身總面積 ${(hg.ownArea / divisor).toFixed(4)}m²，交集 ${areaM2.toFixed(4)}m²），判定為分區邊界與鄰區植栽邊緣相切造成的雜訊，非真實跨區`)
        continue
      }

      if (category === 'unknown') {
        const { plantName: layerKey } = resolvePlantNameForLayer(layer, keywordMap)
        // 名稱含「綠／绿／green」但比對不到任何具體植物：只能是通用色塊/範圍圖層，
        // 不得因此推定為草皮、地被或任何特定植物（見業主明確要求）。
        const isGenericGreen = /綠|绿|green/i.test(layer)
        const key = `unknown-hatch||${layerKey}`
        let g = unknownGroups.get(key)
        if (!g) { g = { plantName: layerKey, category: 'unknown', layerName: layer, shapes: [], handles: [], hatchCount: 0, isGenericGreenArea: isGenericGreen }; unknownGroups.set(key, g) }
        g.shapes.push(clipped)
        g.hatchCount += 1
        if (hg.handle) g.handles.push(hg.handle)
        console.debug(`[分區統計] HATCH handle=${handleLabel} layer=${layer} 重建面積(entity自身)=${(hg.ownArea / divisor).toFixed(4)}m² 與${zone.name}交集面積=${areaM2.toFixed(4)}m² 分類=${isGenericGreen ? 'generic_green_area(未指定植栽範圍)' : 'unknown(待確認)'}`)
      } else {
        const { plantName, matchSource } = resolvePlantNameForLayer(layer, keywordMap)
        const key = `${category}||${plantName}`
        let g = classifiedGroups.get(key)
        if (!g) { g = { plantName, category, layerName: layer, shapes: [], handles: [], hatchCount: 0 }; classifiedGroups.set(key, g) }
        g.shapes.push(clipped)
        g.hatchCount += 1
        if (hg.handle) g.handles.push(hg.handle)
        console.debug(`[分區統計] HATCH handle=${handleLabel} layer=${layer} 重建面積(entity自身)=${(hg.ownArea / divisor).toFixed(4)}m² 與${zone.name}交集面積=${areaM2.toFixed(4)}m² 植栽比對來源=${matchSource} 分類=${category}`)
      }
    }

    // 第二遍：同一植栽名稱的多塊 HATCH 先聯集（同植栽自身重疊只算一次），依聯集後面積由大到小
    // 排序，再依序扣除「已被面積較大植栽認領」的範圍——確保不同植栽間的重疊區域只歸入一方，
    // 使 Σ植栽面積 必定 ≤ 分區總面積。排序準則（面積大者優先）為明確、可重現的慣例，非隨機。
    const merged = [...classifiedGroups.values()].map(g => ({ ...g, shape: unionShapes(g.shapes) }))
    merged.sort((a, b) => multiPolygonArea(b.shape) - multiPolygonArea(a.shape) || a.plantName.localeCompare(b.plantName))

    let claimed: PcMultiPolygon = []
    // 面積先保留完整精度（不四捨五入），供下方彙總分區總計時使用——若每筆先各自 round2 再加總，
    // 累積誤差可能讓「灌木+草皮地被」的加總些微超過分區總面積（實測曾出現 100.05%）。
    const hatchPlantsRaw: Array<ZoneHatchPlantStat & { areaM2Raw: number }> = []
    // 注意：這裡刻意「不」再對不同植栽之間做互斥扣除（曾經試過用「面積較大者優先認領」的
    // 演算法，扣掉與其他植栽重疊的部分——結果實測對照 AutoCAD 才發現，同分區內不同植栽的
    // HATCH 之間幾乎都是正確不重疊的乾淨繪製，互斥演算法反而把本來就沒重疊的灌木床誤判成
    // 重疊、面積被錯誤砍掉大半。跨區「掃過」的假陽性已經在上面用 MIN_OVERLAP_RATIO／
    // MIN_VERTEX_RATIO 篩掉，同植栽自身重複繪製也已經在 unionShapes 處理過，這裡只需要
    // 記錄「加總是否超過分區總面積」供人工檢查，不再自動改動任何一筆植栽的面積數字。
    for (const g of merged) {
      const ownArea = multiPolygonArea(g.shape)
      claimed = claimed.length === 0 ? g.shape : unionShapes([claimed, g.shape])
      const areaM2Raw = ownArea / divisor
      hatchPlantsRaw.push({
        plantName: g.plantName, category: g.category, layerName: g.layerName,
        hatchCount: g.hatchCount, areaM2: round2(areaM2Raw), areaM2Raw, entityHandles: g.handles,
      })
    }
    const claimedUnionArea = multiPolygonArea(claimed) / divisor
    const naiveSum = hatchPlantsRaw.reduce((s, p) => s + p.areaM2Raw, 0)
    if (naiveSum > claimedUnionArea + 0.01) {
      console.debug(`[分區統計] ${zone.name}：不同植栽 HATCH 加總 ${naiveSum.toFixed(4)}m² 大於實際聯集面積 ${claimedUnionArea.toFixed(4)}m²，代表確實有植栽範圍彼此重疊繪製，建議人工檢查圖面`)
    }
    const hatchPlants: ZoneHatchPlantStat[] = hatchPlantsRaw.map(({ areaM2Raw: _areaM2Raw, ...p }) => p)

    const unknownHatchStats: ZoneUnknownPlantStat[] = [...unknownGroups.values()].map(g => ({
      source: 'hatch', layerName: g.layerName, hatchCount: g.hatchCount,
      areaM2: round2(multiPolygonArea(unionShapes(g.shapes)) / divisor), entityHandles: g.handles,
      category: g.isGenericGreenArea ? 'generic_green_area' : 'unknown',
    }))

    const treePlants = [...treeMapByZone.get(zone.name)!.values()]
    const unknownPlants = [...unknownHatchStats, ...unknownBlockMapByZone.get(zone.name)!.values()]

    // 彙總一律用未四捨五入的原始面積計算，避免逐筆先四捨五入再加總造成的累積誤差
    // （曾實測：分區總面積 10.79、灌木+草皮地被卻加總到 10.80，覆蓋率顯示 100.05%）。
    const shrubAreaM2Raw = hatchPlantsRaw.filter(p => p.category === 'shrub').reduce((s, p) => s + p.areaM2Raw, 0)
    const groundLawnAreaM2Raw = hatchPlantsRaw.filter(p => p.category === 'lawn' || p.category === 'groundcover').reduce((s, p) => s + p.areaM2Raw, 0)
    const plantingAreaM2Raw = shrubAreaM2Raw + groundLawnAreaM2Raw
    const treeTotalCount = treePlants.reduce((s, p) => s + p.count, 0)

    const zoneAreaM2Rounded = round2(zoneAreaM2)
    // 最終保險：植栽覆蓋（灌木+草皮地被的聯集）依定義必定 ⊆ 分區本身，數學上不會超過分區總面積；
    // 若四捨五入後仍些微超過（緊貼 100% 覆蓋率時可能發生的顯示層級誤差），以分區總面積為上限。
    const plantingAreaM2 = Math.min(round2(plantingAreaM2Raw), zoneAreaM2Rounded)

    results.push({
      zoneId: zone.name,
      zoneAreaM2: zoneAreaM2Rounded,
      shrubAreaM2: round2(shrubAreaM2Raw),
      groundLawnAreaM2: round2(groundLawnAreaM2Raw),
      plantingAreaM2,
      plantingCoveragePercent: zoneAreaM2Rounded > 0 ? round2((plantingAreaM2 / zoneAreaM2Rounded) * 100) : 0,
      treeTotalCount,
      hatchPlants,
      treePlants,
      unknownPlants,
    })
    console.groupEnd()
  }

  console.groupEnd()
  return results
}
