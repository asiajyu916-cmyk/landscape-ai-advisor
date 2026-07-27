// ── issueCategoryMeta.ts — 問題卡片分類辨識（純顯示層）───────────────────────────
// 把 plantEvaluator.ts 既有的 10 種細分類（category 字串）歸進 4 個使用者看得懂的
// 大分類，並從既有的 cause/impact/suggestion 文字衍生出「一句話結論」與「關鍵標籤」
// 供卡片摘要顯示。全部是純字串/對照表處理，不讀取、不影響任何審查判斷邏輯或資料。

import { Droplet, Waves, Sun, Scissors, type LucideIcon } from 'lucide-react'

import type { IssueDetail } from '@/utils/plantEvaluator'

export type IssueCategoryGroup = 'watering' | 'drainage' | 'sunlight' | 'maintenance'

// plantEvaluator.ts 實際會產生的 10 種 category 字串 → 4 大分類
const CATEGORY_TO_GROUP: Record<string, IssueCategoryGroup> = {
  '澆水衝突': 'watering',
  '排水衝突': 'drainage',
  '日照問題': 'sunlight',
  '維護風險': 'maintenance',
  '根系風險': 'maintenance',
  '養護管理風險': 'maintenance',
  '土壤酸鹼衝突': 'maintenance',
  '土壤改良需求': 'maintenance',
  '土壤質地衝突': 'maintenance',
  '審查疑義風險': 'maintenance',
}

export function classifyCategory(category: string | undefined): IssueCategoryGroup {
  return (category && CATEGORY_TO_GROUP[category]) || 'maintenance'
}

// 分類色刻意跟風險色（紅/橘/綠/灰）完全錯開，避免「養護＝綠」跟「通過＝綠」撞色，
// 讓使用者能同時獨立辨識「這張卡在講什麼」跟「風險多高」兩件事。
export const CATEGORY_GROUP_META: Record<IssueCategoryGroup, {
  label: string; icon: LucideIcon; iconCls: string; bgCls: string
}> = {
  watering:    { label: '澆水需求', icon: Droplet,  iconCls: 'text-blue-600',   bgCls: 'bg-blue-100' },
  drainage:    { label: '排水條件', icon: Waves,     iconCls: 'text-cyan-600',   bgCls: 'bg-cyan-100' },
  sunlight:    { label: '日照需求', icon: Sun,       iconCls: 'text-yellow-600', bgCls: 'bg-yellow-100' },
  maintenance: { label: '養護管理', icon: Scissors,  iconCls: 'text-violet-600', bgCls: 'bg-violet-100' },
}

export const CATEGORY_GROUP_ORDER: IssueCategoryGroup[] = ['watering', 'drainage', 'sunlight', 'maintenance']

