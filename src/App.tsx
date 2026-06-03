import { useState, useEffect } from 'react'
import { authService } from '@/services/authService'
import { seedMockDataIfEmpty } from '@/data/mockData'
import LoginPage from '@/pages/LoginPage'
import ProjectListPage from '@/pages/ProjectListPage'
import WorkbenchPage from '@/pages/WorkbenchPage'
import type { AuthSession } from '@/types'

type AppView = 'login' | 'projects' | 'workbench'

export default function App() {
  const [view,      setView]      = useState<AppView>('login')
  const [session,   setSession]   = useState<AuthSession | null>(null)
  const [projectId, setProjectId] = useState<string | null>(null)

  // 初始化：檢查現有 session + 植入 mock 資料
  useEffect(() => {
    seedMockDataIfEmpty()
    const existing = authService.getSession()
    if (existing) {
      setSession(existing)
      setView('projects')
    }
  }, [])

  const handleLogin = (s: AuthSession) => {
    setSession(s)
    setView('projects')
  }

  const handleLogout = () => {
    setSession(null)
    setProjectId(null)
    setView('login')
  }

  const handleOpenProject = (id: string) => {
    setProjectId(id)
    setView('workbench')
  }

  const handleBackToProjects = () => {
    setProjectId(null)
    setView('projects')
  }

  if (view === 'login' || !session) {
    return <LoginPage onLogin={handleLogin} />
  }

  if (view === 'projects') {
    return (
      <ProjectListPage
        session={session}
        onOpenProject={handleOpenProject}
        onLogout={handleLogout}
      />
    )
  }

  if (view === 'workbench' && projectId) {
    return (
      <WorkbenchPage
        projectId={projectId}
        session={session}
        onBack={handleBackToProjects}
      />
    )
  }

  return null
}
