// ── dxfReportBuilder.ts — DXF 分區審查 PDF「圖面導向＋分區決策摘要」報告產生層 ──
// 純函式，不碰 DOM／React，只讀取既有管線（plantProximity.ts／plantEvaluator.ts）
// 已經算好的資料，重新組成適合印刷閱讀的版面內容。不改動、不重算任何判斷邏輯。
//
// 背景：舊版報告是逐一問題卡片堆疊（同類問題因為只用 category+cause 完全字串比對
// 去重，換一組植物就變成新卡片），19 頁裡充滿重複段落，也完全沒有圖面座標資訊。
// 這裡新增「合併問題＋編號」與「依 zone polygon 畫局部圖」兩個核心能力，讓
// DxfReviewPage.tsx 的 handleExportZonePdf 可以組出 6-8 頁的決策摘要報告。

import type {
  DetectedZone, SpatialPlantInstance, PlantConflictResult, TreeInventoryItem, DxfPolygon,
  SpatialInstanceKind, ProximityLevel, DrawingUnit,
} from '@/types/dxf'
import type { AltSuggestion, EvalResult } from '@/utils/plantEvaluator'
import { deriveConclusion } from '@/utils/issueCategoryMeta'
import { CM_PER_DRAWING_UNIT } from '@/utils/zoneStatistics'

// ── 共用格式化 helper ──────────────────────────────────────────────────────

export function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function zonePrefix(zoneName: string): string {
  return zoneName.charAt(0) || 'Z'
}

export function scoreColor(score?: number): string {
  return score === undefined ? '#78716c' : score >= 80 ? '#15803d' : score >= 60 ? '#d97706' : '#dc2626'
}

export type ZoneReviewStatusLike = '可審查' | '植物待確認' | '無法審查'
export function statusColor(status: ZoneReviewStatusLike): string {
  return status === '可審查' ? '#15803d' : status === '植物待確認' ? '#d97706' : '#dc2626'
}

export function riskLevelLabel(lv: string): string {
  return lv === 'high' ? '高風險' : lv === 'medium' ? '警示' : lv === 'low' ? '通過' : '未辨識'
}
export function riskLevelColor(lv: string): string {
  return lv === 'high' ? '#dc2626' : lv === 'medium' ? '#d97706' : lv === 'low' ? '#15803d' : '#78716c'
}

export function proximityLabel(c: PlantConflictResult): string {
  return c.proximity === 'overlap' ? '範圍重疊' : c.proximity === 'touching' ? '邊界相接'
    : c.nearBand === 'adjacent' ? '鄰近－直接相鄰' : '鄰近－可能影響'
}

export type BlockMatchStatus = 'db-matched' | 'name-only' | 'unmatched' | 'same-hatch-disambiguated-by-layer'
export function matchStatusLabel(s: BlockMatchStatus): string {
  return s === 'db-matched' ? '資料庫比對成功' : s === 'name-only' ? '僅名稱比對' : s === 'same-hatch-disambiguated-by-layer' ? '同HATCH以圖層辨別' : '未對應'
}

function dedupe<T>(arr: T[]): T[] { return [...new Set(arr)] }
function capText(s: string, max: number): string { return s.length > max ? s.slice(0, max) + '…' : s }
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// ── 問題合併與編號 ─────────────────────────────────────────────────────────

export type IssueBucketKey = 'watering' | 'drainage' | 'sunlight' | 'proximity' | 'root-canopy' | 'maintenance' | 'data-quality'

export const BUCKET_ORDER: IssueBucketKey[] =
  ['watering', 'drainage', 'sunlight', 'proximity', 'root-canopy', 'maintenance', 'data-quality']

export const BUCKET_LABEL: Record<IssueBucketKey, string> = {
  watering: '澆水需求', drainage: '排水需求', sunlight: '日照條件',
  proximity: '空間鄰近', 'root-canopy': '根系冠幅', maintenance: '養護管理', 'data-quality': '資料疑義',
}

// 10 種 raw IssueDetail.category（plantEvaluator.ts CATEGORY_DEFS，plantProximity.ts
// 從不自創分類）→ 7 桶固定對照。'proximity' 與部分 'root-canopy' 沒有對應的
// IssueDetail.category，資料另外從 riskLevel==='unmatched' 配對與 treeInventory 合成。
const CATEGORY_TO_BUCKET: Record<string, IssueBucketKey> = {
  '澆水衝突': 'watering',
  '排水衝突': 'drainage',
  '日照問題': 'sunlight',
  '根系風險': 'root-canopy',
  '維護風險': 'maintenance',
  '養護管理風險': 'maintenance',
  '土壤酸鹼衝突': 'maintenance',
  '土壤改良需求': 'maintenance',
  '土壤質地衝突': 'maintenance',
  '審查疑義風險': 'data-quality',
}

// ── 0cm／重疊語意重新分類 ─────────────────────────────────────────────────
// 上游 plantProximity.ts 只要兩個實體幾何重疊，distanceCm 就直接寫死成 0，不論
// 重疊面積多寡，也不分「喬木冠幅壓到耐陰地被（常見合理設計）」跟「兩個 HATCH
// 圖層真的畫錯疊在一起」。這裡純粹依已有的 kind／proximity 欄位做報告層的語意
// 重新分類，不碰任何上游偵測或評分邏輯。conflicts 陣列本身不含喬木（喬木衝突
// 走 treeInventory，見下方 buildZoneEvents），所以這裡只會遇到 HATCH×HATCH。

// TODO（上游辨識問題，不在本輪報告層重構範圍內，另立待辦追查，不要直接認定
// 「大量 needs-review」完全是圖面本身的問題）：實測一份真實圖面 41 組配對裡
// 32 組（78%）落入 unknown-hatch 導致的 needs-review，比例是否合理需要查證：
// - classifyOverlap 本身的判斷規則是否過於保守
// - plantProximity.ts／dxfParser.ts 的圖層名稱正規化、Unicode 解碼是否正確
// - 灌木／地被／草皮關鍵字映射表是否涵蓋不足，導致可辨識圖層被誤歸為 unknown
// - unknown-hatch 是否可以再利用鄰近文字、BLOCK 屬性、顏色或既有圖層對照規則
//   輔助分類，而不是直接落到「無法辨識」
// 這些都會影響上游 SpatialInstanceKind 的判定，牽動即時 UI 與所有既有評分，
// 需要獨立一輪調查，不能跟這次的報告呈現層重構混在一起做。
export interface OverlapNote { label: string; certain: boolean }

