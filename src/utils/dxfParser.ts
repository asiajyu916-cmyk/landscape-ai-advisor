// ── DXF 解析器（純文字解析，無外部依賴）────────────────────────────────────

import type { DxfInsert, DxfText, BlockGroup, DxfPolygon, DxfParseResult, ZoneType, PlantSchedule, PlantScheduleEntry } from '@/types/dxf'

// ── 植栽索引表偵測 ────────────────────────────────────────────────────────────

// 欄位角色
type ColRole = 'code' | 'plantName' | 'scientificName' | 'spec' | 'quantity' | 'unit' | 'note' | 'plantType' | 'unknown'

const COL_ROLE_PATTERNS: Array<{ kws: string[]; role: ColRole }> = [
  { kws: ['項次', '編號', '代號', '圖例', '符號', '號碼', 'NO', 'No.', '序號'], role: 'code' },
  { kws: ['植物名稱', '植名', '中文名稱', '名稱', '植栽名稱', '植物', '中名'], role: 'plantName' },
  { kws: ['學名', '拉丁名', 'Latin', '學名與規格'], role: 'scientificName' },
  { kws: ['規格', '尺寸', '大小', 'SIZE', '胸徑', '樹高', '冠幅'], role: 'spec' },
  { kws: ['小計', '數量', '株數', '面積', '合計', '總計', 'QTY', '棵數', '數目'], role: 'quantity' },
  { kws: ['單位', 'UNIT', 'unit'], role: 'unit' },
  { kws: ['備註', '說明', '注意', 'REMARK', 'Remark', '備注'], role: 'note' },
  { kws: ['類型', '型態', '喬木類', '灌木類'], role: 'plantType' },
]

// 「圖塊名稱／圖層名稱」這類表頭雖然含通用字「名稱」，但指的是 DXF BLOCK/LAYER
// 代號，不是植物名稱——常見於製圖者自己核對用的「圖塊→數量」對照表，若被誤判成
// plantName 欄，會被 detectPlantSchedule 的多表格切分機制當成第二張獨立植栽表，
// 產生跟正式植栽表重複、但植物名稱其實是原始圖層字串的假資料列。
const BLOCK_OR_LAYER_HEADER_RE = /圖塊名稱|圖層名稱|BLOCK\s*NAME|LAYER\s*NAME/i

function headerCellRole(content: string): ColRole {
  const t = content.trim()
  if (BLOCK_OR_LAYER_HEADER_RE.test(t)) return 'unknown'
  for (const { kws, role } of COL_ROLE_PATTERNS) {
    if (kws.some(kw => t.includes(kw))) return role
  }
  return 'unknown'
}

// 解析「13株」「120m2」「13」→ { qty, unit }
function parseQtyUnit(raw: string): { qty?: number; unit?: string } {
  const t = raw.trim()
  const m = t.match(/^(\d+(?:\.\d+)?)\s*(株|棵|本|叢|桿|盆|m²|㎡|m2|M2|平方公尺|公頃|ha|才)?$/)
  if (!m) return {}
  const qty = parseFloat(m[1])
  let unit = m[2]
  if (unit === 'm2' || unit === 'M2' || unit === '平方公尺') unit = '㎡'
  return { qty, unit }
}

// 依植物名稱 / 規格推測預設單位
function inferUnit(plantName: string, spec?: string): { unit: string; note?: string } {
  const text = plantName + ' ' + (spec ?? '')
  if (/喬木|行道樹|樹木|喬木類/.test(text)) return { unit: '株' }
  if (/草皮|草坪|草地|lawn|turf/.test(text))  return { unit: '㎡' }
  if (/地被|groundcover|草花/.test(text))       return { unit: '㎡' }
  if (/灌木|灌叢|綠籬|hedge|shrub/.test(text))  return { unit: '㎡', note: '單位需確認（㎡ 或 株）' }
  return { unit: '株', note: '單位待確認' }
}

// 非植物名稱過濾（圖名/表頭/花色/樹型描述等常混入索引表區域的文字）
const NON_PLANT_NAME_RE =
  /(配置圖|平面圖|剖面圖|立面圖|示意圖|大樣圖|詳圖|索引圖|植栽表|圖例|項次|備註|規格|名稱|數量|單位|小計|合計|月份|樹型|密植|株距|比例|圖號|圖名|日期|編號)|[色型]$|^(伸展|整形|飄型|圓形|橢圓形|自然形|傘形|無花|密植)$/

export function detectPlantSchedule(texts: DxfText[]): PlantSchedule {
  if (texts.length === 0) return { entries: [], detected: false, textCount: 0 }

  const ys = texts.map(t => t.y).sort((a, b) => a - b)
  const yRange = ys[ys.length - 1] - ys[0]
  const tolerance = Math.max(2, Math.min(50, yRange * 0.015 || 5))

  // ── 0. 多表格切分：以「植物名稱」類表頭 cell 為錨點，將圖面切成獨立表格區域 ──
  // 解決：多張植栽表（喬木表/灌木表/地被表）並排或堆疊時，Y 分列把不同表的列混在一起
  const anchorCands = texts
    .filter(t => headerCellRole(t.content) === 'plantName' && t.content.trim().length <= 6)
    .sort((a, b) => b.y - a.y)
  const anchors: DxfText[] = []
  for (const a of anchorCands) {
    // 多行表頭（「植物」/「名稱」上下兩列）合併為同一錨點
    if (!anchors.some(m => Math.abs(m.x - a.x) < tolerance * 4 && Math.abs(m.y - a.y) <= tolerance * 5)) {
      anchors.push(a)
    }
  }

  if (anchors.length > 0) {
    // 表頭帶：錨點上下 2 倍容差（涵蓋兩行式表頭，但不吞資料列）
    const bandOf = (t: DxfText, a: DxfText) => Math.abs(t.y - a.y) <= tolerance * 2
    // 表頭 cell → 依「y 在錨點帶內 + x 最近」指派給錨點
    const nearestAnchor = (t: DxfText): DxfText | null => {
      const inBand = anchors.filter(a => bandOf(t, a))
      if (inBand.length === 0) return null
      return inBand.reduce((best, a) => Math.abs(a.x - t.x) < Math.abs(best.x - t.x) ? a : best)
    }

    const allEntries: PlantScheduleEntry[] = []
    let headerRowOut: string[] | undefined

    for (const a of anchors) {
      // 此表格的表頭 cells（含未知角色欄，供資料 cell 吸收非目標內容）
      const roleCells = texts.filter(t => bandOf(t, a) && nearestAnchor(t) === a && headerCellRole(t.content) !== 'unknown')
      if (roleCells.length < 2) continue
      const xs = roleCells.map(c => c.x)
      const pad = (Math.max(...xs) - Math.min(...xs)) * 0.1 + tolerance
      const xMin = Math.min(...xs) - pad
      const xMax = Math.max(...xs) + pad
      const headerCells = texts.filter(t => bandOf(t, a) && t.x >= xMin && t.x <= xMax)
      const colSchema = headerCells.map(t => ({ x: t.x, role: headerCellRole(t.content) }))

      // 資料區：表頭最低 cell 以下，至下一個（同 x 範圍重疊的）錨點表頭帶為止
      const yStart = Math.min(...headerCells.map(c => c.y)) - tolerance
      const lowerAnchors = anchors.filter(b => b !== a && b.y < a.y && b.x >= xMin && b.x <= xMax)
      const yEnd = lowerAnchors.length > 0 ? Math.max(...lowerAnchors.map(b => b.y)) + tolerance * 5 : -Infinity
      const regionTexts = texts.filter(t => t.x >= xMin && t.x <= xMax && t.y < yStart && t.y > yEnd)

      const entries = parseTableRegion(regionTexts, tolerance, colSchema)
      allEntries.push(...entries)
      if (!headerRowOut && headerCells.length > 0) {
        headerRowOut = [...headerCells].sort((p, q) => p.x - q.x).map(t => t.content)
      }
    }

    if (allEntries.length > 0) {
      // 跨表去重（同名保留資訊較完整者）
      const seen = new Map<string, PlantScheduleEntry>()
      for (const e of allEntries) {
        const prev = seen.get(e.plantName)
        if (!prev || (e.quantity !== undefined && prev.quantity === undefined)) seen.set(e.plantName, e)
      }
      return {
        entries: [...seen.values()],
        headerRow: headerRowOut,
        detected: true,
        textCount: texts.length,
      }
    }
  }

  // ── 無錨點（或錨點解析失敗）→ 舊版單表格全圖解析 ────────────────────────────
  return legacySingleTable(texts, tolerance)
}

/** 單一表格區域解析：Y 分列 → 依 colSchema 欄位角色抽取 */
function parseTableRegion(
  texts: DxfText[],
  tolerance: number,
  presetSchema: Array<{ x: number; role: ColRole }>,
): PlantScheduleEntry[] {
  const rows: DxfText[][] = []
  for (const t of [...texts].sort((a, b) => b.y - a.y)) {
    const row = rows.find(r => Math.abs(r[0].y - t.y) <= tolerance)
    if (row) { row.push(t); row.sort((a, b) => a.x - b.x) }
    else rows.push([t])
  }
  const tableRows = rows.filter(r => r.length >= 2)
  return parseRows(tableRows, -1, presetSchema)
}

