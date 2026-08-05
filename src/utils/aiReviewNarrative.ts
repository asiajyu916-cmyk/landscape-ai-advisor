// ── aiReviewNarrative.ts — DXF 審查結果頁「AI 顧問化」顯示層摘要 ─────────────────
// 目的：把既有審查結果（issues／proximityConflicts／evalResult／alternatives，全部
// 沿用既有判定邏輯與門檻，不重新計算、不改動）整理成使用者容易讀懂的「AI 結論」文字
// 與「修正方案」建議。全部是純函式、規則式文字組裝（字串樣板＋既有資料），目前沒有
// 串接任何語言模型 API。
//
// 未來要換成真正的 LLM 摘要時，只需要替換這個檔案裡的函式實作（輸入輸出介面不變），
// 呼叫端（元件）完全不需要改動——這是刻意把「產生摘要文字」跟「畫面呈現」分開的
// 原因。哪些函式屬於「未來要換成真正 API」，見各函式上方的註記。

import type { PlantConflictResult, RiskLevel } from '@/types/dxf'
import type { IssueDetail, EvalResult, AltOption } from '@/utils/plantEvaluator'
import {
  classifyCategory, CATEGORY_GROUP_META, CATEGORY_GROUP_ORDER, buildCategoryResults,
  type IssueCategoryGroup, type CategoryResult,
} from '@/utils/issueCategoryMeta'

// ── 共用小工具 ──────────────────────────────────────────────────────────────

/** 字元級 Jaccard 相似度（0~1）。中文沒有天然的詞界，字元級比詞級更穩定、不需要斷詞。 */
function textSimilarity(a: string, b: string): number {
  if (!a || !b) return 0
  const setA = new Set(a)
  const setB = new Set(b)
  let inter = 0
  for (const ch of setA) if (setB.has(ch)) inter++
  const union = new Set([...setA, ...setB]).size
  return union === 0 ? 0 : inter / union
}

/**
 * UI 顯示層文字去重：同一張卡片內「主要問題／判斷依據／建議處理」容易複製貼上同一句話。
 * 只整理「顯示用」的文字陣列，不動原始 IssueDetail／EvalResult 資料本身。
 * 完全相同或高度相似（字元 Jaccard ≥ threshold）的句子只保留第一次出現。
 */
export function deduplicateReviewText(
  parts: Array<{ label: string; text: string }>,
  threshold = 0.8,
): Array<{ label: string; text: string }> {
  const kept: Array<{ label: string; text: string }> = []
  for (const p of parts) {
    const norm = p.text.trim()
    if (!norm) continue
    const isDup = kept.some(k => k.text === norm || textSimilarity(k.text, norm) >= threshold)
    if (isDup) continue
    kept.push({ label: p.label, text: norm })
  }
  return kept
}

// ── 主要風險歸納 ────────────────────────────────────────────────────────────

export interface PrimaryRisk {
  category: IssueCategoryGroup
  label: string
  count: number
  dangerCount: number
}

/** 把一批 issues 依既有 4 大分類（issueCategoryMeta.ts）歸納，依「嚴重優先、數量次之」
 *  排序，回傳最多 limit 筆——供「主要風險最多 3 類」與「這一區主要問題」共用。 */
export function groupPrimaryRisks(issues: IssueDetail[], limit = 3): PrimaryRisk[] {
  const counts = new Map<IssueCategoryGroup, { danger: number; caution: number }>()
  for (const g of CATEGORY_GROUP_ORDER) counts.set(g, { danger: 0, caution: 0 })
  for (const iss of issues) {
    if (iss.level === 'ok') continue
    const g = classifyCategory(iss.category)
    const c = counts.get(g)!
    if (iss.level === 'danger') c.danger++
    else c.caution++
  }
  return [...counts.entries()]
    .map(([category, c]) => ({ category, label: CATEGORY_GROUP_META[category].label, count: c.danger + c.caution, dangerCount: c.danger }))
    .filter(r => r.count > 0)
    .sort((a, b) => (b.dangerCount - a.dangerCount) || (b.count - a.count))
    .slice(0, limit)
}

// ── 一、AI 審查總結（跨分區）─────────────────────────────────────────────────
// 對應「DXF 審查結果頁」總覽分頁：統計標籤與問題列表之間的 AI 總結卡。

