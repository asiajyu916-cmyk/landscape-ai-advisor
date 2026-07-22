// ── AuthContext ───────────────────────────────────────────────────────────────
// 登入狀態的唯一來源：session（Supabase Auth）＋ profile（角色/狀態，profiles 表）。
// 用既有的 src/lib/supabase.ts 共用 client，不另外建立 client。

import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase, isSupabaseConfigured } from '@/lib/supabase'
import type { Profile, ProfileRow } from '@/types/auth'
import { profileFromRow } from '@/types/auth'

interface AuthContextValue {
  loading: boolean
  supabaseConfigured: boolean
  session: Session | null
  profile: Profile | null
  /** 帳號存在、密碼正確，但 profile.status !== 'active' */
  accountDisabled: boolean
  /** 使用者點了信箱裡的重設密碼連結回來，需要顯示「設定新密碼」表單 */
  recoveryMode: boolean
  signIn: (email: string, password: string) => Promise<{ ok: true } | { ok: false; message: string }>
  signOut: () => Promise<void>
  resetPassword: (email: string) => Promise<{ ok: true } | { ok: false; message: string }>
  updatePassword: (password: string) => Promise<{ ok: true } | { ok: false; message: string }>
  clearRecoveryMode: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

async function fetchProfile(userId: string): Promise<Profile | null> {
  if (!supabase) return null
  const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle()
  if (error || !data) return null
  return profileFromRow(data as ProfileRow)
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true)
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [accountDisabled, setAccountDisabled] = useState(false)
  const [recoveryMode, setRecoveryMode] = useState(false)

  const loadProfileForSession = useCallback(async (s: Session | null) => {
    if (!s) {
      setProfile(null)
      setAccountDisabled(false)
      return
    }
    const p = await fetchProfile(s.user.id)
    if (p && p.status !== 'active') {
      // 帳號已被停用：視同未登入，並登出（避免殘留一個「有 session 但不能用」的狀態）
      setAccountDisabled(true)
      setProfile(null)
      await supabase?.auth.signOut()
      return
    }
    setAccountDisabled(false)
    setProfile(p)
  }, [])

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) {
      setLoading(false)
      return
    }

    let cancelled = false

    supabase.auth.getSession().then(async ({ data }) => {
      if (cancelled) return
      setSession(data.session)
      await loadProfileForSession(data.session)
      if (!cancelled) setLoading(false)
    })

    const { data: sub } = supabase.auth.onAuthStateChange(async (event, newSession) => {
      if (cancelled) return
      if (event === 'PASSWORD_RECOVERY') {
        setRecoveryMode(true)
      }
      setSession(newSession)
      await loadProfileForSession(newSession)
      setLoading(false)
    })

    return () => { cancelled = true; sub.subscription.unsubscribe() }
  }, [loadProfileForSession])

  const signIn = useCallback(async (email: string, password: string) => {
    if (!supabase) return { ok: false as const, message: 'Supabase 尚未設定，請聯繫系統管理者。' }
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) return { ok: false as const, message: '帳號或密碼錯誤，請重新輸入。' }
    const p = await fetchProfile(data.user.id)
    if (p && p.status !== 'active') {
      await supabase.auth.signOut()
      return { ok: false as const, message: '此帳號已被停用，請聯繫系統管理者。' }
    }
    if (!p) {
      await supabase.auth.signOut()
      return { ok: false as const, message: '找不到對應的使用者資料，請聯繫系統管理者建立帳號權限。' }
    }
    // 更新 last_login_at；只改自己的欄位、role/status 不變，符合 RLS/trigger 允許範圍
    await supabase.from('profiles').update({ last_login_at: new Date().toISOString() }).eq('id', data.user.id)
    setProfile({ ...p, lastLoginAt: new Date().toISOString() })
    return { ok: true as const }
  }, [])

  const signOut = useCallback(async () => {
    await supabase?.auth.signOut()
    setSession(null)
    setProfile(null)
  }, [])

  const resetPassword = useCallback(async (email: string) => {
    if (!supabase) return { ok: false as const, message: 'Supabase 尚未設定，請聯繫系統管理者。' }
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: typeof window !== 'undefined' ? window.location.origin : undefined,
    })
    if (error) return { ok: false as const, message: '寄送重設密碼信失敗，請確認 email 是否正確。' }
    return { ok: true as const }
  }, [])

  const updatePassword = useCallback(async (password: string) => {
    if (!supabase) return { ok: false as const, message: 'Supabase 尚未設定，請聯繫系統管理者。' }
    const { error } = await supabase.auth.updateUser({ password })
    if (error) return { ok: false as const, message: `密碼更新失敗：${error.message}` }
    setRecoveryMode(false)
    return { ok: true as const }
  }, [])

  const clearRecoveryMode = useCallback(() => setRecoveryMode(false), [])

  return (
    <AuthContext.Provider value={{
      loading, supabaseConfigured: isSupabaseConfigured, session, profile, accountDisabled, recoveryMode,
      signIn, signOut, resetPassword, updatePassword, clearRecoveryMode,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth 必須在 <AuthProvider> 內使用')
  return ctx
}