function legacySingleTable(texts: DxfText[], tolerance: number): PlantSchedule {
  const rows: DxfText[][] = []
  for (const t of [...texts].sort((a, b) => b.y - a.y)) {
    const row = rows.find(r => Math.abs(r[0].y - t.y) <= tolerance)
    if (row) { row.push(t); row.sort((a, b) => a.x - b.x) }
    else rows.push([t])
  }

  const tableRows = rows.filter(r => r.length >= 2)
  if (tableRows.length < 3) return { entries: [], detected: false, textCount: texts.length }

  // 找表頭列，建立欄位 X 座標→角色的對照
  let headerRowIdx = -1
  let colSchema: Array<{ x: number; role: ColRole }> = []

  for (let ri = 0; ri < tableRows.length; ri++) {
    const row = tableRows[ri]
    const mapped = row.map(t => ({ x: t.x, role: headerCellRole(t.content) }))
    const namedCount = mapped.filter(m => m.role !== 'unknown').length
    if (namedCount >= 2) { headerRowIdx = ri; colSchema = mapped; break }
  }

  const entries = parseRows(tableRows, headerRowIdx, colSchema)
  return {
    entries,
    headerRow: headerRowIdx >= 0 ? tableRows[headerRowIdx].map(t => t.content) : undefined,
    detected: entries.length > 0,
    textCount: texts.length,
  }
}

/** 逐列抽取植物資料（headerRowIdx = -1 表示 schema 由外部提供，全部列皆為資料列）*/
function parseRows(
  tableRows: DxfText[][],
  headerRowIdx: number,
  colSchema: Array<{ x: number; role: ColRole }>,
): PlantScheduleEntry[] {

  // 依最近欄位 X 座標指派角色
  const assignRole = (cell: DxfText): ColRole => {
    if (colSchema.length === 0) return 'unknown'
    let best: ColRole = 'unknown'; let minDist = Infinity
    for (const col of colSchema) {
      const d = Math.abs(cell.x - col.x)
      if (d < minDist) { minDist = d; best = col.role }
    }
    return best
  }

  // ── 3. 解析每一資料列 ─────────────────────────────────────────────────────────
  const entries: PlantScheduleEntry[] = []

  for (let ri = 0; ri < tableRows.length; ri++) {
    if (ri === headerRowIdx) continue
    const row = tableRows[ri]
    const rawRow = row.map(t => t.content)

    let code = ''
    let plantName = ''
    let scientificName: string | undefined
    let plantType: string | undefined
    let spec: string | undefined
    let quantity: number | undefined
    let unit: string | undefined
    let note: string | undefined
    let quantityNote: string | undefined
    let unitNote: string | undefined

    if (colSchema.length > 0) {
      // ── 表頭已知：按欄位角色分派 ──────────────────────────────────────────
      for (const cell of row) {
        const role = assignRole(cell)
        const t = cell.content.trim()
        if (!t) continue
        switch (role) {
          case 'code':     code = t; break
          case 'plantName':
            // 同列多個名稱欄 cell（如「銀紋」「沿階草」拆兩段）→ 取較長且非雜訊者
            if (/[一-鿿]/.test(t) && !NON_PLANT_NAME_RE.test(t) && t.length > plantName.length) plantName = t
            break
          case 'scientificName': scientificName = t; break
          case 'spec':     spec = t; break
          case 'plantType': plantType = t; break
          case 'note':     note = t; break
          case 'unit':     unit = t; break
          case 'quantity': {
            const { qty, unit: u } = parseQtyUnit(t)
            if (qty !== undefined) {
              quantity = qty
              if (u && !unit) unit = u
            } else {
              quantityNote = `數量待確認（原始值：${t}）`
            }
            break
          }
        }
      }

      // ── Fallback：若欄位指派未能解析植物名稱，掃全列找中文 2-8 字 cell ──
      // 解決：灌木 / 地被欄位因 X 座標偏移被指派到錯誤角色導致 plantName 為空
      if (!plantName) {
        const fallbackCell = row.find(c =>
          /^[一-鿿]{2,8}$/.test(c.content.trim()) && !NON_PLANT_NAME_RE.test(c.content.trim()))
        if (fallbackCell) {
          plantName = fallbackCell.content.trim()
          // 若代號也為空，找植物名稱左側最近的純數字
          if (!code) {
            const leftNum = row
              .filter(c => /^\d{2,}$/.test(c.content.trim()) && c.x < fallbackCell.x)
              .pop()
            if (leftNum) code = leftNum.content.trim()
          }
        }
      }

      // ── 數量校正：小計欄常因右對齊落在未知欄位而漏抓 ──
      // 取植物名稱右側「最右邊」可解析為數量的 cell（列已按 x 排序）
      const nameCell = row.find(c => c.content.trim() === plantName)
      if (nameCell) {
        const nums = row.filter(c =>
          c.x > nameCell.x && /^\d+(?:\.\d+)?\s*(株|棵|本|叢|盆|㎡|m2|M2|m²)?$/.test(c.content.trim()))
        if (nums.length > 0) {
          const { qty, unit: u } = parseQtyUnit(nums[nums.length - 1].content.trim())
          if (qty !== undefined) {
            quantity = qty
            if (u) unit = u
            quantityNote = undefined
          }
        }
      }
    } else {
      // ── 無表頭：啟發式推測 ────────────────────────────────────────────────
      // 找中文植物名稱（純中文 2-8 字，或含中文且不像規格描述）
      const plantCell =
        row.find(t => /^[一-鿿]{2,8}$/.test(t.content.trim()) && !NON_PLANT_NAME_RE.test(t.content.trim())) ??
        row.find(t => /^[一-鿿]{2,}/.test(t.content.trim()) && !/\d/.test(t.content) && !NON_PLANT_NAME_RE.test(t.content.trim()))
      if (!plantCell) continue
      plantName = plantCell.content.trim()

      // 植物名稱左側第一個數字 → 代號（項次），不是數量
      const leftNums = row.filter(c => /^\d+$/.test(c.content.trim()) && c.x < plantCell.x)
      if (leftNums.length > 0) code = leftNums[leftNums.length - 1].content.trim()

      // 植物名稱右側最後一個數字（可能含單位）→ 數量
      const rightNums = row.filter(c => /^\d+/.test(c.content.trim()) && c.x > plantCell.x)
      if (rightNums.length > 0) {
        const last = rightNums[rightNums.length - 1]
        const { qty, unit: u } = parseQtyUnit(last.content.trim())
        quantity = qty
        unit = u
      }

      // 規格：含維度資訊的格
      const specCell = row.find(c =>
        /[HWBhwb]\d|\d+[xX×]\d+|cm|CM|公分|公尺/.test(c.content) && c.x > plantCell.x
      )
      spec = specCell?.content.trim()
    }

    // code 欄本身若命中「圖號」等圖框/標題欄字樣，代表這列其實是圖框註記誤入表格
    // 區域範圍，不是真正的植栽資料列（即使 plantName 欄湊巧抓到別的文字也一樣要排除）。
    if (!plantName || NON_PLANT_NAME_RE.test(plantName) || (code && NON_PLANT_NAME_RE.test(code))) continue

    // ── 4. 單位補全推測 ──────────────────────────────────────────────────────
    if (!unit) {
      if (quantity !== undefined) {
        const inf = inferUnit(plantName, spec)
        unit = inf.unit
        unitNote = inf.note
      } else if (!quantityNote) {
        quantityNote = '數量待確認'
      }
    }

    // ── 5. 信心評分 ──────────────────────────────────────────────────────────
    const confidence: PlantScheduleEntry['confidence'] =
      (code && quantity !== undefined) ? 'high'
      : (code || quantity !== undefined) ? 'medium'
      : 'low'

    entries.push({
      rowIndex: ri, code, plantName, scientificName, plantType,
      spec, quantity, unit, note, quantityNote, unitNote,
      rawRow, dbMatched: false, confidence,
    })
  }

  return entries
}

// ── 附近文字搜尋 ──────────────────────────────────────────────────────────────

export function findNearbyTexts(
  pos: { x: number; y: number },
  texts: DxfText[],
  radius: number,
): string[] {
  return texts
    .filter(t => Math.hypot(t.x - pos.x, t.y - pos.y) <= radius)
    .map(t => t.content)
}

interface GroupCode { code: number; value: string }

function parseGroupCodes(text: string): GroupCode[] {
  const lines = text.replace(/\r/g, '').split('\n').map(l => l.trim())
  const groups: GroupCode[] = []
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i], 10)
    if (!isNaN(code)) groups.push({ code, value: lines[i + 1] ?? '' })
  }
  return groups
}

/** CAD 文字 \U+XXXX Unicode 逸出碼 → 中文字（如 \U+77F3\U+83D6\U+84B2 = 石菖蒲）*/
function decodeUnicodeEscapes(raw: string): string {
  return raw.replace(/\\?U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
}

function stripMtextCodes(raw: string): string {
  return decodeUnicodeEscapes(raw)
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/\\P/gi, ' ')
    .replace(/\\~/g, ' ')
    .replace(/\\[a-zA-Z][^;]*;/g, '')
    .replace(/[{}\\]/g, '')
    .trim()
}

// ── Zone keyword classification ───────────────────────────────────────────────