export interface ZoneReviewInput {
  zoneName: string
  evalResult?: EvalResult
  proximityConflicts: PlantConflictResult[]
}

export interface PriorityZone {
  zoneName: string
  dangerCount: number
  cautionCount: number
  reason: string
}

export interface ReviewSummary {
  overallConclusion: string
  topRisks: PrimaryRisk[]
  priorityZones: PriorityZone[]
  suggestedOrder: string[]
  stats: { totalDanger: number; totalCaution: number; totalPassed: number; zoneCount: number }
}

/**
 * 【未來可替換為真正 LLM API 的函式之一】目前用規則式樣板組句：依 danger／caution
 * 數量與 groupPrimaryRisks 的歸納結果套固定句型。輸入輸出介面（ZoneReviewInput[] →
 * ReviewSummary）之後接真正的語言模型摘要時不需要改動呼叫端。
 */
export function generateReviewSummary(zones: ZoneReviewInput[]): ReviewSummary {
  const reviewable = zones.filter((z): z is ZoneReviewInput & { evalResult: EvalResult } => !!z.evalResult)

  const allIssues = reviewable.flatMap(z => z.evalResult.issues)
  const totalDanger = allIssues.filter(i => i.level === 'danger').length
  const totalCaution = allIssues.filter(i => i.level === 'caution').length
  const totalPassed = reviewable.reduce(
    (s, z) => s + z.proximityConflicts.filter(c => c.riskLevel === 'low' || c.riskLevel === 'unmatched').length, 0)

  const topRisks = groupPrimaryRisks(allIssues, 3)

  const priorityZones: PriorityZone[] = reviewable
    .map(z => {
      const d = z.evalResult.issues.filter(i => i.level === 'danger').length
      const c = z.evalResult.issues.filter(i => i.level === 'caution').length
      const top = groupPrimaryRisks(z.evalResult.issues, 1)[0]
      const reason = d > 0
        ? `${d} 項嚴重問題${top ? `，主要為${top.label}` : ''}`
        : c > 0 ? `${c} 項提醒事項${top ? `，主要為${top.label}` : ''}` : '未發現問題'
      return { zoneName: z.zoneName, dangerCount: d, cautionCount: c, reason }
    })
    .filter(z => z.dangerCount > 0 || z.cautionCount > 0)
    .sort((a, b) => (b.dangerCount - a.dangerCount) || (b.cautionCount - a.cautionCount))
    .slice(0, 3)

  const overallConclusion = (() => {
    if (reviewable.length === 0) return '尚無可審查的分區資料，請先完成分區配置與植栽比對。'
    if (totalDanger === 0 && totalCaution === 0) {
      return `本案整體植栽配置通過審查，共 ${reviewable.length} 個分區皆未發現需優先處理的問題。`
    }
    const focus = topRisks.slice(0, 2).map(r => r.label).join('與')
    if (totalDanger > 0) {
      return `本案整體植栽配置大致可行，目前有 ${totalDanger} 項嚴重問題需要優先處理${focus ? `，主要集中於${focus}` : ''}。`
    }
    return `本案整體植栽配置可行，有 ${totalCaution} 項提醒事項建議留意${focus ? `，主要集中於${focus}` : ''}。`
  })()

  const suggestedOrder: string[] = priorityZones.map(z => {
    const zone = reviewable.find(r => r.zoneName === z.zoneName)
    const top = zone ? groupPrimaryRisks(zone.evalResult.issues, 1)[0] : undefined
    return `處理 ${z.zoneName}${top ? top.label : ''}問題`
  })
  if (totalCaution > 0) suggestedOrder.push('檢查提醒項目')

  return {
    overallConclusion, topRisks, priorityZones, suggestedOrder,
    stats: { totalDanger, totalCaution, totalPassed, zoneCount: reviewable.length },
  }
}

/**
 * 分區總覽圖上方的一句話 AI 洞察，直接重用 generateReviewSummary() 已算好的
 * priorityZones／topRisks，不重新統計，也不假造分析——沒有優先分區時如實說明。
 */
export function generateMapInsight(summary: ReviewSummary): string {
  if (summary.stats.zoneCount === 0) return '尚無可審查的分區資料。'
  if (summary.priorityZones.length === 0) return 'AI 判斷：目前各分區皆未發現需優先處理的問題。'
  const zoneNames = summary.priorityZones.map(z => z.zoneName).join('與')
  const riskFocus = summary.topRisks.slice(0, 2).map(r => r.label).join('與')
  return `AI 判斷：目前問題主要集中在 ${zoneNames}${riskFocus ? `，建議優先檢查${riskFocus}` : ''}。`
}

