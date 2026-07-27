// ── ComboAnalysisCard.tsx — 「分析這組配置」結果的分層呈現 ──────────────────────
// 純顯示元件：資料來自 comboAnalysisPresentation.ts 對 analyzeCombo() 既有輸出的
// 純轉換（分類/排序/標籤化），不在這裡做任何新的判斷或計算。

import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import {
  COMBO_CATEGORY_META, COMBO_SEVERITY_META,
  type ComboSummary, type ComboIssue, type ComboRelation, type ComboLevel,
} from '@/utils/comboAnalysisPresentation'

const LEVEL_STYLE: Record<ComboLevel, string> = {
  '通過':   'bg-emerald-100 text-emerald-700 border-emerald-300',
  '警示':   'bg-orange-100 text-orange-700 border-orange-300',
  '高風險': 'bg-red-100 text-red-700 border-red-300',
}

function IssueCard({ issue }: { issue: ComboIssue }) {
  const meta = COMBO_CATEGORY_META[issue.category]
  const sev = COMBO_SEVERITY_META[issue.severity]
  const Icon = meta.icon
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-3 space-y-1.5">
      <div className="flex items-center gap-2">
        <Icon size={16} className="text-stone-500 flex-shrink-0" />
        <span className="text-sm font-semibold text-stone-500">{meta.label}</span>
        <span className={`px-2 py-0.5 rounded-full border text-xs font-bold ${sev.badgeCls}`}>{sev.label}</span>
      </div>
      {issue.plants.length > 0 && (
        <p className="text-base font-bold text-stone-800">{issue.plants.join(' × ')}</p>
      )}
      <p className="text-[15px] text-stone-700 leading-relaxed">{issue.headline}</p>
      {issue.impact && (
        <p className="text-sm text-stone-500 leading-relaxed"><span className="font-medium text-stone-600">影響：</span>{issue.impact}</p>
      )}
      {issue.suggestion && (
        <p className="text-sm text-green-700 leading-relaxed"><span className="font-medium">建議：</span>{issue.suggestion}</p>
      )}
    </div>
  )
}

function RelationRow({ rel }: { rel: ComboRelation }) {
  return (
    <div className={`rounded-lg border px-3 py-2 ${rel.ok ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50'}`}>
      <p className="text-sm font-bold text-stone-800">{rel.plantA} × {rel.plantB}</p>
      <p className={`text-sm mt-0.5 leading-relaxed ${rel.ok ? 'text-emerald-700' : 'text-red-700'}`}>
        {rel.ok ? '✓ ' : '✕ '}{rel.reason}
      </p>
    </div>
  )
}

function Section({ title, count, icon, defaultOpen, children }: {
  title: string; count: number; icon: string; defaultOpen?: boolean; children: ReactNode
}) {
  const [open, setOpen] = useState(!!defaultOpen)
  if (count === 0) return null
  return (
    <div className="border-t border-stone-100 pt-3 mt-3 first:border-t-0 first:mt-0 first:pt-0">
      <button type="button" onClick={() => setOpen(v => !v)} className="w-full flex items-center justify-between text-left">
        <span className="text-base font-bold text-stone-700">{icon} {title} {count}</span>
        {open ? <ChevronUp size={18} className="text-stone-400 flex-shrink-0" /> : <ChevronDown size={18} className="text-stone-400 flex-shrink-0" />}
      </button>
      {open && <div className="mt-2.5 space-y-2.5">{children}</div>}
    </div>
  )
}