const ZONE_PATTERNS: Array<{ type: Exclude<ZoneType, 'unknown'>; keywords: string[] }> = [
  { type: 'high_irrigation', keywords: ['高澆灌', '喬木澆灌', 'high_irr', 'HIGH_IRR', '高灌'] },
  { type: 'low_irrigation',  keywords: ['低澆灌', '草皮澆灌', 'low_irr', 'LOW_IRR', '低灌'] },
  { type: 'lawn',            keywords: ['草皮', 'lawn', 'LAWN', '草地', 'turf', 'TURF', '草坪'] },
  { type: 'shrub',           keywords: ['灌木', 'shrub', 'SHRUB', '灌叢', '低木'] },
  { type: 'groundcover',     keywords: ['地被', 'groundcover', 'ground_cov', '草花', '覆蓋'] },
  { type: 'tree',            keywords: ['喬木', 'tree', 'TREE', '樹木', '高木'] },
]

export function classifyZone(layerName: string): ZoneType {
  const lower = layerName.toLowerCase()
  for (const { type, keywords } of ZONE_PATTERNS) {
    if (keywords.some(kw => lower.includes(kw.toLowerCase()))) return type
  }
  return 'unknown'
}

// ── HATCH boundary extraction ─────────────────────────────────────────────────
//
// DXF HATCH 結構：
//   91  numBoundaryPaths        ← 此函式從這裡開始（呼叫端已跳過 HATCH header）
//   92  pathType (2=polyline, 1=edge)
//   [boundary vertex data: 10/20 pairs]
//   75  hatchStyle              ← 邊界資料結束標記
//   76  patternType
//   52  patternAngle
//   [fill pattern line 10/20 pairs ← 不要讀這區！]
//   98  seedCount
//   10/20 seed points
//   0   next entity
//
// 關鍵修正：必須在 code 75 前停止，否則 HATCH 填充線的 10/20 座標
// 會被誤判為邊界頂點，污染分區 polygon。

/** 標準 De Boor 演算法：對（有理）B-spline 曲線在參數 t 求值 */
function evalBSplinePoint(
  degree: number,
  knots: number[],
  ctrlPts: Array<{ x: number; y: number; w: number }>,
  t: number,
): { x: number; y: number } {
  const n = ctrlPts.length - 1
  let k = degree
  while (k < n && knots[k + 1] <= t) k++
  const d: Array<{ x: number; y: number; w: number }> = []
  for (let j = 0; j <= degree; j++) {
    const p = ctrlPts[k - degree + j]
    d.push({ x: p.x * p.w, y: p.y * p.w, w: p.w })
  }
  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const idx = k - degree + j
      const denom = knots[idx + degree - r + 1] - knots[idx]
      const alpha = denom !== 0 ? (t - knots[idx]) / denom : 0
      d[j] = {
        x: (1 - alpha) * d[j - 1].x + alpha * d[j].x,
        y: (1 - alpha) * d[j - 1].y + alpha * d[j].y,
        w: (1 - alpha) * d[j - 1].w + alpha * d[j].w,
      }
    }
  }
  const res = d[degree]
  return res.w !== 0 ? { x: res.x / res.w, y: res.y / res.w } : { x: res.x, y: res.y }
}

/**
 * HATCH 邊界的 spline edge（code 72=4）切分成折線點，供面積計算用。
 * 過去完全未處理 spline edge：control point 被直接當成直線頂點連起來，用「控制多邊形」
 * 取代真正的平滑曲線——B-spline 的控制多邊形面積必定 ≥ 曲線本身涵蓋的面積（曲線內縮於
 * 控制多邊形之內），導致孔洞面積被高估、淨面積被低估（實測某筆真實 HATCH：AutoCAD
 * 顯示 7.64 ㎡，控制多邊形近似只算出 4.79 ㎡，短少達 3 成）。
 */
function tessellateBSplineEdge(
  degree: number,
  knots: number[],
  ctrlPts: Array<{ x: number; y: number; w: number }>,
): Array<{ x: number; y: number }> {
  const n = ctrlPts.length - 1
  if (n < 1 || knots.length < degree + n + 2) return ctrlPts.map(p => ({ x: p.x, y: p.y }))
  const tMin = knots[degree]
  const tMax = knots[n + 1]
  if (!(tMax > tMin)) return ctrlPts.map(p => ({ x: p.x, y: p.y }))

  // 固定取樣點數（例如原本的 16 點）對「不同尺寸/不同曲率」的曲線無法一體適用：曲率大或
  // 參數範圍長的曲線會取樣不足、面積系統性低估（實測：三塊灌木床皆用 spline 邊界，
  // 固定 16 點取樣時面積都偏低 1.7~2.4%，且偏低方向一致——典型的弦近似取樣不足徵狀）。
  // 改為遞迴弦偏離量（sagitta）自適應細分：每段中點偏離弦的垂直距離若超過弦長的相對容忍值，
  // 就再切一半，直到夠平滑為止——不論圖面單位（mm/cm/m）或曲線大小，都用同一個相對準則，
  // 確保不同尺寸、不同形狀的 DXF 都能獨立收斂到正確面積，而不是針對特定檔案調整的固定值。
  const pStart = evalBSplinePoint(degree, knots, ctrlPts, tMin)
  const pEnd = evalBSplinePoint(degree, knots, ctrlPts, tMax)
  const pts: Array<{ x: number; y: number }> = [pStart]

  const subdivide = (t0: number, t1: number, p0: { x: number; y: number }, p1: { x: number; y: number }, depth: number): void => {
    if (depth >= 16) { pts.push(p1); return }
    const tm = (t0 + t1) / 2
    const pm = evalBSplinePoint(degree, knots, ctrlPts, tm)
    const dx = p1.x - p0.x; const dy = p1.y - p0.y
    const chordLen = Math.hypot(dx, dy)
    const dev = chordLen > 1e-12
      ? Math.abs((pm.x - p0.x) * dy - (pm.y - p0.y) * dx) / chordLen   // 中點到弦的垂直距離
      : Math.hypot(pm.x - p0.x, pm.y - p0.y)
    const flatEnough = dev <= Math.max(1e-9, chordLen * 0.0005)
    if (flatEnough) { pts.push(p1); return }
    subdivide(t0, tm, p0, pm, depth + 1)
    subdivide(tm, t1, pm, p1, depth + 1)
  }
  subdivide(tMin, tMax, pStart, pEnd, 0)
  return pts
}

// 圓弧切分角度步進：與 spline 自適應細分（tessellateBSplineEdge）採同一套「相對弦弓高
// 容忍值」標準，而非固定 10° 這種與半徑無關、可能不夠精細的經驗值。對圓弧而言
// sagitta = r·(1-cos(θ/2))，若改用「相對於半徑」的容忍值，θ 上限與半徑無關（是常數角度），
// 不必逐段遞迴，直接算出一次性夠用的角度步進即可套用在所有大小的圓弧上。
const ARC_RELATIVE_SAGITTA_TOL = 0.0005
const ARC_STEP_ANGLE = 2 * Math.acos(1 - ARC_RELATIVE_SAGITTA_TOL)

/**
 * Bulge → 弧線中繼點：LWPOLYLINE／HATCH polyline-type 邊界的逐頂點凸度值（code 42）。
 * bulge = tan(θ/4)，θ 為該線段對應弧的圓心角（正值＝從起點到終點逆時針彎曲，負值＝順時針）。
 * 過去完全未讀取 code 42，所有帶弧邊的多邊形（分區邊界、HATCH 外框）都被當成直線頂點連接，
 * 弧線凸出的部分整個漏算（實測某分區邊界因此少算面積）。回傳起訖點之間的中繼弧線點
 * （不含起點/終點本身，由呼叫端負責串接）；bulge=0 時回傳空陣列，代表純直線段。
 */
function tessellateBulge(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  bulge: number,
): Array<{ x: number; y: number }> {
  if (!bulge) return []
  const dx = p2.x - p1.x; const dy = p2.y - p1.y
  const chord = Math.hypot(dx, dy)
  if (chord < 1e-9) return []
  const theta = 4 * Math.atan(bulge)
  const sinHalf = Math.sin(theta / 2)
  if (Math.abs(sinHalf) < 1e-9) return []
  const radius = chord / (2 * Math.abs(sinHalf))
  const dist = chord / 2
  const apothem = Math.sign(bulge) * Math.sqrt(Math.max(0, radius * radius - dist * dist))
  const midX = (p1.x + p2.x) / 2; const midY = (p1.y + p2.y) / 2
  const perpX = -dy / chord; const perpY = dx / chord   // 弦的垂直單位向量（逆時針旋轉 90°）
  const cx = midX + perpX * apothem
  const cy = midY + perpY * apothem
  const a0 = Math.atan2(p1.y - cy, p1.x - cx)
  const a1raw = Math.atan2(p2.y - cy, p2.x - cx)
  let delta = a1raw - a0
  if (bulge > 0) { while (delta < 0) delta += Math.PI * 2 }
  else { while (delta > 0) delta -= Math.PI * 2 }
  const steps = Math.max(1, Math.ceil(Math.abs(delta) / ARC_STEP_ANGLE))
  const pts: Array<{ x: number; y: number }> = []
  for (let s = 1; s < steps; s++) {
    const a = a0 + delta * (s / steps)
    pts.push({ x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) })
  }
  return pts
}

/** 展開一串「頂點 + 逐頂點 outgoing bulge」為完整折線點（含弧線中繼點）；closed=true 時最後一點的 bulge 會補上回到起點的弧 */
function expandPolylineBulges(
  verts: Array<{ x: number; y: number }>,
  bulges: number[],
  closed: boolean,
): Array<{ x: number; y: number }> {
  if (!bulges.some(b => b)) return verts
  const out: Array<{ x: number; y: number }> = []
  const segCount = closed ? verts.length : verts.length - 1
  for (let idx = 0; idx < verts.length; idx++) {
    out.push(verts[idx])
    if (idx >= segCount) continue
    const next = verts[(idx + 1) % verts.length]
    const b = bulges[idx] ?? 0
    if (b) out.push(...tessellateBulge(verts[idx], next, b))
  }
  return out
}