function classifyOverlap(aKind: SpatialInstanceKind, bKind: SpatialInstanceKind, proximity: ProximityLevel): OverlapNote {
  if (proximity === 'touching') return { label: '邊界接觸', certain: true }
  if (proximity !== 'overlap') return { label: '鄰近', certain: true }
  if (aKind === 'unknown-hatch' || bKind === 'unknown-hatch')
    return { label: '圖層類型無法辨識，需人工確認', certain: false }
  const ground = (k: SpatialInstanceKind) => k === 'groundcover-hatch' || k === 'lawn-hatch'
  if ((ground(aKind) && bKind === 'shrub-hatch') || (ground(bKind) && aKind === 'shrub-hatch'))
    return { label: '上下層植栽配置（灌木／地被組合，常見設計手法）', certain: false }
  if (aKind === bKind)
    return { label: '同類型圖層套疊，可能為繪製重複或實際密植', certain: false }
  return { label: '種植範圍重疊，建議現場或圖面覆核', certain: false }
}

/** certain=false（無法從幾何本身確認是否為真衝突）時，嚴重度上限鎖在「一般改善」，
 *  且若原始判定不是高風險，直接降為「需人工確認」——0cm 的重疊絕不會自動變成高風險。*/
function finalizeSeverity(rawSeverity: 'danger' | 'caution', overlap: OverlapNote): EventSeverity {
  if (overlap.certain) return rawSeverity
  return rawSeverity === 'danger' ? 'caution' : 'needs-review'
}

export function judgmentLabel(j: PlantConflictResult['judgment']): string {
  return j === 'ok' ? '符合' : j === 'caution' ? '注意' : j === 'conflict' ? '需改善' : '需人工確認'
}

// ── 事件卡：一組植物＋一個圖面位置＝一個問題事件 ────────────────────────────
// PlantConflictResult 本身已經是「一組植物＋一個圖面位置」的原子單位
//（computeZoneProximityPairs 用 i<j 雙迴圈每一對只產生一筆，judgment==='ok' 的
// 配對在上游已被丟棄），不需要額外去重 key，一筆 conflict 直接對應一張事件卡，
// 卡片內用 categories 陣列列出所有問題類型（澆水/排水/養護...），不再拆成多張卡。

export type EventSeverity = 'danger' | 'caution' | 'needs-review'

export interface ZoneEvent {
  id: string                       // "A-01".. 依嚴重度排序指定（danger 優先），跟優先修正清單天然對齊、跟地圖標記一致
  zoneName: string
  severity: EventSeverity
  overlapLabel: string             // classifyOverlap 的說明文字，卡片小字顯示，不是主標題
  plantAName: string
  plantBName: string
  locationLabels: string[]
  instanceIds: [string, string]
  categories: IssueBucketKey[]     // 問題類型標籤（去重）
  primaryBucket: IssueBucketKey    // 取最嚴重 issue 的分類，作為 spatialCluster 分組的「同一根本原因」依據
  title: string
  cause: string
  impact: string
  suggestion: string
  distanceCm: number | null        // proximity==='overlap' 時給 null（不印容易誤導的 0cm 數字）
  needsReviewNote: string | null
  sourcePairId: string
}

/** 把一個分區的逐對衝突轉成事件卡陣列，一配對一卡，依嚴重度（danger→caution→
 *  needs-review）排序後指定編號。純函式，輸入相同必產生相同結果。*/
export function buildZoneEvents(zoneName: string, conflicts: PlantConflictResult[]): ZoneEvent[] {
  const draft: Array<Omit<ZoneEvent, 'id'>> = conflicts.map(conflict => {
    const overlap = classifyOverlap(conflict.plantA.kind, conflict.plantB.kind, conflict.proximity)
    const locationLabels = dedupe([conflict.plantA.label, conflict.plantB.label])
    const base = {
      zoneName, overlapLabel: overlap.label,
      plantAName: conflict.plantA.name, plantBName: conflict.plantB.name,
      locationLabels, instanceIds: [conflict.plantA.instanceId, conflict.plantB.instanceId] as [string, string],
      distanceCm: conflict.proximity === 'overlap' ? null : conflict.distanceCm,
      sourcePairId: conflict.id,
    }
    if (conflict.riskLevel === 'unmatched') {
      return {
        ...base, severity: 'needs-review' as EventSeverity, categories: [], primaryBucket: 'proximity' as IssueBucketKey,
        title: '植物名稱未能比對資料庫，相容性無法判定',
        cause: `${conflict.plantA.name} 與 ${conflict.plantB.name} 空間${proximityLabel(conflict)}，惟至少一方植物名稱未能比對資料庫，無法判斷相容性。`,
        impact: '無法確認是否存在生長習性衝突，建議人工核實植物品種後再評估。',
        suggestion: '請設計者確認植物名稱與圖例對照，並於必要時補充至植栽資料庫。',
        needsReviewNote: '植物名稱無法比對資料庫',
      }
    }
    const categories = dedupe(conflict.issues.map(i => CATEGORY_TO_BUCKET[i.category] ?? 'maintenance'))
    const rawSeverity: 'danger' | 'caution' = conflict.issues.some(i => i.level === 'danger') ? 'danger' : 'caution'
    const severity = finalizeSeverity(rawSeverity, overlap)
    const worst = conflict.issues.find(i => i.level === 'danger') ?? conflict.issues[0]
    const primaryBucket = CATEGORY_TO_BUCKET[worst.category] ?? 'maintenance'
    return {
      ...base, severity, categories, primaryBucket,
      title: deriveConclusion(worst.cause),
      cause: capText(dedupe(conflict.issues.map(i => i.cause)).join('；'), 60),
      impact: capText(dedupe(conflict.issues.map(i => i.impact)).join('；'), 60),
      suggestion: capText(dedupe(conflict.issues.map(i => i.suggestion)).join('；'), 60),
      needsReviewNote: severity === 'needs-review' ? overlap.label : null,
    }
  })

  const severityRank: Record<EventSeverity, number> = { danger: 0, caution: 1, 'needs-review': 2 }
  const sorted = [...draft].sort((a, b) => severityRank[a.severity] - severityRank[b.severity])
  let seq = 1
  return sorted.map(e => ({ ...e, id: `${zonePrefix(zoneName)}-${String(seq++).padStart(2, '0')}` }))
}

// ── 分區統計 ───────────────────────────────────────────────────────────────

export interface ZoneEventStats {
  checkedPairCount: number     // 檢核配對數：系統依空間鄰近條件篩選後實際比對的植物組合數
  abnormalPairCount: number    // 異常配對數：其中至少命中一項風險條件的配對數（不含 unmatched，那是「無法判定」不是「異常」）
  dangerCount: number
  cautionCount: number
  needsReviewCount: number
  mergedEventCount: number     // 整併後問題數：events.length，不是原始 issue 加總
}

export function buildZoneEventStats(events: ZoneEvent[], conflicts: PlantConflictResult[]): ZoneEventStats {
  return {
    checkedPairCount: conflicts.length,
    abnormalPairCount: conflicts.filter(c => c.judgment === 'conflict' || c.judgment === 'caution').length,
    dangerCount: events.filter(e => e.severity === 'danger').length,
    cautionCount: events.filter(e => e.severity === 'caution').length,
    needsReviewCount: events.filter(e => e.severity === 'needs-review').length,
    mergedEventCount: events.length,
  }
}

