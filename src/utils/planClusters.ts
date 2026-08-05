// ── planClusters.ts — 同一 DXF 內「多張同基地平面圖」偵測與座標對位 ──────────────
// 背景：部分 DXF 會在同一檔案、同一座標系中並排放置兩張同基地圖面（例如左側喬木
// 配置圖／右側灌木地被配置圖），純粹是圖面配置習慣，不代表兩個不同基地。既有
// 分區偵測（detectZonesFromText）只認得「第一個出現」的分區文字與邊界，另一側
// 的圖面內容（通常是左側的喬木 INSERT）因此完全沒有分區邊界可比對，變成「未歸
// 區」而遺失，導致各區喬木統計短少。
//
// 做法：不做通用幾何群聚（風險高、對單一圖面的既有案例可能造成回歸），改用「分
// 區名稱文字在圖面中重複出現」這個具體、可驗證的訊號──若同一個分區名稱（如
// "A區"）在圖面中出現兩次，且多個分區名稱的兩次出現之間存在一致的位移量，即可
//判定為「同一基地被畫了兩次」，並算出純平移的對位向量。再用這個向量把「目前
// 落在既有分區邊界之外、但平移後會落入某個分區邊界」的 INSERT（喬木圖塊）搬進
// canonical 座標系，重新做一次點在多邊形內判斷後併入既有分區統計——不是在 UI
// 或統計結果硬加數字，是在資料進入 buildZonePlantList 之前，於同一份 inserts
// 陣列中新增「已對位」的實體。

import { normalizeZoneName, pointInPolygon, pointInPolygonWithTolerance, polygonBBox } from '@/utils/spatialAnalysis'
import type { DxfInsert, DxfText, DxfParseResult, DetectedZone } from '@/types/dxf'

export interface PlanClusterBBox { minX: number; maxX: number; minY: number; maxY: number }

export interface PlanAlignmentDebug {
  /** 是否偵測到「同一分區名稱在圖面中重複出現」的訊號 */
  duplicateZoneLabelsFound: boolean
  /** 有幾個分區名稱同時符合「重複出現＋位移一致」的判定 */
  matchedZoneNameCount: number
  /** 判定為同基地多圖（=> 有算出平移向量並實際套用）*/
  isSameSitePlan: boolean
  /** 平移向量：secondaryPos + translation = canonicalPos */
  translation: { dx: number; dy: number } | null
  /** 圖群數：偵測到同基地重複圖面時為 2（canonical＋secondary），否則為 1 */
  clusterCount: number
  canonicalCluster: { bbox: PlanClusterBBox; contentType: string } | null
  secondaryCluster: { bbox: PlanClusterBBox; contentType: string } | null
  /** 對位前：落在 secondary 區域內、且不在既有分區邊界內的候選喬木 INSERT 數 */
  candidateTreeInsertCount: number
  /** 對位後：實際成功平移併入某分區邊界的喬木 INSERT 數（已扣除重複） */
  alignedTreeInsertCount: number
  /** 對位後仍未落入任何分區邊界的候選數量 */
  unassignedAfterAlignCount: number
  /** 因與既有（canonical 側）INSERT 位置過近，判定為重複而略過的數量 */
  dedupedSkippedCount: number
  /** 每區新增的喬木 INSERT 數 */
  perZoneAddedCount: Record<string, number>
}

const NO_ALIGNMENT_DEBUG: PlanAlignmentDebug = {
  duplicateZoneLabelsFound: false,
  matchedZoneNameCount: 0,
  isSameSitePlan: false,
  translation: null,
  clusterCount: 1,
  canonicalCluster: null,
  secondaryCluster: null,
  candidateTreeInsertCount: 0,
  alignedTreeInsertCount: 0,
  unassignedAfterAlignCount: 0,
  dedupedSkippedCount: 0,
  perZoneAddedCount: {},
}

/** 找出圖面中所有「符合分區命名格式」的文字，不去重（供偵測重複出現用；
 *  canonical 分區偵測仍用既有 detectZonesFromText，這裡只做輔助訊號判斷）。*/
function findAllZoneLabelOccurrences(texts: DxfText[]): Array<{ name: string; x: number; y: number }> {
  const out: Array<{ name: string; x: number; y: number }> = []
  for (const t of texts) {
    const name = normalizeZoneName(t.content)
    if (name) out.push({ name, x: t.x, y: t.y })
  }
  return out
}

