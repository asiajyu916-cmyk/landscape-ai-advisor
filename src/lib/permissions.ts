// ── 集中式權限設定 ────────────────────────────────────────────────────────────
// 唯一的角色→權限對照表。任何地方要判斷「這個角色能不能做 X」都呼叫
// hasPermission()，不要在頁面元件裡各自寫 role === 'admin' 之類的判斷——
// 之後要調整權限，只要改這個檔案，不用逐頁面找。
//
// 後端（Supabase RLS，見 supabase/auth_schema.sql）是真正的防線；
// 這裡的權限表只決定「前端要不要顯示/啟用某個功能」，兩邊邏輯需保持一致。

import type { Role, Permission } from '@/types/auth'

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: [
    'canReviewDxf', 'canReviewPdf', 'canUseAiPlanting',
    'canManagePlants', 'canManageUsers', 'canExportReport', 'canViewPlantDatabase',
  ],
  reviewer: [
    // 可審查（PDF／DXF／AI 配植），可查看植栽資料庫、可匯出，但不可編輯植栽資料庫
    'canReviewDxf', 'canReviewPdf', 'canUseAiPlanting', 'canExportReport', 'canViewPlantDatabase',
  ],
  viewer: [
    // 只能查看植栽資料庫（搜尋／篩選／看卡片），不可審查、不可匯出、不可編輯資料
    'canViewPlantDatabase',
  ],
  disabled: [],
}

export function hasPermission(role: Role | undefined, permission: Permission): boolean {
  if (!role) return false
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false
}
