/**
 * authService.ts
 * 登入 / 登出 / Session / 權限查詢
 *
 * 目前使用 localStorage + mock users；
 * 未來換成 Supabase Auth 只需替換此檔案，呼叫端不變。
 *
 * Supabase 替換步驟：
 *   import { supabase } from '@/lib/supabase'
 *   login  → supabase.auth.signInWithPassword({ email, password })
 *   logout → supabase.auth.signOut()
 *   getSession → supabase.auth.getSession()
 */

import type { User, AuthSession, Permission, ServiceResult } from '@/types'
import { ROLE_PERMISSIONS } from '@/types'

const SESSION_KEY = 'yf_arch_session'

// ── 公司內部帳號（未來改由 Supabase users table 查詢）────────

const MOCK_USERS: (User & { password: string })[] = [
  {
    id:          'user-lu',
    username:    'lu',
    displayName: '呂建築師',
    role:        'architect',
    createdAt:   '2024-01-01T00:00:00Z',
    password:    '123456',
  },
  {
    id:          'user-lee',
    username:    'lee',
    displayName: '李建築師',
    role:        'architect',
    createdAt:   '2024-01-01T00:00:00Z',
    password:    '123456',
  },
  {
    id:          'user-chen',
    username:    'chen',
    displayName: '陳建築師',
    role:        'architect',
    createdAt:   '2024-01-01T00:00:00Z',
    password:    '123456',
  },
  {
    id:          'user-staff',
    username:    'staff',
    displayName: '專案人員',
    role:        'staff',
    createdAt:   '2024-01-01T00:00:00Z',
    password:    '123456',
  },
  {
    id:          'user-admin',
    username:    'admin',
    displayName: '系統管理者',
    role:        'admin',
    createdAt:   '2024-01-01T00:00:00Z',
    password:    '123456',
  },
]

// ── 工具 ────────────────────────────────────────────────────

function delay(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms))
}

// ── Service ─────────────────────────────────────────────────

export const authService = {

  /**
   * 登入（username + password）
   * TODO: supabase.auth.signInWithPassword({ email: username + '@...', password })
   */
  async login(username: string, password: string): Promise<ServiceResult<AuthSession>> {
    await delay(350)
    const found = MOCK_USERS.find(
      u => u.username === username.trim() && u.password === password
    )
    if (!found) {
      return { data: null, error: '帳號或密碼錯誤，請重新輸入' }
    }
    const { password: _pw, ...user } = found
    const session: AuthSession = {
      user,
      token:     `mock_${user.id}_${Date.now()}`,
      expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
    }
    localStorage.setItem(SESSION_KEY, JSON.stringify(session))
    return { data: session, error: null }
  },

  /**
   * 登出
   * TODO: supabase.auth.signOut()
   */
  async logout(): Promise<void> {
    localStorage.removeItem(SESSION_KEY)
  },

  /**
   * 取得目前 Session
   * TODO: supabase.auth.getSession()
   */
  getSession(): AuthSession | null {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    try {
      const session: AuthSession = JSON.parse(raw)
      if (new Date(session.expiresAt) < new Date()) {
        localStorage.removeItem(SESSION_KEY)
        return null
      }
      return session
    } catch {
      return null
    }
  },

  getCurrentUser(): User | null {
    return this.getSession()?.user ?? null
  },

  isAuthenticated(): boolean {
    return this.getSession() !== null
  },

  /**
   * 查詢目前使用者是否有特定權限
   * UI 層用於隱藏/停用按鈕；後端 Row Level Security 是真正的防線。
   */
  hasPermission(permission: Permission): boolean {
    const user = this.getCurrentUser()
    if (!user) return false
    return ROLE_PERMISSIONS[user.role]?.includes(permission) ?? false
  },

  /** 取得所有 mock 使用者（專案列表頁選人用）*/
  getMockUsers(): Omit<User, never>[] {
    return MOCK_USERS.map(({ password: _pw, ...u }) => u)
  },
}