function parseHatchBoundary(groups: GroupCode[], startIdx: number): {
  loops: Array<Array<{ x: number; y: number }>>; end: number
  hatchScale?: number; hatchAngle?: number
} {
  // ── Type-aware boundary 解析 ────────────────────────────────────────────────
  // 1. Multi-path 分離：一個 HATCH 可含多個不相連 boundary path（code 92 起始）。
  //    舊版合併成單一 polygon 導致 point-in-polygon 奇偶錯亂。
  // 2. Edge type 感知：非 polyline path 中 code 72 = edge type。
  //    type 2（圓弧）：10/20 是圓心（不在弧上）、40 半徑、50/51 起終角 → 產出弧起終點
  //    type 3（橢圓弧）：10/20 是中心、11/21 是「相對中心的長軸向量」→ 產出 中心±向量
  //    舊版把 11/21 一律當絕對座標，產生距圖面數十萬單位的假頂點（實測 -349369），
  //    而事後統計淨化會誤砍細長草皮 loop 的真實端點（導致 J 區覆蓋測不到）。
  //    來源正確解析後，不再需要任何統計淨化。
  const loops: Array<Array<{ x: number; y: number }>> = []
  let current: Array<{ x: number; y: number }> = []
  let currentBulges: number[] = []   // 與 current 平行，僅 polyline path 頂點才可能非 0
  const flush = () => {
    if (current.length >= 3) loops.push(expandPolylineBulges(current, currentBulges, true))
    current = []; currentBulges = []
  }
  let i = startIdx

  if (i < groups.length && groups[i].code !== 91) {
    while (i < groups.length && groups[i].code !== 91 && groups[i].code !== 75 && groups[i].code !== 0) i++
  }
  if (i >= groups.length || groups[i].code !== 91) {
    while (i < groups.length && groups[i].code !== 0) i++
    return { loops, end: i }
  }
  i++ // 跳過 code 91

  let isPoly = false      // 此 path 是否為 polyline path（92 flags bit 2）
  let edgeType = 0        // 非 polyline path 的當前 edge type（code 72；4=spline）
  let pendX: number | null = null
  let pendX2: number | null = null
  let arcCx = 0; let arcCy = 0; let arcR = 0; let arcA0 = 0; let arcCcw = true
  let hasArcC = false; let hasArcR = false
  let ellCx = 0; let ellCy = 0; let hasEllC = false
  // spline edge（code 72=4）狀態：degree(94)/rational(73)/numKnots(95)/numCtrlPts(96)/
  // knots(40 重複)/control points(10-20，rational 時每點後接 42=weight)
  let splineDegree = 3; let splineRational = false
  let splineNumCtrl = 0
  let splineKnots: number[] = []
  let splineCtrl: Array<{ x: number; y: number; w: number }> = []

  const resetSplineState = () => {
    splineDegree = 3; splineRational = false; splineNumCtrl = 0
    splineKnots = []; splineCtrl = []
  }

  while (i < groups.length && groups[i].code !== 0 && groups[i].code !== 75) {
    const g = groups[i]
    const val = parseFloat(g.value) || 0
    switch (g.code) {
      case 92:
        flush()
        isPoly = ((parseInt(g.value) || 0) & 2) !== 0
        edgeType = 0; hasArcC = false; hasArcR = false; hasEllC = false; arcCcw = true
        resetSplineState()
        break
      case 72:
        // polyline path 的 72 是 has-bulge flag，不是 edge type
        if (!isPoly) {
          edgeType = parseInt(g.value) || 0
          hasArcC = false; hasArcR = false; hasEllC = false; arcCcw = true
          resetSplineState()
        }
        break
      case 94:
        if (!isPoly && edgeType === 4) splineDegree = parseInt(g.value) || 3
        break
      case 95:
        // spline knot 數量（本身不需要，僅供除錯核對用）
        break
      case 96:
        if (!isPoly && edgeType === 4) splineNumCtrl = parseInt(g.value) || 0
        break
      case 40:
        if (!isPoly && edgeType === 2) { arcR = val; hasArcR = true }
        else if (!isPoly && edgeType === 4) splineKnots.push(val)
        break
      case 42:
        if (isPoly && currentBulges.length > 0) {
          // polyline path 頂點的 outgoing bulge（該頂點到下一頂點的弧線凸度）
          currentBulges[currentBulges.length - 1] = val
        } else if (!isPoly && edgeType === 4 && splineRational && splineCtrl.length > 0) {
          // control point weight（僅 rational spline 才有，緊接在該點的 10/20 之後）
          splineCtrl[splineCtrl.length - 1].w = val
        }
        break
      case 10: pendX = val; break
      case 20:
        if (pendX !== null) {
          if (isPoly) {
            current.push({ x: pendX, y: val })
            currentBulges.push(0)   // 若緊接著出現 code 42，會覆寫成該頂點的 outgoing bulge
          } else if (edgeType === 2) { arcCx = pendX; arcCy = val; hasArcC = true }   // 圓弧圓心（不在弧上）
          else if (edgeType === 3) { ellCx = pendX; ellCy = val; hasEllC = true }   // 橢圓中心
          else if (edgeType === 4) {
            // spline 控制點：先收集，湊滿 numCtrlPts 後一次切分成折線點（見 tessellateBSplineEdge
            // 頂部註解——曲線本身內縮於控制多邊形之內，直接連控制點會嚴重高估邊界範圍）
            splineCtrl.push({ x: pendX, y: val, w: 1 })
            if (splineNumCtrl > 0 && splineCtrl.length === splineNumCtrl) {
              for (const p of tessellateBSplineEdge(splineDegree, splineKnots, splineCtrl)) current.push(p)
            }
          } else current.push({ x: pendX, y: val })   // line edge 起點
          pendX = null
        }
        break
      case 11: pendX2 = val; break
      case 21:
        if (pendX2 !== null) {
          if (!isPoly && edgeType === 3) {
            // 橢圓弧：11/21 是相對中心的長軸端點向量 → 絕對座標 = 中心 ± 向量
            if (hasEllC) {
              current.push({ x: ellCx + pendX2, y: ellCy + val })
              current.push({ x: ellCx - pendX2, y: ellCy - val })
            }
          } else {
            current.push({ x: pendX2, y: val })   // line edge 終點 / spline fit point（絕對座標）
          }
          pendX2 = null
        }
        break
      case 50:
        if (!isPoly && edgeType === 2) arcA0 = val
        break
      case 73:
        // edge type 2（圓弧）：is-counterclockwise flag；edge type 4（spline）：is-rational flag
        if (!isPoly && edgeType === 2) arcCcw = val !== 0
        else if (!isPoly && edgeType === 4) splineRational = val !== 0
        break
      case 51:
        if (!isPoly && edgeType === 2 && hasArcC && hasArcR) {
          // 弧線切分：依 73 旗標決定掃描方向，依 ARC_STEP_ANGLE（相對弓高容忍值換算）取點，
          // 避免弧形邊界只取頭尾兩點造成的面積失真（見二.3「曲線或圓弧邊界的近似轉換」）
          const r0 = arcA0 * Math.PI / 180
          let delta = (val * Math.PI / 180) - r0
          if (arcCcw) { while (delta < 0) delta += Math.PI * 2 }
          else { while (delta > 0) delta -= Math.PI * 2 }
          const steps = Math.max(1, Math.ceil(Math.abs(delta) / ARC_STEP_ANGLE))
          for (let s = 0; s <= steps; s++) {
            const a = r0 + delta * (s / steps)
            current.push({ x: arcCx + arcR * Math.cos(a), y: arcCy + arcR * Math.sin(a) })
          }
        }
        break
    }
    i++
  }
  flush()

  // 跳過剩餘 HATCH 資料到下一個 entity — 途中捕捉 pattern scale(41) / angle(52)
  let hatchScale: number | undefined
  let hatchAngle: number | undefined
  while (i < groups.length && groups[i].code !== 0) {
    if (groups[i].code === 41 && hatchScale === undefined) hatchScale = parseFloat(groups[i].value) || undefined
    if (groups[i].code === 52 && hatchAngle === undefined) hatchAngle = parseFloat(groups[i].value)
    i++
  }

  return { loops, end: i, hatchScale, hatchAngle }
}

// ── Block definition parser ───────────────────────────────────────────────────

interface BlockDef {
  baseX: number
  baseY: number
  texts: Array<{ content: string; layer: string; localX: number; localY: number; type: 'TEXT' | 'MTEXT' }>
  inserts: Array<{ blockName: string; layer: string; localX: number; localY: number; scaleX: number; scaleY: number; rotation: number; handle?: string }>
  polygons: Array<{ layer: string; vertices: Array<{x:number;y:number}>; closed: boolean; source: 'LWPOLYLINE'|'HATCH'|'POLYLINE'; hatchPattern?: string; hatchScale?: number; hatchAngle?: number; hatchColor?: number; handle?: string }>
  // 本地 bbox（以 block origin 為原點），供計算世界座標 bbox 中心使用
  localBBox?: { minX: number; maxX: number; minY: number; maxY: number; cx: number; cy: number }
}