// ── 問題群組：同分區＋同根本原因＋同一圖面位置＝一個主要問題群 ───────────────
// buildZoneEvents 產生的是「一配對一事件」的原子單位（正確、保留可追溯性，但
// 27 組配對＝27 張卡片，正文塞不下）。這裡再加一層「群聚」：把同一根本原因下、
// 物理位置相鄰的多筆事件合併成一張群組卡，卡片仍保留涉及的全部配對/植物/位置，
// 只是不再一配對一卡各自展開。

/** 空間群聚的次要合併門檻（公分）——共用植物實例是第一優先合併規則，這個門檻只
 *  在「不共用實例、但中心點夠近」時當備援條件用，刻意保守，避免把不同種植帶
 *  誤合併。 */
export const REPORT_SPATIAL_CLUSTER_THRESHOLD_CM = 300
/** 一個群組允許的最大跨度（公分）——union-find 可能因為 A-B、B-C 各自在門檻內
 *  而鏈式把 A-C 拉進同一群，即使 A-C 本身相距很遠。群聚完成後檢查每群的跨度，
 *  超過這個值就退回「只用共用實例」重新切分，避免一整條植栽帶鏈成一張卡。 */
export const REPORT_SPATIAL_CLUSTER_MAX_DIAMETER_CM = 600

export interface EventGroup {
  id: string                       // "A-01".. 依 maxSeverity 排序指定（danger 優先）
  zoneName: string
  maxSeverity: 'danger' | 'caution'
  primaryBucket: IssueBucketKey
  secondaryBuckets: IssueBucketKey[]
  pairCount: number
  plantInstanceIds: string[]
  plantNames: string[]
  locationCodes: string[]
  sourceConflictIds: string[]
  title: string
  cause: string
  impact: string
  suggestion: string
  diameterCm: number
  /** 這一群是「共用植物實例」合併出來的（不受距離門檻限制，跨度可能較大），
   *  還是「中心點在 300cm 門檻內」合併出來的，或本來就只有一組配對——供事後
   *  追查每個群組的合併依據，不是只留最終結果。 */
  mergeReason: 'shared-instance' | 'distance' | 'single'
  /** mergeReason==='shared-instance' 時，實際被多筆配對共用、觸發合併的植物
   *  實例 ID（例如同一株樹跟好幾個鄰居都衝突）。 */
  sharedInstanceIds: string[]
}

export interface NeedsReviewSummary {
  zoneName: string
  count: number
  reasonSummary: string            // 依 overlapLabel 出現頻率排序組成的一句話摘要
  representatives: ZoneEvent[]     // 3-5 個代表案例，完整清單留給附錄
}

function unionFind(n: number) {
  const parent = Array.from({ length: n }, (_, i) => i)
  function find(x: number): number {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] }
    return x
  }
  function union(a: number, b: number) {
    const ra = find(a), rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }
  return { find, union }
}

function instanceCenterCm(inst: SpatialPlantInstance, cmPerDU: number): { x: number; y: number } {
  return { x: inst.center.x * cmPerDU, y: inst.center.y * cmPerDU }
}

/** 把一組事件（同一 primaryBucket 內）依「共用植物實例」分群，忽略距離——用來
 *  在跨度超標時退回最嚴謹的合併規則，重新切分過度鏈接的群組。 */
function clusterByInstanceOnly(events: ZoneEvent[]): ZoneEvent[][] {
  const { find, union } = unionFind(events.length)
  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      if (events[i].instanceIds.some(id => events[j].instanceIds.includes(id))) union(i, j)
    }
  }
  const groups = new Map<number, ZoneEvent[]>()
  events.forEach((e, i) => {
    const root = find(i)
    const arr = groups.get(root) ?? []
    arr.push(e)
    groups.set(root, arr)
  })
  return [...groups.values()]
}

/** 一群事件所涉及的所有植物實例中心點，計算包絡範圍對角線長度（公分）。 */
function clusterDiameterCm(events: ZoneEvent[], instanceById: Map<string, SpatialPlantInstance>, cmPerDU: number): number {
  const centers = events.flatMap(e => e.instanceIds.map(id => instanceById.get(id)).filter((x): x is SpatialPlantInstance => !!x))
    .map(i => instanceCenterCm(i, cmPerDU))
  if (centers.length === 0) return 0
  const minX = Math.min(...centers.map(c => c.x)), maxX = Math.max(...centers.map(c => c.x))
  const minY = Math.min(...centers.map(c => c.y)), maxY = Math.max(...centers.map(c => c.y))
  return Math.hypot(maxX - minX, maxY - minY)
}

/** 把一個分區的事件（buildZoneEvents 的輸出）依「同分區＋同根本原因＋同一圖面
 *  位置」合併成問題群組，並把 needs-review 事件獨立彙總（不逐項展開成群組卡）。
 *  純函式，輸入相同必產生相同結果。*/
