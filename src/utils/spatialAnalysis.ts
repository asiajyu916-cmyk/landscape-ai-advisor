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
  // 迴圈實作：Math.min(...arr) 的 spread 在數十萬頂點時會拋 RangeError
  let minX = Infinity; let maxX = -Infinity
  let minY = Infinity; let maxY = -Infinity
  for (const v of vertices) {
    if (v.x < minX) minX = v.x
    if (v.x > maxX) maxX = v.x
    if (v.y < minY) minY = v.y
    if (v.y > maxY) maxY = v.y
  }
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY }
}

// ── Polygon area（shoelace 公式，單位與圖面座標一致，圖面為公尺時即 m²）────────
export function polygonArea(vertices: Array<{ x: number; y: number }>): number {
  const n = vertices.length
  if (n < 3) return 0
  let sum = 0
  for (let i = 0, j = n - 1; i < n; j = i++) {
    sum += vertices[j].x * vertices[i].y - vertices[i].x * vertices[j].y
  }
  return Math.abs(sum) / 2
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

// ── 分析範圍（評估範圍 + 索引表排除）─────────────────────────────────────────
// 空間分析固定流程：評估範圍 → 排除索引表區 → 分區 closed polyline → 區內 entity

export interface LegendBox { minX: number; minY: number; maxX: number; maxY: number }

export interface AnalysisScope {
  evalBoundaries: DxfPolygon[] // 評估範圍 polygon（可能每分區各一條；空陣列 = 不過濾）
  legendBoxes: LegendBox[]     // 索引表 bounding box（可能多張表）
}

// 索引表表頭關鍵字（強指標，出現 ≥2 個即視為表格區域）
// 亦供 DxfReviewPage 的「HATCH 附近文字」fallback 排除表頭字樣，避免把
// 「圖例」「備註」等欄位標題誤判成植物名稱（表頭文字必然緊鄰圖例符號）。
export const SCHEDULE_KEYWORD_RE = /^(項次|圖例|植物名稱|植栽名稱|名稱|學名|規格|數量|小計|合計|備註|單位|高度|寬度|面積|株\/㎡)/

// 評估範圍圖層關鍵字
const EVAL_BOUNDARY_LAYER_RE = /評估範圍|評估|範圍|基地|境界|紅線|用地|scope|boundar|site/i

export function pointInLegendBoxes(x: number, y: number, boxes: LegendBox[]): boolean {
  return boxes.some(b => x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY)
}

/** 是否在分析範圍內：落在任一評估範圍內（若有）且不在索引表區 */
export function pointInScope(x: number, y: number, scope: AnalysisScope | undefined): boolean {
  if (!scope) return true
  if (pointInLegendBoxes(x, y, scope.legendBoxes)) return false
  if (scope.evalBoundaries.length > 0 && !scope.evalBoundaries.some(b => pointInPolygon(x, y, b.vertices))) return false
  return true
}

/**
 * 偵測分析範圍：
 * 1. 評估範圍 = 圖層名含關鍵字的封閉 polyline 全部保留（找不到 = 不過濾）。
 *    圖面可能是「整個基地一條」，也可能是「每個分區各自一條」（如
 *    A區評估範圍/B區評估範圍/C區評估範圍）——分析範圍取所有評估範圍的聯集，
 *    不再只挑 bbox 面積最大的一條，避免把其他分區排除在分析範圍外。
 * 2. 索引表 bbox = 「包含 ≥2 個表頭關鍵字文字」的封閉 polyline 之 bbox
 *    防呆：候選框內若含任何分區標籤（A區/B區…）則視為圖框/大框而剔除，
 *    避免把整張圖框誤判成索引表導致全部排除。
 *    Fallback：找不到表格外框時，用表頭關鍵字文字群的 bbox 外擴 5% 圖寬。
 */
export function detectAnalysisScope(texts: DxfText[], polygons: DxfPolygon[]): AnalysisScope {
  const closed = polygons.filter(p => p.closed && p.vertices.length >= 3)

  // ── 1. 評估範圍（可能多條，每分區各一）──
  const evalBoundaries = closed.filter(p => EVAL_BOUNDARY_LAYER_RE.test(p.layer))
  const evalBoundarySet = new Set(evalBoundaries)

  // ── 2. 索引表 bbox ──
  const kwTexts = texts.filter(t => SCHEDULE_KEYWORD_RE.test(t.content.trim()))
  // 分區標籤位置（防呆用：索引表框不可包含分區標籤）
  const zoneLabelPts = texts
    .filter(t => normalizeZoneName(t.content) !== null)
    .map(t => ({ x: t.x, y: t.y }))

  const legendBoxes: LegendBox[] = []
  if (kwTexts.length >= 2) {
    for (const p of closed) {
      if (evalBoundarySet.has(p)) continue
      const kwInside = kwTexts.filter(t => pointInPolygon(t.x, t.y, p.vertices)).length
      if (kwInside < 2) continue
      // 內含分區標籤 → 是圖框/評估範圍等大框，不是索引表
      if (zoneLabelPts.some(z => pointInPolygon(z.x, z.y, p.vertices))) continue
      const bb = polygonBBox(p.vertices)
      legendBoxes.push({ minX: bb.minX, minY: bb.minY, maxX: bb.maxX, maxY: bb.maxY })
    }
    // Fallback：完全找不到表格外框 → 用關鍵字文字群 bbox 外擴
    if (legendBoxes.length === 0) {
      const xs = kwTexts.map(t => t.x); const ys = kwTexts.map(t => t.y)
      const allX = texts.map(t => t.x)
      const pad = (Math.max(...allX) - Math.min(...allX)) * 0.05
      legendBoxes.push({
        minX: Math.min(...xs) - pad, minY: Math.min(...ys) - pad,
        maxX: Math.max(...xs) + pad, maxY: Math.max(...ys) + pad,
      })
    }
  }

  console.group('📐 AnalysisScope（分析範圍）')
  console.debug(evalBoundaries.length > 0
    ? `評估範圍 × ${evalBoundaries.length}: ${evalBoundaries.map(b => `layer="${b.layer}" ${b.source}(${b.vertices.length}頂點)`).join(' | ')}`
    : '評估範圍: 未偵測到（不做範圍過濾）')
  console.debug(`索引表 bbox × ${legendBoxes.length}:`)
  for (const b of legendBoxes) console.debug(`  (${b.minX.toFixed(0)},${b.minY.toFixed(0)})-(${b.maxX.toFixed(0)},${b.maxY.toFixed(0)})`)
  console.groupEnd()

  return { evalBoundaries, legendBoxes }
}

// ── 分區邊界候選過濾 ──────────────────────────────────────────────────────────
// 植栽填充 HATCH 的圖層關鍵字：這類 HATCH 是「種植範圍」，不可當「分區邊界」
const PLANT_FILL_LAYER_RE = /灌木|草皮|草坪|地被|喬木|植栽|shrub|lawn|grass|groundcover|tree|plant/i

// 非分區標籤的文字圖層：指北針 / 圖名 / 圖框上的字母不可觸發 Step 2 建區
const NON_ZONE_TEXT_LAYER_RE = /圖名|指北|北針|圖框|標題|north|compass|title|border/i

function bboxArea(p: DxfPolygon): number {
  const b = polygonBBox(p.vertices)
  return b.width * b.height
}

/**
 * 在包含 (x,y) 的封閉多邊形中挑選最合理的分區邊界：
 *  1. 排除植栽填充 HATCH（種植範圍 ≠ 分區邊界）
 *  2. 排除「圖框級」多邊形（bbox 面積 ≥ 全圖 bbox 面積 50% → 視為圖框/外框）
 *  3. 剩餘候選：LWPOLYLINE / POLYLINE 優先於 HATCH，再取 bbox 面積最小者
 */
function findBestBoundary(
  x: number, y: number,
  closedPolygons: DxfPolygon[],
  drawingBBoxArea: number,
  maxBBoxArea?: number,   // 評估範圍 bbox 面積（分區不得大於評估範圍）
): DxfPolygon | undefined {
  const usable = closedPolygons.filter(p => {
    if (!pointInPolygon(x, y, p.vertices)) return false
    if (p.source === 'HATCH' && PLANT_FILL_LAYER_RE.test(p.layer)) return false
    if (drawingBBoxArea > 0 && bboxArea(p) >= drawingBBoxArea * 0.5) return false
    if (maxBBoxArea !== undefined && bboxArea(p) > maxBBoxArea * 1.05) return false
    return true
  })
  if (usable.length === 0) return undefined
  return usable.sort((a, b) => {
    const ha = a.source === 'HATCH' ? 1 : 0
    const hb = b.source === 'HATCH' ? 1 : 0
    if (ha !== hb) return ha - hb          // 邊界線（LWPOLYLINE/POLYLINE）優先
    return bboxArea(a) - bboxArea(b)       // 面積小者優先（最貼近該區的框）
  })[0]
}

export function detectZonesFromText(
  texts: DxfText[],
  polygons: DxfPolygon[],
  scope?: AnalysisScope,
): DetectedZone[] {
  const zones: DetectedZone[] = []
  const seenNames = new Set<string>()
  // 評估範圍只有「單一整體基地範圍」時才視為非分區框而排除；
  // 若有多條（每分區各自一條，如 A區評估範圍/B區評估範圍…），
  // 這些本身就是分區邊界候選，不能排除。
  const singleWholeSiteEvalBoundary = scope?.evalBoundaries.length === 1 ? scope.evalBoundaries[0] : undefined
  // 邊界候選：封閉多邊形，排除索引表區內者與（單一）評估範圍本身
  const closedPolygons = polygons.filter(p => {
    if (!p.closed || p.vertices.length < 3) return false
    if (singleWholeSiteEvalBoundary && p === singleWholeSiteEvalBoundary) return false
    if (scope) {
      const bb = polygonBBox(p.vertices)
      const cx = (bb.minX + bb.maxX) / 2; const cy = (bb.minY + bb.maxY) / 2
      if (pointInLegendBoxes(cx, cy, scope.legendBoxes)) return false
    }
    return true
  })

  // ── 分區定義圖層模式（最優先）─────────────────────────────────────────────
  // 圖面若有專屬分區圖層（AREA / 區域 / 分區 / ZONE）的封閉 polyline ≥ 2 條，
  // 直接以該層 polyline 作為 zone polygon，不再全圖搜尋猜測。
  // 同理，若各分區各自有獨立的「評估範圍」線（≥2 條），也視為分區邊界候選
  // （本案無獨立 AREA/分區圖層，分區邊界即各自的評估範圍線）。
  // 標籤配對：1) 包含標籤的 polyline  2) 標籤在線外（引線標註）→ 取邊界距離
  // 最近者（上限 = 分區層整體寬度 3%），同一 polyline 不重複配對。
  const ZONE_LAYER_RE = /AREA|區域定義|區域|分區|ZONE/i
  const zoneLayerPolysStrict = closedPolygons.filter(p =>
    p.source !== 'HATCH' && ZONE_LAYER_RE.test(p.layer))
  // 圖層名稱本身要能辨識出具體是哪一區（含字母/數字/中文數字 + 區），才算「per-zone」
  // 候選；沒有分區前綴的通用「評估範圍」（涵蓋全場）不算，只留給 pointInScope 做
  // 整體範圍過濾。否則分區標籤若剛好落在通用大框內（即使也在自己的小框外一點點，
  // 例如標籤位置略偏出自己那條線），會被這個通用大框搶走，導致該區綁錯邊界。
  const ZONE_SPECIFIC_LAYER_RE = /[A-Za-z0-9一二三四五六七八九十]\s*區/
  const perZoneEvalPolys = (scope?.evalBoundaries.length ?? 0) >= 2
    ? closedPolygons.filter(p =>
        p.source !== 'HATCH' && EVAL_BOUNDARY_LAYER_RE.test(p.layer) && ZONE_SPECIFIC_LAYER_RE.test(p.layer))
    : []
  const zoneLayerPolys = zoneLayerPolysStrict.length >= 2 ? zoneLayerPolysStrict : perZoneEvalPolys

  const candidates = buildCandidateTexts(texts)
    .filter(c => pointInScope(c.x, c.y, scope))

  // ── 具名分區圖層（最高優先）──────────────────────────────────────────────
  // 圖層直接以 AREA-A / AREA-B / ZONE-C 等具名尾碼命名時，區名可直接從圖層
  // 名稱推導，不需仰賴文字標籤配對——避免同名圖層文字標籤缺漏、位置錯誤，
  // 或多條同名圖層時只抓到最後一條而誤判成只有一區。
  // 同一圖層若有多條封閉線（L 型分區常見），視為同一分區的邊界候選，
  // 取 bbox 面積最大者為主邊界。
  const NAMED_AREA_LAYER_RE = /^(?:AREA|ZONE)[-_\s]?([A-Za-z0-9一-鿿]+)$/i
  const namedAreaGroups = new Map<string, DxfPolygon[]>()
  for (const p of closedPolygons) {
    if (p.source === 'HATCH') continue
    const m = NAMED_AREA_LAYER_RE.exec(p.layer.trim())
    if (!m) continue
    const suffix = m[1].toUpperCase()
    const zoneName = `${suffix}區`
    const arr = namedAreaGroups.get(zoneName) ?? []
    arr.push(p)
    namedAreaGroups.set(zoneName, arr)
  }
  if (namedAreaGroups.size >= 2) {
    for (const [zoneName, polys] of namedAreaGroups) {
      const primary = polys.reduce((a, b) => bboxArea(a) >= bboxArea(b) ? a : b)
      const label = candidates.find(c => c.name === zoneName)
      const labelPos = label ?? (() => {
        const c = polygonCenter(primary.vertices)
        return { x: c.x, y: c.y }
      })()
      zones.push({
        name: zoneName,
        labelPosition: { x: labelPos.x, y: labelPos.y },
        boundary: primary,
        confidence: 'high',
        source: 'text-in-polygon',
      })
      seenNames.add(zoneName)
    }
    const totalPolys = [...namedAreaGroups.values()].reduce((s, a) => s + a.length, 0)
    console.debug(`[Zone] 具名分區圖層模式（AREA-X/ZONE-X）：偵測到 ${namedAreaGroups.size} 區，圖層線×${totalPolys}`)
    zones.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant', { numeric: true }))
    return zones
  }

  if (zoneLayerPolys.length >= 2 && candidates.length > 0) {
    const zlVerts = zoneLayerPolys.flatMap(p => p.vertices)
    const zlBB = polygonBBox(zlVerts)
    const nearLimit = Math.max(100, Math.hypot(zlBB.width, zlBB.height) * 0.03)
    const used = new Set<DxfPolygon>()

    // Pass 1：標籤在 polyline 內
    // 若標籤同時落在多條候選 polyline 內（例如「B區評估範圍」與涵蓋全場的通用
    // 「評估範圍」大框重疊），取 bbox 面積最小者（最貼合該區的框），而非陣列
    // 中第一個命中的——否則标籤會被無關的大框「搶走」，導致該區綁錯邊界。
    const unmatched: typeof candidates = []
    for (const cand of candidates) {
      if (seenNames.has(cand.name)) continue
      const containing = zoneLayerPolys.filter(p => !used.has(p) && pointInPolygon(cand.x, cand.y, p.vertices))
      const hit = containing.length > 0
        ? containing.reduce((a, b) => bboxArea(a) <= bboxArea(b) ? a : b)
        : undefined
      if (hit) {
        used.add(hit); seenNames.add(cand.name)
        zones.push({ name: cand.name, labelPosition: { x: cand.x, y: cand.y }, boundary: hit, confidence: 'high', source: 'text-in-polygon' })
      } else {
        unmatched.push(cand)
      }
    }
    // Pass 2：標籤在線外（引線標註）→ 距離最近的未配對 polyline，依距離貪婪配對
    const pairs = unmatched
      .filter(c => !seenNames.has(c.name))
      .flatMap(c => zoneLayerPolys
        .filter(p => !used.has(p))
        .map(p => ({ c, p, d: distToPolygonEdge(c.x, c.y, p.vertices) })))
      .filter(({ d }) => d <= nearLimit)
      .sort((a, b) => a.d - b.d)
    for (const { c, p, d } of pairs) {
      if (used.has(p) || seenNames.has(c.name)) continue
      used.add(p); seenNames.add(c.name)
      console.debug(`[Zone] "${c.name}" 標籤在分區線外 ${d.toFixed(0)} 單位 → 配對最近的分區層 polyline`)
      zones.push({ name: c.name, labelPosition: { x: c.x, y: c.y }, boundary: p, confidence: 'medium', source: 'text-in-polygon' })
    }
    console.debug(`[Zone] 分區定義圖層模式（${zoneLayerPolysStrict.length >= 2 ? 'AREA/分區圖層' : '各分區獨立評估範圍'}）：polyline×${zoneLayerPolys.length}，標籤×${candidates.length}，配對成功×${zones.length}`)
    if (zones.length > 0) {
      // 依區名排序（A區、B區…），避免線外標籤（第二輪配對）排到最後
      zones.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant', { numeric: true }))
      return zones
    }
    // 全部配對失敗 → fallback 舊邏輯
  }

  // 全圖 bbox 面積（供圖框判斷）
  const allVerts = closedPolygons.flatMap(p => p.vertices)
  const drawingBBoxArea = allVerts.length >= 3
    ? (() => { const b = polygonBBox(allVerts); return b.width * b.height })()
    : 0
  // 評估範圍 bbox 面積：有評估範圍時，分區邊界不得大於「最大的一條」評估範圍（防呆圖框）
  const evalArea = (scope?.evalBoundaries.length ?? 0) > 0
    ? Math.max(...scope!.evalBoundaries.map(bboxArea))
    : undefined

  // ── Step 1: 從文字（包含合併片段）找分區標籤（無分區定義圖層時的 fallback）──
  for (const cand of candidates) {
    if (seenNames.has(cand.name)) continue
    seenNames.add(cand.name)

    const containingPoly = findBestBoundary(cand.x, cand.y, closedPolygons, drawingBBoxArea, evalArea)

    zones.push({
      name: cand.name,
      labelPosition: { x: cand.x, y: cand.y },
      boundary: containingPoly,
      confidence: containingPoly ? 'high' : 'medium',
      source: containingPoly ? 'text-in-polygon' : 'text-only',
    })
  }

  // ── Step 2: 孤立大寫字母落在封閉多邊形內 → 視為 zone 候選 ──────────────────
  // 防呆：指北針的「N」/ 圖名圖層字母不建區；找不到合格邊界（僅圖框包含）不建區
  for (const t of texts) {
    const letter = t.content.trim()
    if (!/^[A-Z]$/.test(letter)) continue
    if (NON_ZONE_TEXT_LAYER_RE.test(t.layer)) continue   // 指北針 / 圖名 / 圖框文字
    if (!pointInScope(t.x, t.y, scope)) continue          // 索引表區 / 評估範圍外
    const zoneName = letter + '區'
    if (seenNames.has(zoneName)) continue

    const containingPoly = findBestBoundary(t.x, t.y, closedPolygons, drawingBBoxArea, evalArea)
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

// 註：面狀歸區已改用「雙向頂點重疊比例」（見 buildZonePlantList），此函式保留供外部使用
export function polygonsOverlap(a: DxfPolygon, b: DxfPolygon): boolean {
  // 任意頂點落入另一多邊形即視為重疊
  return (
    a.vertices.some(v => pointInPolygon(v.x, v.y, b.vertices)) ||
    b.vertices.some(v => pointInPolygon(v.x, v.y, a.vertices))
  )
}

// ── World bbox center 計算（套用 INSERT 的 scale + rotation + translation）────

export function computeWorldCenter(
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

export interface PositionCheckResult {
  inZone: boolean
  method: 'bbox-center' | 'insert-point' | 'canopy-overlap' | 'none'
  bboxCenter?: { x: number; y: number }
}

// 樹冠世界半徑：block local bbox 的長邊一半 × |scale| 最大者
export function canopyWorldRadius(ins: DxfInsert, extent: BlockExtent): number {
  const w = extent.localMaxX - extent.localMinX
  const h = extent.localMaxY - extent.localMinY
  return (Math.max(w, h) / 2) * Math.max(Math.abs(ins.scaleX), Math.abs(ins.scaleY))
}

// 點到多邊形邊界的最短距離（供樹冠重疊 / 最近分區判斷）
export function distToPolygonEdge(
  px: number, py: number,
  polygon: Array<{ x: number; y: number }>,
): number {
  let minSq = Infinity
  const n = polygon.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const d = distSqToSegment(px, py, polygon[j].x, polygon[j].y, polygon[i].x, polygon[i].y)
    if (d < minSq) minSq = d
  }
  return Math.sqrt(minSq)
}

// 分區定義圖層（此層的封閉線是分區邊界，不是植栽面）
const ZONE_DEF_LAYER_RE = /AREA|區域定義|區域|分區|ZONE/i

/**
 * 多邊形內部取樣點（面積估計用）：
 * 在 bbox 上鋪 18×18 網格，保留落在多邊形內的格心。
 * 細長 / 退化形狀網格取不到點時，fallback 用頂點 + 邊中點。
 * 用途：overlapRatio = (樣本落在 zone 內的數量) / (樣本總數)
 *      ≈ 交集面積 / HATCH 自身面積（實際 polygon 取樣，非 bbox 近似）
 */
function samplePolygonPoints(vertices: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  const bb = polygonBBox(vertices)
  const grid = (N: number): Array<{ x: number; y: number }> => {
    const pts: Array<{ x: number; y: number }> = []
    if (bb.width <= 0 || bb.height <= 0) return pts
    const dx = bb.width / N; const dy = bb.height / N
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const px = bb.minX + (i + 0.5) * dx
        const py = bb.minY + (j + 0.5) * dy
        if (pointInPolygon(px, py, vertices)) pts.push({ x: px, y: py })
      }
    }
    return pts
  }
  let pts = grid(18)
  // 細長 / 斜條形（實際面積佔 bbox 比例低）→ 加密重採，確保面積估計可靠
  if (pts.length < 60) pts = grid(48)
  if (pts.length >= 8) return pts
  // 退化形狀 fallback：頂點 + 邊中點
  const fb: Array<{ x: number; y: number }> = []
  const n = vertices.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    fb.push(vertices[i])
    fb.push({ x: (vertices[i].x + vertices[j].x) / 2, y: (vertices[i].y + vertices[j].y) / 2 })
  }
  return fb
}

