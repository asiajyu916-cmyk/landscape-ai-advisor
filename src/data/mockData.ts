/**
 * mockData.ts
 * 初始 mock 資料 — 當 localStorage 沒有資料時使用。
 * 未來接 Supabase 後，此檔案只用於開發測試。
 */

import type { Project, FloorsById, ProjectInfo, PrivateItem, SharedItem } from '@/types'
import { FLOOR_DEFINITIONS } from './floorDefinitions'

// ─── 專案基本資訊 ──────────────────────────────────────────

export const INITIAL_PROJECT_INFO: ProjectInfo = {
  projectName:               'XX集合住宅新建工程',
  buildingLocation:          '台中市南屯區大墩段 852、853、853-1 地號等 3 筆土地',
  zoning:                    '第四種住宅區',
  buildingCoverageRateLimit:  60,
  floorAreaRatioLimit:        500,
  buildingType:              '新建',
  buildingUsage:             '店舖、集合住宅、停車空間、機電設備空間',
  siteArea:                   2591.00,
  legalBuildingCoverageRate:  60,
  legalFloorAreaRatio:        500,
  bonusVolume:                10364.00,
  householdInfo: { shopUnits: 4, residentialUnits: 364, totalUnits: 368 },
  floorCount:    { aboveGround: 29, underground: 7, roof: 3 },
  structureType:  '鋼筋混凝土造',
  buildingHeight: '依各層高度加總',
  designOffice:   'XX建築師事務所',
  preparedBy:     '王小明',
  preparedDate:   '114.05.01',
  version:        '送審版 A',
  page:           '1 / 1',
  landLots: [
    { lotNumber: '852',   area: 581.00  },
    { lotNumber: '853',   area: 1140.00 },
    { lotNumber: '853-1', area: 870.00  },
  ],
}

// ─── 初始專案列表 ──────────────────────────────────────────

export const MOCK_PROJECTS: Project[] = [
  {
    id: 'proj_demo_001',
    name: 'XX集合住宅新建工程',
    location: '台中市南屯區大墩段 852、853、853-1',
    zoning: '第四種住宅區',
    buildingType: '集合住宅',
    siteArea: 2591.00,
    legalBuildingCoverageRate: 60,
    legalFloorAreaRatio: 500,
    status: 'reviewing',
    createdBy: 'user-lu',
    responsibleArchitect: '呂建築師',
    projectStaff: '專案人員',
    updatedAt: '2026-06-03T14:35:00Z',
    createdAt: '2025-01-15T09:00:00Z',
    projectInfo: INITIAL_PROJECT_INFO,
  },
  {
    id: 'proj_demo_002',
    name: 'YY辦公大樓新建工程',
    location: '台北市信義區信義段 101、102',
    zoning: '商業區',
    buildingType: '辦公大樓',
    siteArea: 1850.00,
    legalBuildingCoverageRate: 60,
    legalFloorAreaRatio: 560,
    status: 'draft',
    createdBy: 'user-lee',
    responsibleArchitect: '李建築師',
    projectStaff: '專案人員',
    updatedAt: '2026-05-20T11:20:00Z',
    createdAt: '2025-03-10T09:00:00Z',
    projectInfo: {
      ...INITIAL_PROJECT_INFO,
      projectName: 'YY辦公大樓新建工程',
      buildingLocation: '台北市信義區信義段 101、102 地號',
      zoning: '商業區',
      siteArea: 1850.00,
      legalBuildingCoverageRate: 60,
      legalFloorAreaRatio: 560,
      bonusVolume: 0,
    },
  },
  {
    id: 'proj_demo_003',
    name: 'ZZ透天厝新建工程',
    location: '台南市東區勝利段 321',
    zoning: '第二種住宅區',
    buildingType: '透天住宅',
    siteArea: 320.00,
    legalBuildingCoverageRate: 60,
    legalFloorAreaRatio: 240,
    status: 'finalized',
    createdBy: 'user-chen',
    responsibleArchitect: '陳建築師',
    projectStaff: '-',
    updatedAt: '2026-02-28T16:00:00Z',
    createdAt: '2024-11-05T09:00:00Z',
    projectInfo: {
      ...INITIAL_PROJECT_INFO,
      projectName: 'ZZ透天厝新建工程',
      buildingLocation: '台南市東區勝利段 321 地號',
      zoning: '第二種住宅區',
      siteArea: 320.00,
      legalBuildingCoverageRate: 60,
      legalFloorAreaRatio: 240,
      bonusVolume: 0,
    },
  },
]

// ─── 樓層面積 Mock 生成器 ──────────────────────────────────