export function clusterZoneEvents(
  zoneName: string,
  events: ZoneEvent[],
  instances: SpatialPlantInstance[],
  unit: DrawingUnit,
): { groups: EventGroup[]; needsReview: NeedsReviewSummary } {
  const cmPerDU = CM_PER_DRAWING_UNIT[unit]
  const instanceById = new Map(instances.map(i => [i.id, i]))
  const normal = events.filter(e => e.severity !== 'needs-review')
  const reviewEvents = events.filter(e => e.severity === 'needs-review')

  // 依 primaryBucket 分桶，只在同一桶內做空間群聚——不同根本原因即使物理位置
  // 相鄰也不合併，避免卡片內混了兩種不相關的問題。
  const byBucket = new Map<IssueBucketKey, ZoneEvent[]>()
  for (const e of normal) {
    const arr = byBucket.get(e.primaryBucket) ?? []
    arr.push(e)
    byBucket.set(e.primaryBucket, arr)
  }

  let rawClusters: ZoneEvent[][] = []
  for (const bucketEvents of byBucket.values()) {
    const { find, union } = unionFind(bucketEvents.length)
    for (let i = 0; i < bucketEvents.length; i++) {
      for (let j = i + 1; j < bucketEvents.length; j++) {
        const ei = bucketEvents[i], ej = bucketEvents[j]
        const sharesInstance = ei.instanceIds.some(id => ej.instanceIds.includes(id))
        if (sharesInstance) { union(i, j); continue }
        const a1 = instanceById.get(ei.instanceIds[0]), a2 = instanceById.get(ei.instanceIds[1])
        const b1 = instanceById.get(ej.instanceIds[0]), b2 = instanceById.get(ej.instanceIds[1])
        if (!a1 || !a2 || !b1 || !b2) continue
        const ci = { x: (a1.center.x + a2.center.x) / 2, y: (a1.center.y + a2.center.y) / 2 }
        const cj = { x: (b1.center.x + b2.center.x) / 2, y: (b1.center.y + b2.center.y) / 2 }
        const distCm = Math.hypot(ci.x - cj.x, ci.y - cj.y) * cmPerDU
        if (distCm <= REPORT_SPATIAL_CLUSTER_THRESHOLD_CM) union(i, j)
      }
    }
    const groupsByRoot = new Map<number, ZoneEvent[]>()
    bucketEvents.forEach((e, i) => {
      const root = find(i)
      const arr = groupsByRoot.get(root) ?? []
      arr.push(e)
      groupsByRoot.set(root, arr)
    })
    rawClusters.push(...groupsByRoot.values())
  }

  // 跨度檢查：鏈式合併可能把 A-B-C 拉成一群，即使 A-C 實際距離很遠——超標的群
  // 退回只用「共用實例」重新切分，這條規則絕不會誤合併不相關的位置。
  const finalClusters: ZoneEvent[][] = []
  for (const cluster of rawClusters) {
    const diameter = clusterDiameterCm(cluster, instanceById, cmPerDU)
    if (diameter <= REPORT_SPATIAL_CLUSTER_MAX_DIAMETER_CM || cluster.length <= 1) {
      finalClusters.push(cluster)
    } else {
      finalClusters.push(...clusterByInstanceOnly(cluster))
    }
  }

  const draftGroups = finalClusters.map((cluster): Omit<EventGroup, 'id'> => {
    const maxSeverity: 'danger' | 'caution' = cluster.some(e => e.severity === 'danger') ? 'danger' : 'caution'
    const bucketCounts = new Map<IssueBucketKey, number>()
    for (const e of cluster) for (const c of e.categories) bucketCounts.set(c, (bucketCounts.get(c) ?? 0) + 1)
    const primaryBucket = cluster[0].primaryBucket
    const secondaryBuckets = [...bucketCounts.keys()].filter(b => b !== primaryBucket)
    const worst = [...cluster].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'danger' ? -1 : 1))[0]

    // 追查合併依據：找出被 ≥2 筆配對共用的植物實例——這些是共用實例合併的「樞紐」。
    // 有的話這一群的合併就是靠共用實例（不受距離門檻限制，跨度可能較大也合理）；
    // 沒有就是純粹靠中心點距離門檻合併；只有一組配對則沒有合併行為。
    const instanceHitCount = new Map<string, number>()
    for (const e of cluster) for (const id of e.instanceIds) instanceHitCount.set(id, (instanceHitCount.get(id) ?? 0) + 1)
    const sharedInstanceIds = [...instanceHitCount.entries()].filter(([, n]) => n >= 2).map(([id]) => id)
    const mergeReason: EventGroup['mergeReason'] =
      cluster.length <= 1 ? 'single' : sharedInstanceIds.length > 0 ? 'shared-instance' : 'distance'

    return {
      zoneName, maxSeverity, primaryBucket, secondaryBuckets,
      pairCount: cluster.length,
      plantInstanceIds: dedupe(cluster.flatMap(e => e.instanceIds)),
      plantNames: dedupe(cluster.flatMap(e => [e.plantAName, e.plantBName])),
      locationCodes: dedupe(cluster.flatMap(e => e.locationLabels)),
      sourceConflictIds: dedupe(cluster.map(e => e.sourcePairId)),
      title: worst.title,
      cause: capText(dedupe(cluster.map(e => e.cause)).join('；'), 80),
      impact: capText(dedupe(cluster.map(e => e.impact)).join('；'), 80),
      suggestion: capText(dedupe(cluster.map(e => e.suggestion)).join('；'), 80),
      diameterCm: Math.round(clusterDiameterCm(cluster, instanceById, cmPerDU)),
      mergeReason, sharedInstanceIds,
    }
  })

  const severityRank: Record<'danger' | 'caution', number> = { danger: 0, caution: 1 }
  const sortedGroups = [...draftGroups].sort((a, b) => severityRank[a.maxSeverity] - severityRank[b.maxSeverity])
  let seq = 1
  const groups = sortedGroups.map(g => ({ ...g, id: `${zonePrefix(zoneName)}-${String(seq++).padStart(2, '0')}` }))

  // needs-review 摘要：不逐項展開成群組卡，只統計原因分布＋3-5 個代表案例
  const labelCounts = new Map<string, number>()
  for (const e of reviewEvents) labelCounts.set(e.overlapLabel, (labelCounts.get(e.overlapLabel) ?? 0) + 1)
  const topLabels = [...labelCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([label]) => label)
  const needsReview: NeedsReviewSummary = {
    zoneName,
    count: reviewEvents.length,
    reasonSummary: topLabels.length > 0 ? `主要原因為${topLabels.join('、')}` : '',
    representatives: reviewEvents.slice(0, 5),
  }

  return { groups, needsReview }
}

// ── 區域層級修正策略（每區 3-5 項，取代逐群組各自的替代方案）───────────────────
const STRATEGY_BY_BUCKET: Partial<Record<IssueBucketKey, string>> = {
  watering: '檢討灌溉分區配置，依水分需求差異調整澆灌迴路',
  drainage: '評估積水敏感植栽是否需替換為耐濕品種，或加強排水層設計',
  sunlight: '確認各區塊實際日照條件，必要時調整植栽配置位置',
  'root-canopy': '確認喬木與下層植栽的上下層關係，評估未來冠幅擴張影響',
  maintenance: '訂定差異化養護計畫，因應植栽間管理需求落差',
  proximity: '現場核實空間鄰近植栽的實際配置關係',
  'data-quality': '補充完整植栽資料來源，降低審查疑義',
}

/** 依這一區實際出現的問題類型，彙整 3-5 項區域層級修正策略——不再對每個問題群
 *  各自生成替代方案，避免「相同的修正方案在每個問題重複生成」。 */
export function buildZoneFixStrategies(groups: EventGroup[], needsReviewCount: number): string[] {
  const bucketsInvolved = new Set<IssueBucketKey>()
  for (const g of groups) { bucketsInvolved.add(g.primaryBucket); g.secondaryBuckets.forEach(b => bucketsInvolved.add(b)) }
  const strategies: string[] = []
  for (const bucket of BUCKET_ORDER) {
    if (bucketsInvolved.has(bucket) && STRATEGY_BY_BUCKET[bucket]) strategies.push(STRATEGY_BY_BUCKET[bucket]!)
  }
  if (needsReviewCount > 0) strategies.push('針對圖層類型無法辨識或無法比對資料庫之項目，進行人工現場或圖面覆核')
  if (strategies.length === 0) strategies.push('維持現有配置，依常規養護計畫執行')
  return strategies.slice(0, 5)
}

// ── 報告呈現分數 ───────────────────────────────────────────────────────────
// 刻意跟即時畫面的 evalResult.score（aggregatePairConflictsToEvalResult 算出來的
// 既有公式）分開——那個公式不會因為 0cm 重疊語意不明而排除計分，這裡是報告層
// 專用、公式透明、且會把扣分依據直接印在報告上的另一套分數，不影響、不取代
// 即時畫面顯示的分數。

export interface ReportScore {
  score: number
  tier: '良好' | '可接受' | '需修正' | '高風險'
  tierNote: string
  reasonLine: string
}