function parseBlockDefs(groups: GroupCode[]): Map<string, BlockDef> {
  const defs = new Map<string, BlockDef>()

  // 找到 BLOCKS section（用 SECTION + BLOCKS 兩個標記組合定位）
  let i = 0
  while (i < groups.length - 1) {
    if (groups[i].code === 0 && groups[i].value === 'SECTION' &&
        groups[i + 1].code === 2 && groups[i + 1].value === 'BLOCKS') {
      i += 2; break
    }
    i++
  }

  while (i < groups.length) {
    if (groups[i].code === 0 && groups[i].value === 'ENDSEC') break

    // 每個 BLOCK 定義
    if (groups[i].code === 0 && groups[i].value === 'BLOCK') {
      i++
      let blockName = ''; let baseX = 0; let baseY = 0
      const blockTexts: BlockDef['texts'] = []

      // 讀 block header（非 entity 行）
      while (i < groups.length && groups[i].code !== 0) {
        if (groups[i].code === 2)  blockName = decodeUnicodeEscapes(groups[i].value)
        if (groups[i].code === 10) baseX     = parseFloat(groups[i].value) || 0
        if (groups[i].code === 20) baseY     = parseFloat(groups[i].value) || 0
        i++
      }

      // 讀 block 內所有 entities 直到 ENDBLK
      const blockInserts: BlockDef['inserts'] = []
      const blockPolygons: BlockDef['polygons'] = []

      while (i < groups.length) {
        if (groups[i].code === 0 && groups[i].value === 'ENDBLK') { i++; break }
        if (groups[i].code === 0 && groups[i].value === 'ENDSEC') break

        const eVal = groups[i].value

        // TEXT / MTEXT / ATTDEF
        if (groups[i].code === 0 && (eVal === 'TEXT' || eVal === 'MTEXT' || eVal === 'ATTDEF' || eVal === 'ATTRIB')) {
          const eType = eVal as 'TEXT' | 'MTEXT' | 'ATTDEF' | 'ATTRIB'
          let layer = ''; let content = ''; let lx = 0; let ly = 0
          let ax: number | null = null; let ay: number | null = null  // 對齊點 11/21
          let hAlign = 0; let vAlign = 0                              // 72/73：非 0 = 使用對齊點
          let gotXY = false; let inEmbedded = false
          i++
          while (i < groups.length && groups[i].code !== 0) {
            // MTEXT「101 Embedded Object」區段內有另一組 10/20（方向向量），
            // 會蓋掉真實插入點 → 遇到 101 後停止解析座標
            if (groups[i].code === 101) inEmbedded = true
            if (!inEmbedded) {
              if (groups[i].code === 8)  layer   = decodeUnicodeEscapes(groups[i].value)
              if (groups[i].code === 1)  content = (eType === 'MTEXT') ? stripMtextCodes(groups[i].value) : decodeUnicodeEscapes(groups[i].value)
              if (groups[i].code === 10 && !gotXY) lx = parseFloat(groups[i].value) || 0
              if (groups[i].code === 20 && !gotXY) { ly = parseFloat(groups[i].value) || 0; gotXY = true }
              if (groups[i].code === 11) ax      = parseFloat(groups[i].value)
              if (groups[i].code === 21) ay      = parseFloat(groups[i].value)
              if (groups[i].code === 72) hAlign  = parseInt(groups[i].value) || 0
              if (groups[i].code === 73) vAlign  = parseInt(groups[i].value) || 0
            }
            i++
          }
          // TEXT 有對齊設定（72/73 非 0）時，真實位置是對齊點 11/21 而非 10/20
          // （多個標籤 10/20 同為 (1,0) 的典型症狀）
          const useAlign = eType !== 'MTEXT' && (hAlign !== 0 || vAlign !== 0) &&
            ax !== null && ay !== null && isFinite(ax) && isFinite(ay)
          if (content.trim()) {
            blockTexts.push({
              content: content.trim(), layer,
              localX: useAlign ? ax! : lx,
              localY: useAlign ? ay! : ly,
              type: eType === 'MTEXT' ? 'MTEXT' : 'TEXT',
            })
          }

        // INSERT（nested block）
        } else if (groups[i].code === 0 && eVal === 'INSERT') {
          let layer = ''; let bname = ''; let lx = 0; let ly = 0
          let sx = 1; let sy = 1; let rot = 0
          let extZ = 1  // code 230：OCS 鏡射（見 ENTITIES INSERT 分支說明）
          let handle = ''
          i++
          while (i < groups.length && groups[i].code !== 0) {
            if (groups[i].code === 5)   handle = groups[i].value
            if (groups[i].code === 8)   layer = decodeUnicodeEscapes(groups[i].value)
            if (groups[i].code === 2)   bname = decodeUnicodeEscapes(groups[i].value)
            if (groups[i].code === 10)  lx    = parseFloat(groups[i].value) || 0
            if (groups[i].code === 20)  ly    = parseFloat(groups[i].value) || 0
            if (groups[i].code === 41)  sx    = parseFloat(groups[i].value) || 1
            if (groups[i].code === 42)  sy    = parseFloat(groups[i].value) || 1
            if (groups[i].code === 50)  rot   = parseFloat(groups[i].value) || 0
            if (groups[i].code === 230) extZ  = parseFloat(groups[i].value) || 1
            i++
          }
          if (extZ < -0.5) { lx = -lx; sx = -sx; rot = -rot }
          if (bname) blockInserts.push({ blockName: bname, layer, localX: lx, localY: ly, scaleX: sx, scaleY: sy, rotation: rot, handle: handle || undefined })

        // LWPOLYLINE
        } else if (groups[i].code === 0 && eVal === 'LWPOLYLINE') {
          let layer = ''; let closed = false; let handle = ''
          const verts: Array<{x:number;y:number}> = []; const bulges: number[] = []; let px: number|null = null
          i++
          while (i < groups.length && groups[i].code !== 0) {
            if (groups[i].code === 5)  handle = groups[i].value
            if (groups[i].code === 8)  layer  = decodeUnicodeEscapes(groups[i].value)
            if (groups[i].code === 70) closed = (parseInt(groups[i].value) & 1) === 1
            if (groups[i].code === 10) px     = parseFloat(groups[i].value) || 0
            if (groups[i].code === 20 && px !== null) { verts.push({ x: px, y: parseFloat(groups[i].value) || 0 }); bulges.push(0); px = null }
            if (groups[i].code === 42 && bulges.length > 0) bulges[bulges.length - 1] = parseFloat(groups[i].value) || 0
            i++
          }
          if (verts.length >= 3) {
            const finalClosed = closed || isApproxClosed(verts)
            blockPolygons.push({ layer, vertices: expandPolylineBulges(verts, bulges, finalClosed), closed: finalClosed, source: 'LWPOLYLINE', handle: handle || undefined })
          }

        // HATCH
        } else if (groups[i].code === 0 && eVal === 'HATCH') {
          let layer = ''; let hatchPattern = ''; let hatchColor: number | undefined; let handle = ''
          i++
          while (i < groups.length && groups[i].code !== 0 && groups[i].code !== 91) {
            if (groups[i].code === 5)  handle = groups[i].value
            if (groups[i].code === 8)  layer = decodeUnicodeEscapes(groups[i].value)
            if (groups[i].code === 2)  hatchPattern = groups[i].value
            if (groups[i].code === 62) hatchColor = parseInt(groups[i].value) || undefined
            i++
          }
          const { loops: hLoops, end: he, hatchScale, hatchAngle } = parseHatchBoundary(groups, i)
          i = he
          for (const hv of hLoops) {
            blockPolygons.push({ layer, vertices: hv, closed: true, source: 'HATCH', hatchPattern: hatchPattern || undefined, hatchScale, hatchAngle, hatchColor, handle: handle || undefined })
          }

        // CIRCLE（樹木圓形圖案最常見的幾何元素）
        } else if (groups[i].code === 0 && eVal === 'CIRCLE') {
          let cx = 0; let cy = 0; let r = 0
          i++
          while (i < groups.length && groups[i].code !== 0) {
            if (groups[i].code === 10) cx = parseFloat(groups[i].value) || 0
            if (groups[i].code === 20) cy = parseFloat(groups[i].value) || 0
            if (groups[i].code === 40) r  = parseFloat(groups[i].value) || 0
            i++
          }
          if (r > 0) {
            // 近似為 8 邊形頂點，供 bbox 計算
            const pts: Array<{x:number;y:number}> = []
            for (let a = 0; a < 8; a++) {
              const angle = (a / 8) * Math.PI * 2
              pts.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) })
            }
            blockPolygons.push({ layer: '', vertices: pts, closed: true, source: 'LWPOLYLINE' })
          }

        } else {
          i++
        }
      }

      // ── 計算 block 本地 bbox（以 baseX/baseY 為原點偏移後的 local 座標系）
      // 迴圈實作：大型 block（數萬頂點）用 spread 會拋 RangeError
      let localBBox: BlockDef['localBBox'] = undefined
      let lminX = Infinity; let lmaxX = -Infinity
      let lminY = Infinity; let lmaxY = -Infinity
      for (const poly of blockPolygons) {
        for (const v of poly.vertices) {
          if (v.x < lminX) lminX = v.x
          if (v.x > lmaxX) lmaxX = v.x
          if (v.y < lminY) lminY = v.y
          if (v.y > lmaxY) lmaxY = v.y
        }
      }
      for (const t of blockTexts) {
        if (t.localX < lminX) lminX = t.localX
        if (t.localX > lmaxX) lmaxX = t.localX
        if (t.localY < lminY) lminY = t.localY
        if (t.localY > lmaxY) lmaxY = t.localY
      }
      if (isFinite(lminX)) {
        localBBox = { minX: lminX, maxX: lmaxX, minY: lminY, maxY: lmaxY, cx: (lminX + lmaxX) / 2, cy: (lminY + lmaxY) / 2 }
      }

      if (blockName) defs.set(blockName, { baseX, baseY, texts: blockTexts, inserts: blockInserts, polygons: blockPolygons, localBBox })
    } else {
      i++
    }
  }

  return defs
}

