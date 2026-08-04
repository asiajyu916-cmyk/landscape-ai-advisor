// ── AIReviewSummary.tsx — DXF 審查結果頁頂部「AI 審查結論」卡 ───────────────────
// 純顯示元件：資料由 aiReviewNarrative.ts 的 generateReviewSummary() 從既有審查結果
// 動態算出，這裡不做任何判斷邏輯，只負責排版。預設精簡顯示（結論一句話＋統計），
// 展開後才看到主要風險／優先處理區域／建議處理順序的完整內容。

import { useState } from 'react'
import { Sparkles, ChevronDown, ChevronUp, Wand2 } from 'lucide-react'
import type { ReviewSummary } from '@/utils/aiReviewNarrative'

interface Props {
  summary: ReviewSummary
  /** 點選優先處理區域時跳到對應分區 tab */
  onSelectZone?: (zoneName: string) => void
  /** 「讓 AI 產生修正方案」主要操作按鈕；不傳就不顯示按鈕（例如完全沒有問題時） */
  onGenerateFixPlan?: () => void
}

export default function AIReviewSummary({ summary, onSelectZone, onGenerateFixPlan }: Props) {
  const [expanded, setExpanded] = useState(false)
  const { overallConclusion, topRisks, priorityZones, suggestedOrder, stats } = summary

  return (
    <div className="rounded-2xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-[#f7faf5] overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-start gap-3 px-5 py-4 text-left"
      >
        <div className="w-9 h-9 rounded-xl bg-emerald-600 flex items-center justify-center flex-shrink-0 mt-0.5">
          <Sparkles size={18} className="text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <p className="text-base font-bold text-stone-800">AI 審查結論</p>
            {stats.totalDanger > 0 && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-semibold">嚴重 {stats.totalDanger}</span>
            )}
            {stats.totalCaution > 0 && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-semibold">提醒 {stats.totalCaution}</span>
            )}
            <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-semibold">通過 {stats.totalPassed}</span>
          </div>
          <p className="text-sm text-stone-700 leading-relaxed">{overallConclusion}</p>
        </div>
        <div className="flex-shrink-0 text-stone-400 mt-1.5">
          {expanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </div>
      </button>

      {expanded && (
        <div className="px-5 pb-5 space-y-4 border-t border-emerald-100 pt-4">
          {topRisks.length > 0 && (
            <div>
              <p className="text-xs font-bold text-stone-500 mb-1.5 tracking-wide">主要風險</p>
              <div className="flex flex-wrap gap-2">
                {topRisks.map(r => (
                  <span key={r.category} className="text-sm px-3 py-1 rounded-full bg-white border border-stone-200 text-stone-700">
                    {r.label}
                    <span className={`ml-1.5 font-semibold ${r.dangerCount > 0 ? 'text-red-600' : 'text-blue-600'}`}>{r.count} 項</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {priorityZones.length > 0 && (
            <div>
              <p className="text-xs font-bold text-stone-500 mb-1.5 tracking-wide">優先處理區域</p>
              <div className="space-y-1.5">
                {priorityZones.map(z => (
                  <button
                    key={z.zoneName}
                    type="button"
                    onClick={() => onSelectZone?.(z.zoneName)}
                    disabled={!onSelectZone}
                    className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-white border border-stone-200 text-left hover:border-emerald-300 hover:bg-emerald-50/50 transition-colors disabled:cursor-default disabled:hover:border-stone-200 disabled:hover:bg-white"
                  >
                    <span className="text-sm font-bold text-stone-800">{z.zoneName}</span>
                    <span className="text-xs text-stone-500">{z.reason}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {suggestedOrder.length > 0 && (
            <div>
              <p className="text-xs font-bold text-stone-500 mb-1.5 tracking-wide">AI 建議處理順序</p>
              <ol className="space-y-1">
                {suggestedOrder.map((s, i) => (
                  <li key={i} className="text-sm text-stone-700 flex items-start gap-2">
                    <span className="w-5 h-5 rounded-full bg-emerald-100 text-emerald-700 text-xs font-bold flex items-center justify-center flex-shrink-0 mt-0.5">{i + 1}</span>
                    {s}
                  </li>
                ))}
              </ol>
            </div>
          )}

          {onGenerateFixPlan && (
            <button
              type="button"
              onClick={onGenerateFixPlan}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#1a4731] text-white text-sm font-semibold hover:bg-[#2d6a4f] transition-colors"
            >
              <Wand2 size={15} />
              讓 AI 產生修正方案
            </button>
          )}
        </div>
      )}
    </div>
  )
}
