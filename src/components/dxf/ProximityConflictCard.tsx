// ── ProximityConflictCard.tsx — 一組植物一張卡片 ────────────────────────────────
// 一張卡片＝一組空間鄰近的植物配對（PlantConflictResult 本來就是這樣，一組植物不會
// 重複產生多筆）。植物名稱／HATCH／空間關係／距離無論收合或展開都固定顯示；主要
// 內容以「目前強調的分類」（emphasizeCategory，由父層依目前分類篩選傳入，未篩選時
// 用這組配對本身風險最高的分類）為主，其餘 3 個分類收成一行「其他檢核」小摘要，
// 只有真的有問題的分類才在展開區顯示完整內容，正常的分類只留一行文字，不再各自
// 建一張完整子卡片。
//
// 內容層級（AI 顧問化改版）：1.問題名稱 2.問題位置 3.AI判斷（generateIssueJudgement，
// 一句結論）4.判斷依據 5.建議處理方式 6.替代方案（若有）7.相關植栽與條件標籤。
// AI 判斷／判斷依據／建議處理都是從既有 issues 資料整理出來的文字，不是新的判斷
// 邏輯——見 aiReviewNarrative.ts 檔頭說明。

import { useState } from 'react'
import { MapPin, ChevronDown, ChevronUp, Sparkles } from 'lucide-react'
import type { PlantConflictResult, RiskLevel } from '@/types/dxf'
import type { AltSuggestion } from '@/utils/plantEvaluator'
import {
  classifyCategory, CATEGORY_GROUP_META, buildCategoryResults, pickPrimaryCategory,
  type IssueCategoryGroup, type Severity,
} from '@/utils/issueCategoryMeta'
import { generateIssueJudgement, deduplicateReviewText } from '@/utils/aiReviewNarrative'

interface Props {
  conflict: PlantConflictResult
  /** 「在圖面定位」需要 DxfReviewPage 的圖面畫布——沒有畫布可定位的情境（如 AI 配植
   * 評估頁的分區檢視）不傳這個 prop，按鈕就不會顯示 */
  onLocate?: (conflict: PlantConflictResult) => void
  defaultExpanded?: boolean
  /** 目前分類篩選（非「全部」時），有指定就強調這個分類的內容，取代自動判斷的主分類 */
  emphasizeCategory?: IssueCategoryGroup
  /** 本分區的替代植栽建議（zone.evalResult.alternatives）；用配對雙方植物名稱比對，
   * 找不到相關建議時「替代方案」區塊整段不顯示（不留空標題）。沒有傳這個 prop 的
   * 情境（例如舊呼叫端）也一樣不顯示，行為不變。 */
  alternatives?: AltSuggestion[]
}

// 色彩統一：嚴重＝紅、提醒＝藍、通過＝綠（見 compatibilityLevels.ts 的 GAP_SEVERITY_COLOR）
const RISK_BADGE: Record<RiskLevel, { label: string; cls: string }> = {
  high:      { label: '嚴重',   cls: 'bg-red-100 text-red-700 border-red-300' },
  medium:    { label: '提醒',   cls: 'bg-blue-100 text-blue-700 border-blue-300' },
  low:       { label: '通過',   cls: 'bg-emerald-100 text-emerald-700 border-emerald-300' },
  unmatched: { label: '未辨識', cls: 'bg-stone-100 text-stone-600 border-stone-300' },
}

const SEVERITY_LABEL: Record<Severity, string> = { high: '嚴重', warning: '提醒', normal: '正常' }
const SEVERITY_TEXT_CLS: Record<Severity, string> = {
  high: 'text-red-600 font-bold', warning: 'text-blue-600 font-bold', normal: 'text-stone-400',
}
const SEVERITY_BG_CLS: Record<Severity, string> = {
  high: 'bg-red-50', warning: 'bg-blue-50', normal: 'bg-stone-50',
}

function relationshipText(c: PlantConflictResult): string {
  if (c.proximity === 'overlap') return '範圍重疊'
  if (c.proximity === 'touching') return '邊界相接'
  return c.nearBand === 'adjacent' ? '鄰近－直接相鄰' : '鄰近－可能影響'
}

const JUDGEMENT_CLS: Record<Severity, string> = {
  high: 'text-red-700', warning: 'text-blue-700', normal: 'text-stone-600',
}

