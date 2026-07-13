// ── PlantAutoAddModal.tsx — 新增植栽資料確認視窗 ──────────────────────────────
// 顯示 /api/plant-search 的搜尋結果，使用者確認後才寫入植栽資料庫。
// 三個操作：確認新增並納入評估 / 編輯後新增 / 略過。

import { useState } from 'react'
import { X, CheckCircle, AlertTriangle, HelpCircle, ExternalLink, Pencil } from 'lucide-react'
import type { CsvPlantRecord } from '@/types/csvPlant'
import type { DraftPlantRecord, PlantSearchResult, FieldVerificationStatus } from '@/types/plantSearch'
import { PLANT_SEARCH_FIELD_LABELS, PLANT_DATA_SOURCE_LABELS } from '@/types/plantSearch'

interface Props {
  queryName: string
  result: PlantSearchResult
  draft: DraftPlantRecord
  onConfirm: (record: CsvPlantRecord) => void
  onSkip: () => void
  onClose: () => void
}

function StatusBadge({ status }: { status: FieldVerificationStatus }) {
  if (status === 'official_confirmed') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 text-[11px] font-medium">
        <CheckCircle size={10} />官方確認
      </span>
    )
  }
  if (status === 'inferred') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-700 text-[11px] font-medium">
        <AlertTriangle size={10} />推論
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-stone-100 border border-stone-200 text-stone-400 text-[11px] font-medium">
      <HelpCircle size={10} />資料不足
    </span>
  )
}

function FieldRow({ label, value, status, note }: { label: string; value: string; status: FieldVerificationStatus; note?: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2 border-b border-stone-100 last:border-0">
      <div className="flex-shrink-0 w-24 text-xs text-stone-500 pt-0.5">{label}</div>
      <div className="flex-1 min-w-0">
        <p className={`text-sm ${value ? 'text-stone-800' : 'text-stone-300 italic'}`}>
          {value || '（無資料）'}
        </p>
        {note && <p className="text-[11px] text-stone-400 mt-0.5">{note}</p>}
      </div>
      <div className="flex-shrink-0"><StatusBadge status={status} /></div>
    </div>
  )
}

