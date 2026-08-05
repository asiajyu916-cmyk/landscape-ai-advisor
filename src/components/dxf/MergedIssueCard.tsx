// ── MergedIssueCard.tsx — 分區審查「重複問題合併」主要問題卡 ─────────────────
// 目的：同分區＋同根本原因＋空間位置接近的多組配對，合併成一張卡，不再因為
// 植物配對數量產生大量卡片。合併運算本身完全沿用既有、已在 PDF 匯出驗證過的
// dxfReportBuilder.ts clusterZoneEvents()（同分區＋同 primaryBucket＋距離門檻或
// 共用實例），這裡只是把同一份資料改用互動卡片呈現，不重新設計合併規則。
//
// 文字結構固定五段：結論／主要原因／影響範圍／建議處理／判讀依據——判讀依據
// 預設收合，且完全由既有 EventGroup 的 primaryBucket／mergeReason／pairCount
// 組成，不產生新的判斷邏輯，只是把「為什麼會合併成這張卡」的依據攤開給使用者看。

import { useState } from 'react'
import { ChevronDown, MapPin } from 'lucide-react'
import { BUCKET_LABEL, type EventGroup } from '@/utils/dxfReportBuilder'
import type { PlantConflictResult } from '@/types/dxf'
import type { AltSuggestion } from '@/utils/plantEvaluator'
import ProximityConflictCard from './ProximityConflictCard'

const SEVERITY_META: Record<EventGroup['maxSeverity'], { label: string; badge: string; bar: string }> = {
  danger:  { label: '嚴重', badge: 'bg-red-100 text-red-700 border-red-300',   bar: 'bg-red-500' },
  caution: { label: '提醒', badge: 'bg-blue-100 text-blue-700 border-blue-300', bar: 'bg-blue-400' },
}

const MERGE_REASON_LABEL: Record<EventGroup['mergeReason'], string> = {
  'shared-instance': '多組配對共用同一株植物或同一圖層，判定為同一根本原因',
  distance: '多組配對位置相鄰（中心點距離 300cm 內），判定為同一根本原因',
  single: '僅一組配對，未與其他問題合併',
}

interface Props {
  group: EventGroup
  /** 該分區全部配對，元件自行用 group.sourceConflictIds 篩出展開後的詳細配對 */
  conflicts: PlantConflictResult[]
  onLocate?: (conflict: PlantConflictResult) => void
  alternatives?: AltSuggestion[]
  defaultShowDetail?: boolean
}

export default function MergedIssueCard({ group, conflicts, onLocate, alternatives, defaultShowDetail = false }: Props) {
  const [showDetail, setShowDetail] = useState(defaultShowDetail)
  const [showBasis, setShowBasis] = useState(false)
  const meta = SEVERITY_META[group.maxSeverity]
  const detailConflicts = conflicts.filter(c => group.sourceConflictIds.includes(c.id))

  const basis = `依「${BUCKET_LABEL[group.primaryBucket]}」判定為主要原因`
    + (group.secondaryBuckets.length > 0 ? `，另涉及${group.secondaryBuckets.map(b => BUCKET_LABEL[b]).join('、')}` : '')
    + `；${MERGE_REASON_LABEL[group.mergeReason]}，共合併 ${group.pairCount} 組配對。`

  return (
    <div className="bg-white rounded-2xl border border-stone-200 overflow-hidden">
      <div className={`h-1 ${meta.bar}`} />
      <div className="p-4 space-y-2.5">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-sm font-mono text-stone-400">{group.id}</span>
            <span className={`text-sm px-2 py-0.5 rounded-full border font-semibold ${meta.badge}`}>{meta.label}</span>
          </div>
          <span className="text-sm text-stone-400">涉及配置 {group.pairCount} 組</span>
        </div>

        {/* 結論 */}
        <p className="text-xl font-bold text-stone-800 leading-relaxed">{group.title}</p>
        <p className="text-base text-stone-500">涉及植物：{group.plantNames.join('、')}</p>

        {/* 主要原因：互動網頁不受紙本版面限制，用未截斷的 *Full 欄位 */}
        <div>
          <p className="text-sm font-semibold text-stone-400 mb-0.5">主要原因</p>
          <p className="text-base text-stone-700">{group.causeFull}</p>
        </div>

        {/* 影響範圍 */}
        <div>
          <p className="text-sm font-semibold text-stone-400 mb-0.5">影響範圍</p>
          <p className="text-base text-stone-700">{group.impactFull}（{group.locationCodes.join('、')}）</p>
        </div>

        {/* 建議處理 */}
        <div>
          <p className="text-sm font-semibold text-stone-400 mb-0.5">建議處理</p>
          <p className="text-base text-green-700 font-medium">{group.suggestionFull}</p>
        </div>

        <div className="flex items-center gap-4 pt-1 flex-wrap">
          {onLocate && detailConflicts[0] && (
            <button onClick={() => onLocate(detailConflicts[0])} className="text-sm font-semibold text-[#1a4731] hover:underline flex items-center gap-1">
              <MapPin size={13} /> 在圖面定位
            </button>
          )}
          <button onClick={() => setShowBasis(v => !v)} className="text-sm font-semibold text-stone-500 hover:text-stone-700 flex items-center gap-1">
            判讀依據 <ChevronDown size={13} className={`transition-transform ${showBasis ? 'rotate-180' : ''}`} />
          </button>
          {group.pairCount > 1 && (
            <button onClick={() => setShowDetail(v => !v)} className="text-sm font-semibold text-stone-500 hover:text-stone-700 flex items-center gap-1">
              展開 {group.pairCount} 組詳細配對 <ChevronDown size={13} className={`transition-transform ${showDetail ? 'rotate-180' : ''}`} />
            </button>
          )}
        </div>

        {/* 判讀依據：預設收合 */}
        {showBasis && (
          <p className="text-sm text-stone-500 bg-stone-50 border border-stone-100 rounded-lg px-3 py-2">{basis}</p>
        )}

        {/* 展開後才顯示各組詳細配對 */}
        {showDetail && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2 mt-1 border-t border-stone-100">
            {detailConflicts.map(c => (
              <ProximityConflictCard key={c.id} conflict={c} onLocate={onLocate} alternatives={alternatives} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
