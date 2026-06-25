export type PlantType = '喬木' | '灌木' | '地被' | '草皮'
export type SunRequirement = '全日照' | '半日照' | '耐陰'
export type WaterRequirement = '低' | '中' | '高'
export type MaintenanceLevel = '低' | '中' | '高'
export type RootRisk = '低' | '中' | '高'
export type RooftopSuitability = '適合' | '需注意' | '不建議'
export type PlantStatus = '可用' | '需注意' | '不建議'

export type SiteType = '一樓景觀' | '屋頂景觀' | '中庭' | '入口' | '陽台'
export type SunCondition = '全日照' | '半日照' | '陰影區'
export type IrrigationZone = '同一灌溉區' | '分區灌溉' | '未定'
export type SoilType = '一般壤土' | '排水佳' | '保水型'

export interface PlantRecord {
  id: string
  name: string
  scientificName?: string
  type: PlantType
  sunRequirement: SunRequirement
  waterRequirement: WaterRequirement
  soilRequirement: string
  drainageRequirement: string
  soilDepth: string
  rootRisk: RootRisk
  maintenanceLevel: MaintenanceLevel
  rooftopSuitability: RooftopSuitability
  residentialSuitability: '適合' | '需注意' | '不建議'
  commonRisks: string
  reviewNote: string
}

export interface SelectedPlant extends PlantRecord {
  instanceId: string
  status: PlantStatus
  statusReason?: string
}

export interface SiteCondition {
  siteType: SiteType
  sunCondition: SunCondition
  irrigationZone: IrrigationZone
  soilType: SoilType
}

export type CompatibilityLevel = '配置良好' | '可行但需補充說明' | '需調整配置' | '高風險不建議'

export interface RiskItem {
  category: string
  level: 'ok' | 'warning' | 'danger'
  description: string
}

export interface EvaluationResult {
  score: number
  level: CompatibilityLevel
  risks: RiskItem[]
  aiSuggestion: string
  adjustmentPlan: string[]
  reviewText: string
}

export interface ImportedDrawing {
  fileName: string
  status: '待確認' | '已完成' | '辨識中'
  extractedPlants?: string[]
}
