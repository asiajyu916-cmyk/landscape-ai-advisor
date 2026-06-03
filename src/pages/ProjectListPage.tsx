import { useState, useEffect, useRef } from 'react'
import { authService } from '@/services/authService'
import { projectService } from '@/services/projectService'
import type { Project, AuthSession, ProjectStatus, User } from '@/types'
import { ROLE_LABEL } from '@/types'

interface Props {
  session: AuthSession
  onOpenProject: (projectId: string) => void
  onLogout: () => void
}

// ─── 狀態色票 ────────────────────────────────────────────

const STATUS_LABEL: Record<ProjectStatus, string> = {
  draft:     '草稿',
  reviewing: '審查中',
  finalized: '已定稿',
}
const STATUS_COLOR: Record<ProjectStatus, string> = {
  draft:     'bg-gray-100 text-gray-600 border-gray-200',
  reviewing: 'bg-amber-50 text-amber-700 border-amber-200',
  finalized: 'bg-green-50 text-green-700 border-green-200',
}

// ─── 使用者選單（右上角）────────────────────────────────────

function UserMenu({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const roleLabel = ROLE_LABEL[user.role]

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-gray-100 transition-colors"
      >
        <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center shrink-0">
          <span className="text-white text-xs font-semibold">{user.displayName[0]}</span>
        </div>
        <div className="text-left hidden sm:block">
          <div className="text-sm font-medium text-gray-700 leading-tight">{user.displayName}</div>
          <div className="text-xs text-gray-400 leading-tight">{roleLabel}</div>
        </div>
        <svg className={`w-3.5 h-3.5 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7"/>
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1.5 w-52 bg-white rounded-xl shadow-xl border border-gray-200 py-1 z-50">
          {/* 使用者資訊 */}
          <div className="px-4 py-3 border-b border-gray-100">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-full bg-blue-600 flex items-center justify-center shrink-0">
                <span className="text-white text-sm font-semibold">{user.displayName[0]}</span>
              </div>
              <div>
                <div className="text-sm font-semibold text-gray-800">{user.displayName}</div>
                <div className="flex items-center gap-1 mt-0.5">
                  <span className={`text-xs rounded px-1.5 py-0.5 border font-medium ${
                    user.role === 'admin'     ? 'bg-red-50 text-red-600 border-red-200' :
                    user.role === 'architect' ? 'bg-blue-50 text-blue-600 border-blue-200' :
                    'bg-gray-50 text-gray-600 border-gray-200'
                  }`}>{roleLabel}</span>
                </div>
              </div>
            </div>
          </div>

          {/* 選單項目 */}
          <div className="py-1">
            <button
              className="w-full text-left px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 flex items-center gap-2"
              onClick={() => { setOpen(false); alert('個人設定功能開發中') }}
            >
              <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
              個人設定
            </button>
          </div>

          <div className="border-t border-gray-100 py-1">
            <button
              onClick={async () => { setOpen(false); await authService.logout(); onLogout() }}
              className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 flex items-center gap-2 font-medium"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/></svg>
              登出
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── 新增專案 Modal ─────────────────────────────────────────

function NewProjectModal({ session, onClose, onCreate }: {
  session: AuthSession
  onClose: () => void
  onCreate: (id: string) => void
}) {
  const allUsers = authService.getMockUsers()
  const architects = allUsers.filter(u => u.role === 'architect')

  const [form, setForm] = useState({
    name: '',
    location: '',
    zoning: '第四種住宅區',
    buildingType: '集合住宅',
    siteArea: '',
    legalBCR: '60',
    legalFAR: '500',
    responsibleArchitect: session.user.role === 'architect' ? session.user.displayName : (architects[0]?.displayName ?? ''),
    projectStaff: '',
  })
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')

  const inputCls = "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim()) { setError('請輸入工程名稱'); return }
    if (!form.siteArea || isNaN(Number(form.siteArea))) { setError('請輸入正確的基地面積'); return }
    setLoading(true)
    const result = await projectService.createProject({
      name: form.name.trim(),
      location: form.location.trim(),
      zoning: form.zoning,
      buildingType: form.buildingType,
      siteArea: Number(form.siteArea),
      legalBuildingCoverageRate: Number(form.legalBCR),
      legalFloorAreaRatio: Number(form.legalFAR),
      createdBy: session.user.id,
      responsibleArchitect: form.responsibleArchitect,
      projectStaff: form.projectStaff,
    })
    setLoading(false)
    if (result.error) { setError(result.error); return }
    if (result.data)  onCreate(result.data.id)
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-[560px] max-h-[92vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between sticky top-0 bg-white">
          <h2 className="text-base font-bold text-gray-800">新增專案</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {/* 工程名稱 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">工程名稱 <span className="text-red-500">*</span></label>
            <input className={inputCls} placeholder="例：XX集合住宅新建工程"
              value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} />
          </div>

          {/* 建築地點 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">建築地點</label>
            <input className={inputCls} placeholder="例：台中市南屯區大墩段 852、853"
              value={form.location} onChange={e => setForm(p => ({ ...p, location: e.target.value }))} />
          </div>

          {/* 使用分區 / 建築類別 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">使用分區</label>
              <input className={inputCls} value={form.zoning}
                onChange={e => setForm(p => ({ ...p, zoning: e.target.value }))} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">建築類別</label>
              <select className={inputCls} value={form.buildingType}
                onChange={e => setForm(p => ({ ...p, buildingType: e.target.value }))}>
                <option>集合住宅</option><option>透天住宅</option>
                <option>辦公大樓</option><option>商業大樓</option><option>其他</option>
              </select>
            </div>
          </div>

          {/* 基地面積 / 建蔽率 / 容積率 */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">基地面積(㎡) <span className="text-red-500">*</span></label>
              <input className={inputCls} type="number" step="0.01" placeholder="2591.00"
                value={form.siteArea} onChange={e => setForm(p => ({ ...p, siteArea: e.target.value }))} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">法定建蔽率(%)</label>
              <input className={inputCls} type="number"
                value={form.legalBCR} onChange={e => setForm(p => ({ ...p, legalBCR: e.target.value }))} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">法定容積率(%)</label>
              <input className={inputCls} type="number"
                value={form.legalFAR} onChange={e => setForm(p => ({ ...p, legalFAR: e.target.value }))} />
            </div>
          </div>

          {/* 負責建築師 / 專案人員 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">負責建築師</label>
              <select className={inputCls} value={form.responsibleArchitect}
                onChange={e => setForm(p => ({ ...p, responsibleArchitect: e.target.value }))}>
                <option value="">— 未指定 —</option>
                {architects.map(u => <option key={u.id}>{u.displayName}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">專案人員</label>
              <select className={inputCls} value={form.projectStaff}
                onChange={e => setForm(p => ({ ...p, projectStaff: e.target.value }))}>
                <option value="">— 未指定 —</option>
                {allUsers.map(u => <option key={u.id}>{u.displayName}</option>)}
              </select>
            </div>
          </div>

          {error && <p className="text-red-600 text-sm">{error}</p>}

          <div className="flex justify-end gap-3 pt-2 border-t border-gray-100">
            <button type="button" onClick={onClose}
              className="px-4 py-2 text-sm border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50">
              取消
            </button>
            <button type="submit" disabled={loading}
              className="px-5 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium disabled:opacity-60">
              {loading ? '建立中...' : '建立專案'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── 主頁面 ─────────────────────────────────────────────────

export default function ProjectListPage({ session, onOpenProject, onLogout }: Props) {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading,  setLoading]  = useState(true)
  const [search,   setSearch]   = useState('')
  const [showNew,  setShowNew]  = useState(false)

  const canCreate = authService.hasPermission('project:create')
  const canDelete = authService.hasPermission('project:delete')

  useEffect(() => {
    projectService.getProjects().then(r => {
      if (r.data) setProjects(r.data)
      setLoading(false)
    })
  }, [])

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`確定要刪除「${name}」？此操作無法復原。`)) return
    await projectService.deleteProject(id)
    setProjects(prev => prev.filter(p => p.id !== id))
  }

  const handleDuplicate = async (project: Project) => {
    const result = await projectService.duplicateProject(
      project.id,
      `${project.name}（副本）`,
      session.user.id
    )
    if (result.data) setProjects(prev => [result.data!, ...prev])
  }

  const filtered = projects.filter(p =>
    !search ||
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    p.location.toLowerCase().includes(search.toLowerCase()) ||
    (p.responsibleArchitect || '').includes(search)
  )

  const formatDate = (iso: string) => {
    const d = new Date(iso)
    return `${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,'0')}.${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
  }

  const thCls = "px-4 py-3 text-left text-xs font-semibold text-gray-500 whitespace-nowrap"

  return (
    <div className="min-h-screen bg-gray-50">
      {/* 頂部導覽 */}
      <header className="bg-white border-b border-gray-200 shadow-sm sticky top-0 z-40">
        <div className="max-w-screen-xl mx-auto px-6 h-14 flex items-center gap-4">
          <div className="flex items-center gap-2 shrink-0">
            <div className="w-7 h-7 bg-blue-700 rounded flex items-center justify-center">
              <span className="text-white text-xs font-bold">YF</span>
            </div>
            <span className="font-semibold text-gray-800 text-sm whitespace-nowrap">永豐 AI 建築面積計算平台</span>
          </div>
          <div className="flex-1" />
          <UserMenu user={session.user} onLogout={onLogout} />
        </div>
      </header>

      <main className="max-w-screen-xl mx-auto px-6 py-8">
        {/* Page header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-gray-800">專案列表</h1>
            <p className="text-sm text-gray-500 mt-0.5">共 {projects.length} 個專案</p>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="text"
              placeholder="搜尋名稱 / 地點 / 負責建築師..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-64 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400 bg-white"
            />
            {canCreate && (
              <button
                onClick={() => setShowNew(true)}
                className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
              >
                <span className="text-base leading-none">＋</span>
                新增專案
              </button>
            )}
          </div>
        </div>

        {/* 權限提示（staff 看到時） */}
        {session.user.role === 'staff' && (
          <div className="mb-4 flex items-center gap-2 bg-amber-50 border border-amber-200 text-amber-700 text-xs px-4 py-2.5 rounded-lg">
            <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
            您的角色為「專案人員」，可開啟並編輯面積資料，但無法新增或刪除專案。
          </div>
        )}

        {/* 專案表格 */}
        {loading ? (
          <div className="flex items-center justify-center h-48 text-gray-400 text-sm">載入中...</div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-gray-400">
            <svg className="w-10 h-10 mb-3 text-gray-200" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
            <p className="text-sm">{search ? '查無符合的專案' : '尚無專案，請點「新增專案」'}</p>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className={thCls}>專案名稱</th>
                  <th className={thCls}>基地座落</th>
                  <th className={thCls}>使用分區</th>
                  <th className={thCls}>建築類型</th>
                  <th className={thCls}>負責建築師</th>
                  <th className={thCls}>專案人員</th>
                  <th className={thCls}>最後修改</th>
                  <th className={thCls}>狀態</th>
                  <th className={thCls}>操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p, idx) => (
                  <tr key={p.id}
                    className={`border-b border-gray-100 hover:bg-blue-50/30 transition-colors ${idx % 2 !== 0 ? 'bg-gray-50/30' : ''}`}
                  >
                    {/* 專案名稱 */}
                    <td className="px-4 py-3">
                      <button
                        onClick={() => onOpenProject(p.id)}
                        className="font-medium text-blue-700 hover:text-blue-900 hover:underline text-left"
                      >
                        {p.name}
                      </button>
                    </td>

                    {/* 基地座落 */}
                    <td className="px-4 py-3 text-gray-600 text-xs max-w-[200px] truncate" title={p.location}>
                      {p.location || <span className="text-gray-300">-</span>}
                    </td>

                    {/* 使用分區 */}
                    <td className="px-4 py-3 text-gray-600 text-xs whitespace-nowrap">{p.zoning || '-'}</td>

                    {/* 建築類型 */}
                    <td className="px-4 py-3 text-gray-600 text-xs">{p.buildingType}</td>

                    {/* 負責建築師 */}
                    <td className="px-4 py-3">
                      {p.responsibleArchitect ? (
                        <div className="flex items-center gap-1.5">
                          <div className="w-5 h-5 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
                            <span className="text-blue-600 text-xs font-semibold">{p.responsibleArchitect[0]}</span>
                          </div>
                          <span className="text-xs text-gray-700">{p.responsibleArchitect}</span>
                        </div>
                      ) : <span className="text-xs text-gray-300">-</span>}
                    </td>

                    {/* 專案人員 */}
                    <td className="px-4 py-3 text-xs text-gray-600">
                      {p.projectStaff || <span className="text-gray-300">-</span>}
                    </td>

                    {/* 最後修改 */}
                    <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">
                      {formatDate(p.updatedAt)}
                    </td>

                    {/* 狀態 */}
                    <td className="px-4 py-3">
                      <span className={`text-xs border rounded px-2 py-0.5 font-medium ${STATUS_COLOR[p.status]}`}>
                        {STATUS_LABEL[p.status]}
                      </span>
                    </td>

                    {/* 操作 */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => onOpenProject(p.id)}
                          className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                        >開啟</button>

                        {/* 複製：architect / admin 可用 */}
                        {(session.user.role === 'architect' || session.user.role === 'admin') && (
                          <>
                            <span className="text-gray-200">|</span>
                            <button
                              onClick={() => handleDuplicate(p)}
                              className="text-xs text-gray-500 hover:text-gray-700"
                            >複製</button>
                          </>
                        )}

                        {/* 刪除：只有 admin 可用 */}
                        {canDelete && (
                          <>
                            <span className="text-gray-200">|</span>
                            <button
                              onClick={() => handleDelete(p.id, p.name)}
                              className="text-xs text-red-400 hover:text-red-600"
                            >刪除</button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* 頁尾資訊 */}
        <div className="mt-6 flex items-center justify-between text-xs text-gray-400">
          <span>顯示 {filtered.length} / {projects.length} 個專案</span>
          <span>登入身分：{session.user.displayName}（{ROLE_LABEL[session.user.role]}）</span>
        </div>
      </main>

      {showNew && (
        <NewProjectModal
          session={session}
          onClose={() => setShowNew(false)}
          onCreate={(id) => { setShowNew(false); onOpenProject(id) }}
        />
      )}
    </div>
  )
}
