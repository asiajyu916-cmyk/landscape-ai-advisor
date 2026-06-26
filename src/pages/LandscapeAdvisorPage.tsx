import { useState, useRef, useCallback, useEffect } from 'react'
import {
  Upload, Database, FileDown, Plus, X, Search, Leaf,
  AlertTriangle, CheckCircle, XCircle, Info, ChevronDown, ChevronUp,
  ArrowRight, FileText, ExternalLink, RefreshCw, FileOutput,
} from 'lucide-react'
import { exportReviewReportPdf } from '@/utils/exportReviewPdf'
import {
  savePlantsToStorage, loadPlantsFromStorage,
  fetchDefaultPlants, importFromFile, filterPlants,
  loadImageStore, saveImageStore, upsertPlantImage, removePlantImage, readImageFile,
} from '@/data/plantStore'
import {
  parsePlantCsv, waterScore, sunConflictLevel, drainageConflictLevel,
} from '@/utils/csvParser'
import type {
  CsvPlantRecord, SelectedCsvPlant, ImportResult, PlantStatus,
  PlantImageData, ImageStore, CandidatePhoto, ImageReviewStatus,
} from '@/types/csvPlant'

// ── tiny helpers ──────────────────────────────────────────────────────────────
function uid() { return Math.random().toString(36).slice(2) }

// ── Evaluation types ──────────────────────────────────────────────────────────
type IssueLevel = 'ok' | 'caution' | 'danger'
type CompatLevel = '配置良好' | '可行但需補充說明' | '需調整配置' | '高風險不建議'

interface IssueDetail {
  category: string
  level: IssueLevel
  cause: string
  impact: string
  suggestion: string
}

interface AltOption {
  plant: CsvPlantRecord
  reason: string
  riskReduction: string
}

interface AltSuggestion {
  originalPlant: SelectedCsvPlant
  problemLabels: string[]
  alternatives: AltOption[]
}

interface CatSummary {
  key: string
  label: string
  count: number
  level: IssueLevel
  statusLabel: string
  summary: string
}

interface EvalResult {
  score: number
  compatLevel: CompatLevel
  categories: CatSummary[]
  issues: IssueDetail[]
  alternatives: AltSuggestion[]
  aiSuggestion: string
  adjustmentPlan: string[]
  reviewText: string
}

// ── Evaluation core ───────────────────────────────────────────────────────────

function makeIssue(category: string, level: IssueLevel, cause: string, impact: string, suggestion: string): IssueDetail {
  return { category, level, cause, impact, suggestion }
}

function evaluate(plants: SelectedCsvPlant[], allPlants: CsvPlantRecord[]): EvalResult {
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
  const hasTolerant = wets.includes('耐濕')
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
  const hasLowM = mLevels.includes('低')
  if (hasHighM && hasLowM) {
    deductions += 8
    plants.filter(p => p.maintenanceLevel === '高').forEach(p => problemIds.add(p.instanceId))
    issues.push(makeIssue('維護風險', 'caution',
      `本區植栽維護頻率差異大，包含高維護植物（${plants.filter(p => p.maintenanceLevel === '高').map(p => p.name).join('、')}）與低維護植物。`,
      '若未建立差異化養護頻率計畫，高維護植物易疏於管理，影響整體景觀品質，也可能增加不必要的養護成本。',
      '建議於養護計畫中分別標示各植栽的修剪頻率、施肥需求，並與管理單位確認執行能力。'))
  } else if (mLevels.filter(m => m !== '待查').length > 1 && mLevels.some(m => m === '中')) {
    deductions += 3
    issues.push(makeIssue('維護風險', 'caution',
      '本區植栽維護需求略有差異，需在養護計畫中分別說明。',
      '若統一採用相同養護方式，可能造成部分植物過度或不足管理。',
      '建議建立分植物種類的養護時間表，標示修剪、施肥與灌溉頻率。'))
  }

  // 5. 根系 / 生長尺度風險
  const trees = plants.filter(p => p.normalizedCategory === 'tree')
  const groundcovers = plants.filter(p => p.normalizedCategory === 'groundcover')
  const tallTrees = trees.filter(p => {
    const h = parseFloat(p.height)
    return !isNaN(h) && h >= 10
  })
  if (tallTrees.length > 0 && groundcovers.length > 0) {
    deductions += 6
    issues.push(makeIssue('根系風險', 'caution',
      `本區大喬木（${tallTrees.map(p => `${p.name} ${p.height}`).join('、')}）與地被植物混植，需注意根系競爭與遮蔭問題。`,
      '大喬木根系擴張範圍廣，長期可能壓縮地被生長空間，同時遮蔽地被所需日照。',
      '建議規劃足夠種植間距，並選用耐陰地被配置於喬木冠幅範圍內。'))
  }

  // 6. 養護管理風險（綜合）
  const multiConflict = issues.filter(i => i.level !== 'ok').length >= 3
  if (multiConflict) {
    deductions += 5
    issues.push(makeIssue('養護管理風險', 'caution',
      '本區植栽在水分、日照或排水等多項養護條件上存在差異，整體養護管理難度偏高。',
      '若管理單位缺乏詳細養護計畫，容易因管理方式不當導致整體景觀品質下降。',
      '建議由景觀設計團隊提供完整的分植物養護手冊，納入物業管理合約並定期確認執行狀況。'))
  }

  // 7. 土壤相容性
  const phOrder: Record<string, number> = { '酸性': 1, '微酸性': 2, '中性': 3, '微鹼性': 4, '鹼性': 5 }
  const plantsWithPh = plants.filter(p => p.soilPh && phOrder[p.soilPh] !== undefined)
  let plantsNeedAmend: typeof plants = []
  if (plantsWithPh.length >= 2) {
    const phValues = plantsWithPh.map(p => phOrder[p.soilPh])
    const phGap = Math.max(...phValues) - Math.min(...phValues)
    if (phGap >= 3) {
      deductions += 15
      const acidP  = plantsWithPh.filter(p => phOrder[p.soilPh] <= 2).map(p => `${p.name}（${p.soilPh}）`)
      const alkaliP = plantsWithPh.filter(p => phOrder[p.soilPh] >= 4).map(p => `${p.name}（${p.soilPh}）`)
      issues.push(makeIssue('土壤酸鹼衝突', 'danger',
        `本區植栽土壤 pH 需求差異懸殊：酸性偏好植物（${acidP.join('、')}）與鹼性偏好植物（${alkaliP.join('、')}）無法共存於同一土壤。`,
        '統一土壤 pH 將造成部分植物出現缺素症或生長停滯，長期影響植物存活率。',
        '建議依 pH 需求進行分區種植，各區土壤分別調整至適合 pH 範圍，或替換為相近 pH 需求的替代植栽。'))
    } else if (phGap >= 2) {
      deductions += 8
      const phList = [...new Set(plantsWithPh.map(p => `${p.name}（${p.soilPh}）`))]
      issues.push(makeIssue('土壤酸鹼衝突', 'caution',
        `本區植栽土壤 pH 需求略有差異（${phList.join('、')}），需確認土壤酸鹼性可兼容各植栽。`,
        '不同 pH 偏好的植物在同一土壤中可能出現生長差異，影響景觀均一性。',
        '建議於施工前進行土壤 pH 檢測，必要時以硫磺粉或石灰調整，並定期監測。'))
    }
  }
  plantsNeedAmend = plants.filter(p => p.soilAmendment === '是' || p.soilAmendment === '建議')
  if (plantsNeedAmend.length > 0) {
    deductions += 5
    issues.push(makeIssue('土壤改良需求', 'caution',
      `本區有 ${plantsNeedAmend.length} 種植栽需要或建議進行客土改良（${plantsNeedAmend.map(p => p.name).join('、')}）。`,
      '若未進行適當土壤改良即行種植，此類植栽之根系適應性與長期存活率將受到影響。',
      '建議於景觀施工說明書中明列客土改良規格，並於竣工前確認執行。'))
  }
  const textures = [...new Set(plants.map(p => p.soilTexture).filter(Boolean))]
  if (textures.length >= 2 && textures.includes('砂質土') && textures.includes('黏質土')) {
    deductions += 6
    issues.push(makeIssue('土壤質地衝突', 'caution',
      `本區植栽土壤質地需求相反：偏好砂質土（${plants.filter(p => p.soilTexture === '砂質土').map(p => p.name).join('、')}）與偏好黏質土（${plants.filter(p => p.soilTexture === '黏質土').map(p => p.name).join('、')}）混植。`,
      '統一土壤質地將使部分植物因排水過快或積水而生長不良。',
      '建議採用壤土作為基底，並針對特定植栽進行局部土壤質地改良，或分區配置。'))
  }

  // 8. 審查疑義風險
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
  if (score >= 80) compatLevel = '配置良好'
  else if (score >= 60) compatLevel = '可行但需補充說明'
  else if (score >= 40) compatLevel = '需調整配置'
  else compatLevel = '高風險不建議'

  // ── Alternatives ──────────────────────────────────────────────────────────
  const problemPlants = plants.filter(p =>
    p.status === '不建議' || p.status === '需注意' || problemIds.has(p.instanceId)
  )
  const selectedIds = new Set(plants.map(p => p.id))

  const alternatives: AltSuggestion[] = problemPlants.map(target => {
    const others = plants.filter(p => p.instanceId !== target.instanceId)
    const candidates = allPlants.filter(c =>
      c.normalizedCategory === target.normalizedCategory && !selectedIds.has(c.id)
    )

    type Scored = { plant: CsvPlantRecord; score: number; reasons: string[]; reductions: string[] }
    const scored: Scored[] = candidates.map(c => {
      let sc = 0; const reasons: string[] = []; const reductions: string[] = []

      // water compatibility
      const targetWaterConflicts = others.filter(o => Math.abs(waterScore(o.waterRequirement) - waterScore(target.waterRequirement)) >= 1).length
      const candWaterConflicts = others.filter(o => Math.abs(waterScore(o.waterRequirement) - waterScore(c.waterRequirement)) >= 1).length
      if (candWaterConflicts < targetWaterConflicts) {
        sc += 15; reasons.push(`水分需求（${c.waterRequirement}）與本區其他植栽更為接近`); reductions.push('降低澆水衝突風險')
      }

      // sun compatibility
      const candSuns = [...others.map(o => o.sunRequirement), c.sunRequirement]
      const targSuns = [...others.map(o => o.sunRequirement), target.sunRequirement]
      if (sunConflictLevel(candSuns) === 'none' && sunConflictLevel(targSuns) !== 'none') {
        sc += 15; reasons.push(`日照需求（${c.sunRequirement}）消除了日照衝突`); reductions.push('消除日照需求極端差異')
      } else if (sunConflictLevel(candSuns) === 'mild' && sunConflictLevel(targSuns) === 'severe') {
        sc += 8; reasons.push(`日照需求（${c.sunRequirement}）降低日照衝突程度`)
      }

      // drainage
      if (c.wetTolerance !== '待查' && target.wetTolerance !== c.wetTolerance) {
        const candWets = [...others.map(o => o.wetTolerance), c.wetTolerance]
        const targWets = [...others.map(o => o.wetTolerance), target.wetTolerance]
        if (drainageConflictLevel(candWets) === 'none' && drainageConflictLevel(targWets) !== 'none') {
          sc += 10; reasons.push(`耐濕性（${c.wetTolerance}）與本區排水條件更相容`); reductions.push('解除排水條件衝突')
        }
      }

      // maintenance
      if (c.maintenanceLevel === '低' && target.maintenanceLevel !== '低') {
        sc += 8; reasons.push('維護需求低，便於統一養護管理'); reductions.push('降低整體養護成本')
      }

      // data completeness
      if (c.dataComplete && !target.dataComplete) {
        sc += 5; reasons.push('資料來源完整，可靠性較高')
      }

      return { plant: c, score: sc, reasons, reductions }
    })

    const top3 = scored.filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(s => ({
        plant: s.plant,
        reason: s.reasons.slice(0, 2).join('；') || '整體習性與本區植物較相容',
        riskReduction: s.reductions.length > 0 ? s.reductions.slice(0, 2).join('、') : '提高整體配置相容性',
      }))

    const pLabels: string[] = []
    if (target.status === '不建議') pLabels.push('不建議')
    else if (target.status === '需注意') pLabels.push('需注意')
    if (problemIds.has(target.instanceId)) {
      issues.forEach(iss => {
        if (iss.cause.includes(target.name)) pLabels.push(iss.category)
      })
    }

    return { originalPlant: target, problemLabels: [...new Set(pLabels)], alternatives: top3 }
  }).filter(s => s.alternatives.length > 0)

  // ── Category summaries ────────────────────────────────────────────────────
  const catDefs = [
    { key: '澆水衝突',    okSummary: '植栽水分需求一致，澆灌管理無衝突。' },
    { key: '排水衝突',    okSummary: '排水需求相容，無設計調整需求。' },
    { key: '日照問題',    okSummary: '日照條件相容，不需分區配置。' },
    { key: '維護風險',    okSummary: '維護頻率相近，養護管理負擔低。' },
    { key: '根系風險',    okSummary: '根系尺度相近，生長競爭風險低。' },
    { key: '養護管理風險', okSummary: '整體養護管理負擔低。' },
    { key: '土壤酸鹼衝突', okSummary: '土壤 pH 需求相容，無酸鹼衝突。' },
    { key: '土壤改良需求', okSummary: '無需特殊客土改良。' },
    { key: '土壤質地衝突', okSummary: '土壤質地需求相容。' },
    { key: '審查疑義風險', okSummary: '配置說明完整，審查疑義低。' },
  ]
  const categories: CatSummary[] = catDefs.map(c => {
    const matched = issues.filter(i => i.category === c.key)
    const maxLevel: IssueLevel =
      matched.some(i => i.level === 'danger') ? 'danger' :
      matched.some(i => i.level === 'caution') ? 'caution' : 'ok'
    return {
      key: c.key, label: c.key,
      count: matched.length, level: maxLevel,
      statusLabel: maxLevel === 'danger' ? '高風險' : maxLevel === 'caution' ? '需注意' : '未發現',
      summary: matched.length > 0 ? matched[0].cause.slice(0, 30) + '…' : c.okSummary,
    }
  })

  // ── AI suggestion text ────────────────────────────────────────────────────
  const allDanger = issues.filter(i => i.level === 'danger')
  const allCaution = issues.filter(i => i.level === 'caution')
  let aiSuggestion = ''
  if (allDanger.length === 0 && allCaution.length === 0) {
    aiSuggestion = `本植栽組合整體相容性良好（${score}/100）。所選植栽在水分需求、日照條件及排水特性上具備高度一致性，可維持穩定的生長環境與低維護成本。建議依既定計畫執行，並於施工前確認各植栽之種植間距與覆土深度。`
  } else if (allDanger.length > 0) {
    aiSuggestion = `本植栽組合存在 ${allDanger.length} 項高風險問題（${allDanger.map(i => i.category).join('、')}），建議於提送審查前優先調整。若需維持原配置，應於景觀設計說明書中補充完整的澆灌計畫、排水設計及養護管理方案。`
  } else {
    aiSuggestion = `本植栽組合整體可行，但有 ${allCaution.length} 項注意事項（${allCaution.map(i => i.category).join('、')}）。建議透過分區澆灌、差異化養護計畫及施工說明書補充說明，以降低後續養護風險與審查疑義。`
  }

  // ── Adjustment plan ───────────────────────────────────────────────────────
  const adjustmentPlan: string[] = []
  if (waterGap >= 2) adjustmentPlan.push('設置獨立分區灌溉迴路，依水分需求高低分組管理')
  else if (waterGap >= 1) adjustmentPlan.push('調整澆灌頻率，於養護計畫中標示各植栽的適當給水量')
  if (drainLevel === 'caution') adjustmentPlan.push('分區配置不耐積水與耐濕植物，並設置差異化排水層設計')
  else if (hasNotTolerant) adjustmentPlan.push('補充礫石排水層（建議 10cm 以上），確認種植基盤排水坡度')
  if (sunLevel === 'severe') adjustmentPlan.push('將全日照與耐陰植物分配至場域日照充足區與遮蔭區')
  else if (sunLevel === 'mild') adjustmentPlan.push('確認場域各區塊實際日照時數，依日照需求分組配置')
  if (hasHighM && hasLowM) adjustmentPlan.push('建立分植物養護時間表，標示各植栽修剪頻率與施肥計畫')
  if (tallTrees.length > 0 && groundcovers.length > 0) adjustmentPlan.push('規劃喬木與地被之種植間距，選用耐陰地被配置於冠幅範圍內')
  if (incompleteData.length > 0) adjustmentPlan.push(`補查 ${incompleteData.map(p => p.name).join('、')} 的官方日照水分資料，更新資料庫後重新評估`)
  if (plantsWithPh.length >= 2 && (Math.max(...plantsWithPh.map(p => phOrder[p.soilPh])) - Math.min(...plantsWithPh.map(p => phOrder[p.soilPh]))) >= 2)
    adjustmentPlan.push('施工前進行土壤 pH 檢測，依各植栽需求調整酸鹼度，並分區管理')
  if (plantsNeedAmend.length > 0) adjustmentPlan.push('於景觀施工說明書中列明客土改良規格，竣工前確認執行')
  if (issues.some(i => i.category === '審查疑義風險')) adjustmentPlan.push('於景觀設計說明書中補充植栽配置邏輯、養護管理方式與各植栽資料來源引用')
  if (adjustmentPlan.length === 0) adjustmentPlan.push('維持現有配置，施工前確認種植間距與覆土深度符合各植栽需求')

  // ── Review text ───────────────────────────────────────────────────────────
  const plantNames = plants.map(p => p.name).join('、')
  let reviewText = ''
  const hasIncomplete = incompleteData.length > 0

  if (compatLevel === '配置良好') {
    reviewText = `本區植栽配置計畫，選用植栽包含 ${plantNames}，整體配置相容性評估分數為 ${score}/100，評估結果為「配置良好」。\n\n所選植栽在水分需求、日照條件及排水特性上具備良好的相容性，適合於同一區塊配置。植栽養護需求相近，可採統一養護方式管理，預期能以較低成本維持良好的景觀品質。${hasIncomplete ? `\n\n另有部分植栽資料屬初步判定（${incompleteData.map(p => p.name).join('、')}），建議補查官方資料來源後確認，以利後續審查引用。` : ''}\n\n建議施工單位依景觀設計圖說之種植間距與覆土深度規範施工，竣工後第一年建議定期補充有機肥料，並依季節調整灌溉頻率，以確保植栽穩定生長。`
  } else if (compatLevel === '可行但需補充說明') {
    const notes = allCaution.map(i => `${i.category}：${i.cause}`).join('\n')
    reviewText = `本區植栽配置計畫，選用植栽包含 ${plantNames}，整體配置相容性評估分數為 ${score}/100，評估結果為「可行，但需補充養護說明」。\n\n本配置計畫整體可行，惟部分植栽在下列項目上存在差異，須補充說明：\n\n${notes}\n\n針對上述差異，本設計團隊建議透過以下方式予以解決：\n${adjustmentPlan.map(p => `• ${p}`).join('\n')}\n\n相關養護管理措施將納入景觀竣工說明書及物業養護合約，以確保植栽生長穩定及景觀品質。因此，本配置原則上仍具可行性，惟建議補充養護管理說明。`
  } else {
    const dangerNotes = allDanger.map(i => `${i.category}：${i.cause}`).join('\n')
    reviewText = `本區植栽配置計畫，選用植栽包含 ${plantNames}，整體配置相容性評估分數為 ${score}/100，評估結果為「${compatLevel}」。\n\n本配置計畫目前存在以下需優先處理之問題：\n\n${dangerNotes}\n\n本設計團隊將依評估建議進行配置調整，修正方向如下：\n${adjustmentPlan.map(p => `• ${p}`).join('\n')}\n\n修正後之配置計畫將於調整完成後另案說明，敬請審查委員惠予指導。`
  }

  return { score, compatLevel, categories, issues, alternatives, aiSuggestion, adjustmentPlan, reviewText }
}

