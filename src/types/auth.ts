// ── 登入與角色權限型別 ────────────────────────────────────────────────────────
// 獨立於 src/types/index.ts（那份屬於另一個既有專案「永豐 AI 建築面積計算平台」的
// 死碼，App.tsx 沒有引用它，這裡刻意不共用，避免互相牽動）。

export type Role = 'admin' | 'reviewer' | 'viewer' | 'disabled'

export const ROLE_LABEL: Record<Role, string> = {
  admin: '管理者',
  reviewer: '審查人員',
  viewer: '檢視者',
  disabled: '已停用',
}

export interface Profile {
  id: string
  email: string
  displayName: string | null
  company: string | null
  role: Role
  status: 'active' | 'disabled'
  createdAt: string
  lastLoginAt: string | null
}

// 對應 Supabase profiles 表的原始欄位（snake_case）
export interface ProfileRow {
  id: string
  email: string
  display_name: string | null
  company: string | null
  role: Role
  status: 'active' | 'disabled'
  created_at: string
  last_login_at: string | null
}

export function profileFromRow(row: ProfileRow): Profile {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    company: row.company,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  }
}

export type Permission =
  | 'canReviewDxf'
  | 'canReviewPdf'
  | 'canUseAiPlanting'
  | 'canManagePlants'
  | 'canManageUsers'
  | 'canExportReport'
  | 'canViewPlantDatabase'
