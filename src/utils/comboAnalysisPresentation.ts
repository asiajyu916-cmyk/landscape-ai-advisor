// ── comboAnalysisPresentation.ts — 「分析這組配置」結果的純顯示層轉換 ──────────
// analyzeCombo()（plantAdvisor.ts）本身的判斷邏輯、扣分規則、風險/建議文字內容完全
// 不動；這裡只是把它已經產生好的 AdvisorReply（verdict/risks/fixes/badPairs/
// goodPairs/score）重新分類、標籤化、排序，轉成適合分區塊呈現的結構化資料。
// 分類靠字串比對 analyzeCombo() 目前會產生的固定句型——若之後那邊風險/建議的措辭
// 改了，這裡的分類規則也要跟著更新，兩邊靠句型耦合，不是靠新的判斷邏輯推導。

import type { AdvisorReply } from '@/utils/plantAdvisor'
import type { CsvPlantRecord } from '@/types/csvPlant'
import { Droplet, Waves, Sun, Layers, Scissors, ShieldAlert, Trees, type LucideIcon } from 'lucide-react'

export type ComboCategory = 'watering' | 'drainage' | 'sunlight' | 'structure' | 'maintenance' | 'safety' | 'shade'
export type ComboSeverity = 'high' | 'warning' | 'caution'
export type ComboLevel = '通過' | '警示' | '高風險'

export const COMBO_CATEGORY_META: Record<ComboCategory, { label: string; icon: LucideIcon; emoji: string }> = {
  watering:    { label: '澆水',     icon: Droplet,     emoji: '💧' },
  drainage:    { label: '排水',     icon: Waves,        emoji: '🌊' },
  sunlight:    { label: '日照',     icon: Sun,          emoji: '☀️' },
  structure:   { label: '層次配置', icon: Layers,       emoji: '🌿' },
  maintenance: { label: '養護',     icon: Scissors,     emoji: '✂️' },
  safety:      { label: '安全性',   icon: ShieldAlert,  emoji: '⚠️' },
  shade:       { label: '遮蔭競爭', icon: Trees,        emoji: '🌳' },
}

export const COMBO_SEVERITY_META: Record<ComboSeverity, { label: string; badgeCls: string }> = {
  high:    { label: '高風險', badgeCls: 'bg-red-100 text-red-700 border-red-300' },
  warning: { label: '警示',   badgeCls: 'bg-orange-100 text-orange-700 border-orange-300' },
  caution: { label: '注意',   badgeCls: 'bg-amber-100 text-amber-700 border-amber-300' },
}

const SEVERITY_RANK: Record<ComboSeverity, number> = { high: 3, warning: 2, caution: 1 }

export interface ComboIssue {
  category: ComboCategory
  severity: ComboSeverity
  plants: string[]
  headline: string
  impact?: string
  suggestion?: string
}

export interface ComboRelation {
  plantA: string
  plantB: string
  ok: boolean
  reason: string
}

export interface ComboTag {
  category: ComboCategory
  ok: boolean
  label: string
}

export interface ComboSummary {
  score: number
  level: ComboLevel
  oneLiner: string
  counts: { ok: number; adjust: number; high: number }
  tags: ComboTag[]
  issues: ComboIssue[]
  strengths: ComboRelation[]
  actions: string[]
  relations: ComboRelation[]
  raw: AdvisorReply
}

const TAG_LABEL: Record<ComboCategory, { bad: string; ok: string }> = {
  watering:    { bad: '澆水衝突',   ok: '澆水相容' },
  drainage:    { bad: '排水衝突',   ok: '排水正常' },
  sunlight:    { bad: '日照衝突',   ok: '日照相容' },
  structure:   { bad: '層次待補',   ok: '層次完整' },
  maintenance: { bad: '養護需留意', ok: '養護可接受' },
  safety:      { bad: '有安全疑慮', ok: '安全性正常' },
  shade:       { bad: '遮蔭風險',   ok: '遮蔭正常' },
}

function extractPlantNames(text: string, selectedPlants: CsvPlantRecord[]): string[] {
  return selectedPlants.filter(p => text.includes(p.name)).map(p => p.name)
}

function classifyBadPairReason(reason: string): ComboCategory {
  if (reason.includes('日照')) return 'sunlight'
  if (reason.includes('排水')) return 'drainage'
  return 'watering'
}

// 對應 analyzeCombo() 目前會產生的每一種風險句型；fixTest 有值時，從 reply.fixes
// 裡找對得上的那一句當建議，找不到就不顯示建議（不臆造 analyzeCombo 沒講過的話）
const RISK_CLASSIFIERS: Array<{ test: RegExp; category: ComboCategory; severity: ComboSeverity; fixTest?: RegExp }> = [
  { test: /維護需求高/,                    category: 'maintenance', severity: 'warning', fixTest: /高維護植栽建議集中/ },
  { test: /具毒性/,                        category: 'safety',      severity: 'warning', fixTest: /建議避開遊戲區/ },
  { test: /生長較快.*提早遮蔽或壓迫/,       category: 'shade',       severity: 'caution', fixTest: /生長速度差異大的植栽建議/ },
  { test: /缺乏喬木層/,                    category: 'structure',   severity: 'caution' },
  { test: /缺中低層灌木\/地被/,             category: 'structure',   severity: 'caution' },
  { test: /為全日照植物，配置於.*樹冠下方/, category: 'shade',       severity: 'warning', fixTest: /建議配置於樹冠滴水線外側/ },
]