export function checkPositionInZone(
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
    // 3. 樹冠重疊：樹冠圓（bbox 長邊/2 × scale）觸及分區邊界 → 視為該區
    //    景觀圖常見：喬木種在花台邊、insertion point 在框外但樹冠壓到分區範圍
    const canopyR = canopyWorldRadius(ins, extent)
    if (canopyR > 0 && (
      distToPolygonEdge(center.x, center.y, bv) <= canopyR ||
      distToPolygonEdge(pos.x, pos.y, bv) <= canopyR
    )) {
      return { inZone: true, method: 'canopy-overlap', bboxCenter: center }
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
  scope?: AnalysisScope,
): ZonePlantList[] {
  // 建立 INSERT 快速查詢表：blockName → INSERT 清單（按座標匹配）
  const insertsByBlock = new Map<string, DxfInsert[]>()
  for (const ins of (inserts ?? [])) {
    const arr = insertsByBlock.get(ins.blockName) ?? []
    arr.push(ins)
    insertsByBlock.set(ins.blockName, arr)
  }

  // ── Pass 0：歸屬追蹤 + 每棵樹 debug 資料 + 圖面 extents ──────────────────────
  // 圖面 extents：迴圈計算（block 展開後多邊形可達數萬個、頂點數十萬，
  // spread 版 Math.min(...) 會拋 RangeError 導致整個 zonePlantList 為空）。
  let dwgMinX = Infinity; let dwgMinY = Infinity
  let dwgMaxX = -Infinity; let dwgMaxY = -Infinity
  for (const p of polygons) {
    for (const v of p.vertices) {
      if (v.x < dwgMinX) dwgMinX = v.x
      if (v.y < dwgMinY) dwgMinY = v.y
      if (v.x > dwgMaxX) dwgMaxX = v.x
      if (v.y > dwgMaxY) dwgMaxY = v.y
    }
  }
  for (const ins of (inserts ?? [])) {
    if (ins.x < dwgMinX) dwgMinX = ins.x
    if (ins.y < dwgMinY) dwgMinY = ins.y
    if (ins.x > dwgMaxX) dwgMaxX = ins.x
    if (ins.y > dwgMaxY) dwgMaxY = ins.y
  }
  if (!isFinite(dwgMinX)) { dwgMinX = 0; dwgMinY = 0; dwgMaxX = 0; dwgMaxY = 0 }
  const dwgWidth = dwgMaxX - dwgMinX
  void dwgMaxY  // extents 完整保留供未來使用
  // 最近分區距離上限：圖面寬度 5%（樹冠邊緣到分區邊界的最大允許間距）
  const NEAREST_ZONE_MAX_GAP = dwgWidth * 0.05

  const posKey = (blockName: string, pos: { x: number; y: number }) =>
    `${blockName}|${pos.x.toFixed(3)}|${pos.y.toFixed(3)}`
  const assignedPosKeys = new Set<string>()

  interface TreeDebugRow {
    blockName: string; plantName?: string
    rawX: number; rawY: number          // INSERT 世界座標（OCS 鏡射已在 parser 正規化）
    normX: number; normY: number        // normalized（扣 drawing extents min）
    bboxCX?: number; bboxCY?: number    // 樹冠 bbox 中心（世界座標）
    canopyR?: number                    // 樹冠世界半徑
    zoneName: string; method: string; gapDist: number
  }
  const debugRows: TreeDebugRow[] = []
  const makeDebugRow = (
    m: MappedItem, pos: { x: number; y: number },
    ins: DxfInsert | undefined, extent: BlockExtent | undefined,
    zoneName: string, method: string, gapDist: number,
  ): TreeDebugRow => {
    const center = (ins && extent)
      ? computeWorldCenter(ins.x, ins.y, ins.scaleX, ins.scaleY, ins.rotation, extent)
      : undefined
    return {
      blockName: m.blockName, plantName: m.plantName,
      rawX: pos.x, rawY: pos.y,
      normX: pos.x - dwgMinX, normY: pos.y - dwgMinY,
      bboxCX: center?.x, bboxCY: center?.y,
      canopyR: (ins && extent) ? canopyWorldRadius(ins, extent) : undefined,
      zoneName, method, gapDist,
    }
  }

  // ── 面狀植栽歸區 Pre-pass（全分區共用）──────────────────────────────────────
  // 雙指標：
  //   hatchRatio   = 交集面積 / HATCH 自身面積 → 決定唯一「主要歸屬區」
  //                  ≥0.6 正式歸入；0.2~0.6 歸入但標⚠跨區；<0.2 無主要歸屬
  //   zoneCoverage = 交集面積 / 分區面積 → 大面積 HATCH（如跨全場草皮）雖無主要
  //                  歸屬，但覆蓋某分區 ≥20% 時，該分區列⚠跨區（需人工確認），
  //                  避免「E 區草坪沒讀到」。次要列出一律標 crossZone。
  // 碎片過濾：主要歸屬決定後，HATCH bbox < 該分區 bbox 0.2% → 視為樹冠碎線排除
  //           （改為相對分區比較；舊的全圖比例門檻會誤殺小分區的正常 HATCH）
  const zoneBoundarySet = new Set<DxfPolygon>()
  for (const z of zones) if (z.boundary) zoneBoundarySet.add(z.boundary)
  const zoneBVs = zones.map(z => z.boundary?.vertices ?? [])
  const zoneBBs = zoneBVs.map(bv => bv.length >= 3 ? polygonBBox(bv) : null)
  const zoneSamples = zoneBVs.map(bv => bv.length >= 3 ? samplePolygonPoints(bv) : [])

  interface AreaAssign { zoneIdx: number; ratio: number; cross: boolean }
  const areaAssign = new Map<DxfPolygon, AreaAssign[]>()
  const areaDebug: Array<{
    id: number; source: string; layer: string; pattern: string
    hatchSamples: number; bestZone: string; bestRatio: number
    status: string; reason: string
  }> = []

  // 植栽圖層 HATCH 分組（同 layer+pattern = 同一種植栽的多個 loop）：
  // 供「分組聯合覆蓋率」使用 — 分區被同種植栽的多個小 loop 拼滿時，
  // 單一 loop 覆蓋率 <20% 但合計顯著（實測 J 區草皮即此情況）。
  const plantGroups = new Map<string, Array<{ poly: DxfPolygon; ratios: Map<number, number> }>>()

  let polyId = 0
  for (const poly of polygons) {
    polyId++
    if (!poly.closed || poly.vertices.length < 3) continue
    if (zoneBoundarySet.has(poly)) continue                       // 各區邊界線本身
    if (scope?.evalBoundaries.includes(poly)) continue             // 評估範圍線本身
    if (ZONE_DEF_LAYER_RE.test(poly.layer)) continue              // 分區定義層的其他線
    const pbb = polygonBBox(poly.vertices)
    const pbbArea = pbb.width * pbb.height
    if (pbbArea <= 0) continue
    const n0 = poly.vertices.length
    const pcx = poly.vertices.reduce((s, v) => s + v.x, 0) / n0
    const pcy = poly.vertices.reduce((s, v) => s + v.y, 0) / n0
    // 範圍檢查：質心在分析範圍內；或質心在外但 loop 有頂點在任一評估範圍內
    // （跨界幾何：如延伸出基地的路側草皮，質心在外、實體有一段在基地內）
    if (!pointInScope(pcx, pcy, scope)) {
      const partialInEval = (scope?.evalBoundaries.length ?? 0) > 0
        && !pointInLegendBoxes(pcx, pcy, scope!.legendBoxes)
        && poly.vertices.some(v => scope!.evalBoundaries.some(b => pointInPolygon(v.x, v.y, b.vertices)))
      if (!partialInEval) continue
    }

    // 相交分區預篩（bbox 僅省算力，不做判斷依據）
    const cands: number[] = []
    for (let zi = 0; zi < zones.length; zi++) {
      const zbb = zoneBBs[zi]
      if (!zbb) continue
      if (pbb.minX > zbb.maxX || pbb.maxX < zbb.minX ||
          pbb.minY > zbb.maxY || pbb.maxY < zbb.minY) continue
      cands.push(zi)
    }
    if (cands.length === 0) continue

    // ── 指標 1：hatchRatio（交集 / HATCH 自身面積，實際 polygon 取樣）──
    const samples = samplePolygonPoints(poly.vertices)
    let bestIdx = -1; let bestRatio = 0
    const ratios = new Map<number, number>()
    for (const zi of cands) {
      let hits = 0
      for (const sp of samples) if (pointInPolygon(sp.x, sp.y, zoneBVs[zi])) hits++
      const r = samples.length > 0 ? hits / samples.length : 0
      ratios.set(zi, r)
      if (r > bestRatio) { bestRatio = r; bestIdx = zi }
    }

    // 碎片過濾（相對最佳分區）
    if (bestIdx >= 0 && bestRatio >= 0.2) {
      const zbb = zoneBBs[bestIdx]!
      if (pbbArea < zbb.width * zbb.height * 0.002) continue
    }

    // 植栽圖層 HATCH → 記入分組（供聯合覆蓋率）
    if (poly.source === 'HATCH' && PLANT_FILL_LAYER_RE.test(poly.layer)) {
      const gk = poly.layer.trim() + '|' + (poly.hatchPattern ?? '')
      const arr = plantGroups.get(gk) ?? []
      arr.push({ poly, ratios })
      plantGroups.set(gk, arr)
    }

    if (bestIdx >= 0 && bestRatio >= 0.6) {
      areaAssign.set(poly, [{ zoneIdx: bestIdx, ratio: bestRatio, cross: false }])
      areaDebug.push({ id: polyId, source: poly.source, layer: poly.layer, pattern: poly.hatchPattern ?? '(無)', hatchSamples: samples.length, bestZone: zones[bestIdx].name, bestRatio, status: `歸入 ${zones[bestIdx].name}`, reason: `hatchRatio ${(bestRatio * 100).toFixed(0)}% ≥ 60%` })
    } else if (bestIdx >= 0 && bestRatio >= 0.2) {
      areaAssign.set(poly, [{ zoneIdx: bestIdx, ratio: bestRatio, cross: true }])
      areaDebug.push({ id: polyId, source: poly.source, layer: poly.layer, pattern: poly.hatchPattern ?? '(無)', hatchSamples: samples.length, bestZone: zones[bestIdx].name, bestRatio, status: `跨區→${zones[bestIdx].name}⚠`, reason: `hatchRatio ${(bestRatio * 100).toFixed(0)}% 在 20~60%` })
    } else if (poly.source === 'HATCH' && bestRatio > 0.05) {
      areaDebug.push({ id: polyId, source: poly.source, layer: poly.layer, pattern: poly.hatchPattern ?? '(無)', hatchSamples: samples.length, bestZone: bestIdx >= 0 ? zones[bestIdx].name : '—', bestRatio, status: '無主要歸屬', reason: `最高 hatchRatio ${(bestRatio * 100).toFixed(0)}% < 20%` })
    }
  }

  // ── 指標 2：分組聯合覆蓋率（交集 / 分區面積；同 layer+pattern 的 loop 合併計）──
  // 該組覆蓋某分區 ≥20%，且該組沒有成員以該區為主要歸屬 → 選組內對該區
  // ratio 最高的 loop 列入該區並標⚠跨區（需人工確認）。撈回 J 區草皮這類
  // 「被同種植栽多個小 loop 拼滿」與「大草皮橫跨多區」的情況。
  for (const [gk, members] of plantGroups) {
    for (let zi = 0; zi < zones.length; zi++) {
      const zbb = zoneBBs[zi]
      if (!zbb || zoneSamples[zi].length === 0) continue
      // 該組已有成員主要歸屬此區 → 不需覆蓋列出
      const hasPrimary = members.some(m => areaAssign.get(m.poly)?.some(a => a.zoneIdx === zi))
      if (hasPrimary) continue
      // 與此區 bbox 相交的組內 loop
      const near = members.filter(m => {
        const pb = polygonBBox(m.poly.vertices)
        return !(pb.minX > zbb.maxX || pb.maxX < zbb.minX || pb.minY > zbb.maxY || pb.maxY < zbb.minY)
      })
      if (near.length === 0) continue
      // 聯合覆蓋率：分區樣本落在組內任一 loop 的比例
      let hits = 0
      for (const sp of zoneSamples[zi]) {
        if (near.some(m => pointInPolygon(sp.x, sp.y, m.poly.vertices))) hits++
      }
      const cov = hits / zoneSamples[zi].length
      if (cov < 0.2) continue
      // 選組內對此區 ratio 最高的 loop 作為代表
      const rep = near.reduce((a, b) => (b.ratios.get(zi) ?? 0) > (a.ratios.get(zi) ?? 0) ? b : a)
      const repRatioHere = rep.ratios.get(zi) ?? 0
      // 防呆：若代表 loop 對「其他分區」的個別 ratio 更高且已達 20%（已有跨區
      // 意義），代表這個 loop 主要屬於那一區——不該因為同組聯合覆蓋率又把它
      // 拉進這一區重複列出。典型情境：一大片種植帶主要落在 A 區（個別 ratio
      // 38%），邊緣沾到旁邊一個很小的分區 B，B 區樣本剛好大半落在這片種植帶的
      // 範圍內（聯合覆蓋率高），但這片種植帶其實不屬於 B，不該被列入。
      const strongerElsewhere = [...rep.ratios.entries()]
        .some(([zi2, r2]) => zi2 !== zi && r2 > repRatioHere && r2 >= 0.2)
      if (strongerElsewhere) continue
      const asns = areaAssign.get(rep.poly) ?? []
      if (!asns.some(a => a.zoneIdx === zi)) {
        asns.push({ zoneIdx: zi, ratio: rep.ratios.get(zi) ?? 0, cross: true })
        areaAssign.set(rep.poly, asns)
        areaDebug.push({ id: -1, source: 'HATCH', layer: gk.split('|')[0], pattern: gk.split('|')[1] || '(無)', hatchSamples: near.length, bestZone: zones[zi].name, bestRatio: rep.ratios.get(zi) ?? 0, status: `覆蓋列出→${zones[zi].name}⚠`, reason: `分組聯合覆蓋 ${(cov * 100).toFixed(0)}% ≥ 20%（${near.length} 個 loop 合計）` })
      }
    }
  }

  // ── 同分區同特徵去重：多 loop HATCH（如鋪面格 321 loop）在同區只留代表一筆 ──
  // key = zone|layer|pattern|scale|angle|color；保留 ratio 最高者
  {
    const repMap = new Map<string, { poly: DxfPolygon; asn: AreaAssign }>()
    for (const [poly, asns] of areaAssign) {
      for (const asn of asns) {
        const key = [asn.zoneIdx, poly.layer.trim(), poly.hatchPattern ?? '', poly.hatchScale?.toFixed(2) ?? '', poly.hatchAngle?.toFixed(1) ?? '', poly.hatchColor ?? ''].join('|')
        const prev = repMap.get(key)
        if (!prev || asn.ratio > prev.asn.ratio) repMap.set(key, { poly, asn })
      }
    }
    areaAssign.clear()
    for (const { poly, asn } of repMap.values()) {
      const arr = areaAssign.get(poly) ?? []
      arr.push(asn)
      areaAssign.set(poly, arr)
    }
  }

  const results = zones.map((zone, zi) => {
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
          // 索引表區內的圖例符號 / 評估範圍外 → 不得算入任何分區
          if (!pointInScope(pos.x, pos.y, scope)) {
            const k = posKey(m.blockName, pos)
            if (!assignedPosKeys.has(k)) {
              assignedPosKeys.add(k)   // 標記已處理，pass 2 不再撿回
              debugRows.push(makeDebugRow(m, pos, undefined, extent,
                pointInLegendBoxes(pos.x, pos.y, scope?.legendBoxes ?? []) ? '索引表區(排除)' : '評估範圍外(排除)',
                'scope-excluded', -1))
            }
            continue
          }
          // 找對應的 INSERT（座標精確匹配，容差 0.001）
          const matchedIns = insList.find(ins =>
            Math.abs(ins.x - pos.x) < 0.001 && Math.abs(ins.y - pos.y) < 0.001
          )
          const result = checkPositionInZone(pos, matchedIns, extent, bv, tol)
          if (result.inZone) {
            inZoneCount++
            assignedPosKeys.add(posKey(m.blockName, pos))
            debugRows.push(makeDebugRow(m, pos, matchedIns, extent, zone.name, result.method, 0))
          }
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
      for (const [poly, asns] of areaAssign) {
        const asn = asns.find(a => a.zoneIdx === zi)
        if (!asn) continue   // 此區非主要歸屬亦無覆蓋列出
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
          hatchPattern: poly.hatchPattern,
          hatchScale: poly.hatchScale,
          hatchAngle: poly.hatchAngle,
          hatchColor: poly.hatchColor,
          vertices: poly.vertices,
          overlapRatio: asn.ratio,
          crossZone: asn.cross,
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

  // ── Pass 2：最近分區歸屬（第四層）──────────────────────────────────────────
  // 三層（bbox-center / insert-point+tol / canopy-overlap）都沒進任何區的樹：
  // 找最近的分區邊界，若「樹冠邊緣到邊界的間距」≤ 圖面寬度 5% → 歸入該區。
  // 景觀圖常見：喬木種在花台框外的鄰接綠帶，視覺上屬於該分區。
  const zonesWithBoundary = results.filter(r => (r.zone.boundary?.vertices.length ?? 0) >= 3)
  if (zonesWithBoundary.length > 0) {
    for (const m of mappings) {
      const extent  = blockExtents?.[m.blockName]
      const insList = insertsByBlock.get(m.blockName) ?? []
      for (const pos of m.positions) {
        if (assignedPosKeys.has(posKey(m.blockName, pos))) continue
        if (!pointInScope(pos.x, pos.y, scope)) continue   // 索引表區 / 範圍外不做最近分區
        const matchedIns = insList.find(ins =>
          Math.abs(ins.x - pos.x) < 0.001 && Math.abs(ins.y - pos.y) < 0.001
        )
        const canopyR = (matchedIns && extent) ? canopyWorldRadius(matchedIns, extent) : 0

        let bestZpl: ZonePlantList | null = null
        let bestGap = Infinity
        for (const r of zonesWithBoundary) {
          const bv = r.zone.boundary!.vertices
          const gap = distToPolygonEdge(pos.x, pos.y, bv) - canopyR
          if (gap < bestGap) { bestGap = gap; bestZpl = r }
        }
        if (bestZpl && bestGap <= Math.max(NEAREST_ZONE_MAX_GAP, canopyR * 3)) {
          assignedPosKeys.add(posKey(m.blockName, pos))
          debugRows.push(makeDebugRow(m, pos, matchedIns, extent, bestZpl.zone.name, 'nearest-zone', bestGap))
          const existing = bestZpl.treeBlocks.find(tb => tb.blockName === m.blockName)
          if (existing) {
            existing.positionsInZone++
          } else {
            bestZpl.treeBlocks.push({
              blockName: m.blockName,
              layer: m.layer,
              plantName: m.plantName,
              detectedType: m.detectedType,
              positionsInZone: 1,
              totalCount: m.count,
            })
          }
        } else {
          debugRows.push(makeDebugRow(m, pos, matchedIns, extent, '未歸區', 'none',
            isFinite(bestGap) ? bestGap : -1))
        }
      }
    }
  }

  // ── 每棵樹歸區 debug（drawing extents / 世界座標 / normalized / 樹冠 / 歸屬）──
  console.group(`🌳 樹木歸區 Debug — drawing extents: min=(${dwgMinX.toFixed(0)},${dwgMinY.toFixed(0)}) width=${dwgWidth.toFixed(0)} nearestZoneMaxGap=${NEAREST_ZONE_MAX_GAP.toFixed(0)}`)
  console.table(debugRows.map(r => ({
    block: r.blockName, plant: r.plantName ?? '(未對應)',
    world: `(${r.rawX.toFixed(0)},${r.rawY.toFixed(0)})`,
    normalized: `(${r.normX.toFixed(0)},${r.normY.toFixed(0)})`,
    bboxCenter: r.bboxCX !== undefined ? `(${r.bboxCX.toFixed(0)},${r.bboxCY!.toFixed(0)})` : '—',
    canopyR: r.canopyR?.toFixed(0) ?? '—',
    assignedZone: r.zoneName, method: r.method,
    gap: r.gapDist > 0 ? r.gapDist.toFixed(0) : (r.method === 'nearest-zone' ? '0(重疊)' : '—'),
  })))
  for (const r of results) {
    const bb = r.zone.boundary ? polygonBBox(r.zone.boundary.vertices) : null
    console.debug(`  ${r.zone.name}: boundary=${r.zone.boundary ? `${r.zone.boundary.source}(${r.zone.boundary.vertices.length}頂點) bbox=(${bb!.minX.toFixed(0)},${bb!.minY.toFixed(0)})-(${bb!.maxX.toFixed(0)},${bb!.maxY.toFixed(0)})` : '無'} treeBlocks=${r.treeBlocks.length}`)
  }
  console.groupEnd()

  // ── 每個 HATCH 面狀的歸區 debug（pattern / scale / angle / color / layer / 重疊比例）──
  console.group(`🟦 面狀歸屬總表（全分區共用；每 HATCH 單一主要歸屬；候選 ${areaDebug.length} 筆）`)
  console.table(areaDebug.map(r => ({
    id: r.id === -1 ? '(分組)' : r.id, source: r.source, pattern: r.pattern, layer: r.layer,
    '樣本/loop數': r.hatchSamples,
    hatchRatio: (r.bestRatio * 100).toFixed(0) + '%',
    '歸屬區': r.bestZone,
    '結果': r.status,
    '依據': r.reason,
  })))
  console.groupEnd()

  console.group('🟩 HATCH 面狀歸區 Debug（各區最終清單；跨區項標示需人工確認）')
  for (const r of results) {
    const all = [...r.shrubAreas, ...r.lawnAreas, ...r.groundcoverAreas, ...r.unknownAreas]
    if (all.length === 0) { console.debug(`${r.zone.name}: (無面狀)`); continue }
    console.debug(`${r.zone.name}:`)
    console.table(all.map(a => ({
      source: a.source,
      pattern: a.hatchPattern ?? '(無)',
      scale: a.hatchScale?.toFixed(2) ?? '—',
      angle: a.hatchAngle?.toFixed(1) ?? '—',
      color: a.hatchColor ?? '—',
      layer: a.layer,
      center: `(${a.centerX.toFixed(0)},${a.centerY.toFixed(0)})`,
      vertices: a.vertexCount,
      overlapRatio: a.overlapRatio !== undefined ? (a.overlapRatio * 100).toFixed(0) + '%' : '—',
    })))
  }
  console.groupEnd()

  return results
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
  method: 'bbox-center' | 'insert-point' | 'canopy-overlap' | 'none'
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