export function computeReportScore(dangerCount: number, cautionCount: number, needsReviewCount: number): ReportScore {
  // 需人工確認的事件連「是否為真衝突」都無法確認（見 classifyOverlap），刻意不計入
  // 扣分──否則光是配對數量一多，即使全案 0 高風險，分數也會被大量「不確定」項目
  // 拖到「高風險」等級，跟卡片本身「不列入高風險或扣分計算」的承諾自相矛盾。
  const score = Math.max(0, Math.min(100, 100 - dangerCount * 12 - cautionCount * 5))
  const tier: ReportScore['tier'] = score >= 80 ? '良好' : score >= 65 ? '可接受' : score >= 50 ? '需修正' : '高風險'
  const tierNote = tier === '良好' ? '配置相容性良好' : tier === '可接受' ? '建議局部改善' : tier === '需修正' ? '建議修正後再提送審查' : '建議重新配置'
  const reasonLine = `主要原因：${dangerCount} 項高風險、${cautionCount} 項一般改善`
    + (needsReviewCount > 0 ? `（另有 ${needsReviewCount} 項需人工確認，不列入評分）` : '')
  return { score, tier, tierNote, reasonLine }
}

// ── SVG 地圖 ───────────────────────────────────────────────────────────────

const ZONE_PALETTE = ['#2563eb', '#7c3aed', '#059669', '#d97706', '#0891b2', '#65a30d', '#db2777', '#4338ca']
export function getZoneColor(index: number): string { return ZONE_PALETTE[index % ZONE_PALETTE.length] }

const SPATIAL_KIND_COLOR: Record<string, string> = {
  'shrub-hatch': '#b45309', 'groundcover-hatch': '#0f766e', 'lawn-hatch': '#65a30d', 'unknown-hatch': '#78716c',
}
export const SPATIAL_KIND_LEGEND: Array<{ kind: string; label: string; color: string }> = [
  { kind: 'tree', label: '喬木冠幅', color: '#4d7c0f' },
  { kind: 'shrub-hatch', label: '灌木', color: SPATIAL_KIND_COLOR['shrub-hatch'] },
  { kind: 'groundcover-hatch', label: '地被', color: SPATIAL_KIND_COLOR['groundcover-hatch'] },
  { kind: 'lawn-hatch', label: '草皮', color: SPATIAL_KIND_COLOR['lawn-hatch'] },
]

type Bounds = { minX: number; maxX: number; minY: number; maxY: number }

function polyBounds(vertices: Array<{ x: number; y: number }>): Bounds {
  const xs = vertices.map(v => v.x), ys = vertices.map(v => v.y)
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}

function polyCentroid(vertices: Array<{ x: number; y: number }>): { x: number; y: number } {
  const n = vertices.length || 1
  return { x: vertices.reduce((s, v) => s + v.x, 0) / n, y: vertices.reduce((s, v) => s + v.y, 0) / n }
}

// 真實 DXF 的 HATCH 填充圖案（crosshatch 等）常常是幾百到幾千個頂點的細密線段組成的
// 輪廓——這裡只是畫一張「大概在哪裡」的示意圖，不是精密測繪圖，直接把全部頂點塞進
// SVG polygon points 屬性會讓報告 HTML 字串暴增到幾十萬字元（實測單一分區地圖曾達
// 80 萬字元），拖慢 html2canvas 截圖甚至讓分頁量測失真。均勻抽樣壓到有限點數，形狀
// 精確度對這張示意圖的用途來說綽綽有餘。
function simplifyRing(points: Array<{ x: number; y: number }>, maxPoints = 120): Array<{ x: number; y: number }> {
  if (points.length <= maxPoints) return points
  const step = points.length / maxPoints
  const out: Array<{ x: number; y: number }> = []
  for (let i = 0; i < maxPoints; i++) out.push(points[Math.floor(i * step)])
  return out
}
function ringToPoints(points: Array<{ x: number; y: number }>): string {
  return simplifyRing(points).map(v => `${v.x},${v.y}`).join(' ')
}

// reportHtml 是用 innerHTML= 塞進 detached <div>（不是 React），<svg> 一定要給明確的
// width/height 像素屬性——只給 viewBox 在這個情境下可能量到 0 高度，讓分頁引擎的
// offsetHeight 量測（pdfCanvasExport.ts）把地圖壓成一條線。
function fitDims(aspect: number, maxW: number, maxH: number): { w: number; h: number } {
  let w = maxW
  let h = w / Math.max(aspect, 0.01)
  if (h > maxH) { h = maxH; w = h * aspect }
  return { w: Math.max(Math.round(w), 120), h: Math.max(Math.round(h), 90) }
}

export interface ZoneMapSummary { zoneName: string; score?: number; dangerCount: number; cautionCount: number; needsReviewCount: number }

function severityColor(sev: EventSeverity): string {
  return sev === 'danger' ? '#dc2626' : sev === 'caution' ? '#d97706' : '#ca8a04'
}
export function severityLabel(sev: EventSeverity): string {
  return sev === 'danger' ? '高風險' : sev === 'caution' ? '一般改善' : '需人工確認'
}

/** 全案分區總覽：所有分區邊界依調色盤上色，dangerCount>0 的分區改用醒目紅色粗框線。
 *  回傳完整 <svg> 字串；沒有任何分區有可用 boundary 時回傳 null，呼叫端降級只顯示圖例表。*/
export function buildZoneOverviewMapSvg(zones: DetectedZone[], summaries: ZoneMapSummary[], widthPx = 700): string | null {
  const withBoundary = zones
    .map((z, i) => ({ z, i }))
    .filter(({ z }) => z.boundary && z.boundary.vertices.length >= 3)
  if (withBoundary.length === 0) return null

  const allVerts = withBoundary.flatMap(({ z }) => z.boundary!.vertices)
  const b = polyBounds(allVerts)
  const spanX = Math.max(b.maxX - b.minX, 1)
  const spanY = Math.max(b.maxY - b.minY, 1)
  const pad = Math.max(spanX, spanY) * 0.05
  const viewMinX = b.minX - pad, viewMinY = b.minY - pad
  const viewW = spanX + pad * 2, viewH = spanY + pad * 2
  const scaleUnit = Math.max(viewW, viewH, 1)
  const { w: pxW, h: pxH } = fitDims(viewW / viewH, widthPx, 520)

  const summaryByName = new Map(summaries.map(s => [s.zoneName, s]))

  const shapes = withBoundary.map(({ z, i }) => {
    const color = getZoneColor(i)
    const summary = summaryByName.get(z.name)
    const highRisk = (summary?.dangerCount ?? 0) > 0
    const stroke = highRisk ? '#dc2626' : color
    const strokeW = highRisk ? scaleUnit * 0.006 : scaleUnit * 0.0025
    const points = ringToPoints(z.boundary!.vertices)
    const centroid = polyCentroid(z.boundary!.vertices)
    const labelX = z.labelPosition?.x ?? centroid.x
    const labelY = z.labelPosition?.y ?? centroid.y
    const fontSize = scaleUnit * 0.028
    return `
      <polygon points="${points}" fill="${color}" fill-opacity="0.16" stroke="${stroke}" stroke-width="${strokeW}"/>
      <g transform="translate(${labelX},${labelY}) scale(1,-1)">
        <text font-size="${fontSize}" fill="${color}" font-weight="700" text-anchor="middle" font-family="'Microsoft JhengHei','Noto Sans TC',sans-serif">${escHtml(z.name)}${summary?.score !== undefined ? ` (${summary.score})` : ''}</text>
      </g>`
  }).join('')

  return `<svg width="${pxW}" height="${pxH}" viewBox="${viewMinX} ${viewMinY} ${viewW} ${viewH}" xmlns="http://www.w3.org/2000/svg" style="background:#f7faf5;border:1px solid #d4e8d4;border-radius:10px">
    <g transform="translate(0, ${2 * viewMinY + viewH}) scale(1,-1)">${shapes}</g>
  </svg>`
}

