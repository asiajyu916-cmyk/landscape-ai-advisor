// ── 登入頁 ────────────────────────────────────────────────────────────────────
// 延續 LandscapeAdvisorPage.tsx 既有 header 配色（深綠 #1a4731、強調綠 #4ade80、
// 淺綠卡片 #d8f3dc），不是複製其他專案的藍色版面。
// 不顯示任何測試帳號、不提供一鍵帶入帳密的按鈕。

import { useState } from 'react'
import { AlertTriangle, CheckCircle, Loader2, Mail, Lock, ArrowLeft } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'

type Mode = 'login' | 'forgot' | 'forgot-sent' | 'recovery'

function BrandPanel() {
  return (
    <div className="bg-[#1a4731] text-white px-8 py-10 md:px-10 md:py-14 flex flex-col items-center md:items-start justify-center md:min-h-full text-center md:text-left">
      <svg viewBox="0 0 32 32" className="h-12 w-12 mb-4" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M16 1L28 5V18C28 26 22.5 30.5 16 32C9.5 30.5 4 26 4 18V5Z"
              fill="white" fillOpacity="0.1" stroke="white" strokeWidth="1.5" strokeOpacity="0.5" strokeLinejoin="round"/>
        <polygon points="16,8 20.5,14.5 11.5,14.5" fill="white"/>
        <polygon points="16,12 22,21.5 10,21.5" fill="white" opacity="0.9"/>
        <rect x="14.5" y="21.5" width="3" height="3.5" rx="0.5" fill="white" opacity="0.75"/>
        <polyline points="20,23 22,26 26.5,21" fill="none" stroke="#86efac" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
      <h1 className="text-2xl md:text-3xl font-bold leading-tight">景觀 AI 設計審查顧問 2.0</h1>
      <p className="text-green-200/70 text-sm md:text-base mt-2">植栽配置解析・設計審查・資料管理</p>
    </div>
  )
}