export default function ProximityConflictCard({ conflict: c, onLocate, defaultExpanded = false, emphasizeCategory, alternatives }: Props) {
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

  // 1 個判斷函式產生「AI 判斷」＋「判斷依據」＋「建議處理方式」三段文字，都是從
  // 既有 issues 資料組出來的（見 aiReviewNarrative.ts），不是新的相容性判斷。
  const judgement = generateIssueJudgement(c)
  const dedupedDetail = isUnmatched ? [] : deduplicateReviewText([
    { label: '__headline', text: primaryTitle },
    { label: '判斷依據', text: judgement.basis },
    { label: '建議處理方式', text: judgement.action },
  ]).filter(p => p.label !== '__headline')

  // 6. 替代方案：只在配對雙方任一株有相關建議、且建議清單非空時顯示，避免留空標題
  const relevantAlts = !isUnmatched && alternatives
    ? [c.plantA.name, c.plantB.name]
        .map(name => alternatives.find(a => a.originalPlant.name === name))
        .filter((a): a is AltSuggestion => !!a && a.alternatives.length > 0)
    : []

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

            {/* 1. 問題名稱 */}
            <p className="text-lg font-bold text-stone-800 leading-relaxed mb-1">{primaryTitle}</p>

            {/* 2. 問題位置／分區 + 植物名稱／HATCH／空間關係／距離：收合或展開都固定顯示 */}
            <p className="text-sm text-stone-500 mb-1">{c.locationLabel}</p>
            <p className="text-sm text-stone-500 mb-3">
              {c.plantA.name} × {c.plantB.name}｜HATCH {c.plantA.label} × {c.plantB.label}｜{relationshipText(c)}｜最近距離 {c.distanceCm} cm
            </p>

            {/* 3. AI 判斷：一句結論，卡片只突出這個核心結論 */}
            <div className={`flex items-start gap-1.5 mb-3 ${JUDGEMENT_CLS[isUnmatched ? 'normal' : primaryResult.severity]}`}>
              <Sparkles size={15} className="flex-shrink-0 mt-0.5" />
              <p className="text-base font-bold leading-relaxed">{judgement.headline}</p>
            </div>

            {/* 7. 相關植栽及條件標籤（次要，降低對比） */}
            {!isUnmatched && primaryResult.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-3">
                {primaryResult.tags.map(tag => (
                  <span key={tag} className="text-sm px-2.5 py-0.5 rounded-full bg-stone-100 text-stone-500 font-medium">
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
                  {/* 4-5. 判斷依據／建議處理方式（已去重，相同或高度相似的句子只留一次） */}
                  {dedupedDetail.length > 0 && (
                    <div className="space-y-1.5">
                      {dedupedDetail.map(p => (
                        <p key={p.label} className="text-base text-stone-700 leading-relaxed line-clamp-3">
                          <strong className="text-stone-500 font-semibold">{p.label}：</strong>{p.text}
                        </p>
                      ))}
                    </div>
                  )}

                  {/* 6. 替代方案（找不到相關建議時整段不顯示） */}
                  {relevantAlts.length > 0 && (
                    <div>
                      <p className="text-sm font-semibold text-stone-500 mb-1.5">替代方案</p>
                      <div className="space-y-2">
                        {relevantAlts.map(alt => (
                          <div key={alt.originalPlant.instanceId} className="rounded-lg bg-emerald-50/70 p-2.5">
                            <p className="text-sm font-bold text-stone-700">{alt.originalPlant.name} 可考慮替換為</p>
                            <ul className="mt-1 space-y-0.5">
                              {alt.alternatives.slice(0, 3).map((o, i) => (
                                <li key={i} className="text-sm text-stone-600">
                                  <span className="font-medium text-emerald-700">{o.plant.name}</span>
                                  {o.reason && <span className="text-stone-500">　{o.reason}</span>}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div>
                    <p className="text-sm font-semibold text-stone-500 mb-1.5">其他檢核</p>
                    <div className="space-y-2">
                      {otherResults.map(r => (
                        <div key={r.category} className={`rounded-lg p-2.5 ${SEVERITY_BG_CLS[r.severity]}`}>
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

              {onLocate && (
                <button
                  type="button"
                  onClick={() => onLocate(c)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-stone-300 bg-white text-base font-medium text-stone-600 hover:bg-stone-50"
                >
                  <MapPin size={14} />在圖面定位
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
