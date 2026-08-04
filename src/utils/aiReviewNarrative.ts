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

export interface FixPlanReplacement {
  originalName: string
  replacementName: string
  reason: string
}

export interface FixPlan {
  id: 'A' | 'B' | 'C'
  title: string
  subtitle: string
  expectedDangerAddressed: number
  expectedCautionAddressed: number
  keepPlants: string[]
  replacements: FixPlanReplacement[]
  unresolvedPlants: string[]   // 有問題但找不到同類替代植物，只能保留或人工處理
  reasoning: string
  pros: string[]
  cons: string[]
  estimateNote: string
}

interface FixPlanZoneInput {
  zoneName: string
  evalResult?: EvalResult
  proximityConflicts: PlantConflictResult[]
}

function countAddressedConflicts(conflicts: PlantConflictResult[], replacedNames: Set<string>) {
  const danger = conflicts.filter(c => c.riskLevel === 'high' && (replacedNames.has(c.plantA.name) || replacedNames.has(c.plantB.name))).length
  const caution = conflicts.filter(c => c.riskLevel === 'medium' && (replacedNames.has(c.plantA.name) || replacedNames.has(c.plantB.name))).length
  return { danger, caution }
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

/**
 * 【未來可替換為真正 LLM API 的函式之一】三個方案完全從既有 evalResult.alternatives
 * （既有替代植栽建議，未重新計算相容性分數）與 proximityConflicts（既有配對風險）
 * 組出來：
 *   A（最小修改）：只處理牽涉「嚴重」配對的植物，其餘即使有提醒也保留原配置
 *   B（最佳適配）：所有有問題的植物都換成分數最高的替代植栽（沿用既有評分排序）
 *   C（低維護）：優先挑選 maintenanceLevel 為「低」的替代植栽，找不到才退回最佳適配
 * 不產生任何假造的改善分數／百分比；只回報「處理幾項嚴重／幾項提醒」這種可從既有
 * 資料直接算出的真實數字，資料不足以量化時改用文字描述（estimateNote）。
 */
export function generateFixPlans(zone: FixPlanZoneInput): FixPlan[] {
  const alternatives = zone.evalResult?.alternatives ?? []
  const dangerPlantNames = new Set(
    zone.proximityConflicts.filter(c => c.riskLevel === 'high').flatMap(c => [c.plantA.name, c.plantB.name]),
  )

  if (alternatives.length === 0) {
    const note = '目前沒有標記為需要調整的植栽，建議維持原配置。'
    return (['A', 'B', 'C'] as const).map(id => ({
      id,
      title: id === 'A' ? '方案 A｜最小修改' : id === 'B' ? '方案 B｜最佳適配' : '方案 C｜低維護方案',
      subtitle: note,
      expectedDangerAddressed: 0, expectedCautionAddressed: 0,
      keepPlants: [], replacements: [], unresolvedPlants: [],
      reasoning: note, pros: ['不改動任何植栽'], cons: [],
      estimateNote: note,
    }))
  }

  function buildPlan(
    id: 'A' | 'B' | 'C', title: string, subtitle: string,
    shouldReplace: (originalName: string) => boolean,
    preferFn: ((o: AltOption) => boolean) | undefined,
    reasoning: string, pros: string[], cons: string[],
  ): FixPlan {
    const keepPlants: string[] = []
    const replacements: FixPlanReplacement[] = []
    const unresolvedPlants: string[] = []

    for (const s of alternatives) {
      if (!shouldReplace(s.originalPlant.name)) { keepPlants.push(s.originalPlant.name); continue }
      const alt = pickAlternative(s.alternatives, preferFn)
      if (!alt) { unresolvedPlants.push(s.originalPlant.name); continue }
      replacements.push({ originalName: s.originalPlant.name, replacementName: alt.plant.name, reason: alt.reason })
    }

    const replacedNames = new Set(replacements.map(r => r.originalName))
    const { danger, caution } = countAddressedConflicts(zone.proximityConflicts, replacedNames)
    const estimateNote = replacements.length === 0
      ? '此方案不更換植栽，僅靠位置調整或維持現況。'
      : danger > 0
        ? `預估可明顯降低排水與配植衝突，處理 ${danger} 組涉及嚴重問題的配對。`
        : caution > 0
          ? `預估可降低提醒事項對應的配植衝突，處理 ${caution} 組配對。`
          : '預估可提升整體植栽環境適應性，實際改善幅度建議施工前現場複核。'

    return {
      id, title, subtitle,
      expectedDangerAddressed: danger, expectedCautionAddressed: caution,
      keepPlants, replacements, unresolvedPlants,
      reasoning, pros, cons, estimateNote,
    }
  }

  const planA = buildPlan(
    'A', '方案 A｜最小修改', '優先保留原有植栽，只調整必要問題，修改數量最少',
    name => dangerPlantNames.has(name),
    undefined,
    '只更換牽涉「嚴重」等級配對的植栽，提醒等級的問題改以位置調整或養護管理處理，改動幅度最小。',
    ['對原設計改動最少，施工成本與植栽採購成本最低', '保留大部分原始設計意圖'],
    ['提醒等級的問題仍需另外透過位置或養護計畫處理，不會直接消除'],
  )

  const planB = buildPlan(
    'B', '方案 B｜最佳適配', '優先解決嚴重問題，選擇環境適應性較高的替代植物，平衡設計與審查結果',
    () => true,
    undefined,
    '所有標記為有問題（嚴重或提醒）的植栽，全部換成既有評分機制中分數最高的替代植栽，兼顧審查結果與整體設計平衡。',
    ['同時處理嚴重與提醒問題，審查結果最完整', '替代植栽皆為既有評分機制中適配度最高的選項'],
    ['植栽異動範圍較大，需重新確認整體設計風格與採購成本'],
  )

  const planC = buildPlan(
    'C', '方案 C｜低維護方案', '優先選擇低維護、適應性較高的植物，降低後續養護風險',
    () => true,
    o => o.plant.maintenanceLevel === '低',
    '所有標記為有問題的植栽，優先挑選養護需求「低」的替代植栽（找不到低維護選項時，退回既有評分最高的選項），降低後續管理負擔。',
    ['長期養護成本與人力需求較低', '同時處理嚴重與提醒問題'],
    ['部分植栽可能因優先考量維護需求而非最佳環境適配分數，設計效果需另行確認'],
  )

  const plans = [planA, planB, planC]

  return plans
}

/** 依三方案處理的嚴重問題數量挑一個預設推薦——問題少時最小修改就夠、問題多時
 *  才需要最佳適配，沒有嚴重問題時預設走低維護方案。純粹是既有數字的排序規則，
 *  不是新的判斷邏輯。 */
export function recommendFixPlan(plans: FixPlan[], totalDangerCount: number): { id: FixPlan['id']; reason: string } {
  if (totalDangerCount === 0) {
    return { id: 'C', reason: '目前沒有嚴重問題，建議優先考慮降低後續養護負擔。' }
  }
  if (totalDangerCount <= 2) {
    return { id: 'A', reason: '嚴重問題數量不多，最小修改即可解決，不需大幅調整設計。' }
  }
  return { id: 'B', reason: '嚴重問題較多，建議採用最佳適配方案完整處理審查結果。' }
}