/**
 * 單一分區的一句話 AI 摘要（分區卡／分區快覽面板用）。跟 generateReviewSummary()
 * 裡 priorityZones 的 reason 組句邏輯共用同一套規則，差別只在這裡對「無問題」
 * 分區也給出明確結論，不像 priorityZones 那樣直接濾掉——分區卡需要對每一區都
 * 顯示一句話，不能只有有問題的區才有摘要。
 */
export function generateZoneOneLiner(zone: ZoneReviewInput): string {
  if (!zone.evalResult) return 'AI 判斷：本分區尚未完成植栽比對，無法產生摘要。'
  const d = zone.evalResult.issues.filter(i => i.level === 'danger').length
  const c = zone.evalResult.issues.filter(i => i.level === 'caution').length
  if (d === 0 && c === 0) return `AI 判斷：${zone.zoneName}整體配置通過審查，未發現需優先處理的問題。`
  const top = groupPrimaryRisks(zone.evalResult.issues, 1)[0]
  if (d > 0) {
    return `AI 判斷：${zone.zoneName}整體可行，但有 ${d} 項較高風險${top ? `的${top.label}問題` : '問題'}，建議優先確認。`
  }
  return `AI 判斷：${zone.zoneName}整體可行，有 ${c} 項提醒事項${top ? `，主要為${top.label}` : ''}，建議留意。`
}

// ── 二、單一問題卡片的 AI 判斷 ────────────────────────────────────────────────

export interface IssueJudgement {
  /** 完整一句話，含「AI 判斷：」前綴，直接顯示 */
  headline: string
  /** 判斷依據：說明為什麼成立（來自 cause，已去重） */
  basis: string
  /** 建議處理方式：來自既有 suggestion（已去重） */
  action: string
  /** 這則判斷認為需不需要換植物——供 UI 決定要不要強調「替代方案」區塊 */
  suggestsReplace: boolean
}

const REPLACE_KEYWORDS = /替代|更換|換為|換成|替換/

/**
 * 【未來可替換為真正 LLM API 的函式之一】依既有風險等級（riskLevel／IssueLevel）與
 * 既有 suggestion 文字是否提到「替代/更換」關鍵字，套固定句型產生一句 AI 判斷。
 * 不重新計算風險，只是把已經算好的結果轉成一句話結論。
 */
export function generateIssueJudgement(conflict: PlantConflictResult): IssueJudgement {
  if (conflict.riskLevel === 'unmatched') {
    return {
      headline: 'AI 判斷：植物名稱未能比對資料庫，需人工確認後才能判斷相容性。',
      basis: '空間上確實鄰近／相接／重疊，但至少一方植物名稱無法對應資料庫記錄。',
      action: '請人工確認植物身分後重新執行審查。',
      suggestsReplace: false,
    }
  }

  const categoryResults = buildCategoryResults(conflict.issues)
  const primary = categoryResults.reduce((a, b) => {
    const rank = { high: 2, warning: 1, normal: 0 } as const
    return rank[b.severity] > rank[a.severity] ? b : a
  })

  if (primary.severity === 'normal') {
    return {
      headline: 'AI 判斷：差異在容許範圍內，保留原配置即可。',
      basis: primary.summary,
      action: '無須調整，維持原配置即可。',
      suggestsReplace: false,
    }
  }

  const suggestsReplace = REPLACE_KEYWORDS.test(primary.recommendation ?? '')
  const isSevere = primary.severity === 'high'

  let headline: string
  if (isSevere && suggestsReplace) headline = 'AI 判斷：此問題屬環境適應性衝突，建議更換植物。'
  else if (isSevere) headline = 'AI 判斷：屬嚴重環境適應性衝突，建議優先調整配置或更換植物。'
  else if (suggestsReplace) headline = 'AI 判斷：建議優先調整種植位置，如仍無法改善可考慮更換植物。'
  else headline = 'AI 判斷：建議優先調整種植位置，不需要直接更換植物。'

  return { headline, basis: primary.summary, action: primary.recommendation ?? '', suggestsReplace }
}