// ── Main parser ───────────────────────────────────────────────────────────────

// ── LAYER 表顏色解析：0 LAYER → 2 name → 62 color（ACI）──────────────────
// 供 ByLayer(256)/ByBlock(0) HATCH 解析 effectiveColor 用
function parseLayerColors(groups: GroupCode[]): Record<string, number> {
  const colors: Record<string, number> = {}
  for (let i = 0; i < groups.length; i++) {
    if (groups[i].code === 0 && groups[i].value === 'LAYER') {
      let name = ''; let color: number | undefined
      let j = i + 1
      while (j < groups.length && groups[j].code !== 0) {
        if (groups[j].code === 2)  name  = decodeUnicodeEscapes(groups[j].value).trim()
        if (groups[j].code === 62) color = Math.abs(parseInt(groups[j].value)) || undefined  // 負值=圖層關閉，取絕對值
        j++
      }
      if (name && color !== undefined) colors[name] = color
      i = j - 1
    }
  }
  return colors
}

// ── HEADER $INSUNITS 解析：圖面單位代碼（4=mm, 5=cm, 6=m, 其餘/找不到 = 無法辨識）──
// 供分區植栽面積統計換算 m² 用；找不到或非 mm/cm/m 時交由 UI 提示使用者手動選擇，
// 不可靜默假設，否則面積可能誤差達百萬倍。
function parseInsUnits(groups: GroupCode[]): number | undefined {
  for (let i = 0; i < groups.length; i++) {
    if (groups[i].code === 9 && groups[i].value === '$INSUNITS') {
      let j = i + 1
      while (j < groups.length && groups[j].code !== 70 && groups[j].code !== 9 && groups[j].code !== 0) j++
      if (j < groups.length && groups[j].code === 70) {
        const v = parseInt(groups[j].value, 10)
        return isNaN(v) ? undefined : v
      }
      return undefined
    }
  }
  return undefined
}

