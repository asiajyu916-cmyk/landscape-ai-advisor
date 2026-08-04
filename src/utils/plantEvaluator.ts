// ── plantEvaluator.ts — 植栽配置相容性審查核心（從 LandscapeAdvisorPage 抽出共用）──
// 供 DxfReviewPage 分區審查使用；LandscapeAdvisorPage 維持原有本地版本不變。

import { waterScore, sunConflictLevel, drainageConflictLevel } from '@/utils/csvParser'
import type { CsvPlantRecord, SelectedCsvPlant } from '@/types/csvPlant'
import type { RiskLevel } from '@/types/dxf'
import {
  gapSeverity, levelsGapSeverity, sunLevelOf, waterLevelOf, maintenanceLevelOf,
  type GapSeverity,
} from '@/utils/compatibilityLevels'
import { detectSiteDrainageEvidence, type SiteDrainageEvidence } from '@/utils/siteDrainageContext'

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

// 替代植栽建議（跟 LandscapeAdvisorPage.tsx 本地版本逐欄位對齊，方便 StoredZone 直接
// 餵給既有的 AltCard 元件而不用轉型——兩邊各自維護一份是刻意的，見 evaluate() 內註解）
export interface AltOption {
  plant: CsvPlantRecord
  reason: string
  riskReduction: string
  sameSubCategory?: boolean
}

export interface AltSuggestion {
  originalPlant: SelectedCsvPlant
  noSameType?: boolean
  problemLabels: string[]
  alternatives: AltOption[]
}

export interface EvalResult {
  score: number
  compatLevel: CompatLevel
  categories: CatSummary[]
  issues: IssueDetail[]
  aiSuggestion: string
  adjustmentPlan: string[]
  reviewText: string
  /** 空間鄰近衝突彙整專用（見 aggregatePairConflictsToEvalResult）：跟 score 分開顯示的
   * 整體風險等級，答的是「需不需要優先處理」，score 答的是「整體配置健康度」——
   * 只要有嚴重配對，風險等級就是「高」，即使 score 因為多數配對通過而不算太低。
   * evaluate() 產生的 EvalResult 不填這個欄位。 */
  overallRiskLevel?: '高' | '中' | '低'
  /** DXF 分區審查用：evaluate() 才會填，aggregatePairConflictsToEvalResult() 不填，
   * 分區的 evalResult 是事後另外呼叫一次 evaluate() 補上這個欄位（見 buildZoneReviews）。 */
  alternatives?: AltSuggestion[]
}

// ── Core evaluate ─────────────────────────────────────────────────────────────

function makeIssue(category: string, level: IssueLevel, cause: string, impact: string, suggestion: string): IssueDetail {
  return { category, level, cause, impact, suggestion }
}

