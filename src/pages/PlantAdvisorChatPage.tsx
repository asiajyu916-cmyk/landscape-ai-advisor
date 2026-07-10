// ── PlantAdvisorChatPage.tsx — AI 配植助理（獨立頁面）─────────────────────────
// 跟 LandscapeAdvisorPage 的「AI 配植評估」不同：這裡不是評估已選好的植栽組合，
// 而是「幫我找符合條件的植物」的開放式查詢工具。
//
// 查詢順序（照需求）：
//   1. 解析問句 → 判斷植物類型（喬木/灌木/地被/草皮）
//   2. 套用條件（耐旱/耐陰/半日照/低維護/會開花/容易落葉/有毒性...）
//   3. 優先查本地植栽資料庫（CsvPlantRecord[]）
//   4. 本地完全查無符合結果時，才呼叫 /api/plant-query 讓 Claude 搜官方來源給建議
//
// 不觸碰 DXF / HATCH / PDF 審查 / 分區判讀——只讀 localStorage 裡的植栽資料庫，
// 卡片外觀直接重用 LandscapeAdvisorPage 匯出的 PlantCardItem，不重新設計樣式。

import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { Search, Loader2, Sparkles, X as XIcon } from 'lucide-react'
import type { CsvPlantRecord, PlantImageData } from '@/types/csvPlant'
import { loadPlantsFromStorage, savePlantsToStorage } from '@/data/plantStore'
import { loadImageStore, saveImageStore, upsertPlantImage } from '@/data/plantStore'
import {
  CONDITIONS, parseTypeIntent, matchesCategory, getAdvisorReply,
} from '@/utils/plantAdvisor'
import { PlantCardItem, PlantDetailDrawer } from './LandscapeAdvisorPage'

type CategoryKey = 'tree' | 'shrub' | 'groundcover' | 'lawn'

const TYPE_FILTERS: Array<{ key: CategoryKey; label: string }> = [
  { key: 'tree', label: '喬木' },
  { key: 'shrub', label: '灌木' },
  { key: 'groundcover', label: '地被' },
  { key: 'lawn', label: '草皮' },
]

// 快速篩選只暴露需求指定的 6 個條件（CONDITIONS 裡還有全日照/耐濕/原生等，
// 保留給自然語言問句用，不塞進按鈕列，避免按鈕過多）
const QUICK_CONDITION_KEYS = ['drought', 'shade', 'lowmaint', 'showy', 'leafdrop', 'toxic']

interface ChatMsg {
  role: 'user' | 'assistant'
  text: string
}

interface ApiSuggestion { name: string; reason: string; sourceUrl?: string }

