// ── ProximityConflictCard.tsx — 一組植物一張卡片 ────────────────────────────────
// 一張卡片＝一組空間鄰近的植物配對（PlantConflictResult 本來就是這樣，一組植物不會
// 重複產生多筆）。植物名稱／HATCH／空間關係／距離無論收合或展開都固定顯示；主要
// 內容以「目前強調的分類」（emphasizeCategory，由父層依目前分類篩選傳入，未篩選時
// 用這組配對本身風險最高的分類）為主，其餘 3 個分類收成一行「其他檢核」小摘要，
// 只有真的有問題的分類才在展開區顯示完整內容，正常的分類只留一行文字，不再各自
// 建一張完整子卡片。

import { useState } from 'react'
import { MapPin, ChevronDown, ChevronUp } from 'lucide-react'
import type { PlantConflictResult, RiskLevel } from '@/types/dxf'
import {
  classifyCategory, CATEGORY_GROUP_META, buildCategoryResults, pickPrimaryCategory,
  type IssueCategoryGroup, type Severity,
} from '@/utils/issueCategoryMeta'

interface Props {
  conflict: PlantConflictResult
  onLocate: (conflict: PlantConflictResult) => void
  defaultExpanded?: boolean
  /** 目前分類篩選（非「全部」時），有指定就強調這個分類的內容，取代自動判斷的主分類 */
  emphasizeCategory?: IssueCategoryGroup
}

const RISK_BADGE: Record<RiskLevel, { label: string; cls: string }> = {
  high:      { label: '高風險', cls: 'bg-red-100 text-red-700 border-red-300' },
  medium:    { label: '警示',   cls: 'bg-orange-100 text-orange-700 border-orange-300' },
  low:       { label: '通過',   cls: 'bg-emerald-100 text-emerald-700 border-emerald-300' },
  unmatched: { label: '未辨識', cls: 'bg-stone-100 text-stone-600 border-stone-300' },
}

const SEVERITY_LABEL: Record<Severity, string> = { high: '高風險', warning: '警示', normal: '正常' }
const SEVERITY_TEXT_CLS: Record<Severity, string> = {
  high: 'text-red-600 font-bold', warning: 'text-orange-600 font-bold', normal: 'text-stone-400',
}

function relationshipText(c: PlantConflictResult): string {
  if (c.proximity === 'overlap') return '範圍重疊'
  if (c.proximity === 'touching') return '邊界相接'
  return c.nearBand === 'adjacent' ? '鄰近－直接相鄰' : '鄰近－可能影響'
}

