// ── plantEvaluator.ts — 植栽配置相容性審查核心（從 LandscapeAdvisorPage 抽出共用）──
// 供 DxfReviewPage 分區審查使用；LandscapeAdvisorPage 維持原有本地版本不變。

import { waterScore, sunConflictLevel, drainageConflictLevel } from '@/utils/csvParser'
import type { CsvPlantRecord, SelectedCsvPlant } from '@/types/csvPlant'

// ── Types ─────────────────────────────────────────────────────────────────────

export type IssueLevel   = 'ok' | 'caution' | 'danger'
export type CompatLevel  = '配置良好' | '可行但需補充說明' | '需調整配置' | '高風險不建議'

export interface IssueDetail {
  category: string
  level: IssueLevel
  cause: string
  impact: string
  suggestion: string
}

export interface CatSummary {
  key: string
  label: string
  count: number
  level: IssueLevel
  statusLabel: string
  summary: string
}

export interface EvalResult {
  score: number
  compatLevel: CompatLevel
  categories: CatSummary[]
  issues: IssueDetail[]
  aiSuggestion: string
  adjustmentPlan: string[]
  reviewText: string
}

// ── Core evaluate ─────────────────────────────────────────────────────────────

function makeIssue(category: string, level: IssueLevel, cause: string, impact: string, suggestion: string): IssueDetail {
  return { category, level, cause, impact, suggestion }
}

