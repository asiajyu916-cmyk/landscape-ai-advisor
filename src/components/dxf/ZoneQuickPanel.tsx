// ── ZoneQuickPanel.tsx — 分區總覽圖的「快覽面板」───────────────────────────
// 目的：點選分區總覽圖（或分區卡）後，不用離開總覽頁就能看到「這一區有哪些
// 問題」——名稱／風險等級／數量／AI 一句話摘要／問題列表，取代原本只有標題
// 的分區卡。深入查看仍走既有「查看完整分區內容」按鈕（沿用既有分區頁籤切換
// 機制，不重做）。

import { useState } from 'react'
import { ChevronDown, X } from 'lucide-react'

export interface QuickPanelIssue {
  id: string
  title: string
  level: 'danger' | 'caution' | 'passed'
  reason: string
}

interface Props {
  zoneName: string
  riskLabel: string
  dangerCount: number
  cautionCount: number
  passedCount: number
  aiOneLiner: string
  issues: QuickPanelIssue[]
  selectedIssueId?: string | null
  onSelectIssue?: (issueId: string) => void
  onViewFull?: () => void
  onClose?: () => void
}

const LEVEL_META: Record<QuickPanelIssue['level'], { label: string; cls: string; dot: string }> = {
  danger:  { label: '嚴重', cls: 'bg-red-50 text-red-700 border-red-200',       dot: 'bg-red-500' },
  caution: { label: '提醒', cls: 'bg-blue-50 text-blue-700 border-blue-200',    dot: 'bg-blue-400' },
  passed:  { label: '通過', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', dot: 'bg-emerald-500' },
}

const RISK_BADGE_CLS: Record<string, string> = {
  '嚴重': 'bg-red-100 text-red-700 border-red-300',
  '提醒': 'bg-blue-100 text-blue-700 border-blue-300',
  '通過': 'bg-emerald-100 text-emerald-700 border-emerald-300',
}

const PREVIEW_COUNT = 5

export default function ZoneQuickPanel({
  zoneName, riskLabel, dangerCount, cautionCount, passedCount, aiOneLiner,
  issues, selectedIssueId, onSelectIssue, onViewFull, onClose,
}: Props) {
  const [expanded, setExpanded] = useState(false)
  const visibleIssues = expanded ? issues : issues.slice(0, PREVIEW_COUNT)
  const hiddenCount = issues.length - visibleIssues.length

  return (
    <div className="bg-white rounded-2xl border-2 border-green-200 shadow-sm overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-stone-100 bg-green-50/50">
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold text-stone-800">{zoneName}</span>
          <span className={`text-xs px-2 py-0.5 rounded-full border font-semibold ${RISK_BADGE_CLS[riskLabel] ?? 'bg-stone-100 text-stone-500 border-stone-200'}`}>
            風險等級：{riskLabel}
          </span>
        </div>
        {onClose && (
          <button onClick={onClose} className="p-1 rounded-lg text-stone-400 hover:text-stone-600 hover:bg-stone-100" aria-label="關閉">
            <X size={16} />
          </button>
        )}
      </div>

      <div className="p-4 space-y-3">
        {/* 數量統計 */}
        <div className="flex gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-red-50 text-red-700 font-bold text-sm border border-red-100">🔴 嚴重 {dangerCount}</span>
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-blue-50 text-blue-700 font-bold text-sm border border-blue-100">🔵 提醒 {cautionCount}</span>
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-emerald-50 text-emerald-700 font-bold text-sm border border-emerald-100">🟢 通過 {passedCount}</span>
        </div>

        {/* AI 一句話摘要 */}
        <p className="text-sm text-green-700 bg-green-50 border border-green-100 rounded-lg px-3 py-2">{aiOneLiner}</p>

        {/* 問題列表 */}
        {issues.length === 0 ? (
          <p className="text-sm text-stone-400 py-2">本區沒有需要檢討的問題。</p>
        ) : (
          <div className="space-y-1.5">
            {visibleIssues.map(issue => {
              const meta = LEVEL_META[issue.level]
              const isSelected = selectedIssueId === issue.id
              return (
                <button
                  key={issue.id}
                  onClick={() => onSelectIssue?.(issue.id)}
                  className={`w-full text-left px-3 py-2 rounded-lg border transition-colors ${
                    isSelected ? 'border-green-400 bg-green-50/70 ring-1 ring-green-300' : 'border-stone-200 hover:border-stone-300 hover:bg-stone-50'
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <span className={`mt-1 inline-block w-2 h-2 rounded-full flex-shrink-0 ${meta.dot}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={`text-xs px-1.5 py-0.5 rounded border font-semibold ${meta.cls}`}>{meta.label}</span>
                        <span className="text-sm font-semibold text-stone-800 truncate">{issue.title}</span>
                      </div>
                      <p className="text-xs text-stone-500 mt-0.5 line-clamp-1">{issue.reason}</p>
                    </div>
                  </div>
                </button>
              )
            })}
            {hiddenCount > 0 && (
              <button
                onClick={() => setExpanded(true)}
                className="w-full text-center text-sm font-semibold text-green-700 hover:text-green-800 py-1.5 flex items-center justify-center gap-1"
              >
                顯示全部 {issues.length} 項 <ChevronDown size={14} />
              </button>
            )}
            {expanded && issues.length > PREVIEW_COUNT && (
              <button onClick={() => setExpanded(false)} className="w-full text-center text-sm font-medium text-stone-400 hover:text-stone-600 py-1">
                收合
              </button>
            )}
          </div>
        )}

        {onViewFull && (
          <button
            onClick={onViewFull}
            className="w-full text-center text-sm font-semibold text-white bg-[#1a4731] hover:bg-[#2d6a4f] rounded-lg py-2 transition-colors"
          >
            查看完整分區內容 →
          </button>
        )}
      </div>
    </div>
  )
}