export default function ProximityConflictCard({ conflict: c, onLocate, defaultExpanded = false, emphasizeCategory }: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const isUnmatched = c.riskLevel === 'unmatched'

  const categoryResults = buildCategoryResults(c.issues)
  const fallbackCategory = classifyCategory(c.issues[0]?.category)
  const displayCategory = emphasizeCategory ?? pickPrimaryCategory(categoryResults, fallbackCategory)
  const primaryResult = categoryResults.find(r => r.category === displayCategory)!
  const otherResults = categoryResults.filter(r => r.category !== displayCategory)

  const meta = CATEGORY_GROUP_META[displayCategory]
  const Icon = meta.icon
  const risk = RISK_BADGE[c.riskLevel]
  const primaryTitle = isUnmatched ? '植物名稱未能比對到資料庫，無法判斷相容性' : primaryResult.title

  return (
    <div className="rounded-2xl border border-stone-200 bg-white overflow-hidden shadow-sm">
      <div className="flex items-stretch">
        {/* 左側：分類大圖示辨識區 */}
        <div className={`w-20 flex-shrink-0 flex items-center justify-center ${meta.bgCls}`}>
          <Icon size={32} className={meta.iconCls} strokeWidth={2} />
        </div>

        {/* 右側：資訊分層內容 */}
        <div className="flex-1 min-w-0">
          <button type="button" onClick={() => setExpanded(v => !v)} className="w-full text-left p-4">
            {/* 分類名稱＋風險徽章 */}
            <div className="flex items-start justify-between gap-2 mb-2">
              <span className="text-base font-bold text-stone-500">{meta.label}</span>
              <span className={`flex-shrink-0 px-2.5 py-1 rounded-full border text-sm font-bold ${risk.cls}`}>
                {risk.label}
              </span>
            </div>

            {/* 植物名稱＋HATCH／空間關係／距離：收合或展開都固定顯示 */}
            <p className="text-lg font-bold text-stone-800 mb-1">{c.plantA.name} × {c.plantB.name}</p>
            <p className="text-sm text-stone-500 mb-3">
              HATCH {c.plantA.label} × {c.plantB.label}｜{relationshipText(c)}｜最近距離 {c.distanceCm} cm
            </p>

            {/* 主要問題結論 */}
            <p className="text-lg font-bold text-stone-800 leading-relaxed mb-2">{primaryTitle}</p>

            {!isUnmatched && primaryResult.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-3">
                {primaryResult.tags.map(tag => (
                  <span key={tag} className="text-sm px-2.5 py-0.5 rounded-full bg-stone-100 text-stone-600 font-medium">
                    {tag}
                  </span>
                ))}
              </div>
            )}

            {/* 其他檢核：一行小摘要，不占版面 */}
            {!isUnmatched && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-3 text-sm">
                <span className="text-stone-400 font-medium">其他檢核</span>
                {otherResults.map(r => (
                  <span key={r.category}>
                    <span className="text-stone-500">{CATEGORY_GROUP_META[r.category].label}</span>{' '}
                    <span className={SEVERITY_TEXT_CLS[r.severity]}>{SEVERITY_LABEL[r.severity]}</span>
                  </span>
                ))}
              </div>
            )}

            <span className="inline-flex items-center gap-1 text-sm font-semibold text-green-700">
              {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              查看詳細分析
            </span>
          </button>

          {expanded && (
            <div className="px-4 pb-4 pt-2 space-y-3 border-t border-stone-100">
              {isUnmatched ? (
                <p className="text-base text-stone-500 leading-relaxed">
                  空間上確實鄰近／相接／重疊，但植物名稱未能比對到植栽資料庫，無法判斷相容性，僅記錄空間關係供人工確認。
                </p>
              ) : (
                <>
                  <div>
                    <p className="text-sm font-semibold text-stone-500 mb-1">主要問題（{meta.label}）</p>
                    {primaryResult.impact && (
                      <p className="text-base text-stone-700 mb-1 leading-relaxed"><strong>影響：</strong>{primaryResult.impact}</p>
                    )}
                    {primaryResult.recommendation && (
                      <p className="text-base text-stone-700 leading-relaxed"><strong>建議：</strong>{primaryResult.recommendation}</p>
                    )}
                  </div>

                  <div>
                    <p className="text-sm font-semibold text-stone-500 mb-1.5">其他檢核</p>
                    <div className="space-y-2">
                      {otherResults.map(r => (
                        <div key={r.category} className={`rounded-lg p-2.5 ${r.severity === 'normal' ? 'bg-stone-50' : 'bg-amber-50'}`}>
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className="text-sm font-bold text-stone-700">{CATEGORY_GROUP_META[r.category].label}</span>
                            <span className={`text-sm ${SEVERITY_TEXT_CLS[r.severity]}`}>{SEVERITY_LABEL[r.severity]}</span>
                          </div>
                          <p className="text-sm text-stone-600">{r.severity === 'normal' ? r.summary : r.title}</p>
                          {r.severity !== 'normal' && r.recommendation && (
                            <p className="text-sm text-stone-600 mt-0.5"><strong>建議：</strong>{r.recommendation}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}

              <button
                type="button"
                onClick={() => onLocate(c)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-stone-300 bg-white text-base font-medium text-stone-600 hover:bg-stone-50"
              >
                <MapPin size={14} />在圖面定位
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