const BASE_UNITS = [
  { unit: 'A1', use: '住宅', indoor: 68.71 },
  { unit: 'A2', use: '住宅', indoor: 72.31 },
  { unit: 'A3', use: '住宅', indoor: 53.41 },
  { unit: 'A5', use: '住宅', indoor: 50.62 },
  { unit: 'A6', use: '住宅', indoor: 53.52 },
  { unit: 'A7', use: '住宅', indoor: 50.39 },
  { unit: 'B1', use: '住宅', indoor: 50.62 },
  { unit: 'B2', use: '住宅', indoor: 53.51 },
  { unit: 'B3', use: '住宅', indoor: 53.51 },
  { unit: 'B5', use: '住宅', indoor: 70.23 },
  { unit: 'B6', use: '住宅', indoor: 70.95 },
  { unit: 'B7', use: '住宅', indoor: 51.97 },
  { unit: 'B8', use: '住宅', indoor: 50.76 },
  { unit: 'B9', use: '住宅', indoor: 52.32 },
]

const FLOOR_BALCONY: Record<string, number[]> = {
  '5F':  [11.17,7.52,3.90,3.90,3.90,3.90,3.90,3.90,3.90,8.90,9.38,3.90,3.90,5.15],
  '6F':  [11.05,7.42,3.90,3.90,3.90,3.90,3.90,3.90,3.90,8.75,9.25,3.90,3.90,5.15],
  '7F':  [10.95,7.35,3.90,3.90,3.90,3.90,3.90,3.90,3.90,8.60,9.12,3.90,3.90,5.15],
  '8F':  [10.82,7.22,3.90,3.90,3.90,3.90,3.90,3.90,3.90,8.43,8.95,3.90,3.90,5.15],
  '9F':  [10.68,7.12,3.90,3.90,3.90,3.90,3.90,3.90,3.90,8.27,8.80,3.90,3.90,5.15],
  '10F': [10.55,7.02,3.90,3.90,3.90,3.90,3.90,3.90,3.90,8.12,8.65,3.90,3.90,5.15],
  '11F': [10.43,6.90,3.90,3.90,3.90,3.90,3.90,3.90,3.90,7.98,8.52,3.90,3.90,5.15],
  '12F': [10.30,6.78,3.90,3.90,3.90,3.90,3.90,3.90,3.90,7.85,8.38,3.90,3.90,5.15],
}
const FLOOR_OVER: Record<string, number[]> = {
  '5F':  [0.22,0.18,0,0,0,0,0,0,0,0.39,0.18,0,0,0],
  '6F':  [0.20,0.16,0,0,0,0,0,0,0,0.35,0.15,0,0,0],
  '7F':  [0.18,0.14,0,0,0,0,0,0,0,0.31,0.12,0,0,0],
  '8F':  [0.16,0.12,0,0,0,0,0,0,0,0.27,0.10,0,0,0],
  '9F':  [0.14,0.10,0,0,0,0,0,0,0,0.23,0.08,0,0,0],
  '10F': [0.12,0.08,0,0,0,0,0,0,0,0.19,0.06,0,0,0],
  '11F': [0.10,0.06,0,0,0,0,0,0,0,0.15,0.04,0,0,0],
  '12F': [0.08,0.04,0,0,0,0,0,0,0,0.11,0.02,0,0,0],
}

function mkPrivate(floorId: string): PrivateItem[] {
  const bal  = FLOOR_BALCONY[floorId] ?? FLOOR_BALCONY['5F']
  const over = FLOOR_OVER[floorId]    ?? FLOOR_OVER['5F']
  return BASE_UNITS.map((u, i) => ({
    id:          `${floorId}_${u.unit}`,
    unit:        u.unit,
    use:         u.use,
    indoor:      u.indoor,
    balcony:     bal[i],
    balconyOver: over[i],
    subtotal:    +(u.indoor + over[i]).toFixed(2),
    note:        over[i] > 0 ? '宜居陽台' : '-',
  }))
}

function mkShared(floorId: string, hallArea: number, b2Extra: number): SharedItem[] {
  const art162 = [
    { name: '一般昇降機',     area: 13.89 },
    { name: '特別安全梯(A1)', area: 17.59 },
    { name: '特別安全梯(A2)', area: 19.62 },
    { name: '特別安全梯(B1)', area: 17.59 },
    { name: '特別安全梯(B2)', area: +(16.71 + b2Extra).toFixed(2) },
    { name: '緊急昇降機',     area: 16.62 },
    { name: '機電設備空間',   area: 23.38 },
  ]
  return [
    { id: `${floorId}_hall`, name: '梯廳兼排煙室', area: hallArea, inFloor: '是', inFAR: '條件判斷', rule: '梯廳10%', note: '-' },
    ...art162.map((item, i) => ({
      id: `${floorId}_s${i}`, name: item.name, area: item.area,
      inFloor: '是' as const, inFAR: '免計判斷' as const, rule: '第162條', note: '-',
    })),
  ]
}

