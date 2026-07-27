// ── AiAdvisorDrawer.tsx — DXF 審查頁內嵌的「詢問 AI」側邊抽屜 ────────────────────
// 取代原本「離開審查頁、切到 AI 配植助理分頁」的做法：不離開 DxfReviewPage、不觸發
// App.tsx 的 activeTab 切換，因此 DxfReviewPage 不會被卸載，分析結果、篩選狀態、
// 捲動位置全部原地保留。直接呼叫既有的 getAdvisorReply()（純本地規則引擎，見
// src/utils/plantAdvisor.ts，LandscapeAdvisorPage／PlantAdvisorChatPage 共用同一套），
// 不新增任何 API 呼叫或分析邏輯。

import { useEffect, useRef, useState } from 'react'
import { X, Send, Sparkles } from 'lucide-react'
import { getAdvisorReply, type AdvisorReply } from '@/utils/plantAdvisor'
import type { CsvPlantRecord } from '@/types/csvPlant'

interface Message {
  role: 'user' | 'assistant'
  text?: string
  reply?: AdvisorReply
}

interface Props {
  db: CsvPlantRecord[]
  initialQuestion: string
  onClose: () => void
}

function AdvisorReplyMini({ r }: { r: AdvisorReply }) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-stone-700">{r.verdict}</p>
      {r.score !== undefined && (
        <p className="text-xs text-stone-500">配置評分：<span className="font-semibold text-stone-700">{r.score}</span></p>
      )}
      {r.risks.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-amber-700 mb-1">可能風險</p>
          <ul className="space-y-0.5">
            {r.risks.map((x, i) => <li key={i} className="text-xs text-stone-600">• {x}</li>)}
          </ul>
        </div>
      )}
      {r.fixes.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-blue-700 mb-1">修正建議</p>
          <ul className="space-y-0.5">
            {r.fixes.map((x, i) => <li key={i} className="text-xs text-stone-600">• {x}</li>)}
          </ul>
        </div>
      )}
      {r.badPairs.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-red-700 mb-1">不建議搭配</p>
          <ul className="space-y-0.5">
            {r.badPairs.map((x, i) => <li key={i} className="text-xs text-stone-600">• {x.name}：{x.reason}</li>)}
          </ul>
        </div>
      )}
      {r.goodPairs.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-emerald-700 mb-1">適合搭配</p>
          <ul className="space-y-0.5">
            {r.goodPairs.map((x, i) => <li key={i} className="text-xs text-stone-600">• {x.name}：{x.reason}</li>)}
          </ul>
        </div>
      )}
      {r.alternatives.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-stone-600 mb-1">替代植栽</p>
          <ul className="space-y-0.5">
            {r.alternatives.map((x, i) => <li key={i} className="text-xs text-stone-600">• {x.original} → {x.alt}：{x.reason}</li>)}
          </ul>
        </div>
      )}
      {r.disclaimer && <p className="text-[11px] text-stone-400">{r.disclaimer}</p>}
    </div>
  )
}

export default function AiAdvisorDrawer({ db, initialQuestion, onClose }: Props) {
  const [msgs, setMsgs] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const askedInitial = useRef(false)

  const ask = async (question: string) => {
    const q = question.trim()
    if (!q || busy) return
    setMsgs(m => [...m, { role: 'user', text: q }])
    setInput('')
    setBusy(true)
    try {
      const reply = await getAdvisorReply(q, { db })
      setMsgs(m => [...m, { role: 'assistant', reply }])
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (askedInitial.current) return
    askedInitial.current = true
    void ask(initialQuestion)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [msgs])

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-full max-w-md h-full bg-white shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-stone-200 flex-shrink-0">
          <div className="flex items-center gap-2">
            <Sparkles size={16} className="text-green-600" />
            <p className="text-sm font-bold text-stone-800">詢問 AI</p>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-stone-100 text-stone-500">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {msgs.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[90%] rounded-xl px-3 py-2 ${
                m.role === 'user' ? 'bg-[#1a4731] text-white' : 'bg-stone-50 border border-stone-100'
              }`}>
                {m.text && <p className={`text-sm ${m.role === 'user' ? 'text-white' : 'text-stone-700'}`}>{m.text}</p>}
                {m.reply && <AdvisorReplyMini r={m.reply} />}
              </div>
            </div>
          ))}
          {busy && <p className="text-xs text-stone-400">分析中…</p>}
          <div ref={bottomRef} />
        </div>

        <div className="p-3 border-t border-stone-200 flex-shrink-0">
          <div className="flex items-center gap-2">
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void ask(input) }}
              placeholder="繼續追問…"
              className="flex-1 px-3 py-2 rounded-lg border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            />
            <button
              type="button"
              onClick={() => void ask(input)}
              disabled={!input.trim() || busy}
              className="p-2 rounded-lg bg-green-600 text-white disabled:opacity-40"
            >
              <Send size={16} />
            </button>
          </div>
          <p className="text-[10px] text-stone-400 mt-1.5">規則引擎 v1，基於本地植栽資料庫即時運算，非即時 AI 對話。</p>
        </div>
      </div>
    </div>
  )
}