/** 單一分區局部圖：依 zone.boundary bbox 裁切＋10% 邊界留白，本區原色顯示、其他
 *  分區灰階淡化，喬木畫冠幅圓、HATCH 畫多邊形，問題標記（編號圓點）釘在對應
 *  SpatialPlantInstance 位置。allZones 傳完整陣列（含本區自己），內部過濾出「其他
 *  區域」並依本區在陣列中的 index 決定跟總覽圖一致的顏色。zoneBoundary 缺失時退回
 *  本區 spatialInstances 的聯集 bbox；兩者都沒有則回傳 null。*/
export function buildZoneLocalMapSvg(opts: {
  zoneName: string
  zoneBoundary?: DxfPolygon
  allZones: DetectedZone[]
  instances: SpatialPlantInstance[]
  groups: EventGroup[]
  widthPx?: number
  maxHeightPx?: number
}): string | null {
  const { zoneName, zoneBoundary, allZones, instances, groups, widthPx = 700, maxHeightPx = 420 } = opts

  let b: Bounds
  if (zoneBoundary && zoneBoundary.vertices.length >= 3) {
    b = polyBounds(zoneBoundary.vertices)
  } else if (instances.length > 0) {
    const pts = instances.flatMap(i => i.polygonRings?.[0] ?? [i.center])
    b = polyBounds(pts.length > 0 ? pts : instances.map(i => i.center))
  } else {
    return null
  }

  const spanX = Math.max(b.maxX - b.minX, 1)
  const spanY = Math.max(b.maxY - b.minY, 1)
  const padX = spanX * 0.10, padY = spanY * 0.10
  const viewMinX = b.minX - padX, viewMinY = b.minY - padY
  const viewW = spanX + padX * 2, viewH = spanY + padY * 2
  const scaleUnit = Math.max(viewW, viewH, 1)
  const { w: pxW, h: pxH } = fitDims(viewW / viewH, widthPx, maxHeightPx)

  const zoneIndex = allZones.findIndex(z => z.name === zoneName)
  const thisColor = zoneIndex >= 0 ? getZoneColor(zoneIndex) : '#1a4731'

  const viewBounds = { minX: viewMinX, maxX: viewMinX + viewW, minY: viewMinY, maxY: viewMinY + viewH }
  const inView = (bbox: Bounds) =>
    !(bbox.maxX < viewBounds.minX || bbox.minX > viewBounds.maxX || bbox.maxY < viewBounds.minY || bbox.minY > viewBounds.maxY)

  const otherZonesSvg = allZones
    .filter(z => z.name !== zoneName && z.boundary && z.boundary.vertices.length >= 3)
    .filter(z => inView(polyBounds(z.boundary!.vertices)))
    .map(z => `<polygon points="${ringToPoints(z.boundary!.vertices)}" fill="#d6d3d1" fill-opacity="0.28" stroke="#a8a29e" stroke-width="${scaleUnit * 0.002}"/>`)
    .join('')

  const boundarySvg = zoneBoundary && zoneBoundary.vertices.length >= 3
    ? `<polygon points="${ringToPoints(zoneBoundary.vertices)}" fill="${thisColor}" fill-opacity="0.14" stroke="${thisColor}" stroke-width="${scaleUnit * 0.004}"/>`
    : ''

  const instancesSvg = instances.filter(inst => inView(inst.bbox)).map(inst => {
    if (inst.kind === 'tree') {
      const r = Math.max(inst.canopyRadius ?? scaleUnit * 0.01, scaleUnit * 0.006)
      return `<circle cx="${inst.center.x}" cy="${inst.center.y}" r="${r}" fill="#4d7c0f" fill-opacity="0.30" stroke="#3f6212" stroke-width="${scaleUnit * 0.0015}"/>`
    }
    if (inst.polygonRings?.[0]) {
      const color = SPATIAL_KIND_COLOR[inst.kind] ?? '#78716c'
      const points = ringToPoints(inst.polygonRings[0])
      return `<polygon points="${points}" fill="${color}" fill-opacity="0.22" stroke="${color}" stroke-width="${scaleUnit * 0.0015}"/>`
    }
    return ''
  }).join('')

  // 問題標記：一個問題群＝可能涉及多個植物實例，每個實例畫一個依嚴重度上色的
  // 圓點，群內實例之間用虛線連接，群組代碼（只印代碼，不印完整標題——圖面版面
  // 有限，長句只會疊成一團看不清楚，完整說明留給正文問題清單）印在群組重心一次。
  // 文字要再包一層局部反轉（translate 到定位點後 scale(1,-1)），讓標記位置吃到
  // 外層 Y 翻轉、但文字本身維持正立，不然會上下顛倒。
  const markerR = scaleUnit * 0.014
  const labelFontSize = scaleUnit * 0.024
  const instanceById = new Map(instances.map(i => [i.id, i]))
  const markersSvg = groups.flatMap(g => {
    const pts = g.plantInstanceIds
      .map(id => instanceById.get(id))
      .filter((x): x is SpatialPlantInstance => !!x && inView(x.bbox))
    if (pts.length === 0) return []
    const color = severityColor(g.maxSeverity)
    const parts: string[] = pts.map(inst =>
      `<circle cx="${inst.center.x}" cy="${inst.center.y}" r="${markerR}" fill="${color}" stroke="#fff" stroke-width="${markerR * 0.2}"/>`)
    const centroidX = pts.reduce((s, i) => s + i.center.x, 0) / pts.length
    const centroidY = pts.reduce((s, i) => s + i.center.y, 0) / pts.length
    // 群內每個實例都連一條虛線回重心，數量一多看起來像放射狀分佈圖，直覺呈現
    // 「這些位置屬於同一個問題群」，比兩兩互連更不會糊成一片。
    for (const inst of pts) {
      parts.push(`<line x1="${inst.center.x}" y1="${inst.center.y}" x2="${centroidX}" y2="${centroidY}" stroke="${color}" stroke-width="${scaleUnit * 0.0015}" stroke-dasharray="${scaleUnit * 0.008} ${scaleUnit * 0.005}" opacity="0.5"/>`)
    }
    const labelText = g.id
    const labelW = labelText.length * labelFontSize * 0.7 + labelFontSize
    parts.push(`
      <g transform="translate(${centroidX},${centroidY}) scale(1,-1)">
        <rect x="${-labelW / 2}" y="${markerR * 1.3}" width="${labelW}" height="${labelFontSize * 1.6}" rx="${labelFontSize * 0.4}" fill="${color}" opacity="0.92"/>
        <text x="0" y="${markerR * 1.3 + labelFontSize * 1.15}" font-size="${labelFontSize}" fill="#fff" text-anchor="middle" font-weight="700" font-family="'Microsoft JhengHei','Noto Sans TC',sans-serif">${escHtml(labelText)}</text>
      </g>`)
    return parts
  }).join('')

  return `<svg width="${pxW}" height="${pxH}" viewBox="${viewMinX} ${viewMinY} ${viewW} ${viewH}" xmlns="http://www.w3.org/2000/svg" style="background:#f7faf5;border:1px solid #d4e8d4;border-radius:10px">
    <g transform="translate(0, ${2 * viewMinY + viewH}) scale(1,-1)">
      ${otherZonesSvg}${boundarySvg}${instancesSvg}${markersSvg}
    </g>
  </svg>`
}