// ── 三、修正方案（Plan A/B/C）───────────────────────────────────────────────
// 三個方案是三種不同的「產生策略」，不是同一份資料換句話說：
//   A（最小修改）：只挑問題最集中的 1～2 種植栽，嚴重配對才替換，其餘只標記
//                  「建議調整位置」，不換植栽——修改範圍是三方案中最小的。
//   B（配置優化）：找出本區出現次數最多的問題類型（例如日照），只處理落在這個
//                  類型底下的植栽；其中有嚴重配對的才替換，其餘一樣標記調整
//                  位置——處理範圍比 A 大，但不是全部問題都處理。
//   C（整體替換）：所有標記為有問題的植栽全部替換，目標是盡量清空嚴重與提醒。
// 三個方案畫面上顯示的「涉及植物種類數」「修改前後問題數」「修改程度」都是
// 直接從各自的 touched 集合算出來的真實數字，不是各自配一組固定文案——資料量
// 太小、三種策略殊途同歸時，下面會自動去重，避免顯示看起來不同、內容其實一樣
// 的假選項。

export interface FixPlanReplacement {
  originalName: string
  replacementName: string
  reason: string
}

export interface FixPlan {
  id: 'A' | 'B' | 'C'
  title: string
  subtitle: string
  keepPlants: string[]              // 1. 保留植物
  movedPlants: string[]             // 2. 移動植物（建議調整位置／範圍／比例，不換植栽）
  replacements: FixPlanReplacement[] // 3. 替換植物
  touchedSpeciesCount: number        // 4. 涉及植物種類數（movedPlants + replacements）
  scopeNote: string                  // 5. 預估修改面積或配置數量（用涉及配對數量代理）
  beforeIssueCount: number           // 6. 修改前問題數
  afterIssueCount: number            // 7. 修改後預估問題數
  modificationLevel: '低' | '中' | '高'  // 8. 修改程度
  applicableScenario: string         // 9. 適用情境
  reasoning: string
  pros: string[]
  cons: string[]
}

interface FixPlanZoneInput {
  zoneName: string
  evalResult?: EvalResult
  proximityConflicts: PlantConflictResult[]
}

/** 依偏好挑一個替代植物：優先套用 preferFn（找不到符合的再退回分數最高的第一筆） */
function pickAlternative(options: AltOption[], preferFn?: (o: AltOption) => boolean): AltOption | undefined {
  if (options.length === 0) return undefined
  if (preferFn) {
    const preferred = options.find(preferFn)
    if (preferred) return preferred
  }
  return options[0]   // evaluate() 產生時已依分數排序，第一筆＝最佳適配
}

interface PlantProblemStat {
  dangerConflictCount: number
  totalConflictCount: number
  categories: Set<IssueCategoryGroup>
}

function buildPlantProblemStats(conflicts: PlantConflictResult[]): Map<string, PlantProblemStat> {
  const map = new Map<string, PlantProblemStat>()
  const touch = (name: string): PlantProblemStat => {
    let stat = map.get(name)
    if (!stat) { stat = { dangerConflictCount: 0, totalConflictCount: 0, categories: new Set() }; map.set(name, stat) }
    return stat
  }
  for (const c of conflicts) {
    if (c.riskLevel === 'unmatched') continue
    const isDanger = c.riskLevel === 'high'
    for (const name of [c.plantA.name, c.plantB.name]) {
      const stat = touch(name)
      stat.totalConflictCount++
      if (isDanger) stat.dangerConflictCount++
      for (const issue of c.issues) stat.categories.add(classifyCategory(issue.category))
    }
  }
  return map
}

/** 有實際判定結果（嚴重／提醒）的配對數——unmatched 是「無法判定」，不算問題。 */
function countIssueConflicts(conflicts: PlantConflictResult[]): number {
  return conflicts.filter(c => c.riskLevel === 'high' || c.riskLevel === 'medium' || c.riskLevel === 'low').length
}

function countAddressed(conflicts: PlantConflictResult[], touchedNames: Set<string>): number {
  return conflicts.filter(c =>
    (c.riskLevel === 'high' || c.riskLevel === 'medium' || c.riskLevel === 'low') &&
    (touchedNames.has(c.plantA.name) || touchedNames.has(c.plantB.name)),
  ).length
}