export function parseDxf(text: string): DxfParseResult {
  const groups = parseGroupCodes(text)
  const inserts: DxfInsert[] = []
  const texts: DxfText[] = []
  const polygons: DxfPolygon[] = []
  const splineSegments: Array<{ layer: string; points: Array<{ x: number; y: number }> }> = []
  const layerColors = parseLayerColors(groups)
  const insUnits = parseInsUnits(groups)

  // 預先解析 BLOCKS section（block 定義內的文字）
  const blockDefs = parseBlockDefs(groups)

  // ── AutoCAD R2004+ 格式：model space 實體存在 *Model_Space block 而非 ENTITIES section ──
  // 找 *Model_Space（各種大小寫）block，直接輸出其文字與幾何
  for (const [bname, bdef] of blockDefs) {
    const low = bname.toLowerCase()
    const isModelSpace = low === '*model_space' || low === '*modelspace' || low.includes('model_space')
    const isPaperSpace = low.includes('paper')
    if (isModelSpace && !isPaperSpace) {
      // 文字
      for (const bt of bdef.texts) {
        texts.push({ type: bt.type, layer: bt.layer, content: bt.content, x: bt.localX, y: bt.localY })
      }
      // 幾何（HATCH / LWPOLYLINE）
      for (const bp of bdef.polygons) {
        polygons.push({ layer: bp.layer, vertices: bp.vertices, closed: bp.closed, zoneType: classifyZone(bp.layer), source: bp.source, hatchPattern: bp.hatchPattern, hatchScale: bp.hatchScale, hatchAngle: bp.hatchAngle, hatchColor: bp.hatchColor, handle: bp.handle })
      }
      // ── INSERT 遞迴展開（關鍵：R2004+ 所有實體常包在 Model_Space 甚至再包一層 block）──
      // 沒展開的話：分區標籤（本身是名為「A區」的 block）停在 local 座標 (1,0)，
      // point-in-polygon 全數失敗 → 「未找到包含 X區 的封閉邊界」
      // handlePath：depth 0 直接用該 INSERT 自身 handle（與傳統 ENTITIES section 重複解析
      // 同一實體時會拿到相同 handle，供 zoneStatistics.ts 去重）；depth>0 的巢狀展開則串接
      // 祖先 INSERT handle，讓同一 block 定義被多次插入時，每個世界座標副本仍有唯一鍵。
      const expandInsert = (
        bi: BlockDef['inserts'][0],
        originX: number, originY: number,
        oScaleX: number, oScaleY: number, oRotDeg: number,
        depth: number,
        parentHandlePath: string,
      ): void => {
        if (depth > 5) return  // 防循環
        const oRad = oRotDeg * Math.PI / 180
        const oCos = Math.cos(oRad); const oSin = Math.sin(oRad)
        // insert 點在上層座標系 → 世界座標
        const wx = originX + bi.localX * oScaleX * oCos - bi.localY * oScaleY * oSin
        const wy = originY + bi.localX * oScaleX * oSin + bi.localY * oScaleY * oCos
        const wScaleX = bi.scaleX * oScaleX
        const wScaleY = bi.scaleY * oScaleY
        const wRot = bi.rotation + oRotDeg
        const handlePath = parentHandlePath ? `${parentHandlePath}::${bi.handle ?? ''}` : (bi.handle ?? '')
        inserts.push({ type: 'INSERT', layer: bi.layer, blockName: bi.blockName, x: wx, y: wy, scaleX: wScaleX, scaleY: wScaleY, rotation: wRot, attributes: [], handle: handlePath || undefined })

        const target = blockDefs.get(bi.blockName)
        if (!target) return
        const rad = wRot * Math.PI / 180
        const cos = Math.cos(rad); const sin = Math.sin(rad)
        for (const bt of target.texts) {
          const dx = bt.localX - target.baseX; const dy = bt.localY - target.baseY
          texts.push({
            type: bt.type, layer: bt.layer || bi.layer, content: bt.content,
            x: wx + dx * wScaleX * cos - dy * wScaleY * sin,
            y: wy + dx * wScaleX * sin + dy * wScaleY * cos,
          })
        }
        for (const bp of target.polygons) {
          const worldVerts = bp.vertices.map(v => {
            const dx = v.x - target.baseX; const dy = v.y - target.baseY
            return {
              x: wx + dx * wScaleX * cos - dy * wScaleY * sin,
              y: wy + dx * wScaleX * sin + dy * wScaleY * cos,
            }
          })
          if (worldVerts.length >= 3) {
            polygons.push({
              layer: bp.layer || bi.layer, vertices: worldVerts, closed: bp.closed,
              zoneType: classifyZone(bp.layer || bi.layer), source: bp.source,
              hatchPattern: bp.hatchPattern, hatchScale: bp.hatchScale,
              hatchAngle: bp.hatchAngle, hatchColor: bp.hatchColor,
              handle: handlePath ? `${handlePath}::${bp.handle ?? ''}` : (bp.handle || undefined),
              parentBlockName: bi.blockName,
            })
          }
        }
        // 遞迴展開 nested INSERT（target block 座標系 → 需先扣 target.baseX/Y）
        for (const ni of target.inserts) {
          expandInsert(
            { ...ni, localX: ni.localX - target.baseX, localY: ni.localY - target.baseY },
            wx, wy, wScaleX, wScaleY, wRot, depth + 1,
            handlePath,
          )
        }
      }
      for (const bi of bdef.inserts) {
        expandInsert(
          { ...bi, localX: bi.localX - bdef.baseX, localY: bi.localY - bdef.baseY },
          0, 0, 1, 1, 0, 0,
          '',
        )
      }
    }
  }

  // Locate ENTITIES section（傳統格式的 entity 也繼續讀）
  let i = 0
  while (i < groups.length) {
    if (groups[i].code === 2 && groups[i].value === 'ENTITIES') { i++; break }
    i++
  }

  // Parse entities
  while (i < groups.length) {
    const g = groups[i]
    if (g.code === 0 && g.value === 'ENDSEC') break

    // ── INSERT（含緊接的 ATTRIB/SEQEND）────────────────────────────────────
    // DXF 結構：INSERT → ATTRIB* → SEQEND
    // 必須在同一個分支裡一次讀完，才能把 ATTRIB 連結到父 INSERT。
    if (g.code === 0 && g.value === 'INSERT') {
      let layer = ''; let blockName = ''
      let x = 0; let y = 0
      let scaleX = 1; let scaleY = 1; let rotDeg = 0
      let extZ = 1  // code 230：extrusion normal Z。-1 = AutoCAD MIRROR 產生的 OCS 鏡射
      let handle = ''
      i++
      while (i < groups.length && groups[i].code !== 0) {
        const eg = groups[i]
        if (eg.code === 5)   handle    = eg.value
        if (eg.code === 8)   layer     = decodeUnicodeEscapes(eg.value)
        if (eg.code === 2)   blockName = decodeUnicodeEscapes(eg.value)
        if (eg.code === 10)  x         = parseFloat(eg.value) || 0
        if (eg.code === 20)  y         = parseFloat(eg.value) || 0
        if (eg.code === 41)  scaleX    = parseFloat(eg.value) || 1
        if (eg.code === 42)  scaleY    = parseFloat(eg.value) || 1
        if (eg.code === 50)  rotDeg    = parseFloat(eg.value) || 0
        if (eg.code === 230) extZ      = parseFloat(eg.value) || 1
        i++
      }
      // ── OCS → WCS 正規化（Arbitrary Axis Algorithm，normal=(0,0,-1) 退化情形）──
      // MIRROR 產生的 INSERT 其 10/20 為 OCS 座標：worldX = -ocsX, worldY = ocsY。
      // Block 展開等效變換：insert.x 取負、scaleX 取負、rotation 取負（數學推導：
      // M·R(θ)·S(sx,sy) = R(-θ)·S(-sx,sy)，M = diag(-1,1)）。
      // 正規化後下游（block 展開、bbox center、歸區）全部沿用既有邏輯即正確。
      if (extZ < -0.5) {
        x = -x
        scaleX = -scaleX
        rotDeg = -rotDeg
      }

      // 緊接收集 ATTRIB / ATTDEF 實體（連結到此 INSERT）
      const attribs: import('@/types/dxf').DxfAttrib[] = []
      while (i < groups.length && groups[i].code === 0 &&
             (groups[i].value === 'ATTRIB' || groups[i].value === 'ATTDEF')) {
        let atag = ''; let aval = ''; let altVal = ''; let ax = x; let ay = y
        i++
        while (i < groups.length && groups[i].code !== 0) {
          const eg = groups[i]
          if (eg.code === 2)  atag   = eg.value
          if (eg.code === 1)  aval   = decodeUnicodeEscapes(eg.value)
          if (eg.code === 3)  altVal = decodeUnicodeEscapes(eg.value)
          if (eg.code === 10) ax     = parseFloat(eg.value) || 0
          if (eg.code === 20) ay     = parseFloat(eg.value) || 0
          i++
        }
        const finalVal = (altVal + aval).trim() || aval.trim()
        if (atag && finalVal) attribs.push({ tag: atag, value: finalVal })
        // 同時送入 texts，讓舊有的 nearby text 搜尋仍可命中
        if (finalVal) texts.push({ type: 'TEXT', layer, content: finalVal, x: ax, y: ay })
      }
      // 跳過 SEQEND（ATTRIB 序列結束標記）
      if (i < groups.length && groups[i].code === 0 && groups[i].value === 'SEQEND') {
        i++
        while (i < groups.length && groups[i].code !== 0) i++
      }

      if (blockName) {
        inserts.push({ type: 'INSERT', layer, blockName, x, y, scaleX, scaleY, rotation: rotDeg, attributes: attribs, handle: handle || undefined })

        const bdef = blockDefs.get(blockName)
        if (bdef) {
          const rad = rotDeg * Math.PI / 180
          const cos = Math.cos(rad); const sin = Math.sin(rad)

          // 展開 block 內的文字（世界座標）
          for (const bt of bdef.texts) {
            const dx = bt.localX - bdef.baseX; const dy = bt.localY - bdef.baseY
            const wx = x + dx * scaleX * cos - dy * scaleY * sin
            const wy = y + dx * scaleX * sin + dy * scaleY * cos
            texts.push({ type: bt.type, layer: bt.layer || layer, content: bt.content, x: wx, y: wy })
          }

          // 展開 block 內的 HATCH / LWPOLYLINE（世界座標）
          // 目的：讓索引表 block 內的 HATCH sample 能被 Legend Mapping 讀到
          // handle 組合鍵：外層 INSERT handle + 內層實體 handle，讓同一 block 定義
          // 被插入多次時，每個世界座標副本仍有各自唯一的去重鍵（見 zoneStatistics.ts）
          for (const bp of bdef.polygons) {
            const worldVerts = bp.vertices.map(v => {
              const dx = v.x - bdef.baseX; const dy = v.y - bdef.baseY
              return {
                x: x + dx * scaleX * cos - dy * scaleY * sin,
                y: y + dx * scaleX * sin + dy * scaleY * cos,
              }
            })
            if (worldVerts.length >= 3) {
              polygons.push({
                layer: bp.layer || layer,
                vertices: worldVerts,
                closed: bp.closed,
                zoneType: classifyZone(bp.layer || layer),
                source: bp.source,
                hatchPattern: bp.hatchPattern,
                hatchScale: bp.hatchScale,
                hatchAngle: bp.hatchAngle,
                hatchColor: bp.hatchColor,
                handle: handle ? `${handle}::${bp.handle ?? ''}` : (bp.handle || undefined),
                parentBlockName: blockName,
              })
            }
          }
        }
      }

    // ── TEXT, MTEXT, 孤立的 ATTRIB/ATTDEF，SEQEND ────────────────────────
    } else if (g.code === 0 && g.value === 'SEQEND') {
      // 孤立的 SEQEND（例如在 *Model_Space block 展開後殘留），直接略過
      i++
      while (i < groups.length && groups[i].code !== 0) i++

    } else if (g.code === 0 && (
      g.value === 'TEXT' || g.value === 'MTEXT' ||
      g.value === 'ATTRIB' || g.value === 'ATTDEF'
    )) {
      const type = g.value as 'TEXT' | 'MTEXT' | 'ATTRIB' | 'ATTDEF'
      let layer = ''; let content = ''; let altContent = ''
      let attribTag = ''
      let x = 0; let y = 0
      let ax: number | null = null; let ay: number | null = null
      let hAlign = 0; let vAlign = 0
      let gotXY = false; let inEmbedded = false
      i++
      while (i < groups.length && groups[i].code !== 0) {
        const eg = groups[i]
        // MTEXT 101 Embedded Object 內另有 10/20（方向向量）會蓋掉插入點
        if (eg.code === 101) inEmbedded = true
        if (!inEmbedded) {
          if (eg.code === 8)  layer = decodeUnicodeEscapes(eg.value)
          if (eg.code === 2 && (type === 'ATTRIB' || type === 'ATTDEF')) attribTag = eg.value
          if (eg.code === 1) content    = type === 'MTEXT' ? stripMtextCodes(eg.value) : decodeUnicodeEscapes(eg.value)
          if (eg.code === 3) altContent = type === 'MTEXT' ? stripMtextCodes(eg.value) : decodeUnicodeEscapes(eg.value)
          if (eg.code === 10 && !gotXY) x = parseFloat(eg.value) || 0
          if (eg.code === 20 && !gotXY) { y = parseFloat(eg.value) || 0; gotXY = true }
          if (eg.code === 11) ax = parseFloat(eg.value)
          if (eg.code === 21) ay = parseFloat(eg.value)
          if (eg.code === 72) hAlign = parseInt(eg.value) || 0
          if (eg.code === 73) vAlign = parseInt(eg.value) || 0
        }
        i++
      }
      // TEXT/ATTRIB 有對齊設定時真實位置為對齊點 11/21
      if (type !== 'MTEXT' && (hAlign !== 0 || vAlign !== 0) &&
          ax !== null && ay !== null && isFinite(ax) && isFinite(ay)) {
        x = ax; y = ay
      }
      const fullContent = (altContent + content).trim() || content.trim()
      if (fullContent) {
        if ((type === 'ATTRIB' || type === 'ATTDEF') && attribTag && attribTag !== fullContent) {
          const tagNorm = attribTag.trim()
          if (tagNorm && /[一-鿿A-Za-z]/.test(tagNorm)) {
            texts.push({ type: 'TEXT', layer, content: tagNorm, x, y })
          }
        }
        texts.push({ type: type === 'MTEXT' ? 'MTEXT' : 'TEXT', layer, content: fullContent, x, y })
      }

    // ── LWPOLYLINE ───────────────────────────────────────────────────────────
    } else if (g.code === 0 && g.value === 'LWPOLYLINE') {
      let layer = ''; let closed = false; let handle = ''
      const vertices: Array<{ x: number; y: number }> = []
      const bulges: number[] = []
      let pendingX: number | null = null
      i++
      while (i < groups.length && groups[i].code !== 0) {
        const eg = groups[i]
        if (eg.code === 5)  handle = eg.value
        if (eg.code === 8)  layer  = decodeUnicodeEscapes(eg.value)
        if (eg.code === 70) closed = (parseInt(eg.value) & 1) === 1
        if (eg.code === 10) pendingX = parseFloat(eg.value) || 0
        if (eg.code === 20 && pendingX !== null) {
          vertices.push({ x: pendingX, y: parseFloat(eg.value) || 0 })
          bulges.push(0)
          pendingX = null
        }
        if (eg.code === 42 && bulges.length > 0) bulges[bulges.length - 1] = parseFloat(eg.value) || 0
        i++
      }
      if (vertices.length >= 3) {
        const finalClosed = closed || isApproxClosed(vertices)
        polygons.push({
          layer, vertices: expandPolylineBulges(vertices, bulges, finalClosed),
          closed: finalClosed,
          zoneType: classifyZone(layer),
          source: 'LWPOLYLINE',
          handle: handle || undefined,
        })
      }

    // ── SPLINE ───────────────────────────────────────────────────────────────
    // 分區邊界有時用曲線工具（SPLINE）繪製而非 LWPOLYLINE，尤其是造型自然的
    // 灌木/草皮區塊或分區輪廓。取控制點（code 10/20）近似曲線頂點；同層的多段
    // SPLINE（常見於一條分區邊界被拆成數段曲線）於下方 chainSplineSegments 串接。
    } else if (g.code === 0 && g.value === 'SPLINE') {
      let layer = ''
      const points: Array<{ x: number; y: number }> = []
      let pendingX: number | null = null
      i++
      while (i < groups.length && groups[i].code !== 0) {
        const eg = groups[i]
        if (eg.code === 8)  layer = decodeUnicodeEscapes(eg.value)
        if (eg.code === 10) pendingX = parseFloat(eg.value) || 0
        if (eg.code === 20 && pendingX !== null) {
          points.push({ x: pendingX, y: parseFloat(eg.value) || 0 })
          pendingX = null
        }
        i++
      }
      if (points.length >= 2) splineSegments.push({ layer, points })

    // ── HATCH ────────────────────────────────────────────────────────────────
    } else if (g.code === 0 && g.value === 'HATCH') {
      let layer = ''
      let hatchPattern = ''  // code 2：pattern name
      let hatchColor: number | undefined  // code 62：ACI color
      let handle = ''
      i++
      while (i < groups.length && groups[i].code !== 0 && groups[i].code !== 91) {
        if (groups[i].code === 5)  handle = groups[i].value
        if (groups[i].code === 8)  layer = decodeUnicodeEscapes(groups[i].value)
        if (groups[i].code === 2)  hatchPattern = groups[i].value
        if (groups[i].code === 62) hatchColor = parseInt(groups[i].value) || undefined
        i++
      }
      const { loops: hLoops, end, hatchScale, hatchAngle } = parseHatchBoundary(groups, i)
      i = end
      for (const hv of hLoops) {
        polygons.push({
          layer, vertices: hv,
          closed: true,
          zoneType: classifyZone(layer),
          source: 'HATCH',
          hatchPattern: hatchPattern || undefined,
          hatchScale, hatchAngle, hatchColor,
          handle: handle || undefined,
        })
      }

    // ── POLYLINE (old style) ─────────────────────────────────────────────────
    } else if (g.code === 0 && g.value === 'POLYLINE') {
      let layer = ''; let closed = false; let handle = ''
      i++
      while (i < groups.length && groups[i].code !== 0) {
        if (groups[i].code === 5)  handle = groups[i].value
        if (groups[i].code === 8)  layer  = decodeUnicodeEscapes(groups[i].value)
        if (groups[i].code === 70) closed = (parseInt(groups[i].value) & 1) === 1
        i++
      }
      // Collect VERTEX entities that follow
      const vertices: Array<{ x: number; y: number }> = []
      while (i < groups.length && groups[i].code === 0 && groups[i].value === 'VERTEX') {
        let vx = 0; let vy = 0
        i++
        while (i < groups.length && groups[i].code !== 0) {
          if (groups[i].code === 10) vx = parseFloat(groups[i].value) || 0
          if (groups[i].code === 20) vy = parseFloat(groups[i].value) || 0
          i++
        }
        vertices.push({ x: vx, y: vy })
      }
      if (vertices.length >= 3) {
        polygons.push({
          layer, vertices,
          closed: closed || isApproxClosed(vertices),
          zoneType: classifyZone(layer),
          source: 'POLYLINE',
          handle: handle || undefined,
        })
      }

    } else {
      i++
    }
  }

  // Group INSERTs: store ALL positions + aggregate ATTRIBs (no limit, for spatial analysis)
  const groupMap = new Map<string, BlockGroup>()
  for (const ins of inserts) {
    const key = `${ins.blockName}||${ins.layer}`
    if (!groupMap.has(key)) {
      groupMap.set(key, { blockName: ins.blockName, layer: ins.layer, count: 0, positions: [], attributes: [] })
    }
    const grp = groupMap.get(key)!
    grp.count++
    grp.positions.push({ x: ins.x, y: ins.y })
    // 聚合 ATTRIB：以 tag 去重，保留第一次出現的 value
    for (const attr of ins.attributes) {
      if (!grp.attributes.some(a => a.tag === attr.tag)) {
        grp.attributes.push(attr)
      }
    }
  }

  // ── SPLINE 分區邊界：串接同層曲線段 → 封閉多邊形 ──────────────────────────
  for (const { layer, vertices } of chainSplineSegments(splineSegments)) {
    polygons.push({
      layer, vertices,
      closed: true,
      zoneType: classifyZone(layer),
      source: 'LWPOLYLINE',
    })
  }

  const blockGroups = Array.from(groupMap.values()).sort((a, b) => b.count - a.count)
  const allLayers = [...new Set([
    ...inserts.map(e => e.layer),
    ...texts.map(e => e.layer),
    ...polygons.map(p => p.layer),
  ])].filter(Boolean).sort()

  const classifiedPolygons = polygons.filter(p => p.zoneType !== 'unknown').length

  // 將 block def 的 localBBox 轉成公開型別
  const blockExtents: Record<string, import('@/types/dxf').BlockExtent> = {}
  for (const [name, def] of blockDefs.entries()) {
    if (def.localBBox) {
      blockExtents[name] = {
        baseX: def.baseX, baseY: def.baseY,
        localCx: def.localBBox.cx, localCy: def.localBBox.cy,
        localMinX: def.localBBox.minX, localMaxX: def.localBBox.maxX,
        localMinY: def.localBBox.minY, localMaxY: def.localBBox.maxY,
      }
    }
  }

  return {
    inserts, texts, blockGroups, polygons, allLayers, blockExtents, layerColors, insUnits,
    stats: {
      totalInserts: inserts.length,
      totalTexts: texts.length,
      uniqueBlocks: blockGroups.length,
      uniqueLayers: allLayers.length,
      totalPolygons: polygons.length,
      classifiedPolygons,
    },
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * 串接同層的多段 SPLINE 控制點路徑成封閉多邊形。
 * 分區邊界常見用曲線工具（SPLINE）拆成數段畫成，需先依「端點吻合」串成一條完整曲線，
 * 再視頭尾距離決定是否封閉。
 *
 * 兩種容差分開處理，避免用同一寬鬆容差時，把同層裡「不同分區」的相近端點誤接在一起：
 *   joinTol  = 段與段之間的銜接容差（小、嚴格——同一條曲線斷開的兩段，端點應幾乎重合）
 *   closeTol = 串好的單一鏈條「頭尾是否算封閉」的容差（較寬鬆——曲線工具常留一點縫隙），
 *              只套用在同一條已串好的鏈條自身頭尾，不會跨鏈條誤判。
 */
function chainSplineSegments(
  segments: Array<{ layer: string; points: Array<{ x: number; y: number }> }>,
): Array<{ layer: string; vertices: Array<{ x: number; y: number }> }> {
  const JOIN_TOL = 2
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)
  const results: Array<{ layer: string; vertices: Array<{ x: number; y: number }> }> = []

  const byLayer = new Map<string, Array<Array<{ x: number; y: number }>>>()
  for (const seg of segments) {
    if (seg.points.length < 2) continue
    const arr = byLayer.get(seg.layer) ?? []
    arr.push(seg.points)
    byLayer.set(seg.layer, arr)
  }

  for (const [layer, segs] of byLayer) {
    const remaining = [...segs]
    while (remaining.length > 0) {
      let chain = remaining.shift()!
      let extended = true
      while (extended) {
        extended = false
        for (let idx = 0; idx < remaining.length; idx++) {
          const seg = remaining[idx]
          const chainEnd = chain[chain.length - 1]
          const chainStart = chain[0]
          const segStart = seg[0]
          const segEnd = seg[seg.length - 1]
          if (dist(chainEnd, segStart) <= JOIN_TOL) {
            chain = chain.concat(seg.slice(1)); remaining.splice(idx, 1); extended = true; break
          } else if (dist(chainEnd, segEnd) <= JOIN_TOL) {
            chain = chain.concat([...seg].reverse().slice(1)); remaining.splice(idx, 1); extended = true; break
          } else if (dist(chainStart, segEnd) <= JOIN_TOL) {
            chain = seg.slice(0, -1).concat(chain); remaining.splice(idx, 1); extended = true; break
          } else if (dist(chainStart, segStart) <= JOIN_TOL) {
            chain = [...seg].reverse().slice(0, -1).concat(chain); remaining.splice(idx, 1); extended = true; break
          }
        }
      }

      if (chain.length < 3) continue
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      for (const p of chain) {
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y
      }
      const closeTol = Math.max(20, Math.hypot(maxX - minX, maxY - minY) * 0.02)
      // 頭尾已吻合就視為封閉；否則補一段連回起點（曲線工具常見未精確閉合，但語意上是邊界）
      if (dist(chain[0], chain[chain.length - 1]) > closeTol) continue   // 缺口過大，不強行封閉，避免誤造假邊界
      results.push({ layer, vertices: chain })
    }
  }
  return results
}

function isApproxClosed(vertices: Array<{ x: number; y: number }>): boolean {
  if (vertices.length < 3) return false
  const first = vertices[0]; const last = vertices[vertices.length - 1]
  const dx = Math.abs(first.x - last.x); const dy = Math.abs(first.y - last.y)
  // Consider closed if first ≈ last (within 1 unit)
  return dx < 1 && dy < 1
}
