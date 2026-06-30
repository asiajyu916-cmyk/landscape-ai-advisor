import type { ZonePlantingRow } from './parsePdfZones'
import type { CsvPlantRecord } from '@/types/csvPlant'

export interface ZoneIssue {
  type: string
  description: string
  suggestion: string
}

export interface ZoneReviewResult {
  zoneName: string
  shrubs: string[]
  trees: string[]
  score: number
  riskLevel: '低' | '中' | '高'
  issues: ZoneIssue[]
  summary: string
}

export function evaluateZone(zone: ZonePlantingRow, db: CsvPlantRecord[]): ZoneReviewResult {
  const allNames = [...zone.shrubs, ...zone.trees]
  const found = allNames
    .map(name => db.find(p => p.name === name || p.name.includes(name) || name.includes(p.name)))
    .filter((p): p is CsvPlantRecord => !!p)

  let score = 85
  const issues: ZoneIssue[] = []

  // 水分需求衝突
  const waterReqs = found.map(p => p.waterRequirement).filter(w => w && w !== '待查')
  const hasHighWater = waterReqs.some(w => w === '高' || w === '中至高')
  const hasLowWater  = waterReqs.some(w => w === '低' || w === '低至中')
  if (hasHighWater && hasLowWater) {
    score -= 15
    issues.push({
      type: '水分需求',
      description: '本區植物水分需求差異較大，混植可能導致部分植物缺水或過濕。',
      suggestion: '依水分需求分區配置，或選擇需水量接近的植種，並評估灌溉系統的分區控制能力。',
    })
  }

  // 日照適性衝突
  const sunReqs = found.map(p => p.sunRequirement).filter(s => s && s !== '待查')
  const hasFullSun = sunReqs.some(s => s === '全日照')
  const hasShade   = sunReqs.some(s => s.includes('遮陰'))
  if (hasFullSun && hasShade) {
    score -= 12
    issues.push({
      type: '日照適性',
      description: '本區同時包含全日照與耐陰植物，兩者日照需求難以同時滿足。',
      suggestion: '耐陰植物配置於喬木遮陰下方，全日照植物置於開放空曠區域，以空間位置化解日照差異。',
    })
  }

  // 維護風險
  const highMaint = found.filter(p => p.maintenanceLevel === '高')
  if (highMaint.length >= 2) {
    score -= 8
    issues.push({
      type: '維護風險',
      description: `${highMaint.map(p => p.name).join('、')} 維護需求較高，整區養護成本偏重。`,
      suggestion: '確保充足養護預算與人力配置，或以低維護替代植種替換部分高維護植物。',
    })
  }

  // 根系風險
  const rootRisk = found.filter(p => p.riskTags?.some(t => t.includes('根') || t.includes('侵入')))
  if (rootRisk.length > 0) {
    score -= 10
    issues.push({
      type: '根系風險',
      description: `${rootRisk.map(p => p.name).join('、')} 根系較強，可能影響鋪面、管線或相鄰構造物。`,
      suggestion: '施工時設置根系導引板，並事先確認地下管線位置，預留足夠生長空間。',
    })
  }

  // 景觀層次
  if (zone.shrubs.length === 0) {
    score -= 5
    issues.push({
      type: '景觀層次',
      description: '本區缺乏灌木層，垂直層次感不足，地表裸露風險較高。',
      suggestion: '補充中低層灌木或地被植物，豐富視覺層次並保護地表水土。',
    })
  }
  if (zone.trees.length === 0) {
    score -= 5
    issues.push({
      type: '空間尺度',
      description: '本區缺乏喬木，遮陰效果與垂直尺度感不足。',
      suggestion: '依基地條件補充適當喬木，以提供遮陰、降溫，並強化空間構架感。',
    })
  }

  // 植物不在資料庫
  const unknownPlants = allNames.filter(
    name => !db.find(p => p.name === name || p.name.includes(name) || name.includes(p.name))
  )
  if (unknownPlants.length > 0) {
    score -= 3
    issues.push({
      type: '資料完整性',
      description: `${unknownPlants.join('、')} 未在植栽資料庫中，無法進行詳細特性比對。`,
      suggestion: '請核實植物中文名稱，並補充至植栽資料庫以利後續管理。',
    })
  }

  // 無問題時給正面評語
  if (issues.length === 0) {
    issues.push({
      type: '整體配置',
      description: '本區植栽組合配置均衡，無明顯衝突問題。',
      suggestion: '可進一步規劃花期搭配與季節色彩，提升觀賞多樣性。',
    })
  }

  score = Math.max(50, Math.min(100, score))
  const riskLevel: '低' | '中' | '高' = score >= 75 ? '低' : score >= 60 ? '中' : '高'
  const riskLabel = riskLevel === '低' ? '良好' : riskLevel === '中' ? '尚可，建議調整' : '需調整'

  const summary =
    `${zone.zoneName}配置喬木（${zone.trees.join('、') || '無'}）與灌木地被（${zone.shrubs.join('、') || '無'}），` +
    `整體配置${riskLabel}，共發現 ${issues.length} 項注意事項，審查評分 ${score} 分。`

  return { zoneName: zone.zoneName, shrubs: zone.shrubs, trees: zone.trees, score, riskLevel, issues, summary }
}