const CATEGORY_DEFS = [
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

function categoriesFromIssues(issues: IssueDetail[]): CatSummary[] {
  return CATEGORY_DEFS.map(c => {
    const matched = issues.filter(i => i.category === c.key)
    const maxLevel: IssueLevel = matched.some(i => i.level === 'danger') ? 'danger' : matched.some(i => i.level === 'caution') ? 'caution' : 'ok'
    return {
      key: c.key, label: c.key, count: matched.length, level: maxLevel,
      statusLabel: maxLevel === 'danger' ? '高風險' : maxLevel === 'caution' ? '需注意' : '未發現',
      summary: matched.length > 0 ? matched[0].cause.slice(0, 40) + '…' : c.okSummary,
    }
  })
}

export function evaluate(
  plants: SelectedCsvPlant[],
  allPlants: CsvPlantRecord[],
  siteDrainageEvidence: SiteDrainageEvidence = 'ground-natural',
): EvalResult {
  const issues: IssueDetail[] = []
  const problemIds = new Set<string>()
  let deductions = 0

  // ── 程度差距判定（日照／澆水／排水／養護強度）──────────────────────────────
  // 統一規則（見 compatibilityLevels.ts）：差距 0～2 級＝通過，不列入問題、不扣分；
  // 差距 3 級＝提醒，輕微扣分；差距 4 級以上＝嚴重，列入主要問題與高風險。取代
  // 過去 waterScore/sunConflictLevel/drainageConflictLevel 各自的門檻，避免「條件
  // 只是不同，不是真的衝突」也被列為警示。

  // 1. 澆水
  const waterLevels = plants.map(p => waterLevelOf(p.waterRequirement))
  const { severity: waterSeverity, gap: waterGap } = levelsGapSeverity(waterLevels)
  if (waterSeverity === 'danger') {
    deductions += 20
    const validW = waterLevels.filter((v): v is number => v !== undefined)
    const maxW = Math.max(...validW), minW = Math.min(...validW)
    plants.filter(p => { const lv = waterLevelOf(p.waterRequirement); return lv === minW || lv === maxW })
      .forEach(p => problemIds.add(p.instanceId))
    issues.push(makeIssue('澆水衝突', 'danger',
      `本區植栽水分需求差距達 ${waterGap} 級（${[...new Set(plants.map(p => p.waterRequirement))].join('、')}），若以同一灌溉管理，高需水植物可能缺水，低需水植物可能積水爛根。`,
      '澆水管理無法同時兼顧所有植物需求，長期將導致部分植物衰退，增加後續養護難度。',
      '建議依水分需求高低設置獨立灌溉迴路，或替換為水分需求相近的植栽組合。'))
  } else if (waterSeverity === 'caution') {
    deductions += 6
    issues.push(makeIssue('澆水衝突', 'caution',
      `本區植栽水分需求差距 ${waterGap} 級（${[...new Set(plants.map(p => p.waterRequirement))].join('、')}），建議留意澆灌頻率管理。`,
      '若統一澆水頻率，部分植物可能受到輕微水分壓力，影響生長勢。',
      '建議於養護計畫中標示各植栽的適當給水量，並考慮分組澆灌。'))
  }

  // 2. 排水／耐濕
  // 舊邏輯只比較兩株植物耐濕等級的差距，沒有「這個場地是否真的會積水」這個前提，
  // 導致一樓自然土種植的台北草（耐濕）＋桂花（不耐積水）這種常見庭園配置被判定
  // 為嚴重排水衝突。新規則：耐濕等級不同本身不成立衝突，衝突必須同時存在「場地
  // 積水證據」（siteDrainageEvidence，見 siteDrainageContext.ts，由既有分區／圖層
  // 名稱關鍵字掃描取得，不寫死特定植物名稱）——沒有證據時，即使種了不耐積水植物
  // 也維持通過，不列入 issues、不扣分。
  const dryPlants = plants.filter(p => p.wetTolerance === '不耐積水')
  const wetPlants = plants.filter(p => p.wetTolerance === '耐濕')
  const hasNotTolerant = dryPlants.length > 0
  const drainSeverity: GapSeverity = !hasNotTolerant ? 'pass'
    : siteDrainageEvidence === 'impervious-evidence' ? 'danger'
    : siteDrainageEvidence === 'unknown-structure' ? 'caution'
    : 'pass'   // siteDrainageEvidence === 'ground-natural'：預設一樓自然土層，不成立排水衝突

  if (drainSeverity === 'danger') {
    deductions += 15
    dryPlants.forEach(p => problemIds.add(p.instanceId))
    wetPlants.forEach(p => problemIds.add(p.instanceId))
    issues.push(makeIssue('排水衝突', 'danger',
      `本場地偵測到低窪、集水區、不透水底板或排水不良等積水證據，種植不耐積水植物（${dryPlants.map(p => p.name).join('、')}）風險較高${wetPlants.length > 0 ? `，且與耐濕植物（${wetPlants.map(p => p.name).join('、')}）混植，排水需求差異明顯` : ''}。`,
      '場地已有積水證據時，不耐積水植物易發生爛根，長期影響存活率與景觀品質。',
      '建議優先改善排水設計（如加高花台、增設排水層或明溝）、視情況移動植物位置，若無法改善排水，最後再考慮更換為耐積水植物。'))
  } else if (drainSeverity === 'caution') {
    deductions += 6
    issues.push(makeIssue('排水衝突', 'caution',
      `本區種植不耐積水植物（${dryPlants.map(p => p.name).join('、')}），但圖面無法確認地下是否為自然土層（可能為地下室頂板、人工花台或屋頂綠化），建議先確認排水構造再判斷是否需要調整。`,
      '若地下實際為不透水構造且排水設計不足，不耐積水植物易受積水影響；若確認為自然土層則通常無需特別處理。',
      '建議確認地下構造與排水設施是否符合植栽需求，必要時安排現場或圖面覆核。'))
  }

  // 3. 日照
  const sunLevels = plants.map(p => sunLevelOf(p.sunRequirement))
  const { severity: sunSeverity, gap: sunGap } = levelsGapSeverity(sunLevels)
  if (sunSeverity === 'danger') {
    deductions += 16
    const validSun = sunLevels.filter((v): v is number => v !== undefined)
    const maxSun = Math.max(...validSun), minSun = Math.min(...validSun)
    plants.filter(p => { const lv = sunLevelOf(p.sunRequirement); return lv === minSun || lv === maxSun })
      .forEach(p => problemIds.add(p.instanceId))
    issues.push(makeIssue('日照問題', 'danger',
      `本區植栽日照需求差距達 ${sunGap} 級（${[...new Set(plants.map(p => p.sunRequirement))].join('、')}），日照需求完全相反。`,
      '全日照環境下耐陰植物容易葉燒，遮蔭環境下全日照植物生長勢衰退，兩者無法共存於同一光照條件。',
      '建議將全日照與耐陰植物分區配置，或將耐陰植物換為全日照至半日照之替代植栽。'))
  } else if (sunSeverity === 'caution') {
    deductions += 7
    issues.push(makeIssue('日照問題', 'caution',
      `本區植栽日照需求差距 ${sunGap} 級（${[...new Set(plants.map(p => p.sunRequirement).filter(s => s !== '待查'))].join('、')}），建議確認配置位置對應日照條件。`,
      '日照需求不一的植物若未依位置配置，可能造成部分植物生長差異，影響景觀均一性。',
      '建議確認場域各位置實際日照時數，將日照需求相近的植物集中配置。'))
  }

  // 4. 養護強度
  const mLevels = plants.map(p => maintenanceLevelOf(p.maintenanceLevel))
  const { severity: maintSeverity, gap: maintGap } = levelsGapSeverity(mLevels)
  if (maintSeverity === 'danger' || maintSeverity === 'caution') {
    deductions += maintSeverity === 'danger' ? 10 : 5
    if (maintSeverity === 'danger') plants.filter(p => p.maintenanceLevel === '高').forEach(p => problemIds.add(p.instanceId))
    issues.push(makeIssue('維護風險', maintSeverity,
      `本區植栽維護強度差距 ${maintGap} 級，包含高維護植物（${plants.filter(p => p.maintenanceLevel === '高').map(p => p.name).join('、')}）與低維護植物。`,
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

  // 7. 土壤相容性檢查
  const phOrder: Record<string, number> = {
    '酸性': 1, '微酸性': 2, '中性': 3, '微鹼性': 4, '鹼性': 5,
  }
  const plantsWithPh = plants.filter(p => p.soilPh && phOrder[p.soilPh] !== undefined)
  if (plantsWithPh.length >= 2) {
    const phValues = plantsWithPh.map(p => phOrder[p.soilPh])
    const phGap = Math.max(...phValues) - Math.min(...phValues)
    const phSeverity = gapSeverity(phGap)   // pH 本身已是 1~5 級，直接套用統一門檻，不再自己訂一套
    if (phSeverity === 'danger') {
      deductions += 15
      const acidPlants  = plantsWithPh.filter(p => phOrder[p.soilPh] <= 2).map(p => `${p.name}（${p.soilPh}）`)
      const alkaliPlants = plantsWithPh.filter(p => phOrder[p.soilPh] >= 4).map(p => `${p.name}（${p.soilPh}）`)
      issues.push(makeIssue('土壤酸鹼衝突', 'danger',
        `本區植栽土壤 pH 需求差距達 ${phGap} 級：酸性偏好植物（${acidPlants.join('、')}）與鹼性偏好植物（${alkaliPlants.join('、')}）無法共存於同一土壤環境。`,
        '統一土壤 pH 將造成部分植物出現缺素症（如酸性土壤中鹼性植物缺鐵、缺錳）或生長停滯，長期影響植物存活率。',
        '建議依 pH 需求進行分區種植，各區土壤分別調整至適合 pH 範圍，或替換為相近 pH 需求的替代植栽。'))
    } else if (phSeverity === 'caution') {
      deductions += 6
      const phList = [...new Set(plantsWithPh.map(p => `${p.name}（${p.soilPh}）`))]
      issues.push(makeIssue('土壤酸鹼衝突', 'caution',
        `本區植栽土壤 pH 需求差距 ${phGap} 級（${phList.join('、')}），建議確認土壤酸鹼性可兼容各植栽需求。`,
        '不同 pH 偏好的植物在同一土壤中可能出現生長差異，影響景觀均一性。',
        '建議於施工前進行土壤 pH 檢測，必要時以硫磺粉（降 pH）或石灰（升 pH）調整，並於後續養護中定期監測。'))
    }
  }

  const plantsNeedAmend = plants.filter(p => p.soilAmendment === '是' || p.soilAmendment === '建議')
  if (plantsNeedAmend.length > 0) {
    deductions += 5
    issues.push(makeIssue('土壤改良需求', 'caution',
      `本區有 ${plantsNeedAmend.length} 種植栽需要或建議進行客土改良（${plantsNeedAmend.map(p => p.name).join('、')}）。`,
      '若未進行適當土壤改良即行種植，此類植栽之根系適應性與長期存活率將受到影響。',
      '建議於景觀施工說明書中明列客土改良規格（如有機質添加量、土壤質地改善措施），並於竣工前確認執行。'))
  }

  const textures = [...new Set(plants.map(p => p.soilTexture).filter(Boolean))]
  if (textures.length >= 2 && (textures.includes('砂質土') && textures.includes('黏質土'))) {
    deductions += 6
    const sandPlants = plants.filter(p => p.soilTexture === '砂質土').map(p => p.name)
    const clayPlants = plants.filter(p => p.soilTexture === '黏質土').map(p => p.name)
    issues.push(makeIssue('土壤質地衝突', 'caution',
      `本區植栽土壤質地需求相反：偏好砂質土（${sandPlants.join('、')}）與偏好黏質土（${clayPlants.join('、')}）的植物混植，難以提供理想土壤環境。`,
      '統一土壤質地將使部分植物因排水過快或積水而生長不良。',
      '建議採用壤土作為基底，並針對特定植栽進行局部土壤質地改良，或分區配置以配合不同土壤質地需求。'))
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
  if (score >= 80)      compatLevel = '配置良好'
  else if (score >= 60) compatLevel = '可行但需補充說明'
  else if (score >= 40) compatLevel = '需調整配置'
  else                  compatLevel = '高風險不建議'

  // ── Alternatives（逐字對齊 LandscapeAdvisorPage.tsx 本地 evaluate() 同一段，兩邊
  // 各自維護一份是刻意的——見檔頭與 EvalResult.alternatives 註解）──────────────
  const problemPlants = plants.filter(p =>
    p.status === '不建議' || p.status === '需注意' || problemIds.has(p.instanceId)
  )
  const selectedIds = new Set(plants.map(p => p.id))

  const alternatives: AltSuggestion[] = problemPlants.map(target => {
    const others = plants.filter(p => p.instanceId !== target.instanceId)
    // 優先同 subCategory（大喬木→大喬木），其次同 normalizedCategory，絕不跨大類
    const sameSubCat = allPlants.filter(c =>
      c.subCategory === target.subCategory && c.subCategory !== '' && !selectedIds.has(c.id)
    )
    const sameCat = allPlants.filter(c =>
      c.normalizedCategory === target.normalizedCategory && !selectedIds.has(c.id)
    )
    // subCategory 有值時嚴格同層，不跨大喬木/小喬木/灌木等；subCategory 為空才 fallback 同大類
    const candidates = (target.subCategory && target.subCategory !== '')
      ? sameSubCat
      : sameCat
    const strictMode = sameSubCat.length >= 1

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
        sameSubCategory: s.plant.subCategory === target.subCategory,
      }))

    const noSameType = top3.length === 0 && candidates.length === 0

    const pLabels: string[] = []
    if (target.status === '不建議') pLabels.push('不建議')
    else if (target.status === '需注意') pLabels.push('需注意')
    if (problemIds.has(target.instanceId)) {
      issues.forEach(iss => {
        if (iss.cause.includes(target.name)) pLabels.push(iss.category)
      })
    }

    return {
      originalPlant: target,
      problemLabels: [...new Set(pLabels)],
      alternatives: top3,
      noSameType: noSameType || (!strictMode && top3.length === 0),
    }
  }).filter(s => s.alternatives.length > 0 || s.noSameType)

  const categories: CatSummary[] = categoriesFromIssues(issues)

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
  if (waterSeverity === 'danger') adjustmentPlan.push('設置獨立分區灌溉迴路，依水分需求高低分組管理')
  else if (waterSeverity === 'caution') adjustmentPlan.push('調整澆灌頻率，於養護計畫中標示各植栽的適當給水量')
  if (drainSeverity === 'danger') adjustmentPlan.push('改善排水設計（加高花台、增設排水層或明溝），並視情況調整不耐積水植物的位置')
  else if (drainSeverity === 'caution') adjustmentPlan.push('確認地下構造與排水設施是否符合植栽需求（是否為地下室頂板、人工花台或屋頂綠化）')
  if (sunSeverity === 'danger') adjustmentPlan.push('將全日照與耐陰植物分配至場域日照充足區與遮蔭區')
  else if (sunSeverity === 'caution') adjustmentPlan.push('確認場域各區塊實際日照時數，依日照需求分組配置')
  if (maintSeverity === 'danger' || maintSeverity === 'caution') adjustmentPlan.push('建立分植物養護時間表，標示各植栽修剪頻率與施肥計畫')
  if (tallTrees.length > 0 && groundcovers.length > 0) adjustmentPlan.push('規劃喬木與地被之種植間距，選用耐陰地被配置於冠幅範圍內')
  if (incompleteData.length > 0) adjustmentPlan.push(`補查 ${incompleteData.map(p => p.name).join('、')} 的官方日照水分資料`)
  if (plantsWithPh.length >= 2 && gapSeverity(Math.max(...plantsWithPh.map(p => phOrder[p.soilPh])) - Math.min(...plantsWithPh.map(p => phOrder[p.soilPh]))) !== 'pass')
    adjustmentPlan.push('施工前進行土壤 pH 檢測，依各植栽需求調整酸鹼度，並分區管理')
  if (plantsNeedAmend.length > 0) adjustmentPlan.push('於景觀施工說明書中列明客土改良規格，竣工前確認執行')
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

  // ── 相近植物替代評估標記（與 LandscapeAdvisorPage 本地 evaluate 一致）───────
  const substitutePlants = plants.filter(p => p.evaluationMode === 'similar-plant-substitute')
  if (substitutePlants.length > 0) {
    const substituteList = substitutePlants
      .map(p => `${p.originalPlantName ?? '(原始植物名稱未記錄)'} → 暫代：${p.substitutePlantName ?? p.name}`)
      .join('\n')
    reviewText += `\n\n【相近植物替代評估】\n本次評估中，以下植物因本地資料庫查無完全相符資料，經人工確認以名稱相近植物暫代進行模擬評估：\n${substituteList}\n\n本結果使用相近植物資料進行模擬，不代表原植物品種的正式生育特性，僅供初步參考，正式設計文件請另行查證原始植物之官方生育資料。`
  }

  return { score, compatLevel, categories, issues, aiSuggestion, adjustmentPlan, reviewText, alternatives }
}

// ── 逐對（空間鄰近）評估 ─────────────────────────────────────────────────────
// 供 plantProximity.ts 的空間鄰近管線使用：只評估「這一對」植物是否相容，而不是
// 整區所有已比對植物的 min/max 落差——直接重用 evaluate()（傳入恰好 2 株植物的
// 陣列，此時 min/max 落差就等於這兩株植物本身的落差），沿用同一套水分/日照/排水/
// 土壤/維護/根系等既有門檻邏輯，不重寫比對規則，只改變「誰跟誰比」。

function toSelectedPlant(p: CsvPlantRecord, instanceId: string): SelectedCsvPlant {
  return { ...p, instanceId, status: '可用' }
}

export function evaluatePlantPair(
  a: CsvPlantRecord, b: CsvPlantRecord, allPlants: CsvPlantRecord[],
  siteDrainageEvidence?: SiteDrainageEvidence,
): EvalResult {
  return evaluate([toSelectedPlant(a, 'pair-a'), toSelectedPlant(b, 'pair-b')], allPlants, siteDrainageEvidence)
}

/**
 * 把逐對空間鄰近衝突結果彙整回既有 EvalResult 形狀，讓既有分數／類別 UI
 * （DxfReviewPage.tsx 的分區審查摘要）不需大改。彙整方式：合併所有鄰近對
 * 的 issues（依 category+cause 去重，避免同一種衝突原因因出現在多對植物
 * 而重複列出），再依 danger/caution 數量重新計分。
 */
export function aggregatePairConflictsToEvalResult(
  pairs: Array<{ issues: IssueDetail[]; riskLevel: RiskLevel }>,
): EvalResult {
  const issues: IssueDetail[] = []
  const seen = new Set<string>()
  for (const pair of pairs) {
    for (const issue of pair.issues) {
      const key = `${issue.category}|${issue.cause}`
      if (seen.has(key)) continue
      seen.add(key)
      issues.push(issue)
    }
  }

  // ── 加權扣分制（取代舊的逐項扣分：dangerCnt*15 + cautionCnt*7 沒有上限，
  // 配對一多、去重後的 danger/caution 類別數稍微超過 6~7 項就會把分數打到 0，
  // 跟「只有 2 項高風險」的實際情況觀感不成比例）。改以配對數為分母算加權
  // 比例：嚴重配對計 0 分、警示配對計半分、已通過配對計滿分，score 天生就落在
  // 0~100 之間，不需要 clamp，也不會因配對數變多而輕易歸零。
  const severeCnt = pairs.filter(p => p.riskLevel === 'high').length
  const warningCnt = pairs.filter(p => p.riskLevel === 'medium').length
  const passedCnt = pairs.filter(p => p.riskLevel === 'low' || p.riskLevel === 'unmatched').length
  const totalCnt = severeCnt + warningCnt + passedCnt

  const score = totalCnt === 0
    ? 100
    : Math.round(((severeCnt * 0 + warningCnt * 0.5 + passedCnt * 1) / totalCnt) * 100)

  let compatLevel: CompatLevel
  if (score >= 80) compatLevel = '配置良好'
  else if (score >= 60) compatLevel = '可行但需補充說明'
  else if (score >= 40) compatLevel = '需調整配置'
  else compatLevel = '高風險不建議'

  // 風險等級跟 score 是兩條獨立資訊（雙軌顯示）：score 答「整體配置健康度」，
  // 風險等級答「需不需要優先處理」——只要有嚴重配對就是「高」，不會因為多數
  // 配對已通過、score 被拉高而被稀釋掉「這裡有緊急問題」的訊號。
  const overallRiskLevel: '高' | '中' | '低' = severeCnt > 0 ? '高' : warningCnt > 0 ? '中' : '低'

  const categories = categoriesFromIssues(issues)

  let aiSuggestion: string
  if (totalCnt === 0) {
    aiSuggestion = '本分區內空間鄰近植物配置相容性良好，鄰近範圍內未發現明顯衝突。'
  } else if (severeCnt > 0) {
    const cats = [...new Set(issues.filter(i => i.level === 'danger').map(i => i.category))].join('、')
    aiSuggestion = `風險等級：高；整體評分：${score}；原因：高風險 ${severeCnt} 項、警示 ${warningCnt} 項、通過 ${passedCnt} 項${cats ? `（高風險類別：${cats}）` : ''}。建議於提送審查前優先調整高風險配對。`
  } else if (warningCnt > 0) {
    aiSuggestion = `風險等級：中；整體評分：${score}；警示 ${warningCnt} 項、通過 ${passedCnt} 項。整體可行，建議補充養護說明降低審查疑義。`
  } else {
    aiSuggestion = `風險等級：低；整體評分：${score}；${passedCnt} 項配對皆已通過檢討。`
  }

  const adjustmentPlan = [...new Set(issues.map(i => i.suggestion))]
  if (adjustmentPlan.length === 0) adjustmentPlan.push('維持現有配置，施工前確認種植間距與覆土深度符合各植栽需求')

  const reviewText = totalCnt === 0
    ? `本分區空間鄰近衝突檢討結果為「配置良好」（風險等級：低；整體評分：${score}），鄰近植物之間未發現明顯衝突。`
    : `本分區空間鄰近衝突檢討結果──風險等級：${overallRiskLevel}；整體評分：${score}；原因：高風險 ${severeCnt} 項、警示 ${warningCnt} 項、通過 ${passedCnt} 項。\n\n${issues.map(i => `${i.category}：${i.cause}`).join('\n')}\n\n修正方向：\n${adjustmentPlan.map(p => `• ${p}`).join('\n')}`

  return { score, compatLevel, categories, issues, aiSuggestion, adjustmentPlan, reviewText, overallRiskLevel }
}