/** 重點位置放大圖：只給優先修正清單前幾筆高風險事件用，不是每張事件卡都做——
 *  裁切範圍只取這個事件涉及的兩個實例聯集 bbox＋30% 留白，比全區地圖更貼近細節。
 *  沿用 DrawingLocatorModal.tsx 已驗證過的「兩實例＋其他淡化」畫法。*/
export function buildEventZoomSvg(event: ZoneEvent, instances: SpatialPlantInstance[], widthPx = 320): string | null {
  const a = instances.find(i => i.id === event.instanceIds[0])
  const b = instances.find(i => i.id === event.instanceIds[1])
  if (!a || !b) return null

  const unionMinX = Math.min(a.bbox.minX, b.bbox.minX), unionMaxX = Math.max(a.bbox.maxX, b.bbox.maxX)
  const unionMinY = Math.min(a.bbox.minY, b.bbox.minY), unionMaxY = Math.max(a.bbox.maxY, b.bbox.maxY)
  const spanX = Math.max(unionMaxX - unionMinX, 1), spanY = Math.max(unionMaxY - unionMinY, 1)
  const localScale = Math.max(spanX, spanY, 1)
  const pad = localScale * 0.35
  const viewMinX = unionMinX - pad, viewMinY = unionMinY - pad
  const viewW = spanX + pad * 2, viewH = spanY + pad * 2
  const { w: pxW, h: pxH } = fitDims(viewW / viewH, widthPx, widthPx)

  const viewBounds = { minX: viewMinX, maxX: viewMinX + viewW, minY: viewMinY, maxY: viewMinY + viewH }
  const others = instances.filter(i => i.id !== a.id && i.id !== b.id).filter(i =>
    !(i.bbox.maxX < viewBounds.minX || i.bbox.minX > viewBounds.maxX || i.bbox.maxY < viewBounds.minY || i.bbox.minY > viewBounds.maxY))

  const renderInst = (inst: SpatialPlantInstance, fill: string, stroke: string, sw: number) => {
    if (inst.kind === 'tree') {
      const r = Math.max(inst.canopyRadius ?? localScale * 0.02, localScale * 0.01)
      return `<circle cx="${inst.center.x}" cy="${inst.center.y}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`
    }
    if (inst.polygonRings?.[0]) return `<polygon points="${ringToPoints(inst.polygonRings[0])}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`
    return ''
  }

  const color = severityColor(event.severity)
  const dimSvg = others.map(i => renderInst(i, '#d6d3d1', '#a8a29e', localScale * 0.004)).join('')
  const shapeA = renderInst(a, `${color}66`, color, localScale * 0.012)
  const shapeB = renderInst(b, `${color}66`, color, localScale * 0.012)
  const lineSvg = `<line x1="${a.center.x}" y1="${a.center.y}" x2="${b.center.x}" y2="${b.center.y}" stroke="${color}" stroke-width="${localScale * 0.006}" stroke-dasharray="${localScale * 0.02} ${localScale * 0.012}"/>`

  return `<svg width="${pxW}" height="${pxH}" viewBox="${viewMinX} ${viewMinY} ${viewW} ${viewH}" xmlns="http://www.w3.org/2000/svg" style="background:#fff;border:2px solid ${color};border-radius:8px">
    <g transform="translate(0, ${2 * viewMinY + viewH}) scale(1,-1)">
      ${dimSvg}${shapeA}${shapeB}${lineSvg}
    </g>
  </svg>`
}

// ── 事件對應的替代／修正方案（每個事件最多 2-3 個方案，不是一長串資料庫輸出）──
// severity==='needs-review' 的事件因為連「是否為真衝突」都不確定，不硬塞植物
// 替代建議，改成「人工現場或圖面覆核」這類確認選項。

export interface AlternativeOption {
  planLabel: string
  recommendedPlant?: string
  reason: string
  improvedIssue: string
  newRiskNote: string
}

const PLAN_LABELS = ['方案一', '方案二', '方案三']

export function buildEventAlternatives(
  event: ZoneEvent,
  alternatives: AltSuggestion[],
): AlternativeOption[] {
  if (event.severity === 'needs-review') {
    return [
      {
        planLabel: `${PLAN_LABELS[0]}｜人工現場或圖面覆核`,
        reason: event.overlapLabel,
        improvedIssue: '確認是否為刻意配置或圖面繪製誤差',
        newRiskNote: '覆核前不建議逕行調整或替換植栽，避免影響原設計意圖。',
      },
      {
        planLabel: `${PLAN_LABELS[1]}｜補充圖說標註`,
        reason: '若確認為刻意上下層或密植配置，屬合理設計手法',
        improvedIssue: '降低審查委員對圖面標示不清的疑義',
        newRiskNote: '無新增風險，僅為圖說補充，不涉及植栽調整。',
      },
    ]
  }

  const improvedIssueLabel = dedupe(event.categories.map(c => BUCKET_LABEL[c])).join('、') || '整體相容性'
  // AltSuggestion.originalPlant.instanceId 是 uid() 隨機值，跟 SpatialPlantInstance.id
  // 無關──只能靠植物名稱字串比對回這個事件涉及的哪一株。
  const relevantSuggs = alternatives.filter(s => s.originalPlant.name === event.plantAName || s.originalPlant.name === event.plantBName)

  const options: AlternativeOption[] = []
  for (const sugg of relevantSuggs) {
    for (const alt of sugg.alternatives.slice(0, 2)) {
      if (options.length >= 3) break
      options.push({
        planLabel: `${PLAN_LABELS[options.length]}｜替換「${sugg.originalPlant.name}」為「${alt.plant.name}」`,
        recommendedPlant: alt.plant.name,
        reason: alt.reason,
        improvedIssue: improvedIssueLabel,
        newRiskNote: '建議施工前確認新植栽與周邊植物之相容性。',
      })
    }
    if (options.length >= 3) break
  }
  if (options.length < 3) {
    options.push({
      planLabel: `${PLAN_LABELS[options.length]}｜調整種植位置或改分區灌溉`,
      reason: '不更換植栽，改以配置調整降低衝突',
      improvedIssue: improvedIssueLabel,
      newRiskNote: '需先確認基地條件允許調整種植位置或灌溉分區。',
    })
  }
  if (options.length === 0) {
    return [{
      planLabel: `${PLAN_LABELS[0]}｜人工確認`,
      reason: '目前資料庫無適合之替代植栽建議',
      improvedIssue: improvedIssueLabel,
      newRiskNote: '建議由設計者依現場條件另行研議調整方案。',
    }]
  }
  return options
}