export default function LoginPage() {
  const { supabaseConfigured, recoveryMode, signIn, resetPassword, updatePassword } = useAuth()
  const [mode, setMode] = useState<Mode>(recoveryMode ? 'recovery' : 'login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const effectiveMode: Mode = recoveryMode ? 'recovery' : mode

  if (!supabaseConfigured) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#f4f7f4] px-4">
        <div className="max-w-md w-full bg-white rounded-2xl border border-stone-200 p-8 text-center space-y-3">
          <AlertTriangle className="mx-auto text-amber-500" size={32} />
          <p className="text-base font-semibold text-stone-700">系統尚未設定連線</p>
          <p className="text-sm text-stone-500">請聯繫系統管理者設定 Supabase 環境變數後再登入。</p>
        </div>
      </div>
    )
  }

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    const res = await signIn(email.trim(), password)
    setSubmitting(false)
    if (!res.ok) setError(res.message)
  }

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    const res = await resetPassword(email.trim())
    setSubmitting(false)
    if (!res.ok) { setError(res.message); return }
    setMode('forgot-sent')
  }

  const handleUpdatePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (newPassword.length < 6) { setError('密碼至少需要 6 個字元。'); return }
    setSubmitting(true)
    const res = await updatePassword(newPassword)
    setSubmitting(false)
    if (!res.ok) setError(res.message)
  }

  return (
    <div className="min-h-screen bg-[#f4f7f4] flex items-center justify-center p-4 md:p-8">
      <div className="w-full max-w-4xl bg-white rounded-3xl shadow-xl overflow-hidden grid md:grid-cols-2">
        <BrandPanel />

        <div className="p-8 md:p-10 flex flex-col justify-center">
          {effectiveMode === 'login' && (
            <form onSubmit={handleLogin} className="space-y-5">
              <div>
                <h2 className="text-lg font-bold text-stone-800">登入</h2>
                <p className="text-sm text-stone-400 mt-1">請使用系統管理者提供的帳號登入。</p>
              </div>

              <label className="block">
                <span className="text-xs font-semibold text-stone-500">Email</span>
                <div className="mt-1 flex items-center gap-2 px-3 py-2.5 rounded-xl border border-stone-200 focus-within:border-[#1a4731]">
                  <Mail size={16} className="text-stone-400 flex-shrink-0" />
                  <input type="email" required autoComplete="username" value={email}
                    onChange={e => setEmail(e.target.value)}
                    className="w-full outline-none text-sm text-stone-800" placeholder="name@company.com" />
                </div>
              </label>

              <label className="block">
                <span className="text-xs font-semibold text-stone-500">密碼</span>
                <div className="mt-1 flex items-center gap-2 px-3 py-2.5 rounded-xl border border-stone-200 focus-within:border-[#1a4731]">
                  <Lock size={16} className="text-stone-400 flex-shrink-0" />
                  <input type="password" required autoComplete="current-password" value={password}
                    onChange={e => setPassword(e.target.value)}
                    className="w-full outline-none text-sm text-stone-800" placeholder="••••••••" />
                </div>
              </label>

              {error && (
                <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm">
                  <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
                  {error}
                </div>
              )}

              <button type="submit" disabled={submitting}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-[#1a4731] text-white text-sm font-semibold hover:bg-[#143a27] transition-colors disabled:opacity-60">
                {submitting && <Loader2 size={15} className="animate-spin" />}
                {submitting ? '登入中…' : '登入'}
              </button>

              <button type="button" onClick={() => { setMode('forgot'); setError(null) }}
                className="w-full text-center text-xs text-stone-400 hover:text-stone-600">
                忘記密碼？
              </button>
            </form>
          )}

          {effectiveMode === 'forgot' && (
            <form onSubmit={handleForgot} className="space-y-5">
              <div>
                <button type="button" onClick={() => { setMode('login'); setError(null) }}
                  className="flex items-center gap-1 text-xs text-stone-400 hover:text-stone-600 mb-2">
                  <ArrowLeft size={12} />返回登入
                </button>
                <h2 className="text-lg font-bold text-stone-800">重設密碼</h2>
                <p className="text-sm text-stone-400 mt-1">輸入您的 Email，我們會寄送重設密碼連結。</p>
              </div>

              <label className="block">
                <span className="text-xs font-semibold text-stone-500">Email</span>
                <div className="mt-1 flex items-center gap-2 px-3 py-2.5 rounded-xl border border-stone-200 focus-within:border-[#1a4731]">
                  <Mail size={16} className="text-stone-400 flex-shrink-0" />
                  <input type="email" required autoComplete="username" value={email}
                    onChange={e => setEmail(e.target.value)}
                    className="w-full outline-none text-sm text-stone-800" placeholder="name@company.com" />
                </div>
              </label>

              {error && (
                <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm">
                  <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
                  {error}
                </div>
              )}

              <button type="submit" disabled={submitting}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-[#1a4731] text-white text-sm font-semibold hover:bg-[#143a27] transition-colors disabled:opacity-60">
                {submitting && <Loader2 size={15} className="animate-spin" />}
                {submitting ? '寄送中…' : '寄送重設密碼信'}
              </button>
            </form>
          )}

          {effectiveMode === 'forgot-sent' && (
            <div className="space-y-4 text-center">
              <CheckCircle className="mx-auto text-emerald-600" size={32} />
              <h2 className="text-lg font-bold text-stone-800">已寄出重設密碼信</h2>
              <p className="text-sm text-stone-500">請至 {email} 收信，點擊信中連結設定新密碼。</p>
              <button type="button" onClick={() => { setMode('login'); setError(null) }}
                className="text-sm text-[#1a4731] font-semibold hover:underline">
                返回登入
              </button>
            </div>
          )}

          {effectiveMode === 'recovery' && (
            <form onSubmit={handleUpdatePassword} className="space-y-5">
              <div>
                <h2 className="text-lg font-bold text-stone-800">設定新密碼</h2>
                <p className="text-sm text-stone-400 mt-1">請輸入新密碼以完成重設。</p>
              </div>

              <label className="block">
                <span className="text-xs font-semibold text-stone-500">新密碼</span>
                <div className="mt-1 flex items-center gap-2 px-3 py-2.5 rounded-xl border border-stone-200 focus-within:border-[#1a4731]">
                  <Lock size={16} className="text-stone-400 flex-shrink-0" />
                  <input type="password" required autoComplete="new-password" value={newPassword}
                    onChange={e => setNewPassword(e.target.value)}
                    className="w-full outline-none text-sm text-stone-800" placeholder="至少 6 個字元" />
                </div>
              </label>

              {error && (
                <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm">
                  <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
                  {error}
                </div>
              )}

              <button type="submit" disabled={submitting}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-[#1a4731] text-white text-sm font-semibold hover:bg-[#143a27] transition-colors disabled:opacity-60">
                {submitting && <Loader2 size={15} className="animate-spin" />}
                {submitting ? '更新中…' : '更新密碼'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