function bboxOf(pts: Array<{ x: number; y: number }>): PlanClusterBBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY }
}

/**
 * 偵測同基地重複圖面並對位，回傳「需要額外併入 inserts 的喬木清單」＋除錯資料。
 * 純函式、不修改輸入，呼叫端自行決定如何合併回 DxfParseResult。
 */
export function detectAndAlignDuplicatePlans(
  parsed: Pick<DxfParseResult, 'inserts' | 'texts'>,
  zones: DetectedZone[],
): { extraInserts: DxfInsert[]; debug: PlanAlignmentDebug } {
  const canonicalZones = zones.filter(z => z.boundary && z.boundary.vertices.length >= 3)
  if (canonicalZones.length === 0) return { extraInserts: [], debug: NO_ALIGNMENT_DEBUG }

  // ── 1. 找每個分區名稱的所有出現位置，比對 canonical 位置找出「另一份」出現 ──
  const allOccurrences = findAllZoneLabelOccurrences(parsed.texts)
  const byName = new Map<string, Array<{ x: number; y: number }>>()
  for (const occ of allOccurrences) {
    const arr = byName.get(occ.name) ?? []
    arr.push({ x: occ.x, y: occ.y })
    byName.set(occ.name, arr)
  }

  const offsets: Array<{ dx: number; dy: number; zoneName: string }> = []
  for (const z of canonicalZones) {
    const occs = byName.get(z.name)
    if (!occs || occs.length < 2) continue
    for (const occ of occs) {
      const dist = Math.hypot(occ.x - z.labelPosition.x, occ.y - z.labelPosition.y)
      if (dist < 1) continue   // 就是 canonical 那一筆本身
      offsets.push({ dx: z.labelPosition.x - occ.x, dy: z.labelPosition.y - occ.y, zoneName: z.name })
    }
  }

  if (offsets.length === 0) return { extraInserts: [], debug: { ...NO_ALIGNMENT_DEBUG, duplicateZoneLabelsFound: false } }

  // ── 2. 位移量分群：找出「多個分區名稱一致同意」的主要位移向量 ─────────────
  // 容差用 canonical 分區聯集 bbox 對角線的 1%（純平移案例通常誤差極小，這裡
  // 給足夠寬鬆的容差以涵蓋文字定位/字型量測的微小差異，不追求嚴謹統計群聚）。
  const canonicalBBoxPts = canonicalZones.flatMap(z => z.boundary!.vertices)
  const canonicalBBox = bboxOf(canonicalBBoxPts)
  const diag = Math.hypot(canonicalBBox.maxX - canonicalBBox.minX, canonicalBBox.maxY - canonicalBBox.minY)
  const tol = Math.max(diag * 0.01, 20)

  let bestGroup: typeof offsets = []
  for (const base of offsets) {
    const group = offsets.filter(o => Math.hypot(o.dx - base.dx, o.dy - base.dy) <= tol)
    if (group.length > bestGroup.length) bestGroup = group
  }
  const matchedZoneNames = new Set(bestGroup.map(o => o.zoneName))

  const MIN_MATCHES = 2
  if (matchedZoneNames.size < MIN_MATCHES) {
    return {
      extraInserts: [],
      debug: { ...NO_ALIGNMENT_DEBUG, duplicateZoneLabelsFound: true, matchedZoneNameCount: matchedZoneNames.size },
    }
  }

  const translation = {
    dx: bestGroup.reduce((s, o) => s + o.dx, 0) / bestGroup.length,
    dy: bestGroup.reduce((s, o) => s + o.dy, 0) / bestGroup.length,
  }

  // ── 3. 候選喬木 INSERT：目前（未平移）不在任何 canonical 分區邊界內，
  //       平移後會落入某個分區邊界 → 判定為「另一份圖面裡的喬木」───────────
  const boundaries = canonicalZones.map(z => z.boundary!.vertices)
  const posTol = Math.max(diag * 0.003, 5)

  const insideAnyRaw = (x: number, y: number) => boundaries.some(bv => pointInPolygonWithTolerance(x, y, bv, posTol))
  const insideZoneIndex = (x: number, y: number): number => boundaries.findIndex(bv => pointInPolygon(x, y, bv))

  const candidates = parsed.inserts.filter(ins => !insideAnyRaw(ins.x, ins.y))
  const translated = candidates
    .map(ins => ({ ins, tx: ins.x + translation.dx, ty: ins.y + translation.dy }))
    .filter(({ tx, ty }) => insideAnyRaw(tx, ty))

  // ── 4. 去重：平移後若與既有（canonical 側）同 blockName 的 INSERT 位置極近，
  //       視為同一棵樹的重複記錄，跳過不重複計入 ──────────────────────────
  const dedupTol = Math.max(diag * 0.001, 3)
  const canonicalByBlock = new Map<string, DxfInsert[]>()
  for (const ins of parsed.inserts) {
    const arr = canonicalByBlock.get(ins.blockName) ?? []
    arr.push(ins)
    canonicalByBlock.set(ins.blockName, arr)
  }

  const extraInserts: DxfInsert[] = []
  const perZoneAddedCount: Record<string, number> = {}
  let dedupedSkippedCount = 0
  let unassignedAfterAlignCount = 0

  for (const { ins, tx, ty } of translated) {
    const already = canonicalByBlock.get(ins.blockName) ?? []
    const isDup = already.some(o => Math.hypot(o.x - tx, o.y - ty) <= dedupTol)
    if (isDup) { dedupedSkippedCount++; continue }
    const zi = insideZoneIndex(tx, ty)
    if (zi < 0) { unassignedAfterAlignCount++; continue }   // 落在容差內但非嚴格內部，視為未成功歸區
    extraInserts.push({
      ...ins,
      x: tx, y: ty,
      handle: ins.handle ? `${ins.handle}~aligned` : undefined,
    })
    const zoneName = canonicalZones[zi].name
    perZoneAddedCount[zoneName] = (perZoneAddedCount[zoneName] ?? 0) + 1
  }
  unassignedAfterAlignCount += candidates.length - translated.length   // 平移後仍不在任何邊界內（含容差）的

  const secondaryOccPts = bestGroup.map(o => {
    const z = canonicalZones.find(zz => zz.name === o.zoneName)!
    return { x: z.labelPosition.x - o.dx, y: z.labelPosition.y - o.dy }
  })

  const debug: PlanAlignmentDebug = {
    duplicateZoneLabelsFound: true,
    matchedZoneNameCount: matchedZoneNames.size,
    isSameSitePlan: true,
    translation,
    clusterCount: 2,
    canonicalCluster: { bbox: canonicalBBox, contentType: '灌木／地被／草皮（HATCH／多邊形為主，既有分區邊界所在圖面）' },
    secondaryCluster: { bbox: bboxOf(secondaryOccPts), contentType: '喬木（BLOCK／INSERT 為主，重複分區標籤所在圖面）' },
    candidateTreeInsertCount: candidates.length,
    alignedTreeInsertCount: extraInserts.length,
    unassignedAfterAlignCount,
    dedupedSkippedCount,
    perZoneAddedCount,
  }

  return { extraInserts, debug }
}