const IMPACT_BY_CATEGORY: Record<ComboCategory, string> = {
  watering: '水分需求差距大，其中一方易缺水或積水爛根。',
  drainage: '排水需求衝突，不耐積水的一方易爛根。',
  sunlight: '日照需求不一致，光線不足或過強的一方生長不良。',
  structure: '垂直層次不足，視覺與生態效果打折扣。',
  maintenance: '整體養護人力與預算偏重。',
  safety: '兒童／寵物易接觸的區域需留意誤觸風險。',
  shade: '可能造成生長不良或提早遮蔽下層植栽。',
}

export function buildComboSummary(reply: AdvisorReply, selectedPlants: CsvPlantRecord[]): ComboSummary {
  const score = reply.score ?? 70
  const level: ComboLevel = score >= 80 ? '通過' : score >= 65 ? '警示' : '高風險'
  const genericConflictFix = reply.fixes.find(f => f.includes('分區配置'))

  const issues: ComboIssue[] = []

  // badPairs：一組衝突配對＝一張問題卡（環境需求衝突，扣分最重，一律列為高風險）
  for (const bp of reply.badPairs) {
    const [a, b] = bp.name.split(' × ')
    const category = classifyBadPairReason(bp.reason)
    issues.push({
      category, severity: 'high', plants: [a, b].filter(Boolean),
      headline: bp.reason,
      impact: IMPACT_BY_CATEGORY[category],
      suggestion: genericConflictFix,
    })
  }

  // 其餘風險句子（跳過「N 組植物存在環境需求衝突」彙總句——已經用 badPairs 逐一列出）
  for (const r of reply.risks) {
    if (/組植物存在環境需求衝突/.test(r)) continue
    const hit = RISK_CLASSIFIERS.find(c => c.test.test(r))
    if (!hit) continue
    issues.push({
      category: hit.category, severity: hit.severity,
      plants: extractPlantNames(r, selectedPlants),
      headline: r,
      impact: IMPACT_BY_CATEGORY[hit.category],
      suggestion: hit.fixTest ? reply.fixes.find(f => hit.fixTest!.test(f)) : undefined,
    })
  }

  issues.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])

  // goodPairs 分兩種：「A × B」是目前已選植物之間相容的關係；不含「×」的是資料庫
  // 補植建議（適合再加一株，不是目前配置裡的關係）——後者併入調整建議，不算配置優點
  const relationGoodPairs = reply.goodPairs.filter(g => g.name.includes(' × '))
  const additionSuggestions = reply.goodPairs.filter(g => !g.name.includes(' × '))

  const strengths: ComboRelation[] = relationGoodPairs.map(g => {
    const [a, b] = g.name.split(' × ')
    return { plantA: a, plantB: b, ok: true, reason: g.reason }
  })
  const badRelations: ComboRelation[] = reply.badPairs.map(bp => {
    const [a, b] = bp.name.split(' × ')
    return { plantA: a, plantB: b, ok: false, reason: bp.reason }
  })

  const actions: string[] = [
    ...reply.fixes,
    ...additionSuggestions.map(g => `可考慮補植 ${g.name}：${g.reason}`),
  ]

  const tags: ComboTag[] = (Object.keys(COMBO_CATEGORY_META) as ComboCategory[]).map(category => {
    const ok = !issues.some(i => i.category === category)
    return { category, ok, label: ok ? TAG_LABEL[category].ok : TAG_LABEL[category].bad }
  })

  const high = issues.filter(i => i.severity === 'high').length
  const adjust = issues.filter(i => i.severity !== 'high').length
  const ok = strengths.length

  const oneLiner = (() => {
    if (issues.length === 0) return '整體配置相容性良好，未發現明顯問題。'
    const top = issues[0]
    const catLabel = COMBO_CATEGORY_META[top.category].label
    const plantsText = top.plants.length > 0 ? top.plants.join('與') : ''
    if (level === '高風險') {
      return plantsText ? `配置需重新檢視，${plantsText}在${catLabel}上有明顯衝突。` : `配置需重新檢視，${catLabel}方面有明顯衝突。`
    }
    return plantsText ? `整體配置可使用，但${plantsText}在${catLabel}上需要調整。` : `整體配置可使用，但${catLabel}方面需要留意調整。`
  })()

  return {
    score, level, oneLiner,
    counts: { ok, adjust, high },
    tags, issues, strengths, actions,
    relations: [...badRelations, ...strengths],
    raw: reply,
  }
}