// ── 分區短結論 ─────────────────────────────────────────────────────────────

export function buildShortZoneConclusion(zoneName: string, stats: ZoneEventStats, reportScore: ReportScore): string {
  const scoreNote = `（評分 ${reportScore.score}/100，${reportScore.tier}）`
  if (stats.mergedEventCount === 0) {
    return `${zoneName}整體配置相容性良好${scoreNote}，未發現需優先調整之問題項目，建議維持現有配置並依常規養護計畫執行。`
  }
  if (stats.dangerCount > 0) {
    return `${zoneName}評估發現 ${stats.dangerCount} 項高風險問題、${stats.cautionCount} 項一般改善、${stats.needsReviewCount} 項需人工確認${scoreNote}，建議優先處理標號較前之高風險項目後再提送審查，以降低審查往返次數。`
  }
  return `${zoneName}整體配置可行${scoreNote}，惟有 ${stats.cautionCount} 項事項需補充說明、${stats.needsReviewCount} 項需人工確認，建議於施工說明書中補充對應之養護／設計調整方案。`
}

// ── 技術附錄（逐對明細，不計入主報告頁數） ─────────────────────────────────

export function buildTechnicalAppendixHtml(zoneReviews: Array<{
  zoneName: string
  proximityConflicts: PlantConflictResult[]
  treeInventory: TreeInventoryItem[]
  evalResult?: EvalResult
  groups: EventGroup[]              // 供附錄標示每筆原始配對所屬的群組代碼，維持可追溯性
}>): string {
  const zoneBlocks = zoneReviews.map(r => {
    const conflicts = r.proximityConflicts ?? []
    const treeInventory = r.treeInventory ?? []
    // 附錄改用跟主報告同一份事件卡（buildZoneEvents，一配對一事件，不再拆成
    // 「一配對 x 每種問題類型」各一張卡）——舊版附錄完全沒套用事件整併，41 組配對
    // 因為平均每組有 2-3 種問題類型，展開成近百張完整卡片，是報告暴增到 80 幾頁
    // 的主因。這裡進一步改成單列一事件的密集表格（不是卡片），技術查證要的是
    // HATCH/BLOCK ID、距離、判定這些事實，不需要重複主報告已經印過的完整敘述。
    const events = buildZoneEvents(r.zoneName, conflicts)
    // conflictId → 所屬群組代碼（正文頁的群組卡把哪些原始配對併進去了），讓附錄
    // 能回追到正文；不在任何群組（needs-review）的就標示「需人工確認」。
    const conflictToGroup = new Map<string, string>()
    for (const g of r.groups) for (const cid of g.sourceConflictIds) conflictToGroup.set(cid, g.id)
    // 單一 <table> 對分頁引擎來說是不可切割的整塊，列數一多整張表可能比一頁還高。
    // 實測這張 9 欄表格每列約 85-90px（「問題類型」「結論」欄位中文常常折成 2-3
    // 行），25 列一張仍會超過單頁可用高度（約 950-1100px），拆成每 10 列一張才安全。
    const eventChunks = chunk(events, 10)
    return `
  <div class="sec-hdr">${escHtml(r.zoneName)}　逐對配對明細（共 ${conflicts.length} 組，整併為 ${r.groups.length} 個問題群）</div>
  <div class="sec-body">
    ${eventChunks.length > 0 ? eventChunks.map(rows => `
    <table style="table-layout:fixed">
      <colgroup><col style="width:8%"><col style="width:8%"><col style="width:11%"><col style="width:11%"><col style="width:12%"><col style="width:9%"><col style="width:9%"><col style="width:14%"><col style="width:18%"></colgroup>
      <thead><tr><th>編號</th><th>所屬群組</th><th>植物 A</th><th>植物 B</th><th>HATCH／BLOCK</th><th>距離／關係</th><th>風險</th><th>問題類型</th><th>結論</th></tr></thead>
      <tbody>${rows.map(ev => `
      <tr><td><strong style="color:${severityColor(ev.severity)}">${escHtml(ev.id)}</strong></td>
      <td style="font-weight:700">${escHtml(conflictToGroup.get(ev.sourcePairId) ?? '需人工確認')}</td>
      <td>${escHtml(ev.plantAName)}</td><td>${escHtml(ev.plantBName)}</td>
      <td style="font-family:monospace;font-size:11px;word-break:break-all">${escHtml(ev.locationLabels.join('／'))}</td>
      <td style="font-size:11px">${ev.distanceCm !== null ? `${ev.distanceCm} cm` : escHtml(ev.overlapLabel)}</td>
      <td style="color:${severityColor(ev.severity)};font-weight:700">${escHtml(severityLabel(ev.severity))}</td>
      <td style="font-size:11px">${ev.categories.length > 0 ? escHtml(ev.categories.map(c => BUCKET_LABEL[c]).join('、')) : '—'}</td>
      <td style="font-size:11px">${escHtml(ev.title)}</td></tr>`).join('')}</tbody>
    </table>`).join('') : `<p style="color:#78716c;font-size:13px">本分區無逐對衝突配對資料。</p>`}
    ${treeInventory.length > 0 ? `
    <div class="no-break" style="margin-top:16px">
      <div style="font-size:14px;font-weight:700;color:#1a4731;margin-bottom:8px">喬木盤點</div>
      <table>
        <thead><tr><th>樹種</th><th>株數</th><th>最近株距(cm)</th><th>冠幅重疊處</th><th>遮蔭下層數</th></tr></thead>
        <tbody>${treeInventory.map(t => `
        <tr><td>${escHtml(t.plantName)}</td><td style="text-align:right">${t.count}</td>
        <td style="text-align:right">${t.minSpacingCm ?? '—'}</td>
        <td style="text-align:right">${t.canopyOverlapCount}</td>
        <td style="text-align:right">${t.shadedUnderstory.length}</td></tr>`).join('')}</tbody>
      </table>
    </div>` : ''}
  </div>`
  }).join('')

  return `
  <div class="appendix-divider page-break">技術附錄（逐對明細，僅供工程查證）</div>
  ${zoneBlocks}`
}