/** 把對位後新增的喬木 INSERT 併回 DxfParseResult（inserts + blockGroups + stats 一併更新，
 *  確保「圖塊對應」等既有統計介面看到的總數跟分區喬木統計一致，不是只在單一畫面加數字）。*/
export function mergeAlignedInsertsIntoParseResult(
  result: DxfParseResult,
  extraInserts: DxfInsert[],
): DxfParseResult {
  if (extraInserts.length === 0) return result

  const inserts = [...result.inserts, ...extraInserts]

  const groupMap = new Map(result.blockGroups.map(g => [
    `${g.blockName}||${g.layer}`,
    { blockName: g.blockName, layer: g.layer, count: g.count, positions: [...g.positions], attributes: [...g.attributes] },
  ]))
  for (const ins of extraInserts) {
    const key = `${ins.blockName}||${ins.layer}`
    if (!groupMap.has(key)) {
      groupMap.set(key, { blockName: ins.blockName, layer: ins.layer, count: 0, positions: [], attributes: [] })
    }
    const grp = groupMap.get(key)!
    grp.count++
    grp.positions.push({ x: ins.x, y: ins.y })
    for (const attr of ins.attributes) {
      if (!grp.attributes.some(a => a.tag === attr.tag)) grp.attributes.push(attr)
    }
  }
  const blockGroups = Array.from(groupMap.values()).sort((a, b) => b.count - a.count)

  return {
    ...result,
    inserts,
    blockGroups,
    stats: {
      ...result.stats,
      totalInserts: inserts.length,
      uniqueBlocks: blockGroups.length,
    },
  }
}
