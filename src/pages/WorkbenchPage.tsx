/**
 * WorkbenchPage.tsx
 * 建築面積計算工作台主頁面
 * 保留所有原有 UI；資料由 projectService 讀寫（目前 localStorage）。
 */

import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { authService } from '@/services/authService'
import { projectService } from '@/services/projectService'
import { FLOOR_DEFINITIONS } from '@/data/floorDefinitions'
import {
  computeFloorStats, getAllFloorSummaries, calculateProjectSummary,
  getFloorSummary, deepClone, fmt,
} from '@/utils/calculations'
import type {
  AuthSession, Project, FloorsById, ProjectInfo,
  PrivateItem, SharedItem, FloorSummaryRow,
} from '@/types'

// ─────────────────────────────────────────────
// SIDEBAR
// ─────────────────────────────────────────────

const MENU_ITEMS = [
  { id: 'input',        label: '資料輸入區',      type: 'header' as const },
  { id: '1',            label: '基地基本資料',     type: 'item'   as const, step: 1 },
  { id: '2',            label: '樓層設定',         type: 'item'   as const, step: 2 },
  { id: '3',            label: '各層面積明細',     type: 'item'   as const, step: 3 },
  { id: '4',            label: '樓層面積彙整',     type: 'item'   as const, step: 4 },
  { id: '5',            label: '停車空間檢討',     type: 'item'   as const, step: 5 },
  { id: '6',            label: '建蔽率檢討',       type: 'item'   as const, step: 6 },
  { id: '7',            label: '容積率檢討',       type: 'item'   as const, step: 7 },
  { id: '8',            label: '法定空地檢討',     type: 'item'   as const, step: 8 },
  { id: '9',            label: '防空避難室檢討',   type: 'item'   as const, step: 9 },
  { id: '10',           label: '大總表預覽',       type: 'item'   as const, step: 10 },
  { id: 'mgmt',         label: '資料管理',         type: 'header' as const },
  { id: 'projects',     label: '專案列表',         type: 'item'   as const },
  { id: 'templates',    label: '法規模板庫',       type: 'item'   as const },
  { id: 'importexport', label: '匯入／匯出記錄',   type: 'item'   as const },
  { id: 'versions',     label: '版本記錄',         type: 'item'   as const },
]

