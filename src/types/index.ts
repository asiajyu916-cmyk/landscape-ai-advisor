// ============================================================
// 永豐 AI 建築面積計算平台 — TypeScript 型別定義
// 所有 Service / Component 共用此來源
// ============================================================

// ─── 使用者 ───────────────────────────────────────────────

export type UserRole = 'admin' | 'architect' | 'staff'

export const ROLE_LABEL: Record<UserRole, string> = {
  admin:     '管理者',
  architect: '建築師',
  staff:     '專案人員',
}

/**
 * 權限 key — UI 層用 hasPermission() 查詢
 * 未來接後端時，這些 key 對應 Supabase Row Level Security policy 名稱
 */
export type Permission =
  | 'project:create'
  | 'project:edit'
  | 'project:delete'
  | 'project:export'
  | 'floor:edit'
  | 'template:edit'
  | 'version:view'
  | 'user:manage'

export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  admin: [
    'project:create','project:edit','project:delete','project:export',
    'floor:edit','template:edit','version:view','user:manage',
  ],
  architect: [
    'project:create','project:edit','project:export',
    'floor:edit','version:view',
  ],
  staff: [
    'project:edit','project:export','floor:edit',
  ],
}

export interface User {
  id: string
  username: string      // 登入帳號（不含 @）
  displayName: string   // 顯示名稱
  role: UserRole
  createdAt: string
}

export interface AuthSession {
  user: User
  token: string
  expiresAt: string
}

// ─── 專案 ───────────────────────────────────────────────

export type ProjectStatus = 'draft' | 'reviewing' | 'finalized'

export interface LandLot {
  lotNumber: string
  area: number
}

export interface HouseholdInfo {
  shopUnits: number
  residentialUnits: number
  totalUnits: number
}

export interface FloorCount {
  aboveGround: number
  underground: number
  roof: number
}

export interface ProjectInfo {
  projectName: string
  buildingLocation: string
  zoning: string
  buildingCoverageRateLimit: number
  floorAreaRatioLimit: number
  buildingType: string
  buildingUsage: string
  siteArea: number
  legalBuildingCoverageRate: number
  legalFloorAreaRatio: number
  bonusVolume: number
  householdInfo: HouseholdInfo
  floorCount: FloorCount
  structureType: string
  buildingHeight: string
  designOffice: string
  preparedBy: string
  preparedDate: string
  version: string
  page: string
  landLots: LandLot[]
}

export interface Project {
  id: string
  name: string
  location: string
  zoning: string
  buildingType: string
  siteArea: number
  legalBuildingCoverageRate: number
  legalFloorAreaRatio: number
  status: ProjectStatus
  createdBy: string              // User.id
  responsibleArchitect: string   // 負責建築師 displayName
  projectStaff: string           // 專案人員 displayName
  updatedAt: string              // ISO string
  createdAt: string              // ISO string
  projectInfo: ProjectInfo
}

// ─── 樓層定義（不含面積資料，只有 meta）────────────────────

export interface FloorDefinition {
  id: string
  name: string
  usage: string
  height: number
}

// ─── 面積明細 ─────────────────────────────────────────────

export interface PrivateItem {
  id: string
  unit: string
  use: string
  indoor: number
  balcony: number
  balconyOver: number  // 宜居建築垂直綠化設施（陽台超過2M）
  subtotal: number
  note: string
}

export interface SharedItem {
  id: string
  name: string
  area: number
  inFloor: '是' | '否'
  inFAR: '條件判斷' | '免計判斷' | '計入'
  rule: string
  note: string
}

export interface FloorData {
  privateItems: PrivateItem[]
  sharedItems: SharedItem[]
  sourceFloor: string | null   // 複製來源 floor id
  isOverridden: boolean        // 來自標準層後是否手動修改
}

export type FloorsById = Record<string, FloorData>

// ─── 計算結果 ─────────────────────────────────────────────

export interface FloorStats {
  privateIndoor: number
  privateBalcony: number
  privateBalconyOver: number
  privateSubtotal: number
  sharedTotal: number
  hallArea: number
  art162Total: number
  floorArea: number
  limit10: number
  limit15: number
  combinedSum: number
  over15: number
  farArea: number
}

export interface FloorSummaryRow {
  floorId: string
  floorName: string
  usage: string
  height: number
  floorArea: number
  privateIndoor: number
  balconyArea: number
  balconyOver2m: number
  article162Area: number
  hallArea: number
  floorVolume: number
  over15: number
  isOverridden: boolean
  sourceFloor: string | null
}

export interface ProjectSummary {
  totalFloorArea: number
  totalBalconyArea: number
  totalGreenArea: number
  totalArticle162Area: number
  totalFloorVolume: number
  legalBaseVolume: number
  bonusVolume: number
  maxAllowedVolume: number
  remainingVolume: number
  exceededVolume: number
  usageRate: number
  actualFAR: number
  status: '符合' | '接近上限' | '超量'
}

// ─── 匯出記錄 ─────────────────────────────────────────────

export type ExportType = 'PDF' | 'Excel'

export interface ExportRecord {
  id: string
  projectId: string
  exportType: ExportType
  fileName: string
  createdBy: string
  createdAt: string
}

// ─── 版本記錄 ─────────────────────────────────────────────

export interface VersionRecord {
  id: string
  projectId: string
  description: string
  snapshot: {
    floorsById: FloorsById
    projectInfo: ProjectInfo
  }
  changedBy: string
  changedAt: string
}

// ─── Service 回傳型別 ─────────────────────────────────────

export interface ServiceResult<T> {
  data: T | null
  error: string | null
}
