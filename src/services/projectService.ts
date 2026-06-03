/**
 * projectService.ts
 * 專案 CRUD、樓層資料讀寫、匯出記錄
 *
 * 目前使用 localStorage 模擬資料庫；
 * 未來換成 Supabase 只需替換此檔案的實作，
 * 呼叫端介面不變。
 *
 * Supabase 替換範例：
 *   import { supabase } from '@/lib/supabase'
 *   const { data } = await supabase.from('projects').select('*')
 */

import type {
  Project, FloorsById, ProjectInfo, ExportRecord, ExportType,
  ServiceResult,
} from '@/types'
import { buildInitialFloorsById } from '@/data/mockData'
import { INITIAL_PROJECT_INFO } from '@/data/mockData'

const PROJECTS_KEY = 'yf_arch_projects'
const FLOORS_PREFIX = 'yf_arch_floors_'      // key: yf_arch_floors_{projectId}
const EXPORTS_KEY   = 'yf_arch_exports'

// ─── 內部工具 ────────────────────────────────────────────

function readProjects(): Project[] {
  try {
    return JSON.parse(localStorage.getItem(PROJECTS_KEY) || '[]')
  } catch { return [] }
}

function writeProjects(list: Project[]): void {
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(list))
}

function readFloors(projectId: string): FloorsById {
  try {
    const raw = localStorage.getItem(FLOORS_PREFIX + projectId)
    return raw ? JSON.parse(raw) : buildInitialFloorsById()
  } catch { return buildInitialFloorsById() }
}

function writeFloors(projectId: string, data: FloorsById): void {
  localStorage.setItem(FLOORS_PREFIX + projectId, JSON.stringify(data))
}

function newId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ─── 專案 Service ────────────────────────────────────────

