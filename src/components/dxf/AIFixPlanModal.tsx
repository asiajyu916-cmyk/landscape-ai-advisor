// ── AIFixPlanModal.tsx — 「讓 AI 產生修正方案」彈窗 ─────────────────────────────
// 顯示 generateFixPlans() 產生的三個方案（A 最小修改／B 最佳適配／C 低維護），純
// 顯示既有 evalResult.alternatives 與 proximityConflicts 資料整理後的結果，不修改
// DXF、不直接套用到審查資料——第一版只給使用者參考。

import { X, CheckCircle2, ArrowRight } from 'lucide-react'
import type { FixPlan } from '@/utils/aiReviewNarrative'

interface Props {
  zoneName: string
  plans: FixPlan[]
  recommendedId: FixPlan['id']
  recommendReason: string
  onClose: () => void
}

const PLAN_ACCENT: Record<FixPlan['id'], { ring: string; badge: string }> = {
  A: { ring: 'border-blue-300', badge: 'bg-blue-100 text-blue-700' },
  B: { ring: 'border-emerald-300', badge: 'bg-emerald-100 text-emerald-700' },
  C: { ring: 'border-violet-300', badge: 'bg-violet-100 text-violet-700' },
}

export default function AIFixPlanModal({ zoneName, plans, recommendedId, recommendReason, onClose }: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl w-full max-w-5xl max-h-[90vh] overflow-y-auto shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white border-b border-stone-200 px-6 py-4 flex items-center justify-between z-10">
          <div>
            <p className="text-lg font-bold text-stone-800">AI 修正方案｜{zoneName}</p>
            <p className="text-xs text-stone-400 mt-0.5">依現有審查結果與替代植栽資料自動整理，未直接修改圖面或審查資料</p>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-stone-100 text-stone-400 hover:text-stone-600">
            <X size={20} />
          </button>
        </div>

        <div className="p-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
          {plans.map(plan => {
            const accent = PLAN_ACCENT[plan.id]
            const isRecommended = plan.id === recommendedId
            return (
              <div
                key={plan.id}
                className={`rounded-2xl border-2 ${isRecommended ? accent.ring : 'border-stone-200'} overflow-hidden flex flex-col`}
              >
                <div className={`px-4 py-3 ${isRecommended ? accent.badge : 'bg-stone-50 text-stone-700'}`}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-bold text-sm">{plan.title}</p>
                    {isRecommended && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-white/80">
                        <CheckCircle2 size={12} />AI 推薦
                      </span>
                    )}
                  </div>
                  <p className="text-xs mt-1 opacity-80 leading-relaxed">{plan.subtitle}</p>
                </div>

                <div className="p-4 space-y-3 flex-1 text-sm">
                  <div className="flex gap-3">
                    <div className="flex-1 rounded-lg bg-red-50 px-2.5 py-1.5 text-center">
                      <p className="text-[11px] text-red-500">處理嚴重</p>
                      <p className="text-base font-bold text-red-700">{plan.expectedDangerAddressed}</p>
                    </div>
                    <div className="flex-1 rounded-lg bg-blue-50 px-2.5 py-1.5 text-center">
                      <p className="text-[11px] text-blue-500">處理提醒</p>
                      <p className="text-base font-bold text-blue-700">{plan.expectedCautionAddressed}</p>
                    </div>
                  </div>

                  <p className="text-xs text-stone-500 leading-relaxed">{plan.estimateNote}</p>

                  {plan.replacements.length > 0 && (
                    <div>
                      <p className="text-xs font-bold text-stone-500 mb-1">建議替換</p>
                      <ul className="space-y-1">
                        {plan.replacements.map((r, i) => (
                          <li key={i} className="text-xs text-stone-700 flex items-center gap-1.5 flex-wrap">
                            <span className="font-medium">{r.originalName}</span>
                            <ArrowRight size={11} className="text-stone-400 flex-shrink-0" />
                            <span className="font-medium text-emerald-700">{r.replacementName}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {plan.keepPlants.length > 0 && (
                    <div>
                      <p className="text-xs font-bold text-stone-500 mb-1">建議保留</p>
                      <p className="text-xs text-stone-600">{plan.keepPlants.join('、')}</p>
                    </div>
                  )}

                  {plan.unresolvedPlants.length > 0 && (
                    <div>
                      <p className="text-xs font-bold text-amber-600 mb-1">找不到同類替代植物，需人工確認</p>
                      <p className="text-xs text-stone-600">{plan.unresolvedPlants.join('、')}</p>
                    </div>
                  )}

                  <details className="pt-1">
                    <summary className="text-xs font-semibold text-stone-500 cursor-pointer select-none">修改原因與優缺點</summary>
                    <p className="text-xs text-stone-600 mt-1.5 leading-relaxed">{plan.reasoning}</p>
                    {plan.pros.length > 0 && (
                      <ul className="mt-1.5 space-y-0.5">
                        {plan.pros.map((p, i) => <li key={i} className="text-xs text-emerald-700">✓ {p}</li>)}
                      </ul>
                    )}
                    {plan.cons.length > 0 && (
                      <ul className="mt-1 space-y-0.5">
                        {plan.cons.map((c, i) => <li key={i} className="text-xs text-stone-500">－ {c}</li>)}
                      </ul>
                    )}
                  </details>
                </div>
              </div>
            )
          })}
        </div>

        <div className="px-6 pb-6">
          <p className="text-xs text-stone-500 bg-stone-50 border border-stone-200 rounded-xl px-4 py-2.5">
            AI 推薦：{recommendedId} 方案。{recommendReason}
          </p>
        </div>
      </div>
    </div>
  )
}