function Sidebar({ activeId, onSelect }: { activeId: string; onSelect: (id: string) => void }) {
  return (
    <div style={{ width: 196 }} className="bg-white border-r border-gray-200 flex flex-col shrink-0 overflow-y-auto">
      <div className="py-2">
        {MENU_ITEMS.map(item => {
          if (item.type === 'header') return (
            <div key={item.id} className="px-4 pt-4 pb-1">
              <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{item.label}</span>
            </div>
          )
          const isActive = activeId === item.id
          return (
            <button key={item.id} onClick={() => onSelect(item.id)}
              className={`w-full text-left flex items-center gap-2 px-4 py-2 text-sm transition-colors ${isActive ? 'bg-blue-50 text-blue-700 font-medium border-r-2 border-blue-600' : 'text-gray-600 hover:bg-gray-50'}`}>
              {item.step
                ? <span className={`w-5 h-5 rounded-full text-xs flex items-center justify-center shrink-0 font-medium ${isActive ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-500'}`}>{item.step}</span>
                : <span className="w-5 h-5 shrink-0" />}
              <span className="leading-tight">{item.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────
// TOP BAR
// ─────────────────────────────────────────────

function TopBar({ project, session, savedAt, onExportPDF, onExportExcel, onValidate, onBack }: {
  project: Project; session: AuthSession; savedAt: string
  onExportPDF: () => void; onExportExcel: () => void
  onValidate: () => void; onBack: () => void
}) {
  return (
    <div style={{ height: 52 }} className="flex items-center px-4 bg-white border-b border-gray-200 gap-4 shrink-0 shadow-sm z-10">
      <button onClick={onBack} className="text-gray-400 hover:text-gray-600 mr-1" title="回專案列表">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7"/></svg>
      </button>
      <div className="flex items-center gap-2 shrink-0">
        <div className="w-7 h-7 bg-blue-700 rounded flex items-center justify-center">
          <span className="text-white text-xs font-bold">YF</span>
        </div>
        <span className="font-semibold text-gray-800 text-sm whitespace-nowrap">永豐 AI 建築面積計算平台</span>
      </div>
      <div className="w-px h-5 bg-gray-200 shrink-0" />
      <div className="flex items-center gap-1 shrink-0">
        <span className="text-xs text-gray-500">專案：</span>
        <span className="text-sm font-medium text-gray-700 max-w-xs truncate">{project.name}</span>
      </div>
      <div className="flex items-center gap-1 text-xs text-gray-400 shrink-0">
        <svg className="w-3.5 h-3.5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7"/></svg>
        <span>已儲存 {savedAt}</span>
      </div>
      <div className="flex-1" />
      <button onClick={onValidate} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-gray-300 rounded text-gray-600 hover:bg-gray-50 transition-colors">
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"/></svg>
        檢核全部
      </button>
      <button onClick={onExportPDF} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-red-50 border border-red-200 rounded text-red-700 hover:bg-red-100 transition-colors">
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>
        匯出 PDF
      </button>
      <button onClick={onExportExcel} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-green-50 border border-green-200 rounded text-green-700 hover:bg-green-100 transition-colors">
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
        匯出 Excel
      </button>
      <div className="w-px h-5 bg-gray-200 shrink-0" />
      <div className="flex items-center gap-1.5 shrink-0">
        <div className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center">
          <span className="text-white text-xs font-semibold">{session.user.displayName[0]}</span>
        </div>
        <div className="flex flex-col leading-none">
          <span className="text-xs text-gray-700 font-medium">{session.user.displayName}</span>
          <span className="text-xs text-gray-400">{session.user.role === 'admin' ? '管理者' : session.user.role === 'architect' ? '建築師' : '專案人員'}</span>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────
// FLOOR TABS
// ─────────────────────────────────────────────

function FloorTabs({ floorsById, activeFloorId, onSelect }: {
  floorsById: FloorsById; activeFloorId: string; onSelect: (id: string) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scrollRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }, [activeFloorId])
  return (
    <div className="bg-white border-b border-gray-200">
      <div ref={scrollRef} className="flex overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
        {FLOOR_DEFINITIONS.map(def => {
          const fd = floorsById[def.id]
          const isActive = def.id === activeFloorId
          return (
            <button key={def.id} data-active={isActive}
              onClick={() => onSelect(def.id)}
              className={`flex items-center gap-1 px-3 py-2.5 text-xs whitespace-nowrap border-b-2 transition-colors shrink-0 ${isActive ? 'border-blue-600 text-blue-700 bg-blue-50 font-semibold' : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'}`}>
              {def.name}
              {fd?.isOverridden && <span className="text-amber-500 text-xs">✎</span>}
              {!fd?.isOverridden && fd?.sourceFloor && <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-300" />}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────
// FLOOR SUMMARY BAR
// ─────────────────────────────────────────────

function FloorSummaryBar({ floorId, floorDef, floorData, stats, floorIndex, onPrev, onNext }: {
  floorId: string; floorDef: typeof FLOOR_DEFINITIONS[0]
  floorData: FloorsById[string]; stats: ReturnType<typeof computeFloorStats>
  floorIndex: number; onPrev: () => void; onNext: () => void
}) {
  const sourceDef = floorData.sourceFloor ? FLOOR_DEFINITIONS.find(d => d.id === floorData.sourceFloor) : null
  const dataSourceLabel = floorData.sourceFloor ? `複製自${sourceDef?.name ?? floorData.sourceFloor}` : `${floorDef.name}獨立資料`
  return (
    <div className="bg-gray-50 border-b border-gray-200 px-4 py-2 flex flex-wrap items-start gap-y-1.5">
      <div className="flex items-center gap-2 mr-4 shrink-0">
        <button onClick={onPrev} disabled={floorIndex === 0} className="w-6 h-6 flex items-center justify-center rounded border border-gray-300 text-gray-500 hover:bg-white disabled:opacity-30 disabled:cursor-not-allowed text-xs">‹</button>
        <div>
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-bold text-gray-800">{floorDef.name}</span>
            {floorData.isOverridden && <span className="text-xs bg-amber-100 border border-amber-300 text-amber-700 rounded px-1.5 py-0.5 font-semibold">已覆寫</span>}
            {!floorData.isOverridden && floorData.sourceFloor && <span className="text-xs bg-blue-50 border border-blue-200 text-blue-500 rounded px-1.5 py-0.5">來自標準層</span>}
          </div>
        </div>
        <button onClick={onNext} disabled={floorIndex === FLOOR_DEFINITIONS.length - 1} className="w-6 h-6 flex items-center justify-center rounded border border-gray-300 text-gray-500 hover:bg-white disabled:opacity-30 disabled:cursor-not-allowed text-xs">›</button>
      </div>
      <div className="flex items-center divide-x divide-gray-300 flex-wrap gap-y-1 mr-4">
        {[['用途',floorDef.usage],['高度',`${fmt(floorDef.height,2)}m`],['樓地板',`${fmt(stats.floorArea)}㎡`],['陽台',`${fmt(stats.privateBalcony)}㎡`],['162條',`${fmt(stats.art162Total)}㎡`],['當層容積',`${fmt(stats.farArea)}㎡`]].map(([l,v]) => (
          <div key={l} className="px-2.5 first:pl-0 flex flex-col leading-tight">
            <span className="text-xs text-gray-400">{l}</span>
            <span className="text-xs font-semibold text-gray-700">{v}</span>
          </div>
        ))}
      </div>
      <div className="ml-auto flex flex-col items-end gap-0.5 shrink-0">
        <div className="text-xs text-gray-400"><span className="font-medium text-gray-500">目前編輯：</span>{floorDef.name}</div>
        <div className="text-xs text-gray-400"><span className="font-medium text-gray-500">資料來源：</span>{dataSourceLabel}</div>
        <div className="text-xs text-gray-400"><span className="font-medium text-gray-500">是否覆寫：</span>{floorData.isOverridden ? <span className="text-amber-600 font-semibold">是</span> : <span className="text-gray-500">否</span>}</div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────
// EDITABLE CELL
// ─────────────────────────────────────────────

function EC({ value, onChange, align = 'right' }: { value: string|number; onChange: (v: string) => void; align?: 'left'|'right' }) {
  return (
    <td className="editable-cell border border-gray-200 px-1 py-0.5">
      <input type="text" value={value} onChange={e => onChange(e.target.value)} style={{ textAlign: align, width:'100%', border:'none', background:'transparent', outline:'none', fontSize:'0.75rem', padding:'2px 4px' }} />
    </td>
  )
}

// ─────────────────────────────────────────────
// PRIVATE AREA TABLE
// ─────────────────────────────────────────────

function PrivateAreaTable({ rows, onChange }: { rows: PrivateItem[]; onChange: (rows: PrivateItem[]) => void }) {
  const totals = useMemo(() => ({
    indoor: rows.reduce((s,r)=>s+Number(r.indoor||0),0),
    balcony: rows.reduce((s,r)=>s+Number(r.balcony||0),0),
    balconyOver: rows.reduce((s,r)=>s+Number(r.balconyOver||0),0),
    subtotal: rows.reduce((s,r)=>s+Number(r.subtotal||0),0),
  }), [rows])
  const updateRow = (id: string, field: keyof PrivateItem, val: string) =>
    onChange(rows.map(r => r.id === id ? { ...r, [field]: val } : r))
  const deleteRow = (id: string) => onChange(rows.filter(r => r.id !== id))
  const th = "border border-gray-300 bg-gray-50 px-2 py-1.5 text-xs font-semibold text-gray-600 whitespace-nowrap"
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead><tr>
          <th className={th} style={{width:50}}>編號</th><th className={th} style={{width:60}}>用途</th>
          <th className={th} style={{width:90}}>室內面積(㎡)</th><th className={th} style={{width:100}}>陽台面積(&lt;2M)</th>
          <th className={th} style={{width:110}}>陽台超過2M部分</th><th className={th} style={{width:90}}>小計(㎡)</th>
          <th className={th} style={{width:100}}>備註</th><th className={th} style={{width:40}}>操作</th>
        </tr></thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={8} className="border border-gray-200 py-6 text-center text-xs text-gray-400">尚無專有部份資料</td></tr>
          ) : rows.map(row => (
            <tr key={row.id} className="hover:bg-blue-50/30">
              <EC value={row.unit} onChange={v=>updateRow(row.id,'unit',v)} align="left"/>
              <EC value={row.use} onChange={v=>updateRow(row.id,'use',v)} align="left"/>
              <EC value={row.indoor} onChange={v=>updateRow(row.id,'indoor',v)}/>
              <EC value={row.balcony} onChange={v=>updateRow(row.id,'balcony',v)}/>
              <EC value={row.balconyOver} onChange={v=>updateRow(row.id,'balconyOver',v)}/>
              <td className="border border-gray-200 px-2 py-0.5 text-right font-medium text-blue-800 bg-blue-50/40">
                {fmt(Number(row.indoor||0)+Number(row.balconyOver||0))}
              </td>
              <EC value={row.note} onChange={v=>updateRow(row.id,'note',v)} align="left"/>
              <td className="border border-gray-200 px-1 py-0.5 text-center">
                <button onClick={()=>deleteRow(row.id)} className="text-red-400 hover:text-red-600 text-xs px-1">✕</button>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr className="bg-gray-100 font-semibold">
          <td className="border border-gray-300 px-2 py-1.5 text-xs" colSpan={2}>小計</td>
          <td className="border border-gray-300 px-2 py-1.5 text-xs text-right">{fmt(totals.indoor)}</td>
          <td className="border border-gray-300 px-2 py-1.5 text-xs text-right">{fmt(totals.balcony)}</td>
          <td className="border border-gray-300 px-2 py-1.5 text-xs text-right">{fmt(totals.balconyOver)}</td>
          <td className="border border-gray-300 px-2 py-1.5 text-xs text-right text-blue-700">{fmt(totals.subtotal)}</td>
          <td className="border border-gray-300" colSpan={2}/>
        </tr></tfoot>
      </table>
    </div>
  )
}

// ─────────────────────────────────────────────
// SHARED AREA TABLE
// ─────────────────────────────────────────────

function SharedAreaTable({ rows, onChange }: { rows: SharedItem[]; onChange: (rows: SharedItem[]) => void }) {
  const total = useMemo(() => rows.reduce((s,r)=>s+Number(r.area||0),0), [rows])
  const updateRow = (id: string, field: keyof SharedItem, val: string) =>
    onChange(rows.map(r => r.id === id ? { ...r, [field]: val } : r))
  const deleteRow = (id: string) => onChange(rows.filter(r => r.id !== id))
  const th = "border border-gray-300 bg-gray-50 px-2 py-1.5 text-xs font-semibold text-gray-600 whitespace-nowrap"
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead><tr>
          <th className={th} style={{width:160}}>項目名稱</th><th className={th} style={{width:90}}>面積(㎡)</th>
          <th className={th} style={{width:80}}>計入樓地板</th><th className={th} style={{width:90}}>計入容積</th>
          <th className={th} style={{width:90}}>法規依據</th><th className={th} style={{width:80}}>備註</th>
          <th className={th} style={{width:40}}>操作</th>
        </tr></thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={7} className="border border-gray-200 py-6 text-center text-xs text-gray-400">尚無共用部份資料</td></tr>
          ) : rows.map(row => (
            <tr key={row.id} className="hover:bg-blue-50/30">
              <EC value={row.name} onChange={v=>updateRow(row.id,'name',v)} align="left"/>
              <EC value={row.area} onChange={v=>updateRow(row.id,'area',v)}/>
              <td className="border border-gray-200 px-2 py-0.5 text-center">
                <select value={row.inFloor} onChange={e=>updateRow(row.id,'inFloor',e.target.value)} className="text-xs border-0 bg-transparent focus:outline-none">
                  <option>是</option><option>否</option>
                </select>
              </td>
              <td className={`border border-gray-200 px-2 py-0.5 text-center text-xs font-medium ${row.inFAR==='條件判斷'?'text-amber-600':'text-green-600'}`}>{row.inFAR}</td>
              <EC value={row.rule} onChange={v=>updateRow(row.id,'rule',v)} align="left"/>
              <EC value={row.note} onChange={v=>updateRow(row.id,'note',v)} align="left"/>
              <td className="border border-gray-200 px-1 py-0.5 text-center">
                <button onClick={()=>deleteRow(row.id)} className="text-red-400 hover:text-red-600 text-xs px-1">✕</button>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr className="bg-gray-100 font-semibold">
          <td className="border border-gray-300 px-2 py-1.5 text-xs">小計</td>
          <td className="border border-gray-300 px-2 py-1.5 text-xs text-right">{fmt(total)}</td>
          <td className="border border-gray-300" colSpan={5}/>
        </tr></tfoot>
      </table>
    </div>
  )
}

// ─────────────────────────────────────────────
// AUTO CHECK CARD
// ─────────────────────────────────────────────

function AutoCheckCard({ stats }: { stats: ReturnType<typeof computeFloorStats> }) {
  const { floorArea,privateBalcony,hallArea,art162Total,limit10,limit15,combinedSum,over15,farArea } = stats
  const Pass = () => <span className="flex items-center gap-1 text-green-600 font-medium text-xs"><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7"/></svg>符合</span>
  const Warn = ({msg}:{msg:string}) => <span className="flex items-center gap-1 text-amber-600 font-medium text-xs"><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>{msg}</span>
  return (
    <div className="bg-white border border-gray-200 rounded-lg">
      <div className="px-4 py-3 border-b border-gray-100 bg-gray-50 rounded-t-lg">
        <h3 className="text-sm font-semibold text-gray-700">
          <span className="inline-block w-5 h-5 rounded bg-indigo-600 text-white text-xs text-center leading-5 mr-1.5 font-bold">C</span>當層自動檢討
        </h3>
      </div>
      <div className="p-4 space-y-4">
        <div className="grid grid-cols-2 gap-x-6 gap-y-2">
          {[['A. 當層樓地板面積',fmt(floorArea),'㎡'],['B. 陽台面積',fmt(privateBalcony),'㎡'],['C. 梯廳面積',fmt(hallArea),'㎡'],['E. 第162條第二項設置空間',fmt(art162Total),'㎡']].map(([l,v,u]) => (
            <div key={l} className="flex items-baseline justify-between gap-2 py-1 border-b border-gray-100">
              <span className="text-xs text-gray-500">{l}</span>
              <span className="text-xs font-semibold text-gray-800 whitespace-nowrap">{v} {u}</span>
            </div>
          ))}
          <div className="flex items-baseline justify-between gap-2 py-1 border-b border-blue-100 col-span-2 bg-blue-50/40 px-2 rounded">
            <span className="text-xs font-medium text-blue-700">F. 當層容積</span>
            <span className="text-sm font-bold text-blue-700">{fmt(farArea)} ㎡</span>
          </div>
        </div>
        <div className="space-y-2 pt-1">
          {[
            {label:`陽台 10%：${fmt(privateBalcony)}㎡ < ${fmt(limit10)}㎡`,pass:privateBalcony<limit10,warn:'超過'},
            {label:`梯廳 10%：${fmt(hallArea)}㎡ < ${fmt(limit10)}㎡`,pass:hallArea<limit10,warn:'超過'},
            {label:`陽台＋梯廳 15%：${fmt(combinedSum)}㎡ ${combinedSum<=limit15?'≤':'>'} ${fmt(limit15)}㎡`,pass:combinedSum<=limit15,warn:`超過 ${fmt(over15)}㎡ 計入容積`},
          ].map((c,i) => (
            <div key={i} className={`flex items-center justify-between py-1.5 px-3 rounded border ${c.pass?'bg-gray-50 border-gray-100':'bg-amber-50 border-amber-200'}`}>
              <span className="text-xs text-gray-600">{c.label}</span>
              {c.pass ? <Pass/> : <Warn msg={c.warn}/>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────
// COPY TO FLOORS MODAL
// ─────────────────────────────────────────────

function CopyToFloorsModal({ sourceDef, floorsById, onCopy, onClose }: {
  sourceDef: typeof FLOOR_DEFINITIONS[0]
  floorsById: FloorsById; onCopy: (sourceId: string, targetIds: string[]) => void; onClose: () => void
}) {
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const toggle = (id: string) => setSelected(p => ({...p, [id]: !p[id]}))
  const toggleAll = (val: boolean) => { const n: Record<string,boolean>={};FLOOR_DEFINITIONS.forEach(d=>{if(d.id!==sourceDef.id)n[d.id]=val});setSelected(n) }
  const selectedCount = Object.values(selected).filter(Boolean).length
  const handleConfirm = () => {
    const ids = Object.keys(selected).filter(id=>selected[id])
    if (!ids.length) { alert('請勾選至少一個目標樓層'); return }
    onCopy(sourceDef.id, ids); onClose()
  }
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-[480px] max-h-[80vh] flex flex-col" onClick={e=>e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-gray-200">
          <h2 className="text-base font-bold text-gray-800">複製本層到其他樓層</h2>
          <p className="text-xs text-gray-500 mt-0.5">以「<span className="font-semibold text-blue-700">{sourceDef.name}</span>」為來源，複製後各層獨立，可分別修改。</p>
        </div>
        <div className="px-5 py-2 border-b border-gray-100 flex items-center gap-3">
          <span className="text-xs text-gray-400">已選 {selectedCount} 層</span>
          <button onClick={()=>toggleAll(true)} className="text-xs text-blue-600 hover:underline">全選</button>
          <button onClick={()=>toggleAll(false)} className="text-xs text-gray-400 hover:underline">清除</button>
        </div>
        <div className="overflow-y-auto flex-1 px-5 py-3">
          <div className="grid grid-cols-4 gap-2">
            {FLOOR_DEFINITIONS.filter(d=>d.id!==sourceDef.id).map(def=>{
              const fd=floorsById[def.id]; const isChecked=!!selected[def.id]
              return (
                <button key={def.id} onClick={()=>toggle(def.id)}
                  className={`flex flex-col items-center px-2 py-2 rounded-lg border text-xs transition-colors ${isChecked?'bg-blue-50 border-blue-400 text-blue-700 font-semibold':'bg-white border-gray-200 text-gray-600 hover:border-gray-300'}`}>
                  <span>{def.name}</span>
                  <span className="text-gray-400 font-normal mt-0.5">{def.usage}</span>
                  {fd?.isOverridden && <span className="text-amber-500 text-xs mt-0.5">已覆寫</span>}
                </button>
              )
            })}
          </div>
        </div>
        <div className="px-5 py-4 border-t border-gray-200 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-gray-300 rounded text-gray-600 hover:bg-gray-50">取消</button>
          <button onClick={handleConfirm} className="px-4 py-2 text-sm rounded font-medium text-white bg-blue-600 hover:bg-blue-700">複製到 {selectedCount} 個樓層</button>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────
// RIGHT PANEL
// ─────────────────────────────────────────────

function RightPanel({ floorsById, activeFloorId, projectInfo }: {
  floorsById: FloorsById; activeFloorId: string; projectInfo: ProjectInfo
}) {
  const projectSummary = useMemo(
    () => calculateProjectSummary(FLOOR_DEFINITIONS, floorsById, projectInfo),
    [floorsById, projectInfo]
  )
  const summaryRows = useMemo(
    () => getAllFloorSummaries(FLOOR_DEFINITIONS, floorsById),
    [floorsById]
  )
  const prevVolumeRef = useRef<number|null>(null)
  const [prevVolume, setPrevVolume] = useState<number|null>(null)
  useEffect(() => {
    setPrevVolume(prevVolumeRef.current)
    prevVolumeRef.current = projectSummary.totalFloorVolume
  }, [floorsById])

  const def      = FLOOR_DEFINITIONS.find(d => d.id === activeFloorId)!
  const fd       = floorsById[activeFloorId]
  const curStats = useMemo(() => computeFloorStats(fd), [fd])

  const ps = projectSummary
  const statusColor = ps.status === '符合' ? {bar:'bg-green-500',badge:'bg-green-100 text-green-700 border-green-300',text:'text-green-700'} :
    ps.status === '接近上限' ? {bar:'bg-amber-400',badge:'bg-amber-100 text-amber-700 border-amber-300',text:'text-amber-700'} :
    {bar:'bg-red-500',badge:'bg-red-100 text-red-700 border-red-300',text:'text-red-700'}
  const volumeBorder = ps.status === '符合' ? 'border-green-200' : ps.status === '接近上限' ? 'border-amber-300' : 'border-red-400'
  const delta = prevVolume != null ? ps.totalFloorVolume - prevVolume : null

  const th = "border border-gray-300 bg-gray-100 px-1.5 py-1 text-xs font-semibold text-gray-600 text-center whitespace-nowrap"
  const td = "border border-gray-200 px-1.5 py-0.5 text-xs text-right"
  const cell = (v: number) => v > 0 ? <span>{fmt(v)}</span> : <span className="text-gray-300">-</span>

  const cardCls = "bg-white border border-gray-200 rounded-lg mb-3"
  const cardH   = "px-3 py-2 border-b border-gray-100 bg-gray-50 rounded-t-lg flex items-center justify-between"

  return (
    <div style={{ width: 310 }} className="flex flex-col shrink-0 overflow-y-auto bg-gray-50 border-l border-gray-200 p-3">
      {/* 全案即時總檢核 */}
      <div className={`bg-white rounded-lg mb-3 border-2 ${volumeBorder}`}>
        <div className={`${cardH} rounded-t-lg`}>
          <h3 className="text-xs font-semibold text-gray-700 flex items-center gap-1">
            <svg className="w-3.5 h-3.5 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg>
            全案即時總檢核
          </h3>
          <span className="text-xs text-gray-400">即時連動</span>
        </div>
        <div className="p-3 space-y-3">
          <div>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-gray-500">容積使用率</span>
              <span className={`font-bold ${statusColor.text}`}>{fmt(ps.usageRate,1)}%</span>
            </div>
            <div className="w-full h-3 rounded-full bg-gray-100 overflow-hidden border border-gray-200">
              <div className={`h-full rounded-full transition-all duration-300 ${statusColor.bar}`} style={{width:`${Math.min(100,ps.usageRate)}%`}}/>
            </div>
          </div>
          <div className={`flex items-center justify-between px-3 py-2 rounded border font-semibold ${statusColor.badge}`}>
            <span className="text-xs">全案容積狀態</span>
            <span className="text-sm">{ps.status}</span>
          </div>
          <div className="space-y-0.5">
            {[['目前實設容積',fmt(ps.totalFloorVolume),'㎡',false],['容積上限',fmt(ps.maxAllowedVolume),'㎡',false],['剩餘可用',ps.remainingVolume>=0?fmt(ps.remainingVolume):'—','㎡',ps.remainingVolume<0],['超出容積',ps.exceededVolume>0?fmt(ps.exceededVolume):'—','㎡',ps.exceededVolume>0],['實設容積率',fmt(ps.actualFAR,2),'%',false]].map(([l,v,u,warn]) => (
              <div key={String(l)} className="flex items-baseline justify-between py-0.5 border-b border-gray-100">
                <span className="text-xs text-gray-500">{l}</span>
                <span className={`text-xs font-semibold ${warn?'text-red-600':'text-gray-800'}`}>{v} <span className="text-gray-400 font-normal">{u}</span></span>
              </div>
            ))}
          </div>
          {delta != null && Math.abs(delta) > 0.005 && (
            <div className="bg-indigo-50 border border-indigo-200 rounded px-3 py-2 space-y-0.5">
              <div className="text-xs font-semibold text-indigo-600 mb-1">本次調整影響</div>
              <div className="flex justify-between text-xs">
                <span className="text-gray-500">全案容積變化</span>
                <span className={`font-semibold ${delta>0?'text-red-600':'text-green-600'}`}>{delta>0?'+':''}{fmt(delta)} ㎡</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 目前樓層檢核 */}
      <div className={cardCls}>
        <div className={cardH}><h3 className="text-xs font-semibold text-gray-600">即時檢核摘要</h3></div>
        <div className="p-3 space-y-2">
          <div className="text-xs font-semibold text-gray-500">A. 目前樓層：{def?.name}</div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
            {[['當層容積',fmt(curStats.farArea)],['樓地板',fmt(curStats.floorArea)],['陽台',fmt(curStats.privateBalcony)],['梯廳',fmt(curStats.hallArea)]].map(([l,v]) => (
              <div key={l} className="flex justify-between py-0.5 border-b border-gray-100">
                <span className="text-xs text-gray-500">{l}</span>
                <span className="text-xs font-semibold text-gray-700">{v} ㎡</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 大總表摘要 */}
      <div className={cardCls}>
        <div className={cardH}>
          <h3 className="text-xs font-semibold text-gray-600">大總表摘要預覽</h3>
          <span className="text-xs text-yellow-600 bg-yellow-50 border border-yellow-200 rounded px-1.5 py-0.5">非正式格式</span>
        </div>
        <div className="p-2 overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr>
              <th className={th}>樓層</th><th className={th}>樓地板</th><th className={th}>陽台</th><th className={th}>容積</th>
            </tr></thead>
            <tbody>
              {summaryRows.map(row => {
                const isAct = row.floorId === activeFloorId
                return (
                  <tr key={row.floorId} className={isAct?'bg-blue-100':''}>
                    <td className={`${td} text-center font-medium ${isAct?'text-blue-700':''}`}>{row.floorName}{row.isOverridden?<span className="ml-0.5 text-amber-500 text-xs">✎</span>:null}</td>
                    <td className={td}>{cell(row.floorArea)}</td>
                    <td className={td}>{cell(row.balconyArea)}</td>
                    <td className={`${td} ${isAct?'text-blue-700 font-semibold':''}`}>{cell(row.floorVolume)}</td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot><tr className="bg-gray-100 font-semibold">
              <td className={`${td} text-center`}>合計</td>
              <td className={td}>{fmt(summaryRows.reduce((s,r)=>s+r.floorArea,0))}</td>
              <td className={td}>{fmt(summaryRows.reduce((s,r)=>s+r.balconyArea,0))}</td>
              <td className={td}>{fmt(summaryRows.reduce((s,r)=>s+r.floorVolume,0))}</td>
            </tr></tfoot>
          </table>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────
// PLACEHOLDER PANEL
// ─────────────────────────────────────────────

function PlaceholderPanel({ stepId }: { stepId: string }) {
  const item = MENU_ITEMS.find(m => m.id === stepId)
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="text-center">
        <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-4">
          {'step' in (item ?? {}) ? <span className="text-2xl font-bold text-gray-400">{(item as any).step}</span>
            : <svg className="w-7 h-7 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>}
        </div>
        <h3 className="text-sm font-semibold text-gray-600 mb-1">{item?.label ?? '功能頁面'}</h3>
        <p className="text-xs text-gray-400">此頁面於後續版本開放</p>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────
// WORKBENCH PAGE (main)
// ─────────────────────────────────────────────

interface Props {
  projectId: string
  session: AuthSession
  onBack: () => void
}

export default function WorkbenchPage({ projectId, session, onBack }: Props) {
  const [project,       setProject]       = useState<Project | null>(null)
  const [floorsById,    setFloorsById]    = useState<FloorsById>({})
  const [activeMenu,    setActiveMenu]    = useState('3')
  const [activeFloorId, setActiveFloorId] = useState('5F')
  const [savedAt,       setSavedAt]       = useState('')
  const [showCopyModal, setShowCopyModal] = useState(false)
  const [loading,       setLoading]       = useState(true)
  const contentRef = useRef<HTMLDivElement>(null)

  // ── 初始載入 ──
  useEffect(() => {
    Promise.all([
      projectService.getProjectById(projectId),
      projectService.getFloorsById(projectId),
    ]).then(([pRes, fRes]) => {
      if (pRes.data) setProject(pRes.data)
      if (fRes.data) setFloorsById(fRes.data)
      setLoading(false)
      setSavedAt(new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }))
    })
  }, [projectId])

  // ── 自動儲存（floorsById 變動時）──
  useEffect(() => {
    if (loading) return
    const timer = setTimeout(async () => {
      await projectService.saveFloorsById(projectId, floorsById)
      setSavedAt(new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }))
    }, 800)
    return () => clearTimeout(timer)
  }, [floorsById, projectId, loading])

  // ── 當層 patch（只改 activeFloorId）──
  const patchCurrentFloor = useCallback((patch: Partial<FloorsById[string]>) => {
    setFloorsById(prev => {
      const current = prev[activeFloorId]
      const shouldMarkOverride = current.sourceFloor && !current.isOverridden
      return {
        ...prev,
        [activeFloorId]: {
          ...current,
          ...patch,
          isOverridden: shouldMarkOverride ? true : current.isOverridden,
        },
      }
    })
  }, [activeFloorId])

  const handlePrivateChange  = (items: PrivateItem[]) => patchCurrentFloor({ privateItems: items })
  const handleSharedChange   = (items: SharedItem[])  => patchCurrentFloor({ sharedItems:  items })

  const handleCopy = (sourceId: string, targetIds: string[]) => {
    setFloorsById(prev => {
      const sourceData = prev[sourceId]
      const next = { ...prev }
      targetIds.forEach(tid => {
        next[tid] = {
          ...deepClone(prev[tid]),
          privateItems: deepClone(sourceData.privateItems).map((p: PrivateItem, i: number) => ({ ...p, id: `${tid}_p${i}` })),
          sharedItems:  deepClone(sourceData.sharedItems ).map((s: SharedItem,  i: number) => ({ ...s, id: `${tid}_cs${i}` })),
          sourceFloor:  sourceId,
          isOverridden: false,
        }
      })
      return next
    })
  }

  const addPrivateRow = () => {
    const newId = `${activeFloorId}_new_${Date.now()}`
    handlePrivateChange([...(floorsById[activeFloorId]?.privateItems ?? []), { id: newId, unit:'', use:'住宅', indoor:0, balcony:0, balconyOver:0, subtotal:0, note:'-' }])
  }
  const addSharedRow = () => {
    const newId = `${activeFloorId}_new_${Date.now()}`
    handleSharedChange([...(floorsById[activeFloorId]?.sharedItems ?? []), { id: newId, name:'', area:0, inFloor:'是', inFAR:'免計判斷', rule:'第162條', note:'-' }])
  }

  const navTo = (idx: number) => {
    if (idx >= 0 && idx < FLOOR_DEFINITIONS.length) {
      setActiveFloorId(FLOOR_DEFINITIONS[idx].id)
      contentRef.current?.scrollTo(0, 0)
    }
  }

  if (loading || !project) {
    return <div className="h-screen flex items-center justify-center text-gray-400 text-sm">載入專案資料中...</div>
  }

  const floorIndex = FLOOR_DEFINITIONS.findIndex(d => d.id === activeFloorId)
  const def        = FLOOR_DEFINITIONS[floorIndex]
  const floorData  = floorsById[activeFloorId]
  const stats      = computeFloorStats(floorData)

  const cardCls = "bg-white border border-gray-200 rounded-lg mb-4"
  const cardH   = "flex items-center justify-between px-4 py-2.5 border-b border-gray-100 bg-gray-50 rounded-t-lg"

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <TopBar
        project={project} session={session} savedAt={savedAt}
        onExportPDF={()   => alert('PDF 匯出功能接入後啟用')}
        onExportExcel={()  => alert('Excel 匯出功能接入後啟用')}
        onValidate={()    => alert('檢核完成：請查看右側全案即時總檢核區塊')}
        onBack={onBack}
      />

      <div className="flex flex-1 overflow-hidden">
        <Sidebar activeId={activeMenu} onSelect={setActiveMenu} />

        {activeMenu === '3' ? (
          <div className="flex-1 flex flex-col overflow-hidden">
            <FloorTabs floorsById={floorsById} activeFloorId={activeFloorId}
              onSelect={id => { setActiveFloorId(id); contentRef.current?.scrollTo(0,0) }} />
            <FloorSummaryBar
              floorId={activeFloorId} floorDef={def} floorData={floorData} stats={stats}
              floorIndex={floorIndex} onPrev={()=>navTo(floorIndex-1)} onNext={()=>navTo(floorIndex+1)}
            />
            <div ref={contentRef} className="flex-1 overflow-y-auto p-4">
              <div className="mb-4">
                <div className="flex items-baseline gap-3 mb-3">
                  <h2 className="text-base font-bold text-gray-800">
                    {def.name}
                    {floorData.isOverridden && <span className="ml-2 text-sm bg-amber-100 border border-amber-300 text-amber-700 rounded px-2 py-0.5 font-medium">已覆寫</span>}
                  </h2>
                  <span className="text-sm text-gray-500">各層面積明細</span>
                  <span className="ml-auto flex items-center gap-1 text-xs text-blue-600 bg-blue-50 border border-blue-200 rounded px-2 py-0.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-500 inline-block"/>步驟 3／10
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => setShowCopyModal(true)} className="px-3 py-1.5 text-xs border border-gray-300 rounded text-gray-600 hover:bg-gray-50">複製本層到其他樓層</button>
                  <button onClick={() => alert('匯入 Excel 功能開發中')} className="px-3 py-1.5 text-xs border border-gray-300 rounded text-gray-600 hover:bg-gray-50">匯入 Excel</button>
                  <button onClick={addPrivateRow} className="px-3 py-1.5 text-xs border border-blue-300 rounded text-blue-600 bg-blue-50 hover:bg-blue-100">＋ 新增戶別</button>
                  <button onClick={addSharedRow}  className="px-3 py-1.5 text-xs border border-blue-300 rounded text-blue-600 bg-blue-50 hover:bg-blue-100">＋ 新增共用項目</button>
                </div>
              </div>

              <div className={cardCls}>
                <div className={cardH}>
                  <h3 className="text-sm font-semibold text-gray-700">
                    <span className="inline-block w-5 h-5 rounded bg-blue-600 text-white text-xs text-center leading-5 mr-1.5 font-bold">A</span>專有部份
                  </h3>
                  <span className="text-xs text-gray-400">{floorData.privateItems.length} 筆</span>
                </div>
                <div className="p-3"><PrivateAreaTable rows={floorData.privateItems} onChange={handlePrivateChange}/></div>
              </div>

              <div className={cardCls}>
                <div className={cardH}>
                  <h3 className="text-sm font-semibold text-gray-700">
                    <span className="inline-block w-5 h-5 rounded bg-teal-600 text-white text-xs text-center leading-5 mr-1.5 font-bold">B</span>共用部份
                  </h3>
                  <span className="text-xs text-gray-400">{floorData.sharedItems.length} 筆</span>
                </div>
                <div className="p-3"><SharedAreaTable rows={floorData.sharedItems} onChange={handleSharedChange}/></div>
              </div>

              <AutoCheckCard stats={stats} />
            </div>

            {showCopyModal && (
              <CopyToFloorsModal
                sourceDef={def} floorsById={floorsById}
                onCopy={handleCopy} onClose={() => setShowCopyModal(false)}
              />
            )}
          </div>
        ) : (
          <PlaceholderPanel stepId={activeMenu} />
        )}

        <RightPanel floorsById={floorsById} activeFloorId={activeFloorId} projectInfo={project.projectInfo} />
      </div>
    </div>
  )
}