export const projectService = {

  /** 取得所有專案（目前使用者可見的）
   * TODO: 換成 supabase.from('projects').select('*').eq('org_id', orgId)
   */
  async getProjects(): Promise<ServiceResult<Project[]>> {
    await delay(200)
    const list = readProjects()
    return { data: list, error: null }
  },

  /** 取得單一專案
   * TODO: 換成 supabase.from('projects').select('*').eq('id', id).single()
   */
  async getProjectById(projectId: string): Promise<ServiceResult<Project>> {
    await delay(100)
    const list = readProjects()
    const found = list.find(p => p.id === projectId)
    if (!found) return { data: null, error: '找不到此專案' }
    return { data: found, error: null }
  },

  /** 新增專案
   * TODO: 換成 supabase.from('projects').insert(newProject)
   */
  async createProject(params: {
    name: string
    location: string
    zoning: string
    buildingType: string
    siteArea: number
    legalBuildingCoverageRate: number
    legalFloorAreaRatio: number
    createdBy: string
    responsibleArchitect?: string
    projectStaff?: string
  }): Promise<ServiceResult<Project>> {
    await delay(300)
    const now = new Date().toISOString()
    const project: Project = {
      id: newId(),
      name: params.name,
      location: params.location,
      zoning: params.zoning,
      buildingType: params.buildingType,
      siteArea: params.siteArea,
      legalBuildingCoverageRate: params.legalBuildingCoverageRate,
      legalFloorAreaRatio: params.legalFloorAreaRatio,
      status: 'draft',
      createdBy: params.createdBy,
      responsibleArchitect: params.responsibleArchitect ?? '',
      projectStaff: params.projectStaff ?? '',
      updatedAt: now,
      createdAt: now,
      projectInfo: {
        ...INITIAL_PROJECT_INFO,
        projectName: params.name,
        buildingLocation: params.location,
        zoning: params.zoning,
        buildingType: params.buildingType,
        siteArea: params.siteArea,
        legalBuildingCoverageRate: params.legalBuildingCoverageRate,
        legalFloorAreaRatio: params.legalFloorAreaRatio,
      },
    }
    const list = readProjects()
    list.unshift(project)
    writeProjects(list)

    // 初始化樓層資料
    writeFloors(project.id, buildInitialFloorsById())

    return { data: project, error: null }
  },

  /** 更新專案基本資訊
   * TODO: 換成 supabase.from('projects').update(patch).eq('id', projectId)
   */
  async updateProject(projectId: string, patch: Partial<Project>): Promise<ServiceResult<Project>> {
    await delay(200)
    const list = readProjects()
    const idx = list.findIndex(p => p.id === projectId)
    if (idx === -1) return { data: null, error: '找不到此專案' }
    list[idx] = { ...list[idx], ...patch, updatedAt: new Date().toISOString() }
    writeProjects(list)
    return { data: list[idx], error: null }
  },

  /** 更新 projectInfo（基地基本資料）*/
  async updateProjectInfo(projectId: string, info: ProjectInfo): Promise<ServiceResult<void>> {
    await delay(200)
    const list = readProjects()
    const idx = list.findIndex(p => p.id === projectId)
    if (idx === -1) return { data: null, error: '找不到此專案' }
    list[idx].projectInfo = info
    list[idx].updatedAt = new Date().toISOString()
    writeProjects(list)
    return { data: null, error: null }
  },

  /** 複製專案 */
  async duplicateProject(projectId: string, newName: string, createdBy: string): Promise<ServiceResult<Project>> {
    const src = await this.getProjectById(projectId)
    if (!src.data) return { data: null, error: src.error }
    const floors = await this.getFloorsById(projectId)
    const now = new Date().toISOString()
    const newProject: Project = {
      ...src.data,
      id: newId(),
      name: newName,
      status: 'draft',
      createdBy,
      updatedAt: now,
      createdAt: now,
    }
    const list = readProjects()
    list.unshift(newProject)
    writeProjects(list)
    if (floors.data) writeFloors(newProject.id, floors.data)
    return { data: newProject, error: null }
  },

  /** 刪除專案
   * TODO: 換成 supabase.from('projects').delete().eq('id', projectId)
   */
  async deleteProject(projectId: string): Promise<ServiceResult<void>> {
    await delay(200)
    const list = readProjects().filter(p => p.id !== projectId)
    writeProjects(list)
    localStorage.removeItem(FLOORS_PREFIX + projectId)
    return { data: null, error: null }
  },

  // ─── 樓層資料 ──────────────────────────────────────────

  /** 取得專案所有樓層資料
   * TODO: 換成 supabase.from('floors').select('*, privateItems(*), sharedItems(*)').eq('projectId', projectId)
   */
  async getFloorsById(projectId: string): Promise<ServiceResult<FloorsById>> {
    await delay(100)
    return { data: readFloors(projectId), error: null }
  },

  /** 儲存整份樓層資料（全量覆蓋）
   * TODO: 換成分層 upsert
   */
  async saveFloorsById(projectId: string, floorsById: FloorsById): Promise<ServiceResult<void>> {
    writeFloors(projectId, floorsById)
    // 同步更新 project.updatedAt
    const list = readProjects()
    const idx = list.findIndex(p => p.id === projectId)
    if (idx !== -1) {
      list[idx].updatedAt = new Date().toISOString()
      writeProjects(list)
    }
    return { data: null, error: null }
  },

  /** 更新單一樓層
   * TODO: 換成 supabase.from('floors').upsert({ projectId, floorId, ...data })
   */
  async updateFloor(projectId: string, floorId: string, data: FloorsById[string]): Promise<ServiceResult<void>> {
    const floors = readFloors(projectId)
    floors[floorId] = data
    writeFloors(projectId, floors)
    return { data: null, error: null }
  },

  // ─── 匯出記錄 ──────────────────────────────────────────

  async createExportRecord(projectId: string, exportType: ExportType, createdBy: string): Promise<ServiceResult<ExportRecord>> {
    const records: ExportRecord[] = JSON.parse(localStorage.getItem(EXPORTS_KEY) || '[]')
    const record: ExportRecord = {
      id: newId(),
      projectId,
      exportType,
      fileName: `${exportType}_${projectId}_${new Date().toISOString().slice(0, 10)}.${exportType === 'PDF' ? 'pdf' : 'xlsx'}`,
      createdBy,
      createdAt: new Date().toISOString(),
    }
    records.unshift(record)
    localStorage.setItem(EXPORTS_KEY, JSON.stringify(records.slice(0, 200)))
    return { data: record, error: null }
  },

  async getExportRecords(projectId: string): Promise<ServiceResult<ExportRecord[]>> {
    const records: ExportRecord[] = JSON.parse(localStorage.getItem(EXPORTS_KEY) || '[]')
    return { data: records.filter(r => r.projectId === projectId), error: null }
  },
}
