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
  SpatialInstanceKind, ProximityLevel, DrawingUnit, LayerOverrideAction,
} from '@/types/dxf'
import type { AltSuggestion, EvalResult } from '@/utils/plantEvaluator'
import { deriveConclusion } from '@/utils/issueCategoryMeta'
import { CM_PER_DRAWING_UNIT } from '@/utils/zoneStatistics'
import { layerOverrideKey } from '@/utils/plantProximity'

// ── 共用格式化 helper ──────────────────────────────────────────────────────

export function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function zonePrefix(zoneName: string): string {
  return zoneName.charAt(0) || 'Z'
}

export function scoreColor(score?: number): string {
  return score === undefined ? '#78716c' : score >= 80 ? '#15803d' : score >= 60 ? '#2563eb' : '#dc2626'
}

export type ZoneReviewStatusLike = '可審查' | '植物待確認' | '無法審查'
export function statusColor(status: ZoneReviewStatusLike): string {
  return status === '可審查' ? '#15803d' : status === '植物待確認' ? '#2563eb' : '#dc2626'
}

// 嚴重＝紅、提醒＝藍、通過＝綠（見 src/utils/compatibilityLevels.ts）
export function riskLevelLabel(lv: string): string {
  return lv === 'high' ? '嚴重' : lv === 'medium' ? '提醒' : lv === 'low' ? '通過' : '未辨識'
}
export function riskLevelColor(lv: string): string {
  return lv === 'high' ? '#dc2626' : lv === 'medium' ? '#2563eb' : lv === 'low' ? '#15803d' : '#78716c'
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

/** 供其他頁面（如 LandscapeAdvisorPage.tsx 的「AI 審查回覆」摘要）重用同一套
 *  「0cm／重疊語意」判斷，避免兩個地方各自維護一份不一致的分類規則。
 *
 *  產品規則（比前一輪更嚴格）：灌木／地被／草皮之間的 HATCH 或範圍重疊，一律
 *  預設視為正常景觀配置——複層植栽、混植、群植、片植、自然式邊界都會讓圖面上
 *  的種植範圍互相交錯或局部重疊，這是設計常態，不是異常。不管重疊面積、重疊
 *  比例多高、邊界形狀多不規則，都不能單憑「幾何有重疊」這件事本身判定為問題
 *  或人工確認——不設任何重疊比例門檻（3%、10%……都不設），因為「重疊比例」
 *  這個訊號本身就無法分辨是刻意設計還是真的異常，設門檻只是把猜測包裝成數字。
 *
 *  喬木完全不會走到這裡——plantProximity.ts 在配對產生階段已經用畫法（kind）
 *  與比對到的植物分類（normalizedCategory）雙重排除喬木，這個函式收到的
 *  aKind/bKind 恆為 shrub-hatch／groundcover-hatch／lawn-hatch／unknown-hatch。
 *
 *  真正保留人工確認的只剩「圖層類型無法辨識」（unknown-hatch，見下方）—— 這是
 *  資料辨識問題，不是幾何重疊問題。使用者要求保留的其他幾類真異常（HATCH 疑似
 *  重複建立／同一 HATCH 被重複計入統計／植栽與硬鋪面車道建築設備禁止種植區
 *  衝突／同一範圍標示互斥地表類別／HATCH 幾何破損或跨越錯誤分區／圖層類別與
 *  植物資料矛盾）目前系統沒有對應的圖層辨識、硬鋪面資料或幾何驗證能力，誠實
 *  不做假偵測——要做這些，需要先確認資料來源（例如圖面要有硬鋪面／車道／
 *  設備專屬圖層，且要有幾何自我相交／面積異常的驗證邏輯），不是這裡能直接
 *  生出來的判斷。 */
export function classifyOverlap(aKind: SpatialInstanceKind, bKind: SpatialInstanceKind, proximity: ProximityLevel): OverlapNote {
  if (proximity === 'touching') return { label: '邊界接觸', certain: true }
  if (proximity !== 'overlap') return { label: '鄰近', certain: true }
  if (aKind === 'unknown-hatch' || bKind === 'unknown-hatch')
    return { label: '圖層類型無法辨識，需人工確認', certain: false }
  return { label: '複層／混植配置，屬常見景觀設計手法', certain: true }
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

// ── 人工確認來源分組（取代逐筆配對計數）─────────────────────────────────────────
// 使用者原話：「23 筆配對若都來自同一個未知 HATCH 圖層，只應顯示 1 個未知圖層待
// 確認，影響 23 組配對」。合併 key＝zone+unknownSourceType+layerName+blockName+
// unknownReason（blockName 目前恆為「—」：HATCH 沒有 BLOCK，這裡誠實揭露資料
// 本身的限制，不是漏做）。原本只在 LandscapeAdvisorPage.tsx 的「AI 審查回覆」用，
// 這裡搬成共用函式，供 DxfReviewPage.tsx 的「人工確認」分頁直接重用同一套分組
// 與批次分類邏輯，不重新發明一套判斷規則。
//
// 只剩 2 種允許出現「人工確認」的情況，直接對應底下的 unknownSourceType：
//   unknown-hatch    → 圖層或圖塊歸屬不明（資料辨識問題，不是幾何重疊問題）
//   unmatched-name   → 植物名稱無法辨識
// 灌木／地被／草皮之間單純的 HATCH 或範圍重疊（不管是不是同類型、同物種）一律
// 視為正常景觀配置，見 classifyOverlap()，不會再產生來源分組——上一輪還留著
// 的 layered-planting／same-kind-overlap／generic-overlap 三種來源類型已完全
// 移除（不是只在 UI 隱藏，是底層 classifyOverlap 根本不會再回傳 certain:false
// 讓它們有機會被建立）。
// 一般日照／耐旱／耐濕等級差距（gapSeverity 已判定為 caution/danger）不會進到這裡
// ——它們有明確判斷依據，走「審查問題」分頁的正常問題卡，不是「無法判斷」。
export type UnknownSourceType = 'unknown-hatch' | 'unmatched-name'

export interface UnknownSourceGroup {
  key: string
  zoneName: string
  unknownSourceType: UnknownSourceType
  layerName: string
  blockName: string
  unknownReason: string
  pairCount: number
  // 只有「單一具體圖層」的 unknown-hatch 來源才能安全套用批次分類按鈕——
  // unmatched-name 是「純粹名稱比對不到」，沒有單一圖層可以重新分類，批次
  // 按鈕對它沒有意義，只顯示摘要。
  singleLayer: boolean
  overrideApplied?: LayerOverrideAction
  /** 涉及分區與植物──供卡片直接顯示「涉及分區與植物」欄位，不用呼叫端另外算 */
  plantNames: string[]
  /** 代表性的圖面定位標籤（種植區塊代號），最多列前 5 個，供「圖面定位」欄位使用 */
  locationLabels: string[]
  /** 代表性的植物實例 id（第一筆配對的兩個實例），供「查看位置」按鈕直接定位 */
  representativeInstanceIds: [string, string]
}

export const UNKNOWN_SOURCE_TYPE_LABEL: Record<UnknownSourceType, string> = {
  'unknown-hatch': '未知圖層',
  'unmatched-name': '名稱未比對',
}

/** 「需要確認的具體事項」──比 UNKNOWN_SOURCE_TYPE_LABEL 更完整的一句話，對應
 *  使用者要求的允許出現人工確認的情況說明，只給 DxfReviewPage 的人工確認
 *  分頁用（LandscapeAdvisorPage 既有「AI 審查回覆」維持原本的短標籤，不動）。*/
export const UNKNOWN_SOURCE_WHY_LABEL: Record<UnknownSourceType, string> = {
  'unknown-hatch': '圖層或圖塊歸屬不明：此 HATCH 圖層未能對應到植栽索引表，系統無法判斷屬於灌木、地被或草皮',
  'unmatched-name': '植物名稱無法辨識：至少一方名稱未能比對到植栽資料庫，無法判斷相容性',
}

export function buildUnknownSourceGroups(
  zoneName: string,
  conflicts: PlantConflictResult[],
  overrides?: Map<string, LayerOverrideAction>,
): UnknownSourceGroup[] {
  const groups = new Map<string, UnknownSourceGroup>()
  for (const c of conflicts) {
    let sourceType: UnknownSourceType
    let layerName = '—'
    let reason: string
    if (c.riskLevel === 'unmatched') {
      sourceType = 'unmatched-name'
      reason = '植物名稱未能比對資料庫'
    } else {
      const note = classifyOverlap(c.plantA.kind, c.plantB.kind, c.proximity)
      // certain:true＝灌木／地被／草皮之間的 HATCH 或範圍重疊，一律視為正常景觀
      // 配置（複層／混植／群植／片植／自然式邊界，見 classifyOverlap 上方說明），
      // 跳過不建立來源分組。走到這裡唯一還會是 certain:false 的情況只剩「圖層
      // 類型無法辨識」（unknown-hatch），不再有幾何重疊本身觸發的人工確認。
      if (note.certain) continue
      reason = note.label
      const aUnknown = c.plantA.kind === 'unknown-hatch'
      const bUnknown = c.plantB.kind === 'unknown-hatch'
      sourceType = 'unknown-hatch'
      const layers = dedupe(
        [aUnknown ? c.plantA.sourceLayer : undefined, bUnknown ? c.plantB.sourceLayer : undefined]
          .filter((x): x is string => !!x),
      )
      layerName = layers.length > 0 ? layers.join('／') : '(無圖層名稱)'
    }
    const key = `${zoneName}::${sourceType}::${layerName}::—::${reason}`
    const existing = groups.get(key)
    if (existing) {
      existing.pairCount++
      if (existing.plantNames.length < 8) existing.plantNames = dedupe([...existing.plantNames, c.plantA.name, c.plantB.name])
      if (existing.locationLabels.length < 5) existing.locationLabels = dedupe([...existing.locationLabels, c.plantA.label, c.plantB.label]).slice(0, 5)
      continue
    }
    const singleLayer = sourceType === 'unknown-hatch' && layerName !== '(無圖層名稱)' && !layerName.includes('／')
    groups.set(key, {
      key, zoneName, unknownSourceType: sourceType, layerName, blockName: '—', unknownReason: reason,
      pairCount: 1, singleLayer,
      overrideApplied: singleLayer ? overrides?.get(layerOverrideKey(zoneName, layerName)) : undefined,
      plantNames: dedupe([c.plantA.name, c.plantB.name]),
      locationLabels: dedupe([c.plantA.label, c.plantB.label]),
      representativeInstanceIds: [c.plantA.instanceId, c.plantB.instanceId],
    })
  }
  return [...groups.values()].sort((a, b) => b.pairCount - a.pairCount)
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
  /** 截到 60 字，給 PDF 固定版面用。互動網頁改用下面的 *Full 版本（未截斷）。 */
  cause: string
  impact: string
  suggestion: string
  causeFull: string
  impactFull: string
  suggestionFull: string
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
        causeFull: `${conflict.plantA.name} 與 ${conflict.plantB.name} 空間${proximityLabel(conflict)}，惟至少一方植物名稱未能比對資料庫，無法判斷相容性。`,
        impactFull: '無法確認是否存在生長習性衝突，建議人工核實植物品種後再評估。',
        suggestionFull: '請設計者確認植物名稱與圖例對照，並於必要時補充至植栽資料庫。',
        needsReviewNote: '植物名稱無法比對資料庫',
      }
    }
    const categories = dedupe(conflict.issues.map(i => CATEGORY_TO_BUCKET[i.category] ?? 'maintenance'))
    const rawSeverity: 'danger' | 'caution' = conflict.issues.some(i => i.level === 'danger') ? 'danger' : 'caution'
    const severity = finalizeSeverity(rawSeverity, overlap)
    const worst = conflict.issues.find(i => i.level === 'danger') ?? conflict.issues[0]
    const primaryBucket = CATEGORY_TO_BUCKET[worst.category] ?? 'maintenance'
    const causeJoined = dedupe(conflict.issues.map(i => i.cause)).join('；')
    const impactJoined = dedupe(conflict.issues.map(i => i.impact)).join('；')
    const suggestionJoined = dedupe(conflict.issues.map(i => i.suggestion)).join('；')
    return {
      ...base, severity, categories, primaryBucket,
      title: deriveConclusion(worst.cause),
      cause: capText(causeJoined, 60),
      impact: capText(impactJoined, 60),
      suggestion: capText(suggestionJoined, 60),
      causeFull: causeJoined,
      impactFull: impactJoined,
      suggestionFull: suggestionJoined,
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
  /** 截到 80 字，給 PDF 固定版面用（見 handleExportZonePdf）。互動網頁不受紙本
   *  版面限制，不要用這幾個欄位——改用下面對應的 *Full 版本（未截斷）。 */
  cause: string
  impact: string
  suggestion: string
  /** 未截斷的完整文字，給互動網頁的 MergedIssueCard 用。 */
  causeFull: string
  impactFull: string
  suggestionFull: string
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
      causeFull: dedupe(cluster.map(e => e.causeFull)).join('；'),
      impactFull: dedupe(cluster.map(e => e.impactFull)).join('；'),
      suggestionFull: dedupe(cluster.map(e => e.suggestionFull)).join('；'),
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

// ── 嚴重／提醒／通過：唯一統計來源（single source of truth）─────────────────
// 背景：同一份審查結果，頂部總覽、AI 審查結論、各分區摘要、問題明細頁籤過去
// 各自從不同資料（evalResult.issues／proximityConflicts／EventGroup）獨立
// 重新計數，口徑不一致（issues 是整區去重後的問題「類別」數，可能比配對數
// 多；EventGroup 是合併顯示用的卡片數，一定比配對數少），導致同一份結果在不
// 同畫面顯示不同數字。
//
// 規則：嚴重／提醒／通過的「總數」只能由這裡的 review events（buildZoneEvents
// 的輸出，一配對一事件，已含 classifyOverlap／finalizeSeverity 的嚴重度調整）
// 統計出來，全站唯一入口就是這兩個函式——UI 不得自行 filter evalResult.issues
// 或 proximityConflicts 來算「總數」，grouping／EventGroup 只能用在「問題明細
// 呈現」，不得拿卡片數當事件總數（見下方 groupedIssueCount 欄位的用途註解）。
export interface ZoneSeverityCounts {
  zoneName: string
  /** 嚴重事件數（review events，非 evalResult.issues 類別數） */
  danger: number
  /** 提醒事件數 */
  caution: number
  /** 需人工確認事件數（unmatched 名稱／無法從幾何確認的重疊等） */
  needsReview: number
  /** 通過數＝完成相容性判定的配對數（evaluatedPairCount，含 judgment==='ok'）
   *  減去 danger+caution+needsReview——不是「低風險」的近似值，是真正 judgment
   *  ==='ok' 的配對數。 */
  passed: number
  /** danger+caution+needsReview+passed，恆等於該區 evaluatedPairCount */
  totalEvaluated: number
  /** danger+caution+needsReview（不含 passed）＝ ZoneEvent 總數，供需要「事件
   *  數」而非「配對評估總數」的地方使用（例如問題明細頁籤標題） */
  eventCount: number
  /** 整併後問題卡片數（EventGroup 數，只算 danger/caution，不含 needsReview 彙總）
   *  ──只能用於「N 項｜M 類問題」這種明確標示「已合併」的顯示，不得取代 danger/
   *  caution 的事件總數。呼叫端沒有現成的 clusterZoneEvents 結果時可以不傳
   *  instances／unit，此時為 undefined，UI 應該只顯示事件數，不要顯示假的合併數。 */
  groupedIssueCount?: number
}

/** 唯一計算入口：一個分區的嚴重／提醒／通過統計，全部從 review events 算出。
 *  groupedIssueCount 是額外的「問題明細」用數字，不影響 danger/caution/passed
 *  本身——傳入 instances/unit 才會計算（clusterZoneEvents 需要植物實例算空間
 *  距離），呼叫端沒有現成資料時可以省略，只是不顯示「N 類問題」細節。 */
export function computeZoneSeverityCounts(
  zoneName: string,
  proximityConflicts: PlantConflictResult[],
  evaluatedPairCount: number,
  instances?: SpatialPlantInstance[],
  unit?: DrawingUnit,
): ZoneSeverityCounts {
  const events = buildZoneEvents(zoneName, proximityConflicts)
  const danger = events.filter(e => e.severity === 'danger').length
  const caution = events.filter(e => e.severity === 'caution').length
  const needsReview = events.filter(e => e.severity === 'needs-review').length
  // evaluatedPairCount 理論上恆 ≥ events.length（events 是 evaluatedPairCount 的子集，
  // 只有非 'ok' 才會變成 event）；用 Math.max(0, …) 只是防禦上游資料不同步時不要
  // 顯示負數，不代表這是預期會發生的情況。
  const passed = Math.max(0, evaluatedPairCount - events.length)
  const groupedIssueCount = (instances && unit)
    ? clusterZoneEvents(zoneName, events, instances, unit).groups.length
    : undefined
  return {
    zoneName, danger, caution, needsReview, passed,
    totalEvaluated: evaluatedPairCount,
    eventCount: events.length,
    groupedIssueCount,
  }
}

export interface CaseSeverityCounts {
  danger: number
  caution: number
  needsReview: number
  passed: number
  totalEvaluated: number
  eventCount: number
  zoneCount: number
}

/** 全案彙總＝各分區 ZoneSeverityCounts 相加——不是另一套獨立算法，只是加總，
 *  保證「全案總數必須等於各分區數量加總」（規則第 3 點）恆成立。 */
export function computeCaseSeverityCounts(zones: ZoneSeverityCounts[]): CaseSeverityCounts {
  return zones.reduce((acc, z) => ({
    danger: acc.danger + z.danger,
    caution: acc.caution + z.caution,
    needsReview: acc.needsReview + z.needsReview,
    passed: acc.passed + z.passed,
    totalEvaluated: acc.totalEvaluated + z.totalEvaluated,
    eventCount: acc.eventCount + z.eventCount,
    zoneCount: acc.zoneCount + 1,
  }), { danger: 0, caution: 0, needsReview: 0, passed: 0, totalEvaluated: 0, eventCount: 0, zoneCount: 0 })
}

/** Debug 完整性檢查（規則第 8 點）：獨立重算一次「把全案所有配對當成一個大
 *  分區」的統計，跟「各分區分別統計後加總」比較——兩者理論上恆相等（因為
 *  buildZoneEvents 是逐配對純函式，跟怎麼分組完全無關），若不相等代表統計
 *  管線本身出現不一致，用 console.warn 明確示警，不要讓數字悄悄對不起來。
 *  unassignedCount 由呼叫端傳入（例如 proximityConflicts 裡有 zoneName 找不到
 *  對應分區的配對），目前架構下應恆為 0，這裡仍納入檢查供未來擴充防呆。 */
export function verifySeverityCountIntegrity(
  zoneCounts: ZoneSeverityCounts[],
  allConflictsFlat: PlantConflictResult[],
  allEvaluatedPairCount: number,
  unassignedCount = 0,
): void {
  const sumOfZoneCounts = computeCaseSeverityCounts(zoneCounts)
  const globalCount = computeZoneSeverityCounts('__global__', allConflictsFlat, allEvaluatedPairCount)
  const groupedIssueCountTotal = zoneCounts.reduce((s, z) => s + (z.groupedIssueCount ?? 0), 0)

  console.group('🧮 審查統計完整性檢查（嚴重／提醒／通過 single source of truth）')
  console.table({
    'global count（全案合併重算）': { 嚴重: globalCount.danger, 提醒: globalCount.caution, 需人工確認: globalCount.needsReview, 通過: globalCount.passed, 事件總數: globalCount.eventCount },
    'sum of zone counts（各分區加總）': { 嚴重: sumOfZoneCounts.danger, 提醒: sumOfZoneCounts.caution, 需人工確認: sumOfZoneCounts.needsReview, 通過: sumOfZoneCounts.passed, 事件總數: sumOfZoneCounts.eventCount },
  })
  console.debug(`ungrouped event count（未合併事件數，danger+caution+needsReview）：${sumOfZoneCounts.eventCount}`)
  console.debug(`grouped issue count（合併後問題卡片數，僅 danger/caution）：${groupedIssueCountTotal}`)
  console.debug(`unassigned count（不屬於任何分區的事件數）：${unassignedCount}`)

  const mismatch =
    globalCount.danger !== sumOfZoneCounts.danger + 0 ||
    globalCount.caution !== sumOfZoneCounts.caution + 0 ||
    globalCount.needsReview !== sumOfZoneCounts.needsReview + 0 ||
    globalCount.passed !== sumOfZoneCounts.passed + 0 ||
    globalCount.eventCount !== sumOfZoneCounts.eventCount + unassignedCount
  if (mismatch) {
    console.warn('⚠️ 統計口徑不一致：global count ≠ sum of zone counts + unassigned count，請檢查 computeZoneSeverityCounts／computeCaseSeverityCounts 呼叫端是否有資料未納入。', { globalCount, sumOfZoneCounts, unassignedCount })
  } else {
    console.debug('✅ global count 與 sum of zone counts 一致')
  }
  console.groupEnd()
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

// ── 評分引擎（唯一來源）──────────────────────────────────────────────────────
// 背景：舊公式（100 - dangerCount*12 - cautionCount*5）用「原始配對數」無上限
// 累扣，同一根本原因只要牽涉到多株植物就會被重複扣很多次分，而且分區數/配對數
// 一多，全案總分必然被拖到極低分，跟「大部分分區其實都是 90～100 分」的實況
// 矛盾。改為：
//   1. 分區分數：以「問題群組」（同 zone＋同根本原因＋位置相鄰＝一個 scoring
//      event，見 clusterZoneEvents）計次扣分，而不是逐一配對扣分，且分區內
//      扣分本身也設上限（一區真的問題很多，分數探底是合理的，但不會因為同一
//      個問題牽涉到 10 株植物就扣 10 次）。
//   2. 全案分數＝各分區分數的（面積）平均，不是全案問題數重新累扣一次——這是
//      這次修正的核心：分區數增加不會讓全案分數無止盡下降。
//   3. 全案層級再對「嚴重問題」加一個有上限的整體懲罰（凸顯「有嚴重問題要看」
//      這個訊號），但不會把平均分數打到不成比例的低分。
//   4. 「需人工確認」完全不參與分數（見 classifyOverlap，那類事件連是否為真
//      衝突都無法確認）。
// 全站唯一入口：computeZoneScore()／computeOverallScore()，畫面總覽分數、PDF
// 報告總分、各區分數都必須呼叫這兩個函式，不得另外用 issue 數量從 100 累扣。

// 分區內扣分：同根本原因的問題群組計次，各自設扣分上限，避免同一問題因牽涉
// 多株植物而被放大成離譜低分（一區若真的有 4 個以上不同嚴重問題，40 分封頂
// 已經足以把該區標成「高風險」，不需要無上限繼續扣）。
const ZONE_SEVERE_GROUP_PENALTY = 10
const ZONE_SEVERE_GROUP_PENALTY_CAP = 40
const ZONE_CAUTION_GROUP_PENALTY = 4
const ZONE_CAUTION_GROUP_PENALTY_CAP = 30

export function computeZoneScore(severeGroupCount: number, cautionGroupCount: number): number {
  const penalty =
    Math.min(ZONE_SEVERE_GROUP_PENALTY_CAP, severeGroupCount * ZONE_SEVERE_GROUP_PENALTY) +
    Math.min(ZONE_CAUTION_GROUP_PENALTY_CAP, cautionGroupCount * ZONE_CAUTION_GROUP_PENALTY)
  return Math.max(0, Math.min(100, Math.round(100 - penalty)))
}

export type ScoreTier = '良好' | '可接受' | '需局部調整' | '較高風險' | '高風險'

/** 規則第 9 點的風險等級門檻，畫面總覽／PDF／各區分數共用同一套區間，不再各自
 *  訂一套不同的分級標準（例如舊版 ReportScore 用 80/65/50，跟這裡不一致）。 */
export function scoreTier(score: number): { tier: ScoreTier; tierNote: string } {
  const tier: ScoreTier =
    score >= 90 ? '良好' : score >= 80 ? '可接受' : score >= 70 ? '需局部調整' : score >= 60 ? '較高風險' : '高風險'
  const tierNote =
    tier === '良好' ? '配置相容性良好' :
    tier === '可接受' ? '可行，局部提醒' :
    tier === '需局部調整' ? '建議局部調整' :
    tier === '較高風險' ? '建議優先處理' : '建議重新檢視配置'
  return { tier, tierNote }
}

// 全案層級：嚴重問題的「額外」懲罰，跟分區分數平均分開計算，且設上限——凸顯
// 「有嚴重問題」這個事實，但不會因為問題群組數量隨分區數增加而把平均分數
// 二次打低。
const OVERALL_SEVERE_GLOBAL_PENALTY = 3
const OVERALL_SEVERE_GLOBAL_PENALTY_CAP = 12

export interface OverallScoreZoneInput {
  zoneName: string
  score: number
  /** 分區面積（m²）；全部分區都有時採面積加權平均，否則退回單純平均（規則
   *  第 3、4 點）。 */
  areaM2?: number
}

export interface OverallScore {
  score: number
  tier: ScoreTier
  tierNote: string
  reasonLine: string
  /** 存在嚴重問題時的補充說明，跟分數是否被拉低無關——分數本身已經只扣有上限
   *  的全域懲罰，這裡純粹是「提醒使用者去看」，不是分數的一部分（規則第 10 點）。 */
  severeNote: string | null
}

export function computeOverallScore(
  zoneScores: OverallScoreZoneInput[],
  totalSevereGroupCount: number,
): OverallScore {
  if (zoneScores.length === 0) {
    return { score: 100, tier: '良好', tierNote: '尚無可評分分區', reasonLine: '尚無可評分分區', severeNote: null }
  }
  const hasArea = zoneScores.every(z => typeof z.areaM2 === 'number' && z.areaM2 > 0)
  const totalArea = hasArea ? zoneScores.reduce((s, z) => s + z.areaM2!, 0) : 0
  const base = hasArea && totalArea > 0
    ? zoneScores.reduce((s, z) => s + z.score * z.areaM2!, 0) / totalArea
    : zoneScores.reduce((s, z) => s + z.score, 0) / zoneScores.length

  const severePenalty = Math.min(OVERALL_SEVERE_GLOBAL_PENALTY_CAP, totalSevereGroupCount * OVERALL_SEVERE_GLOBAL_PENALTY)
  const score = Math.max(0, Math.min(100, Math.round(base - severePenalty)))
  const { tier, tierNote } = scoreTier(score)

  const reasonLine = `以 ${zoneScores.length} 個分區${hasArea ? '面積加權' : ''}平均分數 ${Math.round(base)} 分為基礎`
    + (severePenalty > 0 ? `，另計入全案 ${totalSevereGroupCount} 項嚴重問題（全案扣 ${severePenalty} 分，上限 ${OVERALL_SEVERE_GLOBAL_PENALTY_CAP} 分）` : '')

  const severeNote = totalSevereGroupCount > 0 ? `存在 ${totalSevereGroupCount} 項嚴重問題，建議優先處理` : null

  return { score, tier, tierNote, reasonLine, severeNote }
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

export type Bounds = { minX: number; maxX: number; minY: number; maxY: number }

export function polyBounds(vertices: Array<{ x: number; y: number }>): Bounds {
  const xs = vertices.map(v => v.x), ys = vertices.map(v => v.y)
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}

export function polyCentroid(vertices: Array<{ x: number; y: number }>): { x: number; y: number } {
  const n = vertices.length || 1
  return { x: vertices.reduce((s, v) => s + v.x, 0) / n, y: vertices.reduce((s, v) => s + v.y, 0) / n }
}

// 真實 DXF 的 HATCH 填充圖案（crosshatch 等）常常是幾百到幾千個頂點的細密線段組成的
// 輪廓——這裡只是畫一張「大概在哪裡」的示意圖，不是精密測繪圖，直接把全部頂點塞進
// SVG polygon points 屬性會讓報告 HTML 字串暴增到幾十萬字元（實測單一分區地圖曾達
// 80 萬字元），拖慢 html2canvas 截圖甚至讓分頁量測失真。均勻抽樣壓到有限點數，形狀
// 精確度對這張示意圖的用途來說綽綽有餘。
export function simplifyRing(points: Array<{ x: number; y: number }>, maxPoints = 120): Array<{ x: number; y: number }> {
  if (points.length <= maxPoints) return points
  const step = points.length / maxPoints
  const out: Array<{ x: number; y: number }> = []
  for (let i = 0; i < maxPoints; i++) out.push(points[Math.floor(i * step)])
  return out
}
export function ringToPoints(points: Array<{ x: number; y: number }>): string {
  return simplifyRing(points).map(v => `${v.x},${v.y}`).join(' ')
}

// reportHtml 是用 innerHTML= 塞進 detached <div>（不是 React），<svg> 一定要給明確的
// width/height 像素屬性——只給 viewBox 在這個情境下可能量到 0 高度，讓分頁引擎的
// offsetHeight 量測（pdfCanvasExport.ts）把地圖壓成一條線。
export function fitDims(aspect: number, maxW: number, maxH: number): { w: number; h: number } {
  let w = maxW
  let h = w / Math.max(aspect, 0.01)
  if (h > maxH) { h = maxH; w = h * aspect }
  return { w: Math.max(Math.round(w), 120), h: Math.max(Math.round(h), 90) }
}

export interface ZoneMapSummary { zoneName: string; score?: number; dangerCount: number; cautionCount: number; needsReviewCount: number }

function severityColor(sev: EventSeverity): string {
  return sev === 'danger' ? '#dc2626' : sev === 'caution' ? '#2563eb' : '#ca8a04'
}
export function severityLabel(sev: EventSeverity): string {
  return sev === 'danger' ? '嚴重' : sev === 'caution' ? '提醒' : '需人工確認'
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

export function buildShortZoneConclusion(zoneName: string, stats: ZoneEventStats, reportScore: { score: number; tier: string }): string {
  const scoreNote = `（評分 ${reportScore.score}/100，${reportScore.tier}）`
  if (stats.mergedEventCount === 0) {
    return `${zoneName}整體配置相容性良好${scoreNote}，未發現需優先調整之問題項目，建議維持現有配置並依常規養護計畫執行。`
  }
  if (stats.dangerCount > 0) {
    return `${zoneName}評估發現 ${stats.dangerCount} 項嚴重問題、${stats.cautionCount} 項提醒、${stats.needsReviewCount} 項需人工確認${scoreNote}，建議優先處理標號較前之嚴重項目後再提送審查，以降低審查往返次數。`
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