// ── Visual constants ──────────────────────────────────────────────────────────

const COMPAT_COLOR: Record<CompatLevel, string> = {
  '配置良好': 'text-emerald-700 border-emerald-300 bg-emerald-50',
  '可行但需補充說明': 'text-amber-700 border-amber-300 bg-amber-50',
  '需調整配置': 'text-orange-700 border-orange-300 bg-orange-50',
  '高風險不建議': 'text-red-800 border-red-300 bg-red-50',
}
const COMPAT_RING: Record<CompatLevel, string> = {
  '配置良好': 'stroke-emerald-500',
  '可行但需補充說明': 'stroke-amber-500',
  '需調整配置': 'stroke-orange-500',
  '高風險不建議': 'stroke-red-500',
}
const LEVEL_CARD = {
  ok:      { bg: 'bg-emerald-50', border: 'border-emerald-100', count: 'text-emerald-600' },
  caution: { bg: 'bg-amber-50',   border: 'border-amber-200',   count: 'text-amber-700'   },
  danger:  { bg: 'bg-orange-50',  border: 'border-orange-200',  count: 'text-orange-700'  },
}
const LEVEL_ICON_SM = {
  ok:      <CheckCircle  size={13} className="text-emerald-500 flex-shrink-0" />,
  caution: <AlertTriangle size={13} className="text-amber-500  flex-shrink-0" />,
  danger:  <XCircle      size={13} className="text-orange-600 flex-shrink-0" />,
}
const CAT_COLOR: Record<string, string> = {
  '喬木': 'bg-teal-50 text-teal-700', '大喬木': 'bg-teal-50 text-teal-700',
  '灌木': 'bg-green-50 text-green-700',
  '草本': 'bg-lime-50 text-lime-700',
  tree: 'bg-teal-50 text-teal-700', shrub: 'bg-green-50 text-green-700', groundcover: 'bg-lime-50 text-lime-700',
}
const CAT_LABEL: Record<string, string> = { tree: '喬木', shrub: '灌木', groundcover: '草本' }
const STATUS_COLOR: Record<PlantStatus, string> = {
  '可用': 'bg-emerald-50 text-emerald-700 border-emerald-200',
  '需注意': 'bg-amber-50 text-amber-700 border-amber-200',
  '不建議': 'bg-orange-50 text-orange-700 border-orange-200',
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ScoreDial({ score, level }: { score: number; level: CompatLevel }) {
  const R = 44; const C = 2 * Math.PI * R
  return (
    <div className="flex items-center gap-6">
      <div className="relative w-28 h-28 flex-shrink-0">
        <svg className="w-28 h-28 -rotate-90" viewBox="0 0 112 112">
          <circle cx="56" cy="56" r={R} fill="none" strokeWidth="8" className="stroke-stone-200" />
          <circle cx="56" cy="56" r={R} fill="none" strokeWidth="8"
            className={COMPAT_RING[level]}
            strokeDasharray={C} strokeDashoffset={C - (score / 100) * C} strokeLinecap="round" />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-3xl font-bold text-stone-800 leading-none">{score}</span>
          <span className="text-xs text-stone-400 mt-0.5">/ 100</span>
        </div>
      </div>
      <div>
        <p className="text-xs text-stone-400 mb-1.5 tracking-wide">植栽配置相容性分數</p>
        <span className={`inline-block px-3 py-1.5 rounded-full text-sm font-semibold border ${COMPAT_COLOR[level]}`}>{level}</span>
        <p className="text-xs text-stone-400 mt-2 leading-relaxed">
          {score >= 80 ? '各項植栽相容性佳，養護管理負擔低。'
            : score >= 60 ? '整體可行，部分項目需補充養護說明。'
            : score >= 40 ? '植栽衝突較多，建議調整組合再行配置。'
            : '高風險，強烈建議重新規劃植栽配置。'}
        </p>
      </div>
    </div>
  )
}

function CategoryGrid({ categories, altCount }: { categories: CatSummary[]; altCount: number }) {
  const altCard: CatSummary = {
    key: '替代植栽建議', label: '替代植栽建議', count: altCount,
    level: altCount > 0 ? 'caution' : 'ok',
    statusLabel: altCount > 0 ? '可替換' : '無需替換',
    summary: altCount > 0 ? `共 ${altCount} 種植栽有相容性更佳的替代選項。` : '目前植栽組合無需替換。',
  }
  return (
    <div className="grid grid-cols-2 gap-3">
      {[...categories, altCard].map(c => {
        const s = LEVEL_CARD[c.level]
        return (
          <div key={c.key} className={`rounded-xl border p-3.5 ${s.bg} ${s.border}`}>
            <div className="flex items-start gap-2 mb-1">
              {LEVEL_ICON_SM[c.level]}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-stone-700 leading-tight">{c.label}</p>
                <p className={`text-xs font-medium mt-0.5 ${s.count}`}>
                  {c.count > 0 ? `${c.count} 項　` : ''}{c.statusLabel}
                </p>
              </div>
            </div>
            <p className="text-xs text-stone-500 leading-relaxed line-clamp-2">{c.summary}</p>
          </div>
        )
      })}
    </div>
  )
}

function IssueCard({ issue }: { issue: IssueDetail }) {
  const [open, setOpen] = useState(true)
  // 高風險：淡紅；中風險（caution）：淡橘
  const hdr = issue.level === 'danger'
    ? 'bg-red-50 border-red-100 text-red-800'
    : 'bg-orange-50 border-orange-100 text-orange-800'
  const bdr = issue.level === 'danger' ? 'border-red-200' : 'border-orange-200'
  return (
    <div className={`border rounded-xl overflow-hidden shadow-sm ${bdr}`}>
      {/* 標題列 */}
      <button onClick={() => setOpen(o => !o)}
        className={`w-full flex items-center justify-between px-6 py-4 ${hdr} min-h-[52px]`}>
        <div className="flex items-center gap-3">
          {issue.level === 'danger'
            ? <XCircle size={18} className="text-red-600 flex-shrink-0" />
            : <AlertTriangle size={18} className="text-orange-600 flex-shrink-0" />}
          <span className="font-bold text-[18px] leading-snug">{issue.category}</span>
          <span className={`text-[13px] px-3 py-1 rounded-full border font-bold ${
            issue.level === 'danger'
              ? 'bg-red-100 border-red-300 text-red-700'
              : 'bg-orange-100 border-orange-300 text-orange-700'
          }`}>{issue.level === 'danger' ? '高風險' : '需注意'}</span>
        </div>
        {open ? <ChevronUp size={16} className="flex-shrink-0" /> : <ChevronDown size={16} className="flex-shrink-0" />}
      </button>

      {/* 展開內容 */}
      {open && (
        <div className="px-6 py-5 space-y-5 bg-white">
          {[
            { label: '■ 問題原因', text: issue.cause },
            { label: '■ 實務影響', text: issue.impact },
            { label: '■ AI 修正建議', text: issue.suggestion },
          ].map(row => (
            <div key={row.label}>
              <p className="text-[15px] font-semibold text-stone-600 mb-2 tracking-wide">{row.label}</p>
              <p className="text-[15px] text-stone-800 leading-[1.85]">{row.text}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function AltCard({ suggestion }: { suggestion: AltSuggestion }) {
  const [open, setOpen] = useState(true)
  const p = suggestion.originalPlant
  return (
    <div className="border border-stone-200 rounded-xl overflow-hidden">
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 bg-stone-50 hover:bg-stone-100 transition-colors">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <Leaf size={13} className="text-stone-400 flex-shrink-0" />
          <span className="font-semibold text-sm text-stone-800">{p.name}</span>
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${CAT_COLOR[p.category] ?? 'bg-stone-100 text-stone-600'}`}>
            {p.subCategory || p.category}
          </span>
          {suggestion.problemLabels.map(l => (
            <span key={l} className="text-xs px-2 py-0.5 rounded-full bg-orange-50 border border-orange-200 text-orange-700 font-medium flex-shrink-0">{l}</span>
          ))}
        </div>
        {open ? <ChevronUp size={14} className="text-stone-400 flex-shrink-0 ml-2" /> : <ChevronDown size={14} className="text-stone-400 flex-shrink-0 ml-2" />}
      </button>
      {open && (
        <div className="p-4 space-y-3 bg-white">
          {suggestion.alternatives.map((alt, i) => (
            <div key={alt.plant.id} className="flex gap-3">
              <div className="w-6 h-6 rounded-full bg-green-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                <span className="text-xs font-bold text-green-700">{i + 1}</span>
              </div>
              <div className="flex-1 bg-green-50 border border-green-100 rounded-xl p-3">
                <div className="flex items-center gap-2 flex-wrap mb-1.5">
                  <ArrowRight size={12} className="text-green-500 flex-shrink-0" />
                  <span className="font-semibold text-stone-800 text-sm">{alt.plant.name}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${CAT_COLOR[alt.plant.category] ?? 'bg-stone-100 text-stone-600'}`}>
                    {alt.plant.subCategory || alt.plant.category}
                  </span>
                  {alt.plant.scientificName && <span className="text-xs text-stone-400 italic">{alt.plant.scientificName}</span>}
                </div>
                <div className="flex gap-3 text-xs text-stone-500 mb-2 flex-wrap">
                  <span>日照：{alt.plant.sunRequirement}</span>
                  <span>水分：{alt.plant.waterRequirement}</span>
                  <span>耐濕：{alt.plant.wetTolerance}</span>
                  <span>維護：{alt.plant.maintenanceLevel}</span>
                  {!alt.plant.dataComplete && <span className="text-amber-600 font-medium">⚠ 資料初步判定</span>}
                </div>
                <p className="text-xs text-stone-600 leading-relaxed mb-1"><span className="font-medium text-stone-500">替代理由：</span>{alt.reason}</p>
                <p className="text-xs text-green-700 leading-relaxed"><span className="font-medium">可降低風險：</span>{alt.riskReduction}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SelectedPlantCard({ plant, onRemove, imageStore }: {
  plant: SelectedCsvPlant; onRemove: () => void; imageStore?: ImageStore
}) {
  const imgData = imageStore?.[plant.name]
  const imgSrc = imgData?.uploadedDataUrl ?? imgData?.imageUrl ?? `/plant-images/${encodeURIComponent(plant.name)}.jpg`
  const [imgErr, setImgErr] = useState(false)

  return (
    <div className="bg-white border border-stone-200 rounded-xl overflow-hidden relative group hover:border-[#2d6a4f]/50 hover:shadow-md transition-all flex flex-col">
      {/* 移除按鈕 */}
      <button onClick={onRemove}
        className="absolute top-2 right-2 z-10 w-6 h-6 rounded-full bg-white/80 backdrop-blur-sm flex items-center justify-center text-stone-400 hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-all shadow-sm">
        <X size={12} />
      </button>

      {/* 植物照片 */}
      <div className="h-28 relative overflow-hidden bg-[#d8f3dc] flex-shrink-0">
        {!imgErr
          ? <img src={imgSrc} alt={plant.name} className="w-full h-full object-cover" onError={() => setImgErr(true)} />
          : <div className="w-full h-full flex items-center justify-center">
              <Leaf size={28} className="text-[#2d6a4f] opacity-40" />
            </div>
        }
        {/* 類型 badge 懸浮在照片上 */}
        <div className="absolute top-1.5 left-1.5">
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold shadow-sm ${CAT_COLOR[plant.subCategory] ?? CAT_COLOR[plant.category] ?? 'bg-stone-100 text-stone-600'}`}>
            {plant.subCategory || plant.category}
          </span>
        </div>
      </div>

      {/* 資訊區 */}
      <div className="p-2.5 flex-1 flex flex-col gap-1.5">
        <div>
          <p className="font-bold text-stone-800 text-sm leading-tight truncate">{plant.name}</p>
          {plant.scientificName
            ? <p className="text-[10px] text-stone-400 italic truncate">{plant.scientificName}</p>
            : <p className="text-[10px] text-stone-300">—</p>
          }
        </div>
        {/* 狀態 badges */}
        <div className="flex gap-1 flex-wrap">
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full border font-medium ${STATUS_COLOR[plant.status]}`}>{plant.status}</span>
          {!plant.dataComplete && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-stone-100 border border-stone-200 text-stone-400 font-medium">資料待補</span>
          )}
        </div>
        {/* 綠色方格程度顯示 */}
        <div className="space-y-1 mt-auto">
          <RatingBar label="日照" score={toSunScore(plant.sunRequirement)} />
          <RatingBar label="水分" score={toWaterBar(plant.waterRequirement)} />
          <RatingBar label="耐旱" score={toDroughtBar(plant.droughtTolerance)} />
        </div>
      </div>
    </div>
  )
}

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden shadow-sm">
      <div className="flex items-center justify-between px-5 py-3 bg-[#f7f5f0] border-b border-stone-100">
        <p className="text-sm font-semibold text-stone-800 tracking-wide">{title}</p>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </div>
  )
}

// ── Plant Database Modal ──────────────────────────────────────────────────────

// ── PlantImage with error fallback ───────────────────────────────────────────

function PlantImage({ src, alt, fallbackClass, iconColor }: {
  src: string; alt: string; fallbackClass: string; iconColor: string
}) {
  // 若 src 是靜態路徑（/plant-images/名稱.jpg），失敗時依序嘗試 avif → webp → placeholder
  const isStatic = src.startsWith('/plant-images/')
  const baseName = isStatic ? src.replace(/\.[^.]+$/, '') : null
  const [tryIdx, setTryIdx] = useState(0)
  const exts = ['.jpg', '.avif', '.webp']
  const currentSrc = baseName ? `${baseName}${exts[tryIdx]}` : src
  const allFailed = tryIdx >= exts.length

  if (allFailed) {
    return (
      <div className={`absolute inset-0 flex items-center justify-center ${fallbackClass}`}>
        <Leaf size={40} className={`opacity-30 ${iconColor}`} />
      </div>
    )
  }
  return (
    <img
      src={currentSrc} alt={alt}
      className="absolute inset-0 w-full h-full object-cover"
      onError={() => {
        if (isStatic && tryIdx < exts.length - 1) setTryIdx(i => i + 1)
        else setTryIdx(exts.length) // mark all failed
      }}
    />
  )
}

// ── Plant image placeholder ───────────────────────────────────────────────────

const CARD_BG: Record<string, string> = {
  '大喬木': 'from-teal-100 to-teal-50',
  '小喬木': 'from-cyan-100 to-cyan-50',
  '喬木': 'from-teal-100 to-teal-50',
  '灌木': 'from-green-100 to-green-50',
  '草本': 'from-lime-100 to-lime-50',
  '地被': 'from-emerald-100 to-emerald-50',
  '草皮': 'from-green-100 to-emerald-50',
}
const CARD_ICON_COLOR: Record<string, string> = {
  '大喬木': 'text-teal-500', '小喬木': 'text-cyan-500', '喬木': 'text-teal-500',
  '灌木': 'text-green-500', '草本': 'text-lime-600', '地被': 'text-emerald-500', '草皮': 'text-green-500',
}

// ── Rating score helpers ──────────────────────────────────────────────────────

function toSunScore(val: string): number {
  if (!val || val === '待查') return 0
  if (val.includes('全日照') && val.includes('半')) return 4
  if (val.includes('全日照')) return 5
  if (val.includes('半日照') && val.includes('遮')) return 2
  if (val.includes('半日照')) return 3
  if (val.includes('遮陰') || val.includes('耐陰')) return 1
  return 0
}

function toWaterBar(val: string): number {
  const m: Record<string, number> = { '低': 1, '低至中': 2, '中': 3, '中至高': 4, '高': 5, '待查': 0 }
  return m[val] ?? 0
}

function toDroughtBar(val: string): number {
  if (!val || val === '待查') return 0
  if (val.includes('不耐旱')) return 1
  if (val.includes('稍耐旱')) return 2
  if (val.includes('耐旱') && !val.includes('不') && !val.includes('稍')) return 4
  return 0
}

function toMainBar(val: string): number {
  const m: Record<string, number> = { '低': 1, '中': 3, '高': 5, '待查': 0 }
  return m[val] ?? 0
}

function toWetRiskBar(val: string): number {
  if (val === '不耐積水') return 5
  if (val === '稍耐濕') return 3
  if (val === '耐濕') return 1
  return 0
}

// ── RatingBar ─────────────────────────────────────────────────────────────────

function RatingBar({ label, score, max = 5 }: { label: string; score: number; max?: number }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-stone-500 font-medium w-5 flex-shrink-0 leading-none">{label}</span>
      <div className="flex gap-0.5">
        {Array.from({ length: max }, (_, i) => (
          <div key={i} className={`w-3.5 h-3.5 rounded-sm transition-colors ${
            score === 0 ? 'bg-stone-100' :
            i < score ? 'bg-green-400' : 'bg-stone-200'
          }`} />
        ))}
      </div>
      {score === 0 && <span className="text-[10px] text-stone-300 ml-0.5">待補</span>}
    </div>
  )
}

// ── Suitability badge logic ───────────────────────────────────────────────────

function getSuitability(plant: CsvPlantRecord): { label: string; cls: string } {
  const danger = plant.riskTags.filter(t =>
    t.includes('積水') || t.includes('病蟲') || t.includes('不耐積水') || t.includes('高')
  ).length
  if (danger >= 2 || plant.maintenanceLevel === '高') {
    return { label: '需評估', cls: 'bg-orange-50 text-orange-700 border-orange-200' }
  }
  if (plant.riskTags.length >= 3 || !plant.dataComplete) {
    return { label: '注意', cls: 'bg-amber-50 text-amber-700 border-amber-200' }
  }
  return { label: '適合', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' }
}

// ── PlantCardItem ──────────────────────────────────────────────────────────────

function PlantCardItem({ plant, imageData, added, fresh, isActive, onDetail, onAdd }: {
  plant: CsvPlantRecord
  imageData?: PlantImageData
  added: boolean
  fresh: boolean
  isActive: boolean
  onDetail: () => void
  onAdd: () => void
}) {
  const approvedUrl = (!imageData?.imageReviewStatus || imageData.imageReviewStatus === 'approved')
    ? imageData?.imageUrl : undefined
  // 優先 jpg，fallback 到 avif / webp（由 <img> onError 自動切換）
  const staticUrl = `/plant-images/${encodeURIComponent(plant.name)}.jpg`
  const imgSrc = imageData?.uploadedDataUrl ?? approvedUrl ?? staticUrl
  const bgGrad = CARD_BG[plant.subCategory] ?? CARD_BG[plant.category] ?? 'from-stone-100 to-stone-50'
  const iconColor = CARD_ICON_COLOR[plant.subCategory] ?? CARD_ICON_COLOR[plant.category] ?? 'text-stone-400'
  const suitability = getSuitability(plant)
  const visibleTags = plant.riskTags.slice(0, 3)
  const extraTags = plant.riskTags.length - 3

  return (
    <div
      onClick={onDetail}
      className={`bg-white rounded-2xl border overflow-hidden flex flex-col cursor-pointer transition-all hover:shadow-lg ${
        isActive ? 'border-green-400 shadow-md ring-2 ring-green-200' : 'border-stone-200 hover:border-green-300'
      }`}>

      {/* ① Image */}
      <div className={`h-36 relative overflow-hidden ${!imgSrc ? `bg-gradient-to-b ${bgGrad}` : 'bg-stone-100'} flex items-center justify-center flex-shrink-0`}>
        {imgSrc
          ? <PlantImage src={imgSrc} alt={plant.name} fallbackClass={`bg-gradient-to-b ${bgGrad}`} iconColor={iconColor} />
          : <Leaf size={36} className={`opacity-25 ${iconColor}`} />
        }
        {/* Overlay badges */}
        <div className="absolute top-2 left-2 flex gap-1.5 flex-wrap">
          <span className={`text-xs px-2 py-0.5 rounded-full font-semibold shadow-sm backdrop-blur-sm ${CAT_COLOR[plant.category] ?? 'bg-stone-100 text-stone-600'}`}>
            {plant.subCategory || plant.category}
          </span>
        </div>
        <div className="absolute top-2 right-2 flex gap-1">
          {plant.nativeStatus.includes('原生') && (
            <span className="text-xs px-1.5 py-0.5 rounded-full bg-emerald-100/90 text-emerald-700 font-medium shadow-sm">原生</span>
          )}
          <span className={`text-xs px-1.5 py-0.5 rounded-full border font-medium shadow-sm backdrop-blur-sm ${suitability.cls}`}>
            {suitability.label}
          </span>
        </div>
        {!plant.dataComplete && (
          <div className="absolute bottom-1.5 right-1.5">
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100/90 text-amber-700 font-medium">⚠ 資料初步</span>
          </div>
        )}
      </div>

      {/* ② Name */}
      <div className="px-3.5 pt-3 pb-1">
        <p className="font-bold text-stone-900 text-[15px] leading-tight">{plant.name}</p>
        {plant.scientificName && (
          <p className="text-[11px] text-stone-400 italic mt-0.5 truncate">{plant.scientificName}</p>
        )}
      </div>

      {/* ③ Rating bars with icons */}
      <div className="px-3.5 pb-3 grid grid-cols-2 gap-x-2 gap-y-1.5">
        {([
          { icon: '☀️', label: '日照', score: toSunScore(plant.sunRequirement) },
          { icon: '💧', label: '水分', score: toWaterBar(plant.waterRequirement) },
          { icon: '🌱', label: '排水', score: toWetRiskBar(plant.wetTolerance) },
          { icon: '🔥', label: '耐旱', score: toDroughtBar(plant.droughtTolerance) },
          { icon: '🛠', label: '維護', score: toMainBar(plant.maintenanceLevel) },
        ] as { icon: string; label: string; score: number }[]).map(({ icon, label, score }) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap', flexShrink: 0 }}>
            <span style={{ fontSize: 12, flexShrink: 0, lineHeight: 1 }}>{icon}</span>
            <span style={{ fontSize: 11, color: '#78716c', fontWeight: 500, flexShrink: 0, minWidth: 28, whiteSpace: 'nowrap' }}>{label}</span>
            <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
              {Array.from({ length: 5 }, (_, i) => (
                <div key={i} style={{
                  width: 10, height: 10, borderRadius: 2, flexShrink: 0,
                  backgroundColor: score === 0 ? '#f5f5f4' : i < score ? '#4ade80' : '#e7e5e4'
                }} />
              ))}
            </div>
            {score === 0 && <span style={{ fontSize: 9, color: '#d6d3d1' }}>待補</span>}
          </div>
        ))}
      </div>

      {/* ④ Risk chips */}
      {plant.riskTags.length > 0 && (
        <div className="px-3.5 pb-2 flex flex-wrap gap-1 min-h-[24px]">
          {visibleTags.map(t => (
            <span key={t} className="text-[10px] px-2 py-0.5 rounded-full bg-orange-50 border border-orange-200 text-orange-700 font-medium">{t}</span>
          ))}
          {extraTags > 0 && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-stone-100 text-stone-500 font-medium">+{extraTags}</span>
          )}
        </div>
      )}

      {/* ⑤ Buttons */}
      <div className="px-3 pb-3 mt-auto flex gap-2">
        <button
          onClick={e => { e.stopPropagation(); onDetail() }}
          className={`flex-1 py-2.5 rounded-xl text-sm font-medium border transition-colors ${
            isActive ? 'bg-stone-700 text-white border-transparent' : 'border-stone-200 text-stone-600 hover:bg-stone-50'
          }`}>
          {isActive ? '收起' : '詳情'}
        </button>
        <button
          onClick={e => { e.stopPropagation(); onAdd() }}
          disabled={added}
          className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-colors ${
            fresh ? 'bg-emerald-500 text-white' :
            added ? 'bg-stone-100 text-stone-400 cursor-not-allowed' :
            'bg-green-700 text-white hover:bg-green-800'
          }`}>
          {fresh ? '✓ 已加入' : added ? '已在組合' : '加入'}
        </button>
      </div>
    </div>
  )
}

// ── Detail drawer (right panel inside the DB modal) ───────────────────────────

function PlantDetailDrawer({ plant, onClose, onAdd, added, imageData, onSaveImage }: {
  plant: CsvPlantRecord
  onClose: () => void
  onAdd: () => void
  added: boolean
  imageData?: PlantImageData
  onSaveImage: (data: Partial<PlantImageData>) => void
}) {
  const [urlInput, setUrlInput]     = useState(imageData?.imageUrl ?? '')
  const [sourceInput, setSourceInput] = useState(imageData?.imageSource ?? '')
  const [creditInput, setCreditInput] = useState(imageData?.imageCredit ?? '')
  const [uploadErr, setUploadErr]   = useState('')
  const [saving, setSaving]         = useState(false)
  const [imgError, setImgError]     = useState(false)
  const [showImgEdit, setShowImgEdit] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const staticImgUrl = `/plant-images/${encodeURIComponent(plant.name)}.jpg`
  const effectiveImg = !imgError
    ? (imageData?.uploadedDataUrl ?? imageData?.imageUrl ?? (urlInput.trim() || undefined) ?? staticImgUrl)
    : undefined

  const handleSaveUrl = () => {
    setSaving(true)
    onSaveImage({ imageUrl: urlInput.trim(), imageSource: sourceInput.trim(), imageCredit: creditInput.trim() })
    setImgError(false)
    setTimeout(() => setSaving(false), 800)
  }
  const handleUpload = async (file: File) => {
    setUploadErr('')
    try {
      const dataUrl = await readImageFile(file)
      onSaveImage({ uploadedDataUrl: dataUrl, imageSource: sourceInput.trim(), imageCredit: creditInput.trim() })
      setImgError(false)
    } catch (e: any) { setUploadErr(e.message ?? '上傳失敗') }
  }
  const handleClear = () => {
    setUrlInput('')
    onSaveImage({ imageUrl: undefined, uploadedDataUrl: undefined })
    setImgError(false)
  }

  const suitability = getSuitability(plant)
  const bgGrad = CARD_BG[plant.subCategory] ?? CARD_BG[plant.category] ?? 'from-stone-100 to-stone-50'
  const iconColor = CARD_ICON_COLOR[plant.subCategory] ?? CARD_ICON_COLOR[plant.category] ?? 'text-stone-400'

  return (
    <div className="absolute inset-y-0 right-0 w-[420px] bg-white shadow-2xl flex flex-col border-l border-stone-200 z-10">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-stone-100 flex-shrink-0">
        <div className="flex-1 min-w-0 pr-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${CAT_COLOR[plant.category] ?? 'bg-stone-100 text-stone-600'}`}>
              {plant.subCategory || plant.category}
            </span>
            <span className={`text-xs px-2 py-0.5 rounded-full border font-semibold ${suitability.cls}`}>
              {suitability.label}
            </span>
            {!plant.dataComplete && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-600">資料初步判定</span>
            )}
          </div>
          <h3 className="text-lg font-bold text-stone-900 mt-1 leading-tight">{plant.name}</h3>
          {plant.scientificName && <p className="text-xs text-stone-400 italic">{plant.scientificName}</p>}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button onClick={onAdd} disabled={added}
            className={`px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${
              added ? 'bg-stone-100 text-stone-400 cursor-not-allowed' : 'bg-green-700 text-white hover:bg-green-800'
            }`}>
            {added ? '已加入' : '加入配置'}
          </button>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-600 p-1"><X size={18} /></button>
        </div>
      </div>

      {/* Body */}
      <div className="overflow-y-auto flex-1 p-5 space-y-5">

        {/* ① Photo */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold text-stone-500 uppercase tracking-wide">植物照片</p>
            <button onClick={() => setShowImgEdit(v => !v)}
              className="text-xs text-green-700 hover:text-green-800 font-medium">
              {showImgEdit ? '收起編輯' : '編輯圖片'}
            </button>
          </div>
          <div className="w-full aspect-[4/3] rounded-xl overflow-hidden relative mb-2">
            {effectiveImg ? (
              <img src={effectiveImg} alt={plant.name} className="w-full h-full object-cover"
                onError={() => setImgError(true)} />
            ) : (
              <div className={`w-full h-full flex flex-col items-center justify-center gap-2 bg-gradient-to-b ${bgGrad}`}>
                <Leaf size={40} className={`opacity-20 ${iconColor}`} />
                <p className="text-xs text-stone-400">尚無照片</p>
              </div>
            )}
            {effectiveImg && (
              <button onClick={handleClear}
                className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/50 text-white flex items-center justify-center hover:bg-black/70">
                <X size={13} />
              </button>
            )}
            {imgError && !imageData?.uploadedDataUrl && (
              <div className="absolute bottom-2 left-2 right-2 bg-amber-50/90 rounded-lg px-2 py-1 text-xs text-amber-700 text-center">
                圖片載入失敗
              </div>
            )}
          </div>
          {(imageData?.imageSource || imageData?.imageCredit) && (
            <p className="text-[11px] text-stone-400 mb-2">
              {imageData.imageSource}{imageData.imageCredit ? `　${imageData.imageCredit}` : ''}
            </p>
          )}

          {/* Image editor (collapsible) */}
          {showImgEdit && (
            <div className="space-y-2.5 bg-stone-50 rounded-xl p-3">
              <div>
                <p className="text-xs text-stone-500 mb-1 font-medium">圖片網址</p>
                <div className="flex gap-2">
                  <input type="url" value={urlInput} onChange={e => setUrlInput(e.target.value)}
                    placeholder="https://..."
                    className="flex-1 px-3 py-2 border border-stone-200 rounded-lg text-xs bg-white focus:outline-none focus:border-green-400 focus:ring-1 focus:ring-green-200" />
                  <button onClick={handleSaveUrl}
                    className={`px-3 py-2 rounded-lg text-xs font-medium flex-shrink-0 ${saving ? 'bg-emerald-500 text-white' : 'bg-green-700 text-white hover:bg-green-800'}`}>
                    {saving ? '✓' : '套用'}
                  </button>
                </div>
              </div>
              <div>
                <p className="text-xs text-stone-500 mb-1 font-medium">上傳圖片（最大 2 MB）</p>
                <button onClick={() => fileRef.current?.click()}
                  className="w-full py-2 border-2 border-dashed border-stone-200 rounded-lg text-xs text-stone-500 hover:border-green-400 hover:bg-white transition-colors flex items-center justify-center gap-1.5">
                  <Upload size={12} />選擇圖片檔案
                </button>
                <input ref={fileRef} type="file" accept="image/*" className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f); e.target.value = '' }} />
                {uploadErr && <p className="text-xs text-orange-600 mt-1">{uploadErr}</p>}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <p className="text-[11px] text-stone-400 mb-1">圖片來源</p>
                  <input type="text" value={sourceInput} onChange={e => setSourceInput(e.target.value)}
                    placeholder="來源說明" className="w-full px-2 py-1.5 border border-stone-200 rounded-lg text-xs bg-white focus:outline-none focus:border-green-400" />
                </div>
                <div>
                  <p className="text-[11px] text-stone-400 mb-1">授權備註</p>
                  <input type="text" value={creditInput} onChange={e => setCreditInput(e.target.value)}
                    placeholder="© 授權說明" className="w-full px-2 py-1.5 border border-stone-200 rounded-lg text-xs bg-white focus:outline-none focus:border-green-400" />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ② 快速判讀 */}
        <div className="bg-stone-50 rounded-xl p-4 space-y-3">
          <p className="text-xs font-semibold text-stone-500 uppercase tracking-wide">快速判讀</p>
          <div className="flex items-center gap-3">
            <span className={`px-3 py-1 rounded-full text-sm font-bold border ${suitability.cls}`}>
              {suitability.label}
            </span>
            <span className="text-sm text-stone-600">{plant.maintenanceLevel !== '待查' ? `維護需求${plant.maintenanceLevel}` : '維護資料待補'}</span>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <RatingBar label="日照" score={toSunScore(plant.sunRequirement)} />
            <RatingBar label="水分" score={toWaterBar(plant.waterRequirement)} />
            <RatingBar label="耐旱" score={toDroughtBar(plant.droughtTolerance)} />
            <RatingBar label="維護" score={toMainBar(plant.maintenanceLevel)} />
            <RatingBar label="排水" score={toWetRiskBar(plant.wetTolerance)} />
          </div>
          {plant.riskTags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {plant.riskTags.map(t => (
                <span key={t} className="text-xs px-2.5 py-1 rounded-full bg-orange-50 border border-orange-200 text-orange-700 font-medium">{t}</span>
              ))}
            </div>
          )}
        </div>

        {/* ③ 環境需求 */}
        <div>
          <p className="text-xs font-semibold text-stone-500 mb-3 uppercase tracking-wide">環境需求</p>
          <div className="grid grid-cols-2 gap-2">
            {[
              { label: '日照需求', value: plant.sunRequirement },
              { label: '水分需求', value: plant.waterRequirement },
              { label: '耐旱性',   value: plant.droughtTolerance },
              { label: '耐濕性',   value: plant.wetTolerance },
            ].map(f => (
              <div key={f.label} className="bg-white border border-stone-100 rounded-xl px-3 py-2.5">
                <p className="text-xs text-stone-400">{f.label}</p>
                <p className={`text-sm font-bold mt-0.5 ${f.value === '待查' ? 'text-amber-500' : 'text-stone-800'}`}>{f.value}</p>
              </div>
            ))}
          </div>
        </div>

        {/* ④ 植株規格 */}
        <div>
          <p className="text-xs font-semibold text-stone-500 mb-3 uppercase tracking-wide">植株規格</p>
          <div className="grid grid-cols-2 gap-2">
            {[
              { label: '樹高',     value: plant.height },
              { label: '樹冠',     value: plant.crownWidth },
              { label: '覆土深度', value: plant.soilDepth },
              { label: '種植株距', value: plant.plantingSpacing },
              { label: '台灣原生', value: plant.nativeStatus },
              { label: '誘鳥誘蝶', value: plant.biodiversityValue ? '是' : '' },
              { label: '米徑',     value: plant.trunkDiameter },
              { label: '參考價格', value: plant.price },
            ].filter(f => f.value).map(f => (
              <div key={f.label} className="bg-white border border-stone-100 rounded-xl px-3 py-2.5">
                <p className="text-xs text-stone-400">{f.label}</p>
                <p className="text-sm font-medium text-stone-700 mt-0.5 truncate">{f.value}</p>
              </div>
            ))}
          </div>
        </div>

        {/* ⑤ 養護管理 */}
        {plant.maintenanceNote && (
          <div>
            <p className="text-xs font-semibold text-stone-500 mb-2 uppercase tracking-wide">養護管理</p>
            <p className="text-sm text-stone-600 leading-relaxed bg-stone-50 rounded-xl p-3">{plant.maintenanceNote}</p>
          </div>
        )}

        {/* ⑥ 審查說明 */}
        <div>
          <p className="text-xs font-semibold text-stone-500 mb-2 uppercase tracking-wide">審查說明文字</p>
          <p className="text-sm text-stone-600 leading-relaxed bg-green-50 border border-green-100 rounded-xl p-3">{plant.reviewNote}</p>
        </div>

        {/* ⑦ 資料來源 */}
        <div className="border border-stone-100 rounded-xl p-3 space-y-1.5">
          <p className="text-xs font-semibold text-stone-400 uppercase tracking-wide">資料來源與查核</p>
          {plant.sunWaterSource && <p className="text-xs text-stone-500">來源：{plant.sunWaterSource}</p>}
          {plant.verificationStatus && (
            <p className="text-xs text-stone-500">
              判定：<span className={plant.verificationStatus.includes('初步') ? 'text-amber-600 font-medium' : 'text-green-600'}>
                {plant.verificationStatus}
              </span>
            </p>
          )}
          {plant.verifiedAt && <p className="text-xs text-stone-500">查核日期：{plant.verifiedAt}</p>}
          {plant.verificationSummary && <p className="text-xs text-stone-500 leading-relaxed">{plant.verificationSummary}</p>}
          {plant.sunWaterSourceUrl && (
            <a href={plant.sunWaterSourceUrl} target="_blank" rel="noreferrer"
              className="flex items-center gap-1 text-xs text-green-700 hover:underline">
              <ExternalLink size={11} />官方資料連結
            </a>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Keep old PlantDetailModal signature for compatibility ─────────────────────
function PlantDetailModal({ plant, onClose, onAdd, added }: {
  plant: CsvPlantRecord; onClose: () => void; onAdd: () => void; added: boolean
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-stone-100">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-bold text-stone-800">{plant.name}</h2>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${CAT_COLOR[plant.category] ?? 'bg-stone-100 text-stone-600'}`}>
                {plant.subCategory || plant.category}
              </span>
              {!plant.dataComplete && <span className="text-xs px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-600">資料初步判定</span>}
            </div>
            {plant.scientificName && <p className="text-sm text-stone-400 italic mt-0.5">{plant.scientificName}</p>}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onAdd} disabled={added}
              className={`px-4 py-2 rounded-xl text-sm font-medium ${added ? 'bg-stone-100 text-stone-400 cursor-not-allowed' : 'bg-green-700 text-white hover:bg-green-800'}`}>
              {added ? '已加入' : '加入配置'}
            </button>
            <button onClick={onClose} className="text-stone-400 hover:text-stone-600"><X size={20} /></button>
          </div>
        </div>
        <div className="overflow-y-auto flex-1 p-5 space-y-5">
          {/* Tolerance */}
          <div>
            <p className="text-xs font-semibold text-stone-400 mb-2 uppercase tracking-wide">環境條件</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                { label: '日照需求', value: plant.sunRequirement },
                { label: '水分需求', value: plant.waterRequirement },
                { label: '耐旱性', value: plant.droughtTolerance },
                { label: '耐濕性', value: plant.wetTolerance },
              ].map(f => (
                <div key={f.label} className="bg-stone-50 rounded-xl px-3 py-2.5">
                  <p className="text-xs text-stone-400">{f.label}</p>
                  <p className={`text-sm font-semibold mt-0.5 ${f.value === '待查' ? 'text-amber-600' : 'text-stone-800'}`}>{f.value}</p>
                </div>
              ))}
            </div>
          </div>
          {/* Physical */}
          <div>
            <p className="text-xs font-semibold text-stone-400 mb-2 uppercase tracking-wide">植株規格</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {[
                { label: '樹高', value: plant.height },
                { label: '樹冠', value: plant.crownWidth },
                { label: '覆土深度', value: plant.soilDepth },
                { label: '種植株距', value: plant.plantingSpacing },
                { label: '台灣原生', value: plant.nativeStatus },
                { label: '誘鳥誘蝶', value: plant.biodiversityValue ? '是' : '—' },
              ].filter(f => f.value).map(f => (
                <div key={f.label} className="bg-stone-50 rounded-xl px-3 py-2.5">
                  <p className="text-xs text-stone-400">{f.label}</p>
                  <p className="text-sm font-medium text-stone-700 mt-0.5 truncate">{f.value}</p>
                </div>
              ))}
            </div>
          </div>
          {/* Risk tags */}
          {plant.riskTags.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-stone-400 mb-2 uppercase tracking-wide">風險標籤</p>
              <div className="flex flex-wrap gap-1.5">
                {plant.riskTags.map(t => (
                  <span key={t} className="text-xs px-2.5 py-1 rounded-full bg-orange-50 border border-orange-200 text-orange-700 font-medium">{t}</span>
                ))}
              </div>
            </div>
          )}
          {/* Maintenance */}
          {plant.maintenanceNote && (
            <div>
              <p className="text-xs font-semibold text-stone-400 mb-2 uppercase tracking-wide">養護管理</p>
              <p className="text-sm text-stone-600 leading-relaxed bg-stone-50 rounded-xl p-3">{plant.maintenanceNote}</p>
            </div>
          )}
          {/* Review note */}
          <div>
            <p className="text-xs font-semibold text-stone-400 mb-2 uppercase tracking-wide">審查說明文字</p>
            <p className="text-sm text-stone-600 leading-relaxed bg-green-50 border border-green-100 rounded-xl p-3">{plant.reviewNote}</p>
          </div>
          {/* Source */}
          <div className="border border-stone-100 rounded-xl p-3 space-y-1.5">
            <p className="text-xs font-semibold text-stone-400 uppercase tracking-wide">資料來源與查核</p>
            {plant.sunWaterSource && <p className="text-xs text-stone-500">來源：{plant.sunWaterSource}</p>}
            {plant.verificationStatus && <p className="text-xs text-stone-500">判定狀態：<span className={plant.verificationStatus.includes('初步') ? 'text-amber-600 font-medium' : 'text-green-600'}>{plant.verificationStatus}</span></p>}
            {plant.verifiedAt && <p className="text-xs text-stone-500">查核日期：{plant.verifiedAt}</p>}
            {plant.verificationSummary && <p className="text-xs text-stone-500 leading-relaxed">摘要：{plant.verificationSummary}</p>}
            {plant.sunWaterSourceUrl && (
              <a href={plant.sunWaterSourceUrl} target="_blank" rel="noreferrer"
                className="flex items-center gap-1 text-xs text-green-700 hover:underline">
                <ExternalLink size={11} />官方資料連結
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Photo search helpers ──────────────────────────────────────────────────────

// Constructs the nativetree search page URL so users can open it manually
function nativetreeSearchUrl(plantName: string): string {
  return `https://nativetree.forest.gov.tw/Tree#/search?keyword=${encodeURIComponent(plantName)}`
}

// Wikimedia Commons fallback search (CORS-friendly public API)
async function searchWikimediaPhotos(plantName: string, scientificName: string): Promise<CandidatePhoto[]> {
  const queries = [scientificName, plantName].filter(q => q && q !== '待查' && q.trim() !== '')
  for (const query of queries) {
    try {
      const params = new URLSearchParams({
        action: 'query', generator: 'search',
        gsrsearch: query, gsrnamespace: '6', gsrlimit: '12',
        prop: 'imageinfo', iiprop: 'url|extmetadata',
        iiurlwidth: '400', format: 'json', origin: '*',
      })
      const res = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`)
      if (!res.ok) continue
      const data = await res.json()
      const pages: Record<string, any> = data.query?.pages ?? {}
      const candidates: CandidatePhoto[] = Object.values(pages)
        .filter((p: any) => {
          const info = p.imageinfo?.[0]; if (!info?.url) return false
          const url = info.url.toLowerCase()
          if (url.endsWith('.svg') || url.endsWith('.pdf') || url.endsWith('.ogg') ||
              url.endsWith('.ogv') || url.endsWith('.webm') || url.endsWith('.mp4')) return false
          const mime = info.extmetadata?.MIMEType?.value ?? ''
          if (mime && !mime.startsWith('image/')) return false
          return true
        })
        .slice(0, 3)
        .map((p: any) => {
          const info = p.imageinfo[0]; const meta = info.extmetadata ?? {}
          return {
            thumbUrl: info.thumburl ?? info.url,
            fullUrl: info.url,
            sourceUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(p.title ?? '')}`,
            sourceName: 'Wikimedia Commons（備用）',
            credit: (meta.Artist?.value ?? '').replace(/<[^>]+>/g, '').trim(),
            licenseNote: meta.LicenseShortName?.value ?? meta.License?.value ?? '',
          }
        })
      if (candidates.length > 0) return candidates
    } catch { /* try next query */ }
  }
  return []
}

// ── PhotoManagerModal ─────────────────────────────────────────────────────────

function PhotoManagerModal({ plants, imageStore, onSaveImage, onClose }: {
  plants: CsvPlantRecord[]
  imageStore: ImageStore
  onSaveImage: (plantName: string, data: Partial<PlantImageData>) => void
  onClose: () => void
}) {
  type SearchStatus = 'idle' | 'searching' | 'done' | 'failed'
  interface PlantPhotoState { status: SearchStatus; candidates: CandidatePhoto[] }

  const [photoStates, setPhotoStates] = useState<Record<string, PlantPhotoState>>({})
  const [isBulkSearching, setIsBulkSearching] = useState(false)
  const [showSkipped, setShowSkipped] = useState(false)
  const [manualUrls, setManualUrls] = useState<Record<string, string>>({})
  const [showManualInput, setShowManualInput] = useState<Record<string, boolean>>({})

  const needsPhoto = plants.filter(p => {
    const img = imageStore[p.name]
    if (img?.uploadedDataUrl) return false
    if (img?.imageReviewStatus === 'approved') return false
    if (!showSkipped && img?.imageReviewStatus === 'skipped') return false
    return true
  })

  const searchOne = async (plant: CsvPlantRecord) => {
    setPhotoStates(prev => ({ ...prev, [plant.name]: { status: 'searching', candidates: [] } }))
    try {
      const results = await searchWikimediaPhotos(plant.name, plant.scientificName ?? '')
      const status = results.length > 0 ? 'done' : 'failed'
      setPhotoStates(prev => ({ ...prev, [plant.name]: { status, candidates: results } }))
      onSaveImage(plant.name, { imageReviewStatus: results.length > 0 ? 'candidate_found' : 'failed' })
    } catch {
      setPhotoStates(prev => ({ ...prev, [plant.name]: { status: 'failed', candidates: [] } }))
      onSaveImage(plant.name, { imageReviewStatus: 'failed' })
    }
  }

  const bulkSearch = async () => {
    setIsBulkSearching(true)
    const toSearch = needsPhoto.filter(p => !photoStates[p.name] || photoStates[p.name].status === 'idle')
    for (const plant of toSearch) {
      await searchOne(plant)
      await new Promise(r => setTimeout(r, 300))
    }
    setIsBulkSearching(false)
  }

  const approvePhoto = (plant: CsvPlantRecord, c: CandidatePhoto) => {
    onSaveImage(plant.name, {
      imageUrl: c.fullUrl,
      imageSourceName: c.sourceName,
      imageSourceUrl: c.sourceUrl,
      imageCredit: c.credit,
      imageLicenseNote: c.licenseNote,
      imageImportedAt: new Date().toISOString(),
      imageReviewStatus: 'approved',
    })
    setPhotoStates(prev => { const n = { ...prev }; delete n[plant.name]; return n })
    setShowManualInput(prev => { const n = { ...prev }; delete n[plant.name]; return n })
  }

  const approveManualUrl = (plant: CsvPlantRecord, url: string) => {
    if (!url.trim()) return
    onSaveImage(plant.name, {
      imageUrl: url.trim(),
      imageSourceName: '臺灣原生樹木推廣及媒合平臺',
      imageSourceUrl: 'https://nativetree.forest.gov.tw/Tree',
      imageImportedAt: new Date().toISOString(),
      imageReviewStatus: 'approved',
    })
    setManualUrls(prev => { const n = { ...prev }; delete n[plant.name]; return n })
    setShowManualInput(prev => { const n = { ...prev }; delete n[plant.name]; return n })
  }

  const skipPlant = (plant: CsvPlantRecord) => {
    onSaveImage(plant.name, { imageReviewStatus: 'skipped' })
  }

  const statusBadge = (status: ImageReviewStatus | undefined) => {
    if (status === 'failed')          return <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-50 text-red-600 border border-red-100">找不到圖片</span>
    if (status === 'skipped')         return <span className="text-[10px] px-2 py-0.5 rounded-full bg-stone-100 text-stone-400">已略過</span>
    if (status === 'candidate_found') return <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 border border-blue-100">候選待確認</span>
    return <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-600 border border-amber-100">缺圖</span>
  }

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Header */}
      <div className="border-b border-stone-200 px-4 py-3 flex-shrink-0">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h3 className="text-base font-bold text-green-900">補圖管理</h3>
            <p className="text-xs text-stone-400 mt-0.5 leading-tight">
              {needsPhoto.length} 筆缺圖・優先：臺灣原生樹木平臺
            </p>
          </div>
          <button onClick={onClose}
            className="text-stone-400 hover:text-stone-700 p-1 rounded-lg hover:bg-stone-100">
            <X size={16} />
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={bulkSearch} disabled={isBulkSearching || needsPhoto.length === 0}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-green-700 text-white text-xs font-medium hover:bg-green-800 disabled:opacity-50 disabled:cursor-not-allowed">
            {isBulkSearching
              ? <><RefreshCw size={12} className="animate-spin" />搜尋中…</>
              : <><Search size={12} />自動搜尋備用候選圖</>}
          </button>
          <label className="flex items-center gap-1.5 text-xs text-stone-500 cursor-pointer select-none flex-shrink-0">
            <input type="checkbox" checked={showSkipped}
              onChange={e => setShowSkipped(e.target.checked)} className="rounded" />
            含略過
          </label>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-2 bg-stone-50">
        {needsPhoto.length === 0 && (
          <div className="flex flex-col items-center justify-center h-48 text-stone-400">
            <CheckCircle size={32} className="mb-3 text-green-400" />
            <p className="text-sm font-medium">所有植栽已有照片或已略過</p>
          </div>
        )}

        {needsPhoto.map(plant => {
          const img = imageStore[plant.name]
          const ps = photoStates[plant.name]
          const isManualOpen = showManualInput[plant.name]
          const manualUrl = manualUrls[plant.name] ?? ''
          return (
            <div key={plant.id} className="bg-white rounded-2xl border border-stone-200 overflow-hidden">
              {/* Plant row */}
              <div className="flex items-center gap-4 px-5 py-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-stone-800">{plant.name}</span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-stone-100 text-stone-500">
                      {plant.subCategory || plant.category}
                    </span>
                    {statusBadge(img?.imageReviewStatus)}
                  </div>
                  {plant.scientificName && (
                    <p className="text-xs text-stone-400 italic mt-0.5">{plant.scientificName}</p>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {/* ① Primary: nativetree manual link */}
                  <a href={nativetreeSearchUrl(plant.name)} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-50 border border-green-200 text-xs text-green-700 hover:bg-green-100 font-medium whitespace-nowrap">
                    🌲 臺灣原生樹木平臺 ↗
                  </a>
                  <button onClick={() => setShowManualInput(p => ({ ...p, [plant.name]: !p[plant.name] }))}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-stone-200 text-xs text-stone-600 hover:bg-stone-50 whitespace-nowrap">
                    貼入圖片網址
                  </button>
                  {/* ② Fallback: Wikimedia search */}
                  {(!ps || ps.status === 'idle') && (
                    <button onClick={() => searchOne(plant)}
                      className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-stone-100 text-xs text-stone-400 hover:bg-stone-50 whitespace-nowrap">
                      <Search size={10} />備用搜尋
                    </button>
                  )}
                  {ps?.status === 'searching' && (
                    <span className="flex items-center gap-1 text-xs text-stone-400">
                      <RefreshCw size={11} className="animate-spin" />備用搜尋中…
                    </span>
                  )}
                  {(ps?.status === 'done' || ps?.status === 'failed') && (
                    <button onClick={() => searchOne(plant)}
                      className="flex items-center gap-1 px-2 py-1.5 rounded-lg border border-stone-100 text-xs text-stone-400 hover:bg-stone-50">
                      <RefreshCw size={10} />重試
                    </button>
                  )}
                  <button onClick={() => skipPlant(plant)}
                    className="px-2 py-1.5 rounded-lg text-xs text-stone-300 hover:text-stone-500">
                    略過
                  </button>
                </div>
              </div>

              {/* ① Manual URL paste panel (nativetree priority) */}
              {isManualOpen && (
                <div className="border-t border-green-100 bg-green-50 px-5 py-3">
                  <p className="text-xs font-semibold text-green-800 mb-2">
                    🌲 從臺灣原生樹木推廣及媒合平臺貼入圖片網址
                  </p>
                  <p className="text-[11px] text-green-600 mb-2">
                    1. 點上方「臺灣原生樹木平臺 ↗」搜尋 {plant.name}
                    2. 找到植物頁面後，對圖片按右鍵「複製圖片網址」
                    3. 貼入下方欄位，按「確認採用」
                  </p>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={manualUrl}
                      onChange={e => setManualUrls(p => ({ ...p, [plant.name]: e.target.value }))}
                      placeholder="https://nativetree.forest.gov.tw/..."
                      className="flex-1 px-3 py-2 border border-green-200 rounded-lg text-xs bg-white focus:outline-none focus:border-green-500 focus:ring-1 focus:ring-green-200"
                    />
                    <button
                      onClick={() => approveManualUrl(plant, manualUrl)}
                      disabled={!manualUrl.trim()}
                      className="px-4 py-2 rounded-lg bg-green-700 text-white text-xs font-semibold hover:bg-green-800 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap">
                      ✓ 確認採用
                    </button>
                    <button
                      onClick={() => setShowManualInput(p => ({ ...p, [plant.name]: false }))}
                      className="px-3 py-2 rounded-lg border border-stone-200 text-stone-400 text-xs hover:bg-stone-50">
                      收起
                    </button>
                  </div>
                </div>
              )}

              {/* ② Wikimedia fallback candidates */}
              {ps?.status === 'done' && ps.candidates.length > 0 && (
                <div className="border-t border-stone-100 px-5 py-4 bg-stone-50">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-xs text-stone-400 font-medium">
                      備用來源（Wikimedia Commons）找到 {ps.candidates.length} 張候選圖片：
                    </span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-stone-200 text-stone-500">非優先來源</span>
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    {ps.candidates.map((c, i) => (
                      <div key={i} className="bg-white rounded-xl border border-stone-200 overflow-hidden w-40 flex-shrink-0">
                        <div className="h-24 bg-stone-100 overflow-hidden flex items-center justify-center">
                          <img src={c.thumbUrl} alt={plant.name}
                            className="w-full h-full object-cover"
                            onError={e => { (e.target as HTMLImageElement).parentElement!.innerHTML = '<div style="color:#ccc;font-size:11px;padding:12px;text-align:center">圖片載入失敗</div>' }} />
                        </div>
                        <div className="px-3 py-2 space-y-1">
                          <div className="flex items-center gap-1">
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-stone-100 text-stone-400 font-medium">備用</span>
                            <p className="text-[10px] text-stone-500 font-medium truncate">{c.sourceName}</p>
                          </div>
                          {c.credit && <p className="text-[10px] text-stone-400 truncate">© {c.credit}</p>}
                          {c.licenseNote && <p className="text-[10px] text-stone-400">{c.licenseNote}</p>}
                          <a href={c.sourceUrl} target="_blank" rel="noopener noreferrer"
                            onClick={e => e.stopPropagation()}
                            className="text-[10px] text-blue-400 hover:underline block truncate">
                            查看來源頁面 ↗
                          </a>
                          <div className="flex gap-1 pt-1">
                            <button onClick={() => approvePhoto(plant, c)}
                              className="flex-1 py-1.5 rounded-lg bg-stone-700 text-white text-xs font-medium hover:bg-stone-800">
                              採用（備用）
                            </button>
                            <button onClick={() => skipPlant(plant)}
                              className="px-2 py-1.5 rounded-lg border border-stone-200 text-stone-400 text-xs hover:bg-stone-50">
                              略過
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* No results from Wikimedia */}
              {ps?.status === 'failed' && (
                <div className="border-t border-stone-100 px-5 py-3 bg-stone-50 flex items-center gap-2 text-xs text-stone-400">
                  <AlertTriangle size={12} className="text-amber-400 flex-shrink-0" />
                  備用來源也找不到圖片，請點「臺灣原生樹木平臺 ↗」手動搜尋後貼入網址
                  <button onClick={() => skipPlant(plant)}
                    className="ml-auto underline hover:text-stone-600">略過</button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function PlantDatabaseModal({ plants, onClose, onSelect, selectedIds, imageStore, onSaveImage }: {
  plants: CsvPlantRecord[]; onClose: () => void
  onSelect: (p: CsvPlantRecord) => void; selectedIds: Set<string>
  imageStore: ImageStore
  onSaveImage: (plantName: string, data: Partial<PlantImageData>) => void
}) {
  const [search, setSearch] = useState('')
  const [filterCat, setFilterCat] = useState('')
  const [filterSun, setFilterSun] = useState('')
  const [filterWater, setFilterWater] = useState('')
  const [filterWet, setFilterWet] = useState('')
  const [filterNative, setFilterNative] = useState('')
  const [filterMaint, setFilterMaint] = useState('')
  const [detail, setDetail] = useState<CsvPlantRecord | null>(null)
  const [justAdded, setJustAdded] = useState<string | null>(null)
  const [showPhotoManager, setShowPhotoManager] = useState(false)
  const importPhotoRef = useRef<HTMLInputElement>(null)

  const missingPhotoCount = plants.filter(p => {
    const img = imageStore[p.name]
    return !img?.uploadedDataUrl && img?.imageReviewStatus !== 'approved' && img?.imageReviewStatus !== 'skipped'
  }).length

  // Extended filter: native + maintenance + biodiversity
  const filtered = filterPlants(plants, {
    search, category: filterCat as any,
    sun: filterSun, water: filterWater, wet: filterWet,
  }).filter(p => {
    if (filterNative === 'native' && !p.nativeStatus.includes('原生')) return false
    if (filterNative === 'exotic' && !p.nativeStatus.includes('外來')) return false
    if (filterNative === 'bird' && !p.biodiversityValue) return false
    if (filterMaint === 'low' && p.maintenanceLevel !== '低') return false
    if (filterMaint === 'high' && p.maintenanceLevel !== '高') return false
    return true
  })

  const handleAdd = (plant: CsvPlantRecord) => {
    if (selectedIds.has(plant.id)) return
    onSelect(plant)
    setJustAdded(plant.id)
    setTimeout(() => setJustAdded(null), 1800)
  }

  // Chip helper
  const Chip = ({ label, active, onClick, color = 'green' }: {
    label: string; active: boolean; onClick: () => void; color?: string
  }) => {
    const activeClass =
      color === 'amber' ? 'bg-amber-600 text-white' :
      color === 'blue'  ? 'bg-blue-600 text-white' :
      color === 'cyan'  ? 'bg-cyan-700 text-white' :
      color === 'stone' ? 'bg-stone-600 text-white' :
      'bg-green-700 text-white'
    return (
      <button onClick={onClick}
        className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors border ${
          active ? `${activeClass} border-transparent` : 'bg-white text-stone-600 border-stone-200 hover:border-stone-300 hover:bg-stone-50'
        }`}>
        {label}
      </button>
    )
  }

  return (
    <div className="fixed inset-0 z-50 bg-stone-50 flex flex-col">

      {/* ── Top bar ── */}
      <div className="bg-white border-b border-stone-200 px-8 py-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-xl font-bold text-green-900">植栽資料庫</h2>
            <p className="text-sm text-stone-400 mt-0.5">
              景觀 AI 設計審查顧問 2.0｜共 {plants.length} 筆植栽資料　顯示 {filtered.length} 筆
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                // 判斷哪些欄位算「缺漏」：空字串 或 '待查'
                const isEmpty = (v: string) => !v || v.trim() === '' || v === '待查'
                const missing = plants.filter(p =>
                  isEmpty(p.sunRequirement) || isEmpty(p.droughtTolerance) ||
                  isEmpty(p.waterRequirement) || isEmpty(p.maintenanceLevel) ||
                  isEmpty(p.height) || isEmpty(p.crownWidth) ||
                  isEmpty(p.nativeStatus) || isEmpty(p.flowerColor) || isEmpty(p.flowerMonth)
                )
                if (missing.length === 0) { alert('所有植物資料均已完整，無需補充！'); return }
                const headers = [
                  '植物名稱', '學名', '類型', '子類型',
                  '樹高（待填）', '冠幅（待填）',
                  '日照需求（待填）', '需水量（待填）', '耐旱性（待填）',
                  '花色（待填）', '花期月份（待填）',
                  '原生狀態（待填）', '維護等級（待填）',
                  '備注',
                ]
                const rows = missing.map(p => [
                  p.name, p.scientificName, p.category, p.subCategory,
                  p.height || '', p.crownWidth || '',
                  p.sunRequirement || '', p.waterRequirement || '', p.droughtTolerance || '',
                  p.flowerColor || '', p.flowerMonth || '',
                  p.nativeStatus || '', p.maintenanceLevel || '',
                  p.remarks || '',
                ])
                const csv = [headers, ...rows]
                  .map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
                  .join('\n')
                const bom = '﻿'
                const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a'); a.href = url
                a.download = `植栽待補充資料_${missing.length}筆.csv`
                a.click(); URL.revokeObjectURL(url)
              }}
              className="flex items-center gap-2 px-4 py-2 rounded-xl border border-stone-200 text-sm text-stone-600 hover:bg-stone-50 font-medium">
              <FileDown size={14} />匯出待補充 CSV
            </button>
            {/* 匯出植栽庫 CSV（含圖片網址） */}
            <button
              onClick={() => {
                // Tab 分隔，與原始 CSV 格式相容，欄位 32 加圖片網址
                const headers = [
                  '植物名稱','喬木.灌木.草本','細分類','學名',
                  '樹高','冠幅','幹徑','樹形',
                  '花色','花期月份','花期','原生狀態','花期補充',
                  '土壤深度','生物多樣性','維護備注','單價','種植間距',
                  '參考頁碼','參考備注','官方連結','備注',
                  '日照需求','耐旱性','耐濕性','水分需求','耐水標籤',
                  '日照水分來源','日照水分來源URL','驗證狀態','驗證時間','驗證摘要',
                  '圖片網址',
                ]
                const rows = plants.map(p => {
                  const img = imageStore[p.name]
                  const imgUrl = img?.imageUrl || img?.uploadedDataUrl || ''
                  return [
                    p.name, p.category, p.subCategory, p.scientificName,
                    p.height, p.crownWidth, p.trunkDiameter, p.treeForm,
                    p.flowerColor, p.flowerMonth, p.flowerPeriod, p.nativeStatus, p.flowerSupplement,
                    p.soilDepth, p.biodiversityValue, p.maintenanceNote, p.price, p.plantingSpacing,
                    p.referencePageNo, p.referenceNote, p.officialUrl, p.remarks,
                    p.sunRequirement, p.droughtTolerance, p.wetTolerance, p.waterRequirement, p.waterToleranceTag,
                    p.sunWaterSource, p.sunWaterSourceUrl, p.verificationStatus, p.verifiedAt, p.verificationSummary,
                    imgUrl,
                  ].join('\t')
                })
                const tsv = [headers.join('\t'), ...rows].join('\n')
                const bom = '﻿'
                const blob = new Blob([bom + tsv], { type: 'text/tab-separated-values;charset=utf-8' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a'); a.href = url
                a.download = `植栽資料庫_含圖片網址_${plants.length}筆.csv`
                a.click(); URL.revokeObjectURL(url)
              }}
              title="匯出完整植栽庫，最後一欄含圖片網址，同事匯入後可直接看到圖片"
              className="flex items-center gap-2 px-4 py-2 rounded-xl border border-green-300 bg-green-50 text-sm text-green-700 hover:bg-green-100 font-medium">
              <FileDown size={14} />匯出含圖片網址 CSV
            </button>
            <button
              onClick={() => { setShowPhotoManager(v => !v); setDetail(null) }}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl border text-sm font-medium transition-colors relative ${
                showPhotoManager
                  ? 'bg-amber-500 text-white border-transparent'
                  : 'border-stone-200 text-stone-600 hover:bg-stone-50'
              }`}>
              <Upload size={14} />補圖管理
              {missingPhotoCount > 0 && !showPhotoManager && (
                <span className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-amber-500 text-white text-[10px] font-bold flex items-center justify-center">
                  {missingPhotoCount > 99 ? '99+' : missingPhotoCount}
                </span>
              )}
            </button>
            <button onClick={onClose}
              className="flex items-center gap-2 px-4 py-2 rounded-xl border border-stone-200 text-sm text-stone-600 hover:bg-stone-50">
              <X size={16} />關閉
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="relative mb-3">
          <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-stone-400" />
          <input type="text" placeholder="搜尋植物名稱、學名或關鍵字…" value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 border border-stone-200 rounded-xl text-sm bg-white focus:outline-none focus:border-green-400 focus:ring-2 focus:ring-green-100" />
        </div>

        {/* Filter chips */}
        <div className="space-y-2">
          {/* Row 1: category */}
          <div className="flex gap-1.5 flex-wrap items-center">
            <span className="text-xs text-stone-400 font-medium w-10 flex-shrink-0">類型</span>
            <Chip label="全部" active={filterCat === ''} onClick={() => setFilterCat('')} />
            <Chip label="喬木" active={filterCat === 'tree'} onClick={() => setFilterCat(filterCat === 'tree' ? '' : 'tree')} />
            <Chip label="灌木" active={filterCat === 'shrub'} onClick={() => setFilterCat(filterCat === 'shrub' ? '' : 'shrub')} />
            <Chip label="草本" active={filterCat === 'groundcover'} onClick={() => setFilterCat(filterCat === 'groundcover' ? '' : 'groundcover')} />
          </div>
          {/* Row 2: sun */}
          <div className="flex gap-1.5 flex-wrap items-center">
            <span className="text-xs text-stone-400 font-medium w-10 flex-shrink-0">日照</span>
            <Chip label="全日照" color="amber" active={filterSun === '全日照'} onClick={() => setFilterSun(filterSun === '全日照' ? '' : '全日照')} />
            <Chip label="全日照至半日照" color="amber" active={filterSun === '全日照至半日照'} onClick={() => setFilterSun(filterSun === '全日照至半日照' ? '' : '全日照至半日照')} />
            <Chip label="半日照至遮陰" color="amber" active={filterSun === '半日照至遮陰'} onClick={() => setFilterSun(filterSun === '半日照至遮陰' ? '' : '半日照至遮陰')} />
          </div>
          {/* Row 3: water + wet */}
          <div className="flex gap-1.5 flex-wrap items-center">
            <span className="text-xs text-stone-400 font-medium w-10 flex-shrink-0">水分</span>
            {(['低', '低至中', '中', '中至高', '高'] as const).map(w => (
              <Chip key={w} label={`水${w}`} color="blue" active={filterWater === w} onClick={() => setFilterWater(filterWater === w ? '' : w)} />
            ))}
            <span className="text-stone-300 mx-1">|</span>
            {(['不耐積水', '稍耐濕', '耐濕'] as const).map(w => (
              <Chip key={w} label={w} color="cyan" active={filterWet === w} onClick={() => setFilterWet(filterWet === w ? '' : w)} />
            ))}
          </div>
          {/* Row 4: native + maintenance */}
          <div className="flex gap-1.5 flex-wrap items-center">
            <span className="text-xs text-stone-400 font-medium w-10 flex-shrink-0">其他</span>
            <Chip label="台灣原生種" color="stone" active={filterNative === 'native'} onClick={() => setFilterNative(filterNative === 'native' ? '' : 'native')} />
            <Chip label="外來種"     color="stone" active={filterNative === 'exotic'} onClick={() => setFilterNative(filterNative === 'exotic' ? '' : 'exotic')} />
            <Chip label="誘鳥誘蝶"   color="stone" active={filterNative === 'bird'}   onClick={() => setFilterNative(filterNative === 'bird' ? '' : 'bird')} />
            <Chip label="低維護"     color="stone" active={filterMaint === 'low'}     onClick={() => setFilterMaint(filterMaint === 'low' ? '' : 'low')} />
            <Chip label="高維護"     color="stone" active={filterMaint === 'high'}    onClick={() => setFilterMaint(filterMaint === 'high' ? '' : 'high')} />
          </div>
        </div>
      </div>

      {/* ── Card grid + optional drawer ── */}
      <div className="flex-1 flex overflow-hidden">
        {/* Card grid */}
        <div className="flex-1 overflow-y-auto px-6 py-6">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-stone-400">
              <Leaf size={32} className="mb-3 opacity-40" />
              <p className="text-sm">找不到符合條件的植栽</p>
            </div>
          ) : (
            <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
              {filtered.map(plant => (
                <PlantCardItem
                  key={plant.id}
                  plant={plant}
                  imageData={imageStore[plant.name]}
                  added={selectedIds.has(plant.id)}
                  fresh={justAdded === plant.id}
                  isActive={detail?.id === plant.id}
                  onDetail={() => setDetail(detail?.id === plant.id ? null : plant)}
                  onAdd={() => handleAdd(plant)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Detail drawer */}
        {detail && !showPhotoManager && (
          <div className="w-[420px] flex-shrink-0 relative border-l border-stone-200">
            <PlantDetailDrawer
              plant={detail}
              onClose={() => setDetail(null)}
              onAdd={() => handleAdd(detail)}
              added={selectedIds.has(detail.id)}
              imageData={imageStore[detail.name]}
              onSaveImage={data => onSaveImage(detail.name, data)}
            />
          </div>
        )}

        {/* Photo Manager — right-side drawer */}
        {showPhotoManager && (
          <div className="w-[480px] flex-shrink-0 border-l border-stone-200 bg-white flex flex-col overflow-hidden">
            <PhotoManagerModal
              plants={plants}
              imageStore={imageStore}
              onSaveImage={onSaveImage}
              onClose={() => setShowPhotoManager(false)}
            />
          </div>
        )}
      </div>
    </div>
  )
}

// ── CSV Import Modal ──────────────────────────────────────────────────────────

function CsvImportModal({ onClose, onImported }: {
  onClose: () => void
  onImported: (result: ImportResult) => void
}) {
  const [phase, setPhase] = useState<'idle' | 'processing' | 'done' | 'error'>('idle')
  const [result, setResult] = useState<ImportResult | null>(null)
  const [errMsg, setErrMsg] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFile = async (file: File) => {
    setPhase('processing')
    try {
      const r = await importFromFile(file)
      setResult(r)
      setPhase('done')
    } catch {
      setErrMsg('檔案讀取失敗，請確認檔案格式。')
      setPhase('error')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg">
        <div className="flex items-center justify-between p-6 border-b border-stone-100">
          <div>
            <h2 className="text-lg font-semibold text-stone-800">匯入植栽資料庫 CSV</h2>
            <p className="text-xs text-stone-400 mt-0.5">Tab 分隔格式，UTF-8 編碼</p>
          </div>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-600"><X size={20} /></button>
        </div>
        <div className="p-6 space-y-4">
          {phase === 'idle' && (
            <div
              onDragOver={e => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f) }}
              onClick={() => inputRef.current?.click()}
              className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-colors ${
                dragOver ? 'border-green-400 bg-green-50' : 'border-stone-200 hover:border-stone-300 hover:bg-stone-50'}`}>
              <FileText size={32} className="mx-auto text-stone-300 mb-3" />
              <p className="text-stone-600 font-medium">拖放或點擊上傳 CSV 檔案</p>
              <p className="text-xs text-stone-400 mt-1">報告書常用植栽整理_核實更新版.csv</p>
              <input ref={inputRef} type="file" accept=".csv,.tsv,.txt" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />
            </div>
          )}
          {phase === 'processing' && (
            <div className="py-10 text-center">
              <div className="w-10 h-10 border-4 border-green-700 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
              <p className="text-stone-600 font-medium">解析 CSV 資料中…</p>
            </div>
          )}
          {phase === 'done' && result && (
            <div className="space-y-3">
              <div className="flex items-center gap-3 p-3 bg-green-50 rounded-xl border border-green-100">
                <CheckCircle size={18} className="text-green-600 flex-shrink-0" />
                <div>
                  <p className="text-sm font-medium text-stone-800">匯入成功</p>
                  <p className="text-xs text-stone-500">共 {result.totalRows} 列，成功匯入 {result.successRows} 筆，跳過 {result.skippedRows} 筆</p>
                </div>
              </div>
              {result.missingColumns.length > 0 && (
                <div className="flex gap-2 p-3 bg-amber-50 rounded-xl border border-amber-100">
                  <AlertTriangle size={15} className="text-amber-500 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-medium text-stone-700">缺漏欄位</p>
                    <p className="text-xs text-stone-500 mt-0.5">{result.missingColumns.join('、')}</p>
                  </div>
                </div>
              )}
              <div className="bg-stone-50 rounded-xl p-3 grid grid-cols-2 gap-1.5">
                {Object.entries(result.columnMap).filter(([, v]) => v).map(([k]) => (
                  <div key={k} className="flex items-center gap-1.5 text-xs text-stone-600">
                    <CheckCircle size={11} className="text-green-500 flex-shrink-0" />{k}
                  </div>
                ))}
              </div>
            </div>
          )}
          {phase === 'error' && (
            <div className="flex gap-2 p-4 bg-red-50 rounded-xl border border-red-100">
              <XCircle size={16} className="text-red-500 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-700">{errMsg}</p>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-3 px-6 pb-6">
          <button onClick={onClose} className="px-4 py-2 rounded-xl border border-stone-200 text-sm text-stone-600 hover:bg-stone-50">
            {phase === 'done' ? '關閉' : '取消'}
          </button>
          {phase === 'done' && result && (
            <button onClick={() => { onImported(result); onClose() }}
              className="px-5 py-2 rounded-xl bg-green-700 text-white text-sm font-medium hover:bg-green-800">
              套用為植栽資料庫
            </button>
          )}
          {(phase === 'error' || phase === 'idle') && phase !== 'idle' && (
            <button onClick={() => { setPhase('idle'); setResult(null) }}
              className="px-4 py-2 rounded-xl bg-stone-700 text-white text-sm hover:bg-stone-800">重新上傳</button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function LandscapeAdvisorPage({
  activeTab = 'landscape',
  onTabChange,
  importedPlantNames,
  onImportConsumed,
}: {
  activeTab?: 'pdf' | 'landscape' | 'dxf'
  onTabChange?: (tab: 'pdf' | 'landscape' | 'dxf') => void
  importedPlantNames?: string[]
  onImportConsumed?: () => void
} = {}) {
  const [allPlants, setAllPlants] = useState<CsvPlantRecord[]>([])
  const [dbStatus, setDbStatus] = useState<'loading' | 'loaded' | 'empty'>('loading')
  const [selectedPlants, setSelectedPlants] = useState<SelectedCsvPlant[]>([])
  const [result, setResult] = useState<EvalResult | null>(null)
  const [showDb, setShowDb] = useState(false)
  const [showCsvImport, setShowCsvImport] = useState(false)
  const [copyDone, setCopyDone] = useState(false)
  const [activeReviewTab, setActiveReviewTab] = useState<'overview'|'categories'|'issues'|'alternatives'|'summary'>('overview')
  const [showMobileTools, setShowMobileTools] = useState(false)
  const [aiSuggestionExpanded, setAiSuggestionExpanded] = useState(false)

  // ── DXF 分區審查資料（從 localStorage 讀取）──────────────────────────────────
  type StoredZone = {
    zoneName: string; status: string; plantCount: number
    score?: number; compatLevel?: string
    issueCount: number; dangerCount: number; mainIssues: string[]
    categories?: Array<{ key:string; label:string; count:number; level:string; statusLabel:string; summary:string }>
    issues?: Array<{ category:string; level:string; cause:string; impact:string; suggestion:string }>
    aiSuggestion?: string; adjustmentPlan?: string[]; reviewText?: string
  }
  const [storedZones] = useState<StoredZone[]>(() => {
    try { const r = localStorage.getItem('dxf-zone-review-full'); return r ? JSON.parse(r) : [] }
    catch { return [] }
  })
  const [activeZoneId, setActiveZoneId] = useState<string | null>(null)
  const activeZone = storedZones.find(z => z.zoneName === activeZoneId) ?? null

  // ── Split pane ──────────────────────────────────────────────────────────────
  const SPLIT_MIN_LEFT  = 320
  const SPLIT_MIN_RIGHT = 480
  const SPLIT_DEFAULT   = 400
  const [leftWidth, setLeftWidth] = useState<number>(() => {
    const saved = localStorage.getItem('landscape-split-width')
    return saved ? parseInt(saved, 10) : SPLIT_DEFAULT
  })
  const splitContainerRef = useRef<HTMLDivElement>(null)
  const isDragging = useRef(false)

  const onSplitMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    isDragging.current = true
    const startX = e.clientX
    const startW = leftWidth
    let lastW = startW
    const onMove = (ev: MouseEvent) => {
      if (!isDragging.current) return
      const containerW = splitContainerRef.current?.getBoundingClientRect().width ?? window.innerWidth
      lastW = Math.min(
        containerW - SPLIT_MIN_RIGHT,
        Math.max(SPLIT_MIN_LEFT, startW + ev.clientX - startX)
      )
      setLeftWidth(lastW)
    }
    const onUp = () => {
      isDragging.current = false
      localStorage.setItem('landscape-split-width', String(lastW))
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  // Initialize imageStore directly from localStorage (lazy init avoids useEffect delay)
  const [imageStore, setImageStore] = useState<ImageStore>(() => loadImageStore())

  const handleSaveImage = useCallback((plantName: string, data: Partial<PlantImageData>) => {
    setImageStore(prev => {
      const next = upsertPlantImage(prev, plantName, data)
      saveImageStore(next)
      return next
    })
  }, [])

  useEffect(() => {
    const stored = loadPlantsFromStorage()
    if (stored && stored.length > 0) {
      setAllPlants(stored); setDbStatus('loaded'); return
    }
    fetchDefaultPlants().then(res => {
      if (res && res.plants.length > 0) {
        setAllPlants(res.plants)
        savePlantsToStorage(res.plants)
        setDbStatus('loaded')
      } else {
        setDbStatus('empty')
      }
    })
  }, [])

  // ── 從 PDF / DXF 導入植栽並自動執行評估 ──────────────────────────────────────
  useEffect(() => {
    if (!importedPlantNames || importedPlantNames.length === 0) return
    const db = allPlants.length > 0 ? allPlants : (loadPlantsFromStorage() ?? [])
    if (db.length === 0) return   // 資料庫還沒載入，等下一次觸發

    const imported: SelectedCsvPlant[] = importedPlantNames
      .map(name => db.find(p => p.name === name))
      .filter((p): p is CsvPlantRecord => !!p)
      .map(plant => ({ ...plant, instanceId: uid(), status: '可用' as const }))

    if (imported.length > 0) {
      setSelectedPlants(imported)
      setResult(evaluate(imported, db))
      onImportConsumed?.()  // 清除 App.tsx 的暫存，避免重複觸發
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importedPlantNames, allPlants])

  const selectedIds = new Set(selectedPlants.map(p => p.id))

  const addPlant = useCallback((plant: CsvPlantRecord) => {
    const status: PlantStatus =
      plant.wetTolerance === '不耐積水' && plant.droughtTolerance === '不耐旱' ? '需注意' : '可用'
    setSelectedPlants(prev => [...prev, { ...plant, instanceId: uid(), status }])
    setResult(null)
  }, [])

  const removePlant = useCallback((instanceId: string) => {
    setSelectedPlants(prev => prev.filter(p => p.instanceId !== instanceId))
    setResult(null)
  }, [])

  const handleCsvImported = (res: ImportResult) => {
    setAllPlants(res.plants)
    savePlantsToStorage(res.plants)
    // 若 CSV 含圖片網址欄，自動合併進 imageStore（不覆蓋本機已上傳的檔案）
    if (Object.keys(res.imageUrls).length > 0) {
      const current = loadImageStore()
      const merged = { ...current }
      for (const [plantName, url] of Object.entries(res.imageUrls)) {
        if (!merged[plantName]?.uploadedDataUrl) {
          merged[plantName] = { ...(merged[plantName] ?? {}), imageUrl: url, hasImage: true }
        }
      }
      saveImageStore(merged)
      setImageStore(merged)
    }
    setDbStatus('loaded')
    setSelectedPlants([])
    setResult(null)
  }

  const handleExport = () => {
    if (!result) return
    const altSection = result.alternatives.length > 0
      ? ['', '【替代植栽建議】',
          ...result.alternatives.flatMap(s => [
            `▌ ${s.originalPlant.name}（問題：${s.problemLabels.join('、')}）`,
            ...s.alternatives.map((a, i) =>
              `  ${i + 1}. ${a.plant.name}　理由：${a.reason}　可降低：${a.riskReduction}`),
          ])]
      : []
    const lines = [
      '景觀 AI 設計審查顧問 2.0', '植栽配置評估報告', '═'.repeat(50), '',
      '【本區植栽組合】',
      ...selectedPlants.map(p => `• ${p.name}（${p.subCategory || p.category}）　日照：${p.sunRequirement}　水分：${p.waterRequirement}　耐濕：${p.wetTolerance}　耐旱：${p.droughtTolerance}`),
      '',
      `【配置相容性分數】\n${result.score} / 100　${result.compatLevel}`,
      '',
      '【問題分類總覽】',
      ...result.categories.map(c => `${c.label}：${c.count > 0 ? `${c.count} 項　` : ''}${c.statusLabel}`),
      '',
      '【審查問題明細】',
      ...result.issues.map(i =>
        `▌ ${i.category}（${i.level === 'danger' ? '高風險' : '需注意'}）\n  問題原因：${i.cause}\n  實務影響：${i.impact}\n  修正建議：${i.suggestion}`),
      ...altSection,
      '',
      '【AI 配置修正建議】', result.aiSuggestion,
      '',
      '【配置調整方案】', ...result.adjustmentPlan.map(p => `• ${p}`),
      '',
      '【審查回覆文字】', result.reviewText,
      '',
      '【植栽資料來源引用】',
      ...selectedPlants.filter(p => p.sunWaterSource).map(p =>
        `• ${p.name}：${p.sunWaterSource}${p.verifiedAt ? `（查核：${p.verifiedAt}）` : ''}`),
      '',
      `產生時間：${new Date().toLocaleString('zh-TW')}`,
    ].join('\n')
    const blob = new Blob([lines], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `景觀配置評估報告_${new Date().toLocaleDateString('zh-TW').replace(/\//g, '')}.txt`
    a.click(); URL.revokeObjectURL(url)
  }

  const handleExportPdf = () => {
    if (!result) return
    exportReviewReportPdf(selectedPlants, result, { reviewType: 'AI 配植評估' })
  }

  const activeIssues = result?.issues.filter(i => i.level !== 'ok') ?? []

  return (
    <div className="min-h-screen" style={{ background: 'radial-gradient(circle at 85% 15%, rgba(121,190,140,0.16) 0%, transparent 30%), radial-gradient(circle at 20% 85%, rgba(183,220,190,0.18) 0%, transparent 35%), linear-gradient(135deg, #f7faf5 0%, #eef6ef 48%, #e5f1e8 100%)' }}>
      {/* Header */}
      <header className="bg-[#1a4731] sticky top-0 z-40 shadow-md">
        <div className="max-w-[1536px] mx-auto px-4 md:px-8 h-14 md:h-16 flex items-center justify-between gap-2 md:gap-4">
          {/* 標題 */}
          <div className="flex-shrink-0 min-w-0">
            <h1 className="text-sm md:text-base font-bold text-white leading-tight tracking-wide truncate">景觀 AI 設計審查顧問 2.0</h1>
            <p className="text-[10px] md:text-xs text-green-200/70 leading-tight hidden sm:block">植栽配置相容性・養護風險・審查回覆</p>
          </div>

          {/* Tab navigation — 桌機顯示 */}
          {onTabChange && (
            <div className="hidden md:flex items-center bg-[#0f2d1d] rounded-xl p-1 gap-0.5">
              {([
                { id: 'pdf'       as const, label: 'PDF 審圖' },
                { id: 'landscape' as const, label: 'AI 配植評估' },
                { id: 'dxf'       as const, label: 'DXF 審查' },
              ]).map(t => (
                <button key={t.id} onClick={() => onTabChange(t.id)}
                  className={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                    activeTab === t.id
                      ? 'bg-[#2d6a4f] text-white shadow-sm'
                      : 'text-green-300/80 hover:text-white hover:bg-[#1a4731]'
                  }`}>
                  {t.label}
                </button>
              ))}
            </div>
          )}

          {/* 桌機版工具列 */}
          <div className="hidden md:flex items-center gap-2">
            <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border ${
              dbStatus === 'loaded' ? 'bg-green-800/40 text-green-200 border-green-700/50'
              : dbStatus === 'loading' ? 'bg-white/10 text-white/60 border-white/20'
              : 'bg-amber-800/40 text-amber-200 border-amber-700/50'
            }`}>
              {dbStatus === 'loaded' ? <><CheckCircle size={11} />{allPlants.length} 筆植栽資料庫</> :
               dbStatus === 'loading' ? <><RefreshCw size={11} className="animate-spin" />載入中…</> :
               <><AlertTriangle size={11} />未載入資料庫</>}
            </div>
            <div className="flex items-center gap-1.5 border-l border-white/20 pl-2">
              <button onClick={() => setShowCsvImport(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-white/10 border border-white/20 rounded-lg text-xs text-white hover:bg-white/20 transition-colors font-medium">
                <Upload size={12} />匯入 CSV
              </button>
              <button onClick={() => setShowDb(true)} disabled={allPlants.length === 0}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                  allPlants.length > 0 ? 'bg-white/10 border-white/20 text-white hover:bg-white/20' : 'border-white/10 text-white/30 cursor-not-allowed'
                }`}>
                <Database size={12} />植栽資料庫
              </button>
            </div>
            <div className="flex items-center gap-1.5 border-l border-white/20 pl-2">
              <button onClick={handleExportPdf} disabled={!result}
                className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  result ? 'bg-[#d8f3dc] text-[#1a4731] hover:bg-white' : 'bg-white/10 text-white/30 cursor-not-allowed'
                }`}>
                <FileOutput size={12} />匯出 PDF
              </button>
              <button onClick={handleExport} disabled={!result}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                  result ? 'bg-white/10 border-white/20 text-white hover:bg-white/20' : 'border-white/10 text-white/30 cursor-not-allowed'
                }`}>
                <FileDown size={12} />txt
              </button>
            </div>
          </div>

          {/* 手機版右側：模式切換 + 工具下拉 */}
          <div className="flex md:hidden items-center gap-2">
            {/* 手機版 tab 切換 */}
            {onTabChange && (
              <div className="flex items-center bg-[#0f2d1d] rounded-lg p-0.5 gap-0.5">
                {([
                  { id: 'pdf' as const, label: 'PDF' },
                  { id: 'landscape' as const, label: 'AI' },
                  { id: 'dxf' as const, label: 'DXF' },
                ]).map(t => (
                  <button key={t.id} onClick={() => onTabChange(t.id)}
                    className={`px-2.5 py-2 rounded-md text-xs font-medium transition-colors min-w-[44px] ${
                      activeTab === t.id ? 'bg-[#2d6a4f] text-white' : 'text-green-300/80 hover:text-white'
                    }`}>
                    {t.label}
                  </button>
                ))}
              </div>
            )}
            {/* 工具下拉按鈕 */}
            <div className="relative">
              <button onClick={() => setShowMobileTools(v => !v)}
                className="flex items-center gap-1.5 px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-xs text-white font-medium min-h-[44px]">
                <ChevronDown size={14} className={`transition-transform ${showMobileTools ? 'rotate-180' : ''}`} />
                工具
              </button>
              {showMobileTools && (
                <div className="absolute right-0 top-12 z-50 w-52 bg-[#1a4731] border border-white/20 rounded-2xl shadow-xl overflow-hidden">
                  <div className="p-1 space-y-0.5">
                    <div className={`flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium ${
                      dbStatus === 'loaded' ? 'text-green-200' : 'text-amber-200'
                    }`}>
                      {dbStatus === 'loaded' ? <CheckCircle size={14} /> : <AlertTriangle size={14} />}
                      {dbStatus === 'loaded' ? `${allPlants.length} 筆植栽資料庫` : '未載入資料庫'}
                    </div>
                    <button onClick={() => { setShowDb(true); setShowMobileTools(false) }} disabled={allPlants.length === 0}
                      className="w-full flex items-center gap-2 px-3 py-3 rounded-lg text-sm text-white hover:bg-white/10 transition-colors text-left min-h-[44px]">
                      <Database size={14} />植栽資料庫
                    </button>
                    <button onClick={() => { setShowCsvImport(true); setShowMobileTools(false) }}
                      className="w-full flex items-center gap-2 px-3 py-3 rounded-lg text-sm text-white hover:bg-white/10 transition-colors text-left min-h-[44px]">
                      <Upload size={14} />匯入 CSV
                    </button>
                    <div className="h-px bg-white/10 mx-2" />
                    <button onClick={() => { handleExportPdf(); setShowMobileTools(false) }} disabled={!result}
                      className={`w-full flex items-center gap-2 px-3 py-3 rounded-lg text-sm transition-colors text-left min-h-[44px] ${result ? 'text-[#d8f3dc] hover:bg-white/10' : 'text-white/30 cursor-not-allowed'}`}>
                      <FileOutput size={14} />匯出 PDF 報告
                    </button>
                    <button onClick={() => { handleExport(); setShowMobileTools(false) }} disabled={!result}
                      className={`w-full flex items-center gap-2 px-3 py-3 rounded-lg text-sm transition-colors text-left min-h-[44px] ${result ? 'text-white hover:bg-white/10' : 'text-white/30 cursor-not-allowed'}`}>
                      <FileDown size={14} />匯出 TXT
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 手機版點外部關閉下拉 */}
        {showMobileTools && (
          <div className="fixed inset-0 z-40" onClick={() => setShowMobileTools(false)} />
        )}
      </header>

      {/* No DB banner (outside main grid so it stays at top) */}
      {dbStatus === 'empty' && (
        <div className="mx-auto px-8 pt-3" style={{ maxWidth: '1536px' }}>
          <div className="flex items-center gap-4 p-4 bg-amber-50 border border-amber-200 rounded-2xl">
            <AlertTriangle size={20} className="text-amber-500 flex-shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-stone-800">尚未載入植栽資料庫</p>
              <p className="text-xs text-stone-500 mt-0.5">請點擊「匯入 CSV」上傳植栽資料庫，或將 plantdb.csv 放置於 public 目錄。</p>
            </div>
            <button onClick={() => setShowCsvImport(true)}
              className="px-4 py-2 rounded-xl bg-amber-600 text-white text-sm font-medium hover:bg-amber-700 flex-shrink-0">
              立即匯入
            </button>
          </div>
        </div>
      )}

      {/* Main — 手機單欄；桌機 Split Pane 可拖曳 */}
      <div ref={splitContainerRef} className="flex flex-col md:flex-row md:h-[calc(100vh-56px)] md:overflow-hidden">

        {/* ── Left: 植栽組合 ── */}
        <div
          className="md:flex-shrink-0 md:overflow-y-auto border-b md:border-b-0 border-stone-200 p-5 space-y-4 bg-[#f7f5f0]"
          style={{ width: typeof window !== 'undefined' && window.innerWidth >= 768 ? leftWidth : undefined }}
        >
          {/* Header row */}
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-stone-800 tracking-wide">
              本區植栽組合{selectedPlants.length > 0 ? `　${selectedPlants.length} 種` : ''}
            </p>
            <button onClick={() => setShowDb(true)} disabled={allPlants.length === 0}
              className="flex items-center gap-1.5 text-xs text-green-700 font-medium hover:text-green-800 disabled:text-stone-300">
              <Plus size={13} />加入植栽
            </button>
          </div>

          {/* Add-from-DB button */}
          <button onClick={() => setShowDb(true)} disabled={allPlants.length === 0}
            className={`w-full flex items-center justify-center gap-2 py-3 border-2 border-dashed rounded-xl text-sm font-medium transition-colors ${
              allPlants.length > 0 ? 'border-green-200 text-green-700 hover:border-green-400 hover:bg-green-50' : 'border-stone-200 text-stone-400 cursor-not-allowed'
            }`}>
            <Plus size={15} />
            {allPlants.length > 0 ? '從植栽資料庫加入植物' : '請先匯入植栽資料庫'}
          </button>

          {/* Plant cards grid */}
          {selectedPlants.length === 0
            ? <p className="text-center text-stone-400 text-sm py-6">尚未加入植栽</p>
            : (
              <div className="grid grid-cols-2 gap-2">
                {selectedPlants.map(p => (
                  <SelectedPlantCard key={p.instanceId} plant={p} onRemove={() => removePlant(p.instanceId)} imageStore={imageStore} />
                ))}
              </div>
            )
          }

          {/* Spacer so button doesn't overlap last card */}
          <div className="h-2" />

          {/* Evaluate button — stays in left panel */}
          <div className="sticky bottom-0 pb-2 pt-1 bg-[#f7f5f0]">
            <button onClick={() => { setResult(evaluate(selectedPlants, allPlants)); setActiveReviewTab('overview') }} disabled={selectedPlants.length === 0}
              className={`w-full py-3.5 rounded-2xl text-sm font-bold transition-all min-h-[44px] ${
                selectedPlants.length > 0 ? 'bg-[#1a4731] text-white hover:bg-[#2d6a4f] shadow-md' : 'bg-stone-100 text-stone-400 cursor-not-allowed'
              }`}>
              {result ? '重新執行 AI 配植評估' : 'AI 配植評估'}
            </button>
          </div>
        </div>

        {/* ── Splitter (桌機可見) ── */}
        <div
          onMouseDown={onSplitMouseDown}
          className="hidden md:flex flex-shrink-0 w-2 items-center justify-center group cursor-col-resize bg-stone-200 hover:bg-[#2d6a4f] transition-colors z-10 select-none"
          title="拖曳調整版面寬度">
          <div className="w-0.5 h-8 rounded-full bg-stone-400 group-hover:bg-white transition-colors" />
        </div>

        {/* ── Right: 評估結果 ── */}
        <div className="flex-1 md:overflow-y-auto p-5 bg-[#f7f5f0] min-w-0">
          {!result ? (
            /* Empty state */
            <div className="border border-stone-200/80 rounded-2xl flex flex-col items-center justify-center py-28 text-center px-8 shadow-sm h-full max-h-[600px]" style={{ background: 'radial-gradient(circle at top right, rgba(111,168,120,0.10) 0%, transparent 32%), linear-gradient(145deg, #ffffff 0%, #fbfdfb 55%, #f3faf5 100%)' }}>
              <div className="w-20 h-20 rounded-full bg-[#d8f3dc] flex items-center justify-center mb-6">
                <Leaf size={36} className="text-[#2d6a4f]" />
              </div>
              <p className="text-xl font-bold text-stone-800 mb-2">尚未執行評估</p>
              <p className="text-sm text-stone-500 mt-1 max-w-sm leading-relaxed">
                在左側選取植栽組合後，點擊「AI 配植評估」按鈕，系統將自動分析水分、日照、排水與養護相容性，並產生審查回覆文字。
              </p>
              <div className="mt-8 flex items-center gap-6 text-xs text-stone-400">
                {[['🌿', '相容性分析'], ['⚠️', '風險識別'], ['📋', '審查回覆']].map(([icon, label]) => (
                  <div key={label} className="flex flex-col items-center gap-1.5">
                    <span className="text-2xl">{icon}</span>
                    <span>{label}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            /* Result tabs */
            (() => {
              const dangerCount = result.issues.filter(i => i.level === 'danger').length
              const TABS = [
                { id: 'overview'     as const, label: '總覽' },
                { id: 'categories'   as const, label: '問題分析' },
                { id: 'issues'       as const, label: `問題明細${activeIssues.length > 0 ? ` (${activeIssues.length})` : ''}` },
                { id: 'alternatives' as const, label: `替代植栽${result.alternatives.length > 0 ? ` (${result.alternatives.length})` : ''}` },
                { id: 'summary'      as const, label: '總結建議' },
              ]
              return (
                <div className="space-y-4">
                  {/* Tab bar — 膠囊按鈕風格，字大易讀 */}
                  <div className="flex items-center gap-2 flex-wrap bg-stone-100 rounded-2xl p-1.5">
                    {TABS.map(t => (
                      <button key={t.id} onClick={() => setActiveReviewTab(t.id)}
                        className={`flex-1 px-4 py-2.5 rounded-xl text-base font-semibold whitespace-nowrap transition-all ${
                          activeReviewTab === t.id
                            ? 'bg-[#1a4731] text-white shadow-md ring-2 ring-[#1a4731]/30'
                            : 'text-stone-500 hover:text-stone-800 hover:bg-white/70'
                        }`}>
                        {t.label}
                      </button>
                    ))}
                  </div>

                  {/* ── 總覽 ── */}
                  {activeReviewTab === 'overview' && (
                    <div className="space-y-4">
                      <div className="bg-white border border-stone-200 rounded-2xl p-6">
                        <ScoreDial score={result.score} level={result.compatLevel} />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="bg-white border border-stone-200 rounded-xl p-3">
                          <p className="text-xs text-stone-400">已選植物</p>
                          <p className="text-2xl font-bold text-stone-800">{selectedPlants.length} 種</p>
                        </div>
                        <div className="bg-white border border-stone-200 rounded-xl p-3">
                          <p className="text-xs text-stone-400">主要問題</p>
                          <p className="text-2xl font-bold text-amber-600">{activeIssues.length} 項</p>
                        </div>
                        <div className="bg-white border border-stone-200 rounded-xl p-3">
                          <p className="text-xs text-stone-400">高風險問題</p>
                          <p className="text-2xl font-bold text-red-600">{dangerCount} 項</p>
                        </div>
                        <div className="bg-white border border-stone-200 rounded-xl p-3">
                          <p className="text-xs text-stone-400">配置風險等級</p>
                          <p className="text-sm font-bold text-stone-800">{result.compatLevel}</p>
                        </div>
                      </div>
                      {/* ── DXF 分區審查結果（若有）── */}
                      {storedZones.length > 0 && (
                        <div className="rounded-xl border border-green-200 overflow-hidden">
                          <div className="px-4 py-2.5 bg-green-50 border-b border-green-100 flex items-center justify-between">
                            <p className="text-xs font-bold text-green-800 tracking-wide">DXF 分區審查結果（{storedZones.length} 區）</p>
                            <span className="text-[10px] text-green-600">點擊分區可查看詳細審查</span>
                          </div>
                          <div className="divide-y divide-stone-100 bg-white">
                            {storedZones.map(z => {
                              const riskCls = z.dangerCount > 0 ? 'bg-red-50 border-red-200 text-red-700'
                                : z.issueCount > 0 ? 'bg-amber-50 border-amber-200 text-amber-700'
                                : z.score !== undefined ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                                : 'bg-stone-50 border-stone-200 text-stone-500'
                              const riskLabel = z.dangerCount > 0 ? '高風險' : z.issueCount > 0 ? '中風險' : z.score !== undefined ? '低風險' : '待審查'
                              const scoreClr = !z.score ? 'text-stone-400' : z.score >= 80 ? 'text-emerald-700' : z.score >= 60 ? 'text-amber-700' : 'text-red-700'
                              const isActive = activeZoneId === z.zoneName
                              return (
                                <button key={z.zoneName}
                                  onClick={() => { setActiveZoneId(isActive ? null : z.zoneName); setActiveReviewTab('overview') }}
                                  className={`w-full text-left px-4 py-3 hover:bg-stone-50 transition-colors ${isActive ? 'bg-green-50 border-l-4 border-green-500' : ''}`}>
                                  <div className="flex items-center justify-between mb-1">
                                    <span className="font-bold text-stone-800 text-sm">{z.zoneName}</span>
                                    <div className="flex items-center gap-2">
                                      <span className={`text-xs font-bold px-2 py-0.5 rounded-full border ${riskCls}`}>{riskLabel}</span>
                                      {z.score !== undefined && (
                                        <span className={`text-sm font-bold ${scoreClr}`}>{z.score}<span className="text-xs font-normal text-stone-400">/100</span></span>
                                      )}
                                    </div>
                                  </div>
                                  <div className="flex gap-4 text-xs text-stone-500">
                                    <span>植物 {z.plantCount} 株</span>
                                    {z.issueCount > 0 && <span className="text-amber-600">問題 {z.issueCount} 項</span>}
                                    {z.dangerCount > 0 && <span className="text-red-600">高風險 {z.dangerCount} 項</span>}
                                    {z.mainIssues.length > 0 && <span className="text-stone-400 truncate">{z.mainIssues.slice(0,2).join('、')}</span>}
                                  </div>
                                  {isActive && <p className="text-[10px] text-green-600 mt-1">↓ 切換上方分頁查看本區詳細審查</p>}
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      )}

                      {/* AI 核心建議 — 手機預設收合，桌機展開 */}
                      <div className="bg-stone-50 border border-stone-200 rounded-xl overflow-hidden">
                        <button
                          onClick={() => setAiSuggestionExpanded(v => !v)}
                          className="w-full flex items-center justify-between px-4 py-3 text-left md:cursor-default min-h-[44px]">
                          <p className="text-xs font-semibold text-stone-600">
                            AI 核心建議{activeZone ? `（${activeZone.zoneName}）` : '（全案）'}
                          </p>
                          <ChevronDown size={15} className={`text-stone-400 transition-transform md:hidden ${aiSuggestionExpanded ? 'rotate-180' : ''}`} />
                        </button>
                        <div className={`px-4 pb-4 ${aiSuggestionExpanded ? 'block' : 'hidden md:block'}`}>
                          <p className="text-sm text-stone-700 leading-relaxed">
                            {activeZone ? (activeZone.aiSuggestion ?? '此區尚無 AI 建議') : result.aiSuggestion}
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* ── 分區指示列（有選中分區時顯示）── */}
                  {activeZone && (
                    <div className="flex items-center gap-3 px-4 py-2.5 bg-green-50 border border-green-200 rounded-xl">
                      <button onClick={() => setActiveZoneId(null)}
                        className="flex items-center gap-1.5 text-xs text-green-700 font-semibold hover:text-green-900">
                        <ArrowRight size={12} className="rotate-180" />回到全案總覽
                      </button>
                      <span className="text-stone-300">|</span>
                      <span className="text-sm font-bold text-green-800">目前查看：{activeZone.zoneName}</span>
                      {activeZone.score !== undefined && (
                        <span className={`text-sm font-bold ml-auto ${activeZone.score >= 80 ? 'text-emerald-700' : activeZone.score >= 60 ? 'text-amber-700' : 'text-red-700'}`}>
                          {activeZone.score}/100
                        </span>
                      )}
                    </div>
                  )}

                  {/* ── 問題分析 ── */}
                  {activeReviewTab === 'categories' && (
                    activeZone ? (
                      /* 分區問題分析 */
                      <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden shadow-sm">
                        <div className="px-5 py-3 bg-[#f7f5f0] border-b border-stone-100">
                          <p className="text-sm font-semibold text-stone-800 tracking-wide">{activeZone.zoneName} 問題分類總覽</p>
                        </div>
                        <div className="p-5">
                          {activeZone.categories && activeZone.categories.length > 0
                            ? <CategoryGrid categories={activeZone.categories as never} altCount={0} />
                            : <p className="text-sm text-stone-400 text-center py-8">此區無問題分析資料</p>
                          }
                        </div>
                      </div>
                    ) : (
                      /* 全案問題分析 */
                      <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden shadow-sm">
                        <div className="px-5 py-3 bg-[#f7f5f0] border-b border-stone-100">
                          <p className="text-sm font-semibold text-stone-800 tracking-wide">問題分類總覽</p>
                        </div>
                        <div className="p-5">
                          <CategoryGrid categories={result.categories} altCount={result.alternatives.length} />
                        </div>
                      </div>
                    )
                  )}

                  {/* ── 問題明細 ── */}
                  {activeReviewTab === 'issues' && (
                    activeZone ? (
                      /* 分區問題明細 */
                      activeZone.issues && activeZone.issues.length > 0 ? (
                        <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden shadow-sm">
                          <div className="px-5 py-3 bg-[#f7f5f0] border-b border-stone-100">
                            <p className="text-sm font-semibold text-stone-800 tracking-wide">{activeZone.zoneName} 問題明細　{activeZone.issues.length} 項</p>
                          </div>
                          <div className="p-5 space-y-3">
                            {activeZone.issues.map((issue, i) => <IssueCard key={i} issue={issue as never} />)}
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center justify-center py-16 text-stone-400">
                          <CheckCircle size={36} className="text-green-400 mb-3" />
                          <p className="text-sm font-medium">{activeZone.zoneName} 無審查問題</p>
                        </div>
                      )
                    ) : (
                      /* 全案問題明細 */
                      activeIssues.length > 0 ? (
                        <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden shadow-sm">
                          <div className="px-5 py-3 bg-[#f7f5f0] border-b border-stone-100">
                            <p className="text-sm font-semibold text-stone-800 tracking-wide">審查問題明細　{activeIssues.length} 項</p>
                          </div>
                          <div className="p-5 space-y-3">
                            {activeIssues.map((issue, i) => <IssueCard key={i} issue={issue} />)}
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center justify-center py-16 text-stone-400">
                          <CheckCircle size={36} className="text-green-400 mb-3" />
                          <p className="text-sm font-medium">無審查問題</p>
                        </div>
                      )
                    )
                  )}

                  {/* ── 替代植栽 ── */}
                  {activeReviewTab === 'alternatives' && (
                    activeZone ? (
                      <div className="flex flex-col items-center justify-center py-16 text-stone-400">
                        <p className="text-sm font-medium">DXF 分區審查不含替代植栽建議</p>
                        <p className="text-xs mt-1">如需替代植栽，請至 AI 配植評估（全案）查看</p>
                      </div>
                    ) : (
                      result.alternatives.length > 0 ? (
                        <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden shadow-sm">
                          <div className="px-5 py-3 bg-[#f7f5f0] border-b border-stone-100">
                            <p className="text-sm font-semibold text-stone-800 tracking-wide">替代植栽建議　{result.alternatives.length} 種植栽可替換</p>
                          </div>
                          <div className="p-5 space-y-3">
                            {result.alternatives.map((s, i) => <AltCard key={i} suggestion={s} />)}
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center justify-center py-16 text-stone-400">
                          <p className="text-sm font-medium">無替代建議</p>
                        </div>
                      )
                    )
                  )}

                  {/* ── 總結建議 ── */}
                  {activeReviewTab === 'summary' && (() => {
                    const ai   = activeZone ? (activeZone.aiSuggestion   ?? '') : result.aiSuggestion
                    const plan = activeZone ? (activeZone.adjustmentPlan  ?? []) : result.adjustmentPlan
                    const rev  = activeZone ? (activeZone.reviewText      ?? '') : result.reviewText
                    const title = activeZone ? `${activeZone.zoneName} 審查建議` : 'AI 配置修正建議'
                    return (
                    <div className="space-y-4">
                      <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden shadow-sm">
                        <div className="px-5 py-3 bg-[#f7f5f0] border-b border-stone-100">
                          <p className="text-sm font-semibold text-stone-800 tracking-wide">{title}</p>
                        </div>
                        <div className="p-5">
                          <p className="text-sm text-stone-600 leading-relaxed">{ai || '（無建議）'}</p>
                        </div>
                      </div>
                      {plan.length > 0 && (
                        <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden shadow-sm">
                          <div className="px-5 py-3 bg-[#f7f5f0] border-b border-stone-100">
                            <p className="text-sm font-semibold text-stone-800 tracking-wide">配置調整方案</p>
                          </div>
                          <div className="p-5">
                            <ul className="space-y-2.5">
                              {plan.map((p, i) => (
                                <li key={i} className="flex items-start gap-3">
                                  <div className="w-5 h-5 rounded-full bg-green-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                                    <span className="text-xs font-bold text-green-700">{i + 1}</span>
                                  </div>
                                  <p className="text-sm text-stone-600 leading-relaxed">{p}</p>
                                </li>
                              ))}
                            </ul>
                          </div>
                        </div>
                      )}
                      <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden shadow-sm">
                        <div className="px-5 py-3 bg-[#f7f5f0] border-b border-stone-100">
                          <p className="text-sm font-semibold text-stone-800 tracking-wide">審查回覆文字</p>
                        </div>
                        <div className="p-5 space-y-3">
                          <div className="bg-stone-50 rounded-xl p-4 border border-stone-100 max-h-64 overflow-y-auto">
                            <p className="text-sm text-stone-700 leading-[1.9] whitespace-pre-line">{rev || '（無審查回覆）'}</p>
                          </div>
                          {!activeZone && (
                            <div className="flex gap-3">
                              <button onClick={() => { navigator.clipboard.writeText(result.reviewText).then(() => { setCopyDone(true); setTimeout(() => setCopyDone(false), 2000) }) }}
                                className="flex items-center gap-2 px-4 py-2 rounded-xl border border-stone-200 text-sm text-stone-600 hover:bg-stone-50 transition-colors">
                                {copyDone ? <CheckCircle size={14} className="text-green-500" /> : <Info size={14} />}
                                {copyDone ? '已複製' : '複製文字'}
                              </button>
                              <button onClick={handleExport}
                                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-green-700 text-white text-sm font-medium hover:bg-green-800 transition-colors">
                                <FileDown size={14} />匯出完整報告
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                    )
                  })()}
                </div>
              )
            })()
          )}
        </div>
      </div>

      {showDb && (
        <PlantDatabaseModal
          plants={allPlants}
          onClose={() => setShowDb(false)}
          onSelect={addPlant}
          selectedIds={selectedIds}
          imageStore={imageStore}
          onSaveImage={handleSaveImage}
        />
      )}
      {showCsvImport && (
        <CsvImportModal onClose={() => setShowCsvImport(false)} onImported={handleCsvImported} />
      )}
    </div>
  )
}