export default function PlantAdvisorChatPage() {
  const [plants, setPlants] = useState<CsvPlantRecord[]>([])
  const [imageStore, setImageStore] = useState(() => loadImageStore())
  const [activeType, setActiveType] = useState<CategoryKey | null>(null)
  const [activeConds, setActiveConds] = useState<Set<string>>(new Set())
  const [messages, setMessages] = useState<ChatMsg[]>([{
    role: 'assistant',
    text: '您好，我是 AI 配植助理。可以直接問我，例如「會開花的喬木有哪些」「耐旱低維護灌木」，也可以用上方的快速篩選按鈕縮小範圍。',
  }])
  const [input, setInput] = useState('')
  const [apiLoading, setApiLoading] = useState(false)
  const [apiSuggestions, setApiSuggestions] = useState<ApiSuggestion[] | null>(null)
  const [apiNote, setApiNote] = useState('')
  const [detail, setDetail] = useState<CsvPlantRecord | null>(null)

  const handleSaveImage = useCallback((plantName: string, data: Partial<PlantImageData>) => {
    setImageStore(prev => {
      const next = upsertPlantImage(prev, plantName, data)
      saveImageStore(next)
      return next
    })
  }, [])

  const handleDeletePlant = useCallback((plantId: string) => {
    setPlants(prev => {
      const next = prev.filter(p => p.id !== plantId)
      const saved = savePlantsToStorage(next)
      if (!saved) {
        window.alert('刪除失敗：瀏覽器儲存空間可能已滿，請稍後再試。')
        return prev
      }
      return next
    })
    setDetail(null)
  }, [])

  // ── 左右面板可拖曳調整寬度 ────────────────────────────────────────────────
  const [chatWidth, setChatWidth] = useState(380)   // 對話區寬度（px），預設跟原本固定寬度一致
  const containerRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  const MIN_CHAT_WIDTH = 280
  const MIN_GRID_WIDTH = 320   // 右側卡片區至少保留的寬度，避免拖到卡片完全放不下

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    draggingRef.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!draggingRef.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const maxWidth = rect.width - MIN_GRID_WIDTH   // 上限依容器實際寬度動態算，不是寫死的數字
      const left = rect.left
      const next = Math.min(maxWidth, Math.max(MIN_CHAT_WIDTH, e.clientX - left))
      setChatWidth(next)
    }
    const handleMouseUp = () => {
      if (!draggingRef.current) return
      draggingRef.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  useEffect(() => {
    setPlants(loadPlantsFromStorage() ?? [])
    setImageStore(loadImageStore())
  }, [])

  // ── 目前篩選條件下的比對結果（本地資料庫，優先）────────────────────────────
  const matches = useMemo(() => {
    let list = plants
    if (activeType) list = list.filter(p => matchesCategory(p, activeType))
    for (const key of activeConds) {
      const cond = CONDITIONS.find(c => c.key === key)
      if (cond) list = list.filter(cond.test)
    }
    return list
  }, [plants, activeType, activeConds])

  const typeLabel = activeType ? TYPE_FILTERS.find(t => t.key === activeType)?.label ?? '' : ''
  const condLabels = [...activeConds].map(k => CONDITIONS.find(c => c.key === k)?.label).filter(Boolean) as string[]

  const toggleType = (key: CategoryKey) => {
    setApiSuggestions(null); setApiNote('')
    setActiveType(prev => prev === key ? null : key)
  }
  const toggleCond = (key: string) => {
    setApiSuggestions(null); setApiNote('')
    setActiveConds(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  // ── 本地查無時才呼叫 API（步驟 4）────────────────────────────────────────────
  const callApiFallback = useCallback(async (tLabel: string, cLabels: string[]) => {
    setApiLoading(true); setApiSuggestions(null); setApiNote('')
    try {
      const res = await fetch('/api/plant-query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ typeLabel: tLabel, conditionLabels: cLabels }),
      })
      const data = await res.json()
      if (data.ok && data.suggestions?.length > 0) {
        setApiSuggestions(data.suggestions)
      } else {
        setApiNote(data.reason || '目前查無建議，建議人工確認。')
      }
    } catch {
      setApiNote('搜尋服務連線失敗，請稍後再試。')
    } finally {
      setApiLoading(false)
    }
  }, [])

  // 篩選結果變動時，若本地完全查無資料，自動觸發 API 補充建議
  useEffect(() => {
    if (matches.length === 0 && (activeType || activeConds.size > 0) && plants.length > 0) {
      callApiFallback(typeLabel, condLabels)
    } else {
      setApiSuggestions(null); setApiNote('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeType, activeConds])

  // ── 自然語言提問 ──────────────────────────────────────────────────────────
  const handleAsk = async () => {
    const q = input.trim()
    if (!q) return
    setMessages(prev => [...prev, { role: 'user', text: q }])
    setInput('')

    const parsedTypes = parseTypeIntent(q)
    const parsedConds = CONDITIONS.filter(c => c.pattern.test(q))

    if (parsedTypes.length > 0 || parsedConds.length > 0) {
      // 看起來是「找符合條件的植物」類型的問題 → 用篩選條件 + 卡片呈現
      const nextType = parsedTypes.length > 0 ? parsedTypes[0] : null
      const nextConds = new Set(parsedConds.map(c => c.key))
      setActiveType(nextType)
      setActiveConds(nextConds)
      const tLabel = nextType ? TYPE_FILTERS.find(t => t.key === nextType)?.label ?? '' : '植物'
      const cLabels = parsedConds.map(c => c.label)
      const list = plants
        .filter(p => !nextType || matchesCategory(p, nextType))
        .filter(p => [...nextConds].every(k => CONDITIONS.find(c => c.key === k)?.test(p)))
      setMessages(prev => [...prev, {
        role: 'assistant',
        text: list.length > 0
          ? `本地資料庫找到 ${list.length} 種符合「${cLabels.join('、') || '條件'}」的${tLabel}，已列在右側。`
          : `本地資料庫查無符合「${cLabels.join('、') || '條件'}」的${tLabel}，正在搜尋官方資料補充建議…`,
      }])
    } else {
      // 不是條件式列表查詢（例如「哪些植物不建議混植」這類相容性問題）
      // → 交給既有規則引擎（跟「AI 配植評估」頁下方那個助理同一套邏輯）
      setActiveType(null); setActiveConds(new Set())
      try {
        const reply = await getAdvisorReply(q, { db: plants })
        const parts: string[] = [reply.verdict]
        if (reply.badPairs.length > 0) {
          parts.push('不建議混植：' + reply.badPairs.map(b => `${b.name}（${b.reason}）`).join('；'))
        }
        if (reply.risks.length > 0) parts.push('風險提醒：' + reply.risks.join('；'))
        if (reply.fixes.length > 0) parts.push('建議：' + reply.fixes.join('；'))
        setMessages(prev => [...prev, { role: 'assistant', text: parts.filter(Boolean).join('\n') }])
      } catch {
        setMessages(prev => [...prev, { role: 'assistant', text: '目前無法產生回覆，請稍後再試。' }])
      }
    }
  }

  const clearFilters = () => {
    setActiveType(null); setActiveConds(new Set())
    setApiSuggestions(null); setApiNote('')
  }

  return (
    <div className="flex flex-col h-[calc(100vh-64px)] bg-stone-50">
      {/* 快速篩選列 */}
      <div className="flex-shrink-0 px-5 py-3 bg-white border-b border-stone-200 flex items-center gap-2 flex-wrap">
        <span className="text-xs font-semibold text-stone-400 mr-1">類型</span>
        {TYPE_FILTERS.map(t => (
          <button key={t.key} onClick={() => toggleType(t.key)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
              activeType === t.key ? 'bg-green-700 text-white border-green-700' : 'border-stone-200 text-stone-600 hover:bg-stone-50'
            }`}>
            {t.label}
          </button>
        ))}
        <span className="text-xs font-semibold text-stone-400 ml-3 mr-1">條件</span>
        {QUICK_CONDITION_KEYS.map(key => {
          const cond = CONDITIONS.find(c => c.key === key)
          if (!cond) return null
          const active = activeConds.has(key)
          return (
            <button key={key} onClick={() => toggleCond(key)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                active ? 'bg-emerald-600 text-white border-emerald-600' : 'border-stone-200 text-stone-600 hover:bg-stone-50'
              }`}>
              {cond.label.replace('植物', '')}
            </button>
          )
        })}
        {(activeType || activeConds.size > 0) && (
          <button onClick={clearFilters}
            className="ml-2 flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs text-stone-400 hover:text-stone-600 hover:bg-stone-100">
            <XIcon size={12} />清除篩選
          </button>
        )}
      </div>

      <div ref={containerRef} className="flex-1 flex overflow-hidden">
        {/* 左側：對話區（寬度可拖曳調整）*/}
        <div style={{ width: chatWidth }} className="flex-shrink-0 bg-white flex flex-col">
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm whitespace-pre-line ${
                  m.role === 'user' ? 'bg-green-700 text-white' : 'bg-stone-100 text-stone-700'
                }`}>
                  {m.text}
                </div>
              </div>
            ))}
          </div>
          <div className="flex-shrink-0 p-3 border-t border-stone-100">
            <div className="flex gap-2">
              <input value={input} onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleAsk() }}
                placeholder="例：會開花的喬木有哪些？"
                className="flex-1 px-3 py-2 border border-stone-200 rounded-xl text-sm focus:outline-none focus:border-green-400" />
              <button onClick={handleAsk}
                className="px-3 py-2 bg-green-700 text-white rounded-xl hover:bg-green-800">
                <Search size={16} />
              </button>
            </div>
          </div>
        </div>

        {/* 拖曳分隔線 */}
        <div
          onMouseDown={handleDragStart}
          title="拖曳調整寬度"
          className="w-1.5 flex-shrink-0 cursor-col-resize bg-stone-100 hover:bg-green-200 active:bg-green-300 transition-colors relative group border-x border-stone-200">
          <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-0.5 bg-stone-300 group-hover:bg-green-500" />
        </div>

        {/* 右側：符合條件的植栽卡片 */}
        <div className="flex-1 overflow-y-auto p-5 relative">
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm text-stone-500">
              {activeType || activeConds.size > 0
                ? <>符合「{[typeLabel, ...condLabels].filter(Boolean).join('、')}」，本地資料庫共 <strong className="text-stone-800">{matches.length}</strong> 種</>
                : <>植栽資料庫共 <strong className="text-stone-800">{plants.length}</strong> 種，使用上方篩選或左側對話查詢</>}
            </p>
          </div>

          {matches.length > 0 ? (
            <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}>
              {matches.map(p => (
                <PlantCardItem key={p.id} plant={p} imageData={imageStore[p.name]}
                  added={false} fresh={false} isActive={detail?.id === p.id}
                  onDetail={() => setDetail(prev => prev?.id === p.id ? null : p)} onAdd={() => {}} />
              ))}
            </div>
          ) : (activeType || activeConds.size > 0) ? (
            <div className="py-10">
              {apiLoading ? (
                <div className="flex items-center gap-2 text-stone-400 text-sm">
                  <Loader2 size={16} className="animate-spin" />本地資料庫查無符合資料，正在搜尋官方來源補充建議…
                </div>
              ) : apiSuggestions ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-1.5 text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                    <Sparkles size={13} />
                    以下為官方來源搜尋建議，非本地植栽資料庫資料，請至「植栽資料庫」使用自動搜尋功能個別核實、新增後才會出現在卡片清單中。
                  </div>
                  {apiSuggestions.map((s, i) => (
                    <div key={i} className="p-3.5 bg-white border border-stone-200 rounded-2xl">
                      <p className="font-semibold text-stone-800 text-sm">{s.name}</p>
                      <p className="text-xs text-stone-500 mt-1">{s.reason}</p>
                      {s.sourceUrl && (
                        <a href={s.sourceUrl} target="_blank" rel="noreferrer"
                          className="text-xs text-blue-600 hover:underline mt-1 inline-block truncate max-w-full">
                          {s.sourceUrl}
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-stone-400">{apiNote || '本地資料庫查無符合條件的植物。'}</p>
              )}
            </div>
          ) : (
            <div className="py-16 text-center text-stone-300 text-sm">
              使用上方篩選按鈕，或在左側輸入問題開始查詢
            </div>
          )}

          {/* 詳情面板（疊加在右側卡片區上方）*/}
          {detail && (
            <PlantDetailDrawer
              plant={detail}
              onClose={() => setDetail(null)}
              onAdd={() => {}}
              added={false}
              imageData={imageStore[detail.name]}
              onSaveImage={data => handleSaveImage(detail.name, data)}
              onDelete={() => handleDeletePlant(detail.id)}
            />
          )}
        </div>
      </div>
    </div>
  )
}
