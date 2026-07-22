// ── RequireAuth ───────────────────────────────────────────────────────────────
// ProtectedRoute 的等效機制：本專案沒有用 react-router-dom（見規劃筆記），導覽是
// App.tsx 用 activeTab state 切換頁面、全部掛在同一個網址下。未登入時這裡只會
// render <LoginPage />，children（PDF 審圖／DXF 審查／AI 配植等整棵樹）完全不會
// 掛載，不是用 CSS 隱藏——沒有登入就不會執行任何頁面的資料抓取或寫入邏輯。

import type { ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import LoginPage from '@/pages/auth/LoginPage'

export default function RequireAuth({ children }: { children: ReactNode }) {
  const { loading, session, profile, accountDisabled, recoveryMode } = useAuth()

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#f4f7f4]">
        <Loader2 className="animate-spin text-[#1a4731]" size={28} />
      </div>
    )
  }

  if (recoveryMode) {
    return <LoginPage />
  }

  if (accountDisabled) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#f4f7f4] px-4">
        <div className="max-w-md w-full bg-white rounded-2xl border border-stone-200 p-8 text-center space-y-3">
          <p className="text-base font-semibold text-stone-700">此帳號已被停用</p>
          <p className="text-sm text-stone-500">請聯繫系統管理者確認帳號狀態。</p>
        </div>
      </div>
    )
  }

  if (!session || !profile) {
    return <LoginPage />
  }

  return <>{children}</>
}