export default function ComboAnalysisCard({ summary }: { summary: ComboSummary }) {
  const [showFull, setShowFull] = useState(false)

  return (
    <div className="space-y-3 w-full min-w-0">
      {/* 一、整體結論卡 */}
      <div className="rounded-2xl border border-stone-200 bg-white p-4 space-y-2.5">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <span className="text-xl font-bold text-stone-800">配置整體評估</span>
          <span className={`px-3 py-1 rounded-full border text-base font-bold ${LEVEL_STYLE[summary.level]}`}>{summary.level}</span>
        </div>
        <p className="text-lg font-bold text-stone-700">適合度 {summary.score}／100</p>
        <div className="flex items-center gap-2 text-sm font-semibold flex-wrap">
          <span className="text-emerald-600">{summary.counts.ok} 項可行</span>
          <span className="text-stone-300">｜</span>
          <span className="text-orange-600">{summary.counts.adjust} 項需要調整</span>
          <span className="text-stone-300">｜</span>
          <span className="text-red-600">{summary.counts.high} 項高風險</span>
        </div>
        <p className="text-[15px] text-stone-700 leading-relaxed">{summary.oneLiner}</p>
        <div className="flex flex-wrap gap-1.5">
          {summary.tags.map(t => (
            <span key={t.category}
              className={`text-xs px-2 py-1 rounded-full font-medium border whitespace-nowrap ${
                t.ok ? 'bg-stone-50 text-stone-500 border-stone-200' : 'bg-red-50 text-red-600 border-red-200'
              }`}>
              {t.label}
            </span>
          ))}
        </div>
      </div>

      {/* 二、四個分區塊（配置優點／主要問題／調整建議／植物關係）；預設只展開主要問題 */}
      <div className="rounded-2xl border border-stone-200 bg-white p-4">
        <Section title="配置優點" count={summary.strengths.length} icon="✓">
          {summary.strengths.map((r, i) => <RelationRow key={i} rel={r} />)}
        </Section>
        <Section title="主要問題" count={summary.issues.length} icon="⚠" defaultOpen>
          {summary.issues.map((iss, i) => <IssueCard key={i} issue={iss} />)}
        </Section>
        <Section title="調整建議" count={summary.actions.length} icon="→">
          <ol className="space-y-1.5 list-decimal list-inside">
            {summary.actions.map((a, i) => (
              <li key={i} className="text-[15px] text-stone-700 leading-relaxed">{a}</li>
            ))}
          </ol>
        </Section>
        <Section title="植物關係" count={summary.relations.length} icon="🌿">
          {summary.relations.map((r, i) => <RelationRow key={i} rel={r} />)}
        </Section>
      </div>

      {/* 三、完整分析（原始 AdvisorReply 全文，預設收合，不預先展開避免版面又變長） */}
      <div className="rounded-2xl border border-stone-200 bg-white p-4">
        <button type="button" onClick={() => setShowFull(v => !v)} className="w-full flex items-center justify-between text-left">
          <span className="text-sm font-semibold text-stone-500">查看完整分析</span>
          {showFull ? <ChevronUp size={16} className="text-stone-400 flex-shrink-0" /> : <ChevronDown size={16} className="text-stone-400 flex-shrink-0" />}
        </button>
        {showFull && (
          <div className="mt-2.5 space-y-2.5 text-sm text-stone-600 leading-relaxed">
            <p>{summary.raw.verdict}</p>
            {summary.raw.risks.length > 0 && (
              <div>
                <p className="font-semibold text-stone-700 mb-1">風險</p>
                <ul className="list-disc list-inside space-y-0.5">{summary.raw.risks.map((r, i) => <li key={i}>{r}</li>)}</ul>
              </div>
            )}
            {summary.raw.fixes.length > 0 && (
              <div>
                <p className="font-semibold text-stone-700 mb-1">建議</p>
                <ul className="list-disc list-inside space-y-0.5">{summary.raw.fixes.map((f, i) => <li key={i}>{f}</li>)}</ul>
              </div>
            )}
            {summary.raw.alternatives.length > 0 && (
              <div>
                <p className="font-semibold text-stone-700 mb-1">替代方案</p>
                <ul className="list-disc list-inside space-y-0.5">
                  {summary.raw.alternatives.map((a, i) => <li key={i}>{a.original} → {a.alt}：{a.reason}</li>)}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