/** buildInitialFloorsById — 建立初始樓層資料（新專案或本機無快取時使用） */
export function buildInitialFloorsById(): FloorsById {
  const map: FloorsById = {}

  // 停車層
  const parkingAreas: Record<string, number> = { B3F: 2110.12, B2F: 2102.52, B1F: 1522.21 }
  for (const [id, area] of Object.entries(parkingAreas)) {
    map[id] = {
      privateItems: [],
      sharedItems: [{ id: `${id}_s0`, name: '停車設備空間', area, inFloor: '是', inFAR: '免計判斷', rule: '第162條', note: '-' }],
      sourceFloor: null, isOverridden: false,
    }
  }

  // 一層（店舖）
  map['1F'] = {
    privateItems: [
      { id: '1F_S1', unit: 'S1', use: '店舖', indoor: 420.50, balcony: 38.20, balconyOver: 0, subtotal: 420.50, note: '騎樓' },
      { id: '1F_S2', unit: 'S2', use: '店舖', indoor: 385.30, balcony: 32.10, balconyOver: 0, subtotal: 385.30, note: '-' },
      { id: '1F_S3', unit: 'S3', use: '店舖', indoor: 310.20, balcony: 28.90, balconyOver: 0, subtotal: 310.20, note: '-' },
    ],
    sharedItems: [
      { id: '1F_h0', name: '梯廳兼排煙室', area: 102.50, inFloor: '是', inFAR: '條件判斷', rule: '梯廳10%', note: '-' },
      { id: '1F_s0', name: '一般昇降機',   area: 13.89,  inFloor: '是', inFAR: '免計判斷', rule: '第162條', note: '-' },
      { id: '1F_s1', name: '特別安全梯(A)',area: 21.30,  inFloor: '是', inFAR: '免計判斷', rule: '第162條', note: '-' },
      { id: '1F_s2', name: '特別安全梯(B)',area: 19.80,  inFloor: '是', inFAR: '免計判斷', rule: '第162條', note: '-' },
    ],
    sourceFloor: null, isOverridden: false,
  }

  // 二～四層
  const lowerVariants: Record<string, { balScale: number; b2Extra: number; hallArea: number }> = {
    '2F': { balScale: 0.88, b2Extra: 0, hallArea: 101.30 },
    '3F': { balScale: 0.92, b2Extra: 0, hallArea: 100.80 },
    '4F': { balScale: 0.96, b2Extra: 0, hallArea: 98.72  },
  }
  for (const [fid, v] of Object.entries(lowerVariants)) {
    map[fid] = {
      privateItems: mkPrivate('5F').map((p, i) => ({
        ...p, id: `${fid}_${BASE_UNITS[i].unit}`, balcony: +(p.balcony * v.balScale).toFixed(2),
      })),
      sharedItems: mkShared(fid, v.hallArea, v.b2Extra),
      sourceFloor: null, isOverridden: false,
    }
  }

  // 五～十二層（標準層）
  const stdExtras: Record<string, number> = { '5F':0,'6F':0.49,'7F':0.79,'8F':1.09,'9F':1.12,'10F':1.48,'11F':1.69,'12F':1.89 }
  for (const [fid, extra] of Object.entries(stdExtras)) {
    map[fid] = {
      privateItems: mkPrivate(fid),
      sharedItems:  mkShared(fid, 98.72, extra),
      sourceFloor:  fid === '5F' ? null : '5F',
      isOverridden: false,
    }
  }

  // 屋突
  map['RF1'] = {
    privateItems: [],
    sharedItems: [
      { id: 'RF1_s0', name: '機電設備間', area: 85.20, inFloor: '是', inFAR: '免計判斷', rule: '第162條', note: '-' },
      { id: 'RF1_s1', name: '電梯機房',   area: 22.50, inFloor: '是', inFAR: '免計判斷', rule: '第162條', note: '-' },
    ],
    sourceFloor: null, isOverridden: false,
  }
  map['RF2'] = {
    privateItems: [],
    sharedItems: [
      { id: 'RF2_s0', name: '水箱間', area: 42.30, inFloor: '是', inFAR: '免計判斷', rule: '第162條', note: '-' },
    ],
    sourceFloor: null, isOverridden: false,
  }

  return map
}

/** seedMockDataIfEmpty — 開發時自動植入 mock 資料 */
export function seedMockDataIfEmpty(): void {
  const existing = localStorage.getItem('yf_arch_projects')
  if (!existing || existing === '[]') {
    localStorage.setItem('yf_arch_projects', JSON.stringify(MOCK_PROJECTS))
    for (const project of MOCK_PROJECTS) {
      const floorsKey = `yf_arch_floors_${project.id}`
      if (!localStorage.getItem(floorsKey)) {
        localStorage.setItem(floorsKey, JSON.stringify(buildInitialFloorsById()))
      }
    }
  }
}
