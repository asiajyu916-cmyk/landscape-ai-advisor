// ── CSV-based plant record ────────────────────────────────────────────────────

export type NormalizedCategory = 'tree' | 'shrub' | 'groundcover'
export type SunReq = '全日照' | '全日照至半日照' | '半日照至遮陰' | '待查'
export type WaterReq = '低' | '低至中' | '中' | '中至高' | '高' | '待查'
export type DroughtTolerance = '耐旱' | '稍耐旱' | '不耐旱' | '待查'
export type WetTolerance = '耐濕' | '稍耐濕' | '不耐積水' | '待查'
export type MaintenanceLevel = '低' | '中' | '高' | '待查'
export type DrainageSensitivity = '低' | '中' | '高' | '待查'
export type PlantStatus = '可用' | '需注意' | '不建議'

export interface CsvPlantRecord {
  // ── identity ──────────────────────────────────────────────────────────────
  id: string                  // generated from row index
  name: string
  category: string            // raw: 喬木 / 灌木 / 草本
  normalizedCategory: NormalizedCategory
  subCategory: string
  scientificName: string

  // ── physical ──────────────────────────────────────────────────────────────
  height: string
  crownWidth: string
  trunkDiameter: string
  treeForm: string
  soilDepth: string
  plantingSpacing: string

  // ── flowering ─────────────────────────────────────────────────────────────
  flowerColor: string
  flowerMonth: string
  flowerPeriod: string
  flowerSupplement: string

  // ── ecological ────────────────────────────────────────────────────────────
  nativeStatus: string
  biodiversityValue: string

  // ── care ──────────────────────────────────────────────────────────────────
  maintenanceNote: string
  maintenanceLevel: MaintenanceLevel

  // ── environmental tolerance ───────────────────────────────────────────────
  sunRequirement: SunReq
  droughtTolerance: DroughtTolerance
  wetTolerance: WetTolerance
  waterRequirement: WaterReq
  waterToleranceTag: string
  drainageSensitivity: DrainageSensitivity

  // ── soil ─────────────────────────────────────────────────────────────────
  soilPh: string            // 土壤酸鹼性：酸性/微酸性/中性/微鹼性/鹼性
  soilPhRange: string       // 建議 pH 範圍，如 5.5~6.5
  soilTexture: string       // 土壤質地：砂質土/壤土/黏質土
  soilAmendment: string     // 客土改良需求：是/否/建議

  // ── risk & tags ───────────────────────────────────────────────────────────
  riskTags: string[]

  // ── reference ────────────────────────────────────────────────────────────
  price: string
  referencePageNo: string
  referenceNote: string
  officialUrl: string
  remarks: string
  sunWaterSource: string
  sunWaterSourceUrl: string
  verificationStatus: string
  verifiedAt: string
  verificationSummary: string

  // ── derived ───────────────────────────────────────────────────────────────
  reviewNote: string
  dataComplete: boolean       // false if key fields are '待查'
}

// ── Selected plant (with evaluation status) ───────────────────────────────────

export interface SelectedCsvPlant extends CsvPlantRecord {
  instanceId: string
  status: PlantStatus
}

// ── Plant image data (stored separately from CSV, keyed by plant name) ────────

export type ImageReviewStatus = 'missing' | 'candidate_found' | 'approved' | 'skipped' | 'failed'

export interface CandidatePhoto {
  thumbUrl: string
  fullUrl: string
  sourceUrl: string
  sourceName: string
  credit: string
  licenseNote: string
}

export interface PlantImageData {
  imageUrl?: string          // external URL
  uploadedDataUrl?: string   // base64 data URL from local upload
  localImagePath?: string
  imageSource?: string       // legacy
  imageCredit?: string       // legacy
  imageSourceName?: string
  imageSourceUrl?: string
  imageLicenseNote?: string
  imageImportedAt?: string
  imageReviewStatus?: ImageReviewStatus
  hasImage: boolean
}

export type ImageStore = Record<string, PlantImageData>  // key = plant name

// ── Import result ─────────────────────────────────────────────────────────────

export interface ImportResult {
  plants: CsvPlantRecord[]
  totalRows: number
  successRows: number
  missingColumns: string[]
  skippedRows: number
  columnMap: Record<string, boolean>
  imageUrls: Record<string, string>   // plantName → imageUrl（若 CSV 含圖片網址欄）
}
