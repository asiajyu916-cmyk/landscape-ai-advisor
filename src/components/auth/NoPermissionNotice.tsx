// ── NoPermissionNotice ────────────────────────────────────────────────────────
// 帳號角色沒有權限使用目前分頁時顯示，取代該分頁原本的內容（不是用 CSS 藏起來——
// 對應的頁面元件在 App.tsx 直接不會被 mount，這裡只是告訴使用者原因）。

import { Lock } from 'lucide-react'
import { ROLE_LABEL } from '@/types/auth'
import { useAuth } from '@/contexts/AuthContext'

export default function NoPermissionNotice({ featureName }: { featureName: string }) {
  const { profile } = useAuth()
  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-white rounded-2xl border border-stone-200 p-8 text-center space-y-3">
        <Lock className="mx-auto text-stone-400" size={28} />
        <p className="text-base font-semibold text-stone-700">此帳號角色無法使用「{featureName}」</p>
        <p className="text-sm text-stone-500">
          目前角色：{profile ? ROLE_LABEL[profile.role] : '—'}。如需使用此功能，請聯繫系統管理者調整帳號權限。
        </p>
      </div>
    </div>
  )
}