export default function PlantAutoAddModal({ queryName, result, draft, onConfirm, onSkip, onClose }: Props) {
  const [editing, setEditing] = useState(false)
  const [edited, setEdited] = useState<CsvPlantRecord>(draft)

  const f = result.fields
  const missingCount = result.missingFieldKeys.length
  const fieldOrder: Array<keyof typeof f> = [
    'plantType', 'sunRequirement', 'waterRequirement', 'droughtTolerance', 'wetTolerance',
    'drainageRequirement', 'soilRequirement', 'height', 'crownWidth', 'soilDepth',
    'plantingSpacing', 'flowerPeriod', 'flowerColor', 'deciduous', 'deciduousLevel',
    'flowerDropRisk', 'maintenanceNote', 'maintenanceRisk',
  ]

  const setField = (k: keyof CsvPlantRecord, v: string) => setEdited(prev => ({ ...prev, [k]: v }))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-5 border-b border-stone-200">
          <div>
            <h3 className="text-lg font-bold text-stone-800">新增植栽資料確認</h3>
            <p className="text-xs text-stone-400 mt-1">
              圖面辨識到「{queryName}」，植栽資料庫查無此植物，已自動搜尋官方資料
            </p>
            <span className="inline-flex items-center gap-1 mt-2 px-2 py-0.5 rounded-full bg-stone-100 border border-stone-200 text-stone-600 text-[11px] font-medium">
              資料來源：{PLANT_DATA_SOURCE_LABELS[result.dataSource]}
            </span>
          </div>
          <button onClick={onClose} className="text-stone-300 hover:text-stone-500 flex-shrink-0">
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {/* 名稱 / 學名 / 分類 */}
          <div className="mb-4 p-4 bg-stone-50 rounded-2xl border border-stone-200">
            {editing ? (
              <div className="space-y-2">
                <input value={edited.name} onChange={e => setField('name', e.target.value)}
                  className="w-full px-3 py-1.5 border border-stone-300 rounded-lg text-sm font-semibold"
                  placeholder="植物名稱" />
                <input value={edited.scientificName} onChange={e => setField('scientificName', e.target.value)}
                  className="w-full px-3 py-1.5 border border-stone-300 rounded-lg text-sm italic"
                  placeholder="學名" />
              </div>
            ) : (
              <>
                <p className="text-base font-bold text-stone-800">{edited.name}</p>
                {edited.scientificName && <p className="text-sm text-stone-400 italic">{edited.scientificName}</p>}
                {result.aliases.length > 0 && (
                  <p className="text-xs text-stone-400 mt-1">別名：{result.aliases.join('、')}</p>
                )}
              </>
            )}
          </div>

          {/* 整體信心度 */}
          <div className="mb-4 flex items-center gap-3 flex-wrap">
            <StatusBadge status={result.overallStatus} />
            <span className="text-xs text-stone-500">整體信心度 {result.overallConfidence}%</span>
            {missingCount > 0 && (
              <span className="text-xs text-amber-600">
                {missingCount} 個欄位資料不足，需人工確認
              </span>
            )}
          </div>

          {/* 逐欄位資料 */}
          <div className="mb-4 bg-white rounded-2xl border border-stone-200 px-4">
            {fieldOrder.map(k => {
              const fv = f[k]
              if (!fv) return null
              return (
                <FieldRow key={String(k)}
                  label={PLANT_SEARCH_FIELD_LABELS[k]}
                  value={fv.value}
                  status={fv.status}
                  note={fv.note}
                />
              )
            })}
          </div>

          {/* 資料來源 */}
          <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-2xl">
            <p className="text-xs font-semibold text-blue-800 mb-1">資料來源</p>
            <p className="text-sm text-blue-700">{result.dataSourceName || '（未取得來源名稱）'}</p>
            {result.dataSourceUrl && (
              <a href={result.dataSourceUrl} target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline mt-1">
                {result.dataSourceUrl}<ExternalLink size={10} />
              </a>
            )}
            <p className="text-[11px] text-blue-400 mt-2">
              擷取時間：{new Date(result.retrievedAt).toLocaleString('zh-TW')}
            </p>
            {result.citedSources && result.citedSources.length > 1 && (
              <div className="mt-2 pt-2 border-t border-blue-100">
                <p className="text-[11px] text-blue-400 mb-1">其他引用來源：</p>
                {result.citedSources.slice(1).map((s, i) => (
                  <a key={i} href={s.url} target="_blank" rel="noreferrer"
                    className="block text-[11px] text-blue-500 hover:underline truncate">
                    {s.name || s.url}
                  </a>
                ))}
              </div>
            )}
          </div>

          {/* 照片提示 */}
          <div className="p-3 bg-stone-50 border border-stone-200 rounded-xl text-xs text-stone-400">
            照片將先留空（placeholder），新增後可至植栽資料庫或補圖管理另行補上。
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-stone-200 flex items-center justify-between gap-3 flex-wrap">
          <button onClick={onSkip}
            className="px-4 py-2 text-sm text-stone-500 hover:text-stone-700 font-medium">
            略過
          </button>
          <div className="flex items-center gap-2">
            {!editing ? (
              <button onClick={() => setEditing(true)}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-stone-600 border border-stone-300 rounded-xl hover:bg-stone-50">
                <Pencil size={14} />編輯後新增
              </button>
            ) : (
              <button onClick={() => setEditing(false)}
                className="px-4 py-2 text-sm font-medium text-stone-600 border border-stone-300 rounded-xl hover:bg-stone-50">
                完成編輯
              </button>
            )}
            <button onClick={() => onConfirm(edited)}
              className="inline-flex items-center gap-1.5 px-5 py-2 text-sm font-semibold text-white bg-emerald-600 rounded-xl hover:bg-emerald-700">
              <CheckCircle size={14} />確認新增並納入評估
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