/** 從問題說明全文取出一句話結論：去掉「本區」開頭與括號內的落落長清單，取第一個句讀前的核心句 */
export function deriveConclusion(cause: string): string {
  const stripped = cause
    .replace(/^(本區|本植栽組合)/, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .trim()
  const match = stripped.match(/^[^，。；]+/)
  const result = (match ? match[0] : stripped).trim()
  return result.length > 0 ? result : cause
}

// 各分類的關鍵字 → 標籤對照（比對 cause+impact+suggestion 合併文字，命中就採用該標籤）
const TAG_RULES: Record<IssueCategoryGroup, Array<{ pattern: RegExp; tag: string }>> = {
  watering: [
    { pattern: /水分需求差異|需水.{0,4}差異/, tag: '需水差異大' },
    { pattern: /澆灌頻率|澆水頻率/, tag: '澆水頻率不同' },
    { pattern: /積水爛根|積水/, tag: '積水風險' },
    { pattern: /缺水/, tag: '局部缺水' },
  ],
  drainage: [
    { pattern: /不耐積水/, tag: '不耐積水' },
    { pattern: /爛根/, tag: '根腐風險' },
    { pattern: /排水(設計|層|坡度|條件)/, tag: '排水不良' },
    { pattern: /礫石|改良/, tag: '土壤需改善' },
  ],
  sunlight: [
    { pattern: /全日照/, tag: '全日照' },
    { pattern: /半日照/, tag: '半日照' },
    { pattern: /遮陰|耐陰|遮蔭/, tag: '喬木遮陰' },
    { pattern: /日照需求.{0,6}(相反|差異)/, tag: '日照不足' },
  ],
  maintenance: [
    { pattern: /維護頻率差異|高維護/, tag: '維護成本高' },
    { pattern: /修剪頻率|施肥/, tag: '修剪頻繁' },
    { pattern: /生長差異|生長勢|生長停滯/, tag: '生長速度不同' },
    { pattern: /根系競爭|根系擴張/, tag: '管理難度高' },
    { pattern: /管理難度|管理方式不當|管理單位/, tag: '管理難度高' },
    { pattern: /pH|酸鹼|質地|客土/, tag: '土壤需改善' },
  ],
}

/** 從 issue 的既有文字衍生 2~4 個關鍵標籤，比對不到任何關鍵字時以分類名稱本身當保底標籤 */
export function deriveTags(issue: Pick<IssueDetail, 'category' | 'cause' | 'impact' | 'suggestion'>): string[] {
  const group = classifyCategory(issue.category)
  const text = `${issue.cause}${issue.impact}${issue.suggestion}`
  const tags: string[] = []
  for (const rule of TAG_RULES[group]) {
    if (rule.pattern.test(text) && !tags.includes(rule.tag)) tags.push(rule.tag)
    if (tags.length >= 4) break
  }
  if (tags.length === 0) tags.push(CATEGORY_GROUP_META[group].label)
  return tags
}

// ── 一組植物配對 → 4 分類結構化結果（一組植物一張卡片的核心轉換）───────────────
// 純粹把既有的 issues[] 依 classifyCategory 分組、取每組最嚴重的一筆代表，永遠回傳
// 4 筆（沒問題的分類 severity='normal'）。不改變、不重算任何 issue 本身的內容。

export type Severity = 'high' | 'warning' | 'normal'

export interface CategoryResult {
  category: IssueCategoryGroup
  severity: Severity
  title: string
  summary: string
  impact?: string
  recommendation?: string
  tags: string[]
}

const SEVERITY_RANK: Record<Severity, number> = { high: 2, warning: 1, normal: 0 }

function severityFromLevel(level: IssueDetail['level']): Severity {
  return level === 'danger' ? 'high' : level === 'caution' ? 'warning' : 'normal'
}

// 分類正常（無問題）時的固定措辭——純文案，不是判斷邏輯
const NORMAL_COPY: Record<IssueCategoryGroup, { title: string; summary: string }> = {
  watering:    { title: '澆水需求相容', summary: '水分需求無明顯衝突' },
  drainage:    { title: '排水條件相容', summary: '排水需求無明顯衝突' },
  sunlight:    { title: '日照需求相容', summary: '日照條件無明顯衝突' },
  maintenance: { title: '養護管理相容', summary: '維護需求無明顯衝突' },
}

/** 把一組植物配對的 issues[] 轉成「4 分類各一筆」的結構化結果；掃描全部 issues，不是只看第一筆 */
export function buildCategoryResults(issues: IssueDetail[]): CategoryResult[] {
  return CATEGORY_GROUP_ORDER.map(group => {
    const groupIssues = issues.filter(iss => classifyCategory(iss.category) === group)
    if (groupIssues.length === 0) {
      return { category: group, severity: 'normal', ...NORMAL_COPY[group], tags: [] }
    }
    const worst = groupIssues.reduce((a, b) =>
      SEVERITY_RANK[severityFromLevel(b.level)] > SEVERITY_RANK[severityFromLevel(a.level)] ? b : a)
    const allTags = groupIssues.flatMap(deriveTags)
    return {
      category: group,
      severity: severityFromLevel(worst.level),
      title: deriveConclusion(worst.cause),
      summary: worst.cause,
      impact: groupIssues.map(i => i.impact).join('；'),
      recommendation: groupIssues.map(i => i.suggestion).join('；'),
      tags: [...new Set(allTags)].slice(0, 4),
    }
  })
}

/** 從 categoryResults 挑風險最高的分類當主分類；全部 normal 時用 fallback */
export function pickPrimaryCategory(results: CategoryResult[], fallback: IssueCategoryGroup): IssueCategoryGroup {
  const withIssue = results.filter(r => r.severity !== 'normal')
  if (withIssue.length === 0) return fallback
  return withIssue.reduce((a, b) => SEVERITY_RANK[b.severity] > SEVERITY_RANK[a.severity] ? b : a).category
}
