import { useState } from 'react'
import { authService } from '@/services/authService'
import type { AuthSession } from '@/types'

interface Props {
  onLogin: (session: AuthSession) => void
}

const TEST_ACCOUNTS = [
  { label: '呂建築師', username: 'lu',    password: '123456', role: '建築師' },
  { label: '李建築師', username: 'lee',   password: '123456', role: '建築師' },
  { label: '陳建築師', username: 'chen',  password: '123456', role: '建築師' },
  { label: '專案人員', username: 'staff', password: '123456', role: '專案人員' },
  { label: '管理者',   username: 'admin', password: '123456', role: '管理者' },
]

export default function LoginPage({ onLogin }: Props) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!username.trim() || !password.trim()) {
      setError('請輸入帳號與密碼')
      return
    }
    setLoading(true)
    setError(null)
    const result = await authService.login(username.trim(), password)
    setLoading(false)
    if (result.error) {
      setError(result.error)
    } else if (result.data) {
      onLogin(result.data)
    }
  }

  // 點選測試帳號自動填入
  const fillAccount = (uname: string, pwd: string) => {
    setUsername(uname)
    setPassword(pwd)
    setError(null)
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-950 via-blue-900 to-slate-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md">

        {/* Logo & Title */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-blue-600 shadow-lg mb-4">
            <span className="text-white text-2xl font-bold tracking-tight">YF</span>
          </div>
          <h1 className="text-2xl font-bold text-white tracking-wide">
            永豐 AI 建築面積計算平台
          </h1>
          <p className="text-blue-300 text-sm mt-1.5">公司內部建築面積計算系統</p>
        </div>

        {/* Login Card */}
        <div className="bg-white rounded-2xl shadow-2xl p-8">
          <h2 className="text-base font-semibold text-gray-700 mb-5">登入帳號</h2>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">帳號</label>
              <input
                type="text"
                value={username}
                onChange={e => { setUsername(e.target.value); setError(null) }}
                placeholder="請輸入帳號（如：lu、lee、admin）"
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                autoComplete="username"
                disabled={loading}
                autoFocus
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">密碼</label>
              <input
                type="password"
                value={password}
                onChange={e => { setPassword(e.target.value); setError(null) }}
                placeholder="請輸入密碼"
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                autoComplete="current-password"
                disabled={loading}
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2 rounded-lg">
                <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-semibold py-2.5 rounded-lg transition-colors text-sm flex items-center justify-center gap-2 mt-2"
            >
              {loading ? (
                <>
                  <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                  </svg>
                  登入中...
                </>
              ) : '登　入'}
            </button>
          </form>

          {/* 測試帳號提示 */}
          <div className="mt-6 pt-5 border-t border-gray-100">
            <p className="text-xs font-medium text-gray-400 mb-2">測試帳號（點選自動填入）</p>
            <div className="grid grid-cols-1 gap-1.5">
              {TEST_ACCOUNTS.map(a => (
                <button
                  key={a.username}
                  type="button"
                  onClick={() => fillAccount(a.username, a.password)}
                  className="flex items-center justify-between px-3 py-1.5 rounded-lg border border-gray-100 hover:border-blue-200 hover:bg-blue-50 transition-colors text-left group"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-gray-700 group-hover:text-blue-700">{a.label}</span>
                    <span className="text-xs text-gray-400">帳號：{a.username}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-300 bg-gray-50 border border-gray-200 rounded px-1.5 py-0.5">{a.role}</span>
                    <svg className="w-3.5 h-3.5 text-gray-300 group-hover:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7"/>
                    </svg>
                  </div>
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-300 mt-2 text-center">所有帳號密碼均為 123456</p>
          </div>
        </div>

        <p className="text-center text-blue-400/60 text-xs mt-6">
          © 永豐建設 · 建築面積計算平台 v1.2 · 公司內部系統
        </p>
      </div>
    </div>
  )
}