export function evaluate(plants: SelectedCsvPlant[], allPlants: CsvPlantRecord[]): EvalResult {
  const issues: IssueDetail[] = []
  const problemIds = new Set<string>()
  let deductions = 0

  const waterScores = plants.map(p => waterScore(p.waterRequirement))
  const maxW = Math.max(...waterScores)
  const minW = Math.min(...waterScores)
  const waterGap = maxW - minW

  // 1. 澆水衝突
  if (waterGap >= 2) {
    deductions += 20
    plants.filter(p => waterScore(p.waterRequirement) === minW || waterScore(p.waterRequirement) === maxW)
      .forEach(p => problemIds.add(p.instanceId))
    issues.push(makeIssue('澆水衝突', 'danger',
      `本區植栽水分需求差異大（${[...new Set(plants.map(p => p.waterRequirement))].join('、')}），若以同一灌溉管理，高需水植物可能缺水，低需水植物可能積水爛根。`,
      '澆水管理無法同時兼顧所有植物需求，長期將導致部分植物衰退，增加後續養護難度。',
      '建議依水分需求高低設置獨立灌溉迴路，或替換為水分需求相近的植栽組合。'))
  } else if (waterGap >= 1) {
    deductions += 9
    issues.push(makeIssue('澆水衝突', 'caution',
      `本區植栽水分需求略有差異（${[...new Set(plants.map(p => p.waterRequirement))].join('、')}），需注意澆灌頻率管理。`,
      '若統一澆水頻率，部分植物可能受到輕微水分壓力，影響生長勢。',
      '建議於養護計畫中標示各植栽的適當給水量，並考慮分組澆灌。'))
  }

  // 2. 土壤 / 排水衝突
  const wets = plants.map(p => p.wetTolerance)
  const drainLevel = drainageConflictLevel(wets)
  const hasNotTolerant = wets.includes('不耐積水')
  if (drainLevel === 'caution') {
    deductions += 13
    if (hasNotTolerant) plants.filter(p => p.wetTolerance === '不耐積水').forEach(p => problemIds.add(p.instanceId))
    issues.push(makeIssue('排水衝突', 'caution',
      `本區同時包含不耐積水（${plants.filter(p => p.wetTolerance === '不耐積水').map(p => p.name).join('、')}）與耐濕植物，排水條件需求相反。`,
      '若採統一排水設計，不耐積水植物易發生爛根，耐濕植物則可能因過度排水而受影響。',
      '建議分區配置並設置差異化排水層，或選用排水需求相近的替代植栽。'))
  } else if (hasNotTolerant && plants.length > 1) {
    deductions += 5
    issues.push(makeIssue('排水衝突', 'caution',
      `本區含不耐積水植物（${plants.filter(p => p.wetTolerance === '不耐積水').map(p => p.name).join('、')}），需確保排水設計符合需求。`,
      '若排水層設計不足，不耐積水植物易在雨季受積水影響。',
      '建議補充礫石排水層（10cm 以上），並確認種植基盤排水坡度。'))
  }

  // 3. 日照問題
  const suns = plants.map(p => p.sunRequirement)
  const sunLevel = sunConflictLevel(suns)
  if (sunLevel === 'severe') {
    deductions += 16
    plants.filter(p => p.sunRequirement === '半日照至遮陰').forEach(p => problemIds.add(p.instanceId))
    issues.push(makeIssue('日照問題', 'danger',
      `本區同時包含全日照植物（${plants.filter(p => p.sunRequirement === '全日照').map(p => p.name).join('、')}）與半日照至遮陰植物（${plants.filter(p => p.sunRequirement === '半日照至遮陰').map(p => p.name).join('、')}），日照需求完全相反。`,
      '全日照環境下耐陰植物容易葉燒，遮蔭環境下全日照植物生長勢衰退，兩者無法共存於同一光照條件。',
      '建議將全日照與耐陰植物分區配置，或將耐陰植物換為全日照至半日照之替代植栽。'))
  } else if (sunLevel === 'mild') {
    deductions += 7
    issues.push(makeIssue('日照問題', 'caution',
      `本區植栽日照需求略有差異（${[...new Set(suns.filter(s => s !== '待查'))].join('、')}），需確認配置位置對應日照條件。`,
      '日照需求不一的植物若未依位置配置，可能造成部分植物生長差異，影響景觀均一性。',
      '建議確認場域各位置實際日照時數，將日照需求相近的植物集中配置。'))
  }

  // 4. 維護風險
  const mLevels = plants.map(p => p.maintenanceLevel)
  const hasHighM = mLevels.includes('高')
  const hasLowM  = mLevels.includes('低')
  if (hasHighM && hasLowM) {
    deductions += 8
    plants.filter(p => p.maintenanceLevel === '高').forEach(p => problemIds.add(p.instanceId))
    issues.push(makeIssue('維護風險', 'caution',
      `本區植栽維護頻率差異大，包含高維護植物（${plants.filter(p => p.maintenanceLevel === '高').map(p => p.name).join('、')}）與低維護植物。`,
      '若未建立差異化養護頻率計畫，高維護植物易疏於管理，影響整體景觀品質。',
      '建議於養護計畫中分別標示各植栽的修剪頻率、施肥需求，並與管理單位確認執行能力。'))
  }

  // 5. 根系風險
  const trees        = plants.filter(p => p.normalizedCategory === 'tree')
  const groundcovers = plants.filter(p => p.normalizedCategory === 'groundcover')
  const tallTrees    = trees.filter(p => { const h = parseFloat(p.height); return !isNaN(h) && h >= 10 })
  if (tallTrees.length > 0 && groundcovers.length > 0) {
    deductions += 6
    issues.push(makeIssue('根系風險', 'caution',
      `本區大喬木（${tallTrees.map(p => `${p.name} ${p.height}`).join('、')}）與地被植物混植，需注意根系競爭與遮蔭問題。`,
      '大喬木根系擴張範圍廣，長期可能壓縮地被生長空間，同時遮蔽地被所需日照。',
      '建議規劃足夠種植間距，並選用耐陰地被配置於喬木冠幅範圍內。'))
  }

  // 6. 養護管理風險（綜合）
  if (issues.filter(i => i.level !== 'ok').length >= 3) {
    deductions += 5
    issues.push(makeIssue('養護管理風險', 'caution',
      '本區植栽在水分、日照或排水等多項養護條件上存在差異，整體養護管理難度偏高。',
      '若管理單位缺乏詳細養護計畫，容易因管理方式不當導致整體景觀品質下降。',
      '建議由景觀設計團隊提供完整的分植物養護手冊，納入物業管理合約並定期確認執行狀況。'))
  }

  // 7. 審查疑義風險
  const dangerCnt = issues.filter(i => i.level === 'danger').length
  const cautionCnt = issues.filter(i => i.level === 'caution').length
  const incompleteData = plants.filter(p => !p.dataComplete)
  if (dangerCnt > 0 || cautionCnt >= 3) {
    deductions += 3
    const incNote = incompleteData.length > 0
      ? `另有 ${incompleteData.length} 種植栽（${incompleteData.map(p => p.name).join('、')}）資料屬初步判定，建議人工確認後再提審。`
      : ''
    issues.push(makeIssue('審查疑義風險', 'caution',
      `本植栽組合存在多項習性差異，若未補充完整說明，審查委員可能提出疑義。${incNote}`,
      '審查時可能需要補充澆灌計畫、養護說明或土壤改良方案，增加審查往返次數。',
      '建議於景觀設計說明書中補充植栽配置邏輯、養護管理方式與相容性說明，並附上各植栽資料來源。'))
  } else if (incompleteData.length > 0) {
    deductions += 2
    issues.push(makeIssue('審查疑義風險', 'caution',
      `${incompleteData.map(p => p.name).join('、')} 的日照或水分資料屬初步判定，尚待人工確認。`,
      '若以未確認資料作為審查依據，可能導致委員要求補充或質疑資料可靠性。',
      '建議補查各植栽官方資料來源，確認日照與水分需求欄位後再行提送審查。'))
  }

  const score = Math.max(0, 100 - deductions)
  let compatLevel: CompatLevel
  if (score >= 80)      compatLevel = '配置良好'
  else if (score >= 60) compatLevel = '可行但需補充說明'
  else if (score >= 40) compatLevel = '需調整配置'
  else                  compatLevel = '高風險不建議'

  const catDefs = [
    { key: '澆水衝突',    okSummary: '植栽水分需求一致，澆灌管理無衝突。' },
    { key: '排水衝突',    okSummary: '排水需求相容，無設計調整需求。' },
    { key: '日照問題',    okSummary: '日照條件相容，不需分區配置。' },
    { key: '維護風險',    okSummary: '維護頻率相近，養護管理負擔低。' },
    { key: '根系風險',    okSummary: '根系尺度相近，生長競爭風險低。' },
    { key: '養護管理風險', okSummary: '整體養護管理負擔低。' },
    { key: '審查疑義風險', okSummary: '配置說明完整，審查疑義低。' },
  ]
  const categories: CatSummary[] = catDefs.map(c => {
    const matched = issues.filter(i => i.category === c.key)
    const maxLevel: IssueLevel = matched.some(i => i.level === 'danger') ? 'danger' : matched.some(i => i.level === 'caution') ? 'caution' : 'ok'
    return {
      key: c.key, label: c.key, count: matched.length, level: maxLevel,
      statusLabel: maxLevel === 'danger' ? '高風險' : maxLevel === 'caution' ? '需注意' : '未發現',
      summary: matched.length > 0 ? matched[0].cause.slice(0, 40) + '…' : c.okSummary,
    }
  })

  const allDanger  = issues.filter(i => i.level === 'danger')
  const allCaution = issues.filter(i => i.level === 'caution')
  let aiSuggestion = ''
  if (allDanger.length === 0 && allCaution.length === 0) {
    aiSuggestion = `本植栽組合整體相容性良好（${score}/100）。所選植栽在水分需求、日照條件及排水特性上具備高度一致性，可維持穩定的生長環境與低維護成本。`
  } else if (allDanger.length > 0) {
    aiSuggestion = `本植栽組合存在 ${allDanger.length} 項高風險問題（${allDanger.map(i => i.category).join('、')}），建議於提送審查前優先調整。`
  } else {
    aiSuggestion = `本植栽組合整體可行，但有 ${allCaution.length} 項注意事項（${allCaution.map(i => i.category).join('、')}）。建議透過分區澆灌、差異化養護計畫補充說明，以降低審查疑義。`
  }

  const adjustmentPlan: string[] = []
  if (waterGap >= 2) adjustmentPlan.push('設置獨立分區灌溉迴路，依水分需求高低分組管理')
  else if (waterGap >= 1) adjustmentPlan.push('調整澆灌頻率，於養護計畫中標示各植栽的適當給水量')
  if (drainLevel === 'caution') adjustmentPlan.push('分區配置不耐積水與耐濕植物，並設置差異化排水層設計')
  else if (hasNotTolerant) adjustmentPlan.push('補充礫石排水層（建議 10cm 以上），確認種植基盤排水坡度')
  if (sunLevel === 'severe') adjustmentPlan.push('將全日照與耐陰植物分配至場域日照充足區與遮蔭區')
  else if (sunLevel === 'mild') adjustmentPlan.push('確認場域各區塊實際日照時數，依日照需求分組配置')
  if (hasHighM && hasLowM) adjustmentPlan.push('建立分植物養護時間表，標示各植栽修剪頻率與施肥計畫')
  if (tallTrees.length > 0 && groundcovers.length > 0) adjustmentPlan.push('規劃喬木與地被之種植間距，選用耐陰地被配置於冠幅範圍內')
  if (incompleteData.length > 0) adjustmentPlan.push(`補查 ${incompleteData.map(p => p.name).join('、')} 的官方日照水分資料`)
  if (adjustmentPlan.length === 0) adjustmentPlan.push('維持現有配置，施工前確認種植間距與覆土深度符合各植栽需求')

  const plantNames = plants.map(p => p.name).join('、')
  let reviewText = ''
  if (compatLevel === '配置良好') {
    reviewText = `本區植栽配置計畫，選用植栽包含 ${plantNames}，整體配置相容性評估分數為 ${score}/100，評估結果為「配置良好」。所選植栽在水分需求、日照條件及排水特性上具備良好的相容性。`
  } else if (compatLevel === '可行但需補充說明') {
    const notes = allCaution.map(i => `${i.category}：${i.cause}`).join('\n')
    reviewText = `本區植栽配置計畫，選用植栽包含 ${plantNames}，整體配置相容性評估分數為 ${score}/100，評估結果為「可行，但需補充養護說明」。\n\n${notes}\n\n修正方向：\n${adjustmentPlan.map(p => `• ${p}`).join('\n')}`
  } else {
    const dangerNotes = allDanger.map(i => `${i.category}：${i.cause}`).join('\n')
    reviewText = `本區植栽配置計畫，選用植栽包含 ${plantNames}，整體配置相容性評估分數為 ${score}/100，評估結果為「${compatLevel}」。\n\n${dangerNotes}\n\n修正方向：\n${adjustmentPlan.map(p => `• ${p}`).join('\n')}`
  }

  void allPlants // 保留參數以維持與 LandscapeAdvisorPage 相同介面
  return { score, compatLevel, categories, issues, aiSuggestion, adjustmentPlan, reviewText }
}