/** 【未來可替換為真正 LLM API 的函式之一】見檔案這一段最上方的策略說明。 */
export function generateFixPlans(zone: FixPlanZoneInput): FixPlan[] {
  const alternatives = zone.evalResult?.alternatives ?? []
  const beforeIssueCount = countIssueConflicts(zone.proximityConflicts)

  if (alternatives.length === 0 || beforeIssueCount === 0) {
    const note = '目前沒有標記為需要調整的植栽，建議維持原配置。'
    return [{
      id: 'A', title: '建議方案', subtitle: note,
      keepPlants: [], movedPlants: [], replacements: [], touchedSpeciesCount: 0,
      scopeNote: '無需調整', beforeIssueCount, afterIssueCount: beforeIssueCount,
      modificationLevel: '低', applicableScenario: '目前配置無須調整',
      reasoning: note, pros: ['不改動任何植栽'], cons: [],
    }]
  }

  const stats = buildPlantProblemStats(zone.proximityConflicts)
  const problemNames = alternatives.map(s => s.originalPlant.name)

  function buildPlan(
    id: 'A' | 'B' | 'C', title: string, subtitle: string,
    touchNames: Set<string>,
    reasoning: string, pros: string[], cons: string[], applicableScenario: string,
  ): FixPlan {
    const keepPlants: string[] = []
    const movedPlants: string[] = []
    const replacements: FixPlanReplacement[] = []

    for (const s of alternatives) {
      const name = s.originalPlant.name
      if (!touchNames.has(name)) { keepPlants.push(name); continue }
      const hasDanger = (stats.get(name)?.dangerConflictCount ?? 0) > 0
      const alt = hasDanger ? pickAlternative(s.alternatives) : undefined
      if (alt) replacements.push({ originalName: name, replacementName: alt.plant.name, reason: alt.reason })
      else movedPlants.push(name)   // 嚴重問題找不到替代植物，或本來就只是提醒等級：建議調整位置
    }

    const touchedSpeciesCount = movedPlants.length + replacements.length
    const touchedNames = new Set([...movedPlants, ...replacements.map(r => r.originalName)])
    const addressedConflictCount = countAddressed(zone.proximityConflicts, touchedNames)
    const afterIssueCount = Math.max(0, beforeIssueCount - addressedConflictCount)
    const modificationLevel: FixPlan['modificationLevel'] = id === 'A' ? '低' : id === 'B' ? '中' : '高'
    const scopeNote = touchedSpeciesCount === 0
      ? '本方案不調整任何植栽'
      : `涉及 ${touchedSpeciesCount} 種植栽・${addressedConflictCount} 組配對`

    return {
      id, title, subtitle, keepPlants, movedPlants, replacements, touchedSpeciesCount,
      scopeNote, beforeIssueCount, afterIssueCount, modificationLevel, applicableScenario,
      reasoning, pros, cons,
    }
  }

  // ── A：只挑問題最集中（嚴重配對數優先，其次總配對數）的 1～2 種植栽 ──────────
  const rankedByProblem = [...problemNames].sort((a, b) => {
    const sa = stats.get(a), sb = stats.get(b)
    const da = sa?.dangerConflictCount ?? 0, db = sb?.dangerConflictCount ?? 0
    if (db !== da) return db - da
    return (sb?.totalConflictCount ?? 0) - (sa?.totalConflictCount ?? 0)
  })
  const planANames = new Set(rankedByProblem.slice(0, 2))
  const planA = buildPlan(
    'A', '方案 A｜最小修改', '優先保留原設計，只處理問題最集中的 1～2 種植栽，嚴重問題才替換，其餘建議調整位置',
    planANames,
    `只針對問題最集中的 ${planANames.size} 種植栽處理：涉及嚴重配對的植栽替換，其餘僅標記建議調整種植位置或範圍，其他植栽維持原設計。`,
    ['對原設計改動最少，施工與植栽採購成本最低', '保留絕大部分原始設計意圖'],
    ['未處理的提醒問題仍需另外透過位置或養護計畫留意'],
    '設計已定案、僅需微調的專案，希望維持既有植栽採購與施工範圍',
  )

  // ── B：只處理出現次數最多的問題類型 ──────────────────────────────────────
  const categoryCount = new Map<IssueCategoryGroup, number>()
  for (const c of zone.proximityConflicts) {
    if (c.riskLevel === 'unmatched') continue
    for (const issue of c.issues) {
      const cat = classifyCategory(issue.category)
      categoryCount.set(cat, (categoryCount.get(cat) ?? 0) + 1)
    }
  }
  const primaryCategory = [...categoryCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  const primaryCategoryLabel = primaryCategory ? CATEGORY_GROUP_META[primaryCategory].label : ''
  const planBNames = new Set(
    primaryCategory ? problemNames.filter(name => stats.get(name)?.categories.has(primaryCategory)) : [],
  )
  const planB = buildPlan(
    'B', '方案 B｜配置優化', `優先解決本區最多的「${primaryCategoryLabel || '主要'}」問題，重新分配相關植栽的位置或比例，部分植栽替換`,
    planBNames,
    `找出本區出現次數最多的問題類型（${primaryCategoryLabel || '無明顯主要類型'}），只處理落在這個類型底下的植栽：有嚴重配對的替換，其餘重新分配位置或種植比例，其他類型的問題暫不處理。`,
    ['針對主要問題類型集中處理，效益比例較高', '仍保留與主要問題無關的原始設計'],
    ['非主要類型的提醒問題仍會保留，需另外處理'],
    '希望優先解決單一最大宗問題類型、但不想全面重做設計的專案',
  )

  // ── C：全部問題植栽都替換 ────────────────────────────────────────────────
  const planCNames = new Set(problemNames)
  const planC = buildPlan(
    'C', '方案 C｜整體替換', '全面替換所有標記為有問題的植栽，以降低全部嚴重與提醒問題為優先，配置調整幅度最大',
    planCNames,
    '所有標記為有問題（嚴重或提醒）的植栽全數替換為既有評分機制中適配度最高的選項，目標是盡量清空本區的嚴重與提醒問題。',
    ['同時處理嚴重與提醒問題，審查結果最完整', '長期環境適應性最佳'],
    ['植栽異動範圍最大，需重新確認整體設計風格與採購成本'],
    '設計階段仍可大幅調整、以審查通過與長期穩定性為優先的專案',
  )

  // ── 若三個方案的替換／移動集合實質相同（資料量太小，三種策略殊途同歸），
  // 去重合併，避免製造假選項──不是只藏卡片，是真的只回傳不重複的方案。
  const signature = (p: FixPlan) => JSON.stringify({
    moved: [...p.movedPlants].sort(),
    replaced: p.replacements.map(r => `${r.originalName}>${r.replacementName}`).sort(),
  })
  const seen = new Set<string>()
  const distinctPlans: FixPlan[] = []
  for (const p of [planA, planB, planC]) {
    const sig = signature(p)
    if (seen.has(sig)) continue
    seen.add(sig)
    distinctPlans.push(p)
  }

  if (distinctPlans.length === 1) {
    return [{ ...distinctPlans[0], title: '建議方案', subtitle: '目前資料只能產生一種有意義的調整方式，已合併為單一建議方案' }]
  }
  return distinctPlans
}

/** 依三方案處理的嚴重問題數量挑一個預設推薦——問題少時最小修改就夠、問題多時
 *  才需要最佳適配，沒有嚴重問題時預設走低維護方案。純粹是既有數字的排序規則，
 *  不是新的判斷邏輯。 */
export function recommendFixPlan(plans: FixPlan[], totalDangerCount: number): { id: FixPlan['id']; reason: string } {
  // 方案可能因為去重只剩 1～2 個，推薦一定要從實際存在的方案裡選，不能假設 A/B/C 都在。
  if (plans.length === 1) {
    return { id: plans[0].id, reason: '目前資料只能產生一種有意義的調整方式，已合併為單一建議方案。' }
  }
  const byId = (id: FixPlan['id']) => plans.find(p => p.id === id)
  if (totalDangerCount === 0) {
    const pick = byId('C') ?? byId('B') ?? plans[plans.length - 1]
    return { id: pick.id, reason: '目前沒有嚴重問題，建議優先考慮降低後續提醒事項。' }
  }
  if (totalDangerCount <= 2) {
    const pick = byId('A') ?? plans[0]
    return { id: pick.id, reason: '嚴重問題數量不多，最小修改即可解決，不需大幅調整設計。' }
  }
  const pick = byId('B') ?? byId('C') ?? plans[plans.length - 1]
  return { id: pick.id, reason: '嚴重問題較多，建議採用配置優化方案完整處理審查結果。' }
}
