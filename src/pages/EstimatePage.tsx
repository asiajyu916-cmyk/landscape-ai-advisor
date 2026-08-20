// ── 工程估價／景觀概算 ────────────────────────────────────────────────────────
// 讀取既有 DXF 分區審查已解析好的 zoneStatistics（由 DxfReviewPage 橋接到
// sessionStorage 的 'dxf-zone-statistics'），透過 estimateAdapter 轉換成估價
// 明細，不重新解析 DXF、不修改既有分區審查/植物資料庫邏輯。
// 單價資料獨立存放在 estimatePriceStore（localStorage），不寫進植物生態資料庫。

import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Search, X, Settings2, AlertTriangle } from 'lucide-react'
import type { ZoneStatisticsResult, PlantScheduleEntry } from '@/types/dxf'
import type { EstimateCategory, EstimateItem, PlantPrice, PriceSourceType } from '@/types/estimate'
import { ESTIMATE_CATEGORY_LABEL, PRICING_UNIT_LABEL, PRICE_SOURCE_TYPE_LABEL } from '@/types/estimate'
import { buildEstimateItemsFromDxf, computeCaseSummary, computeZoneSummary } from '@/utils/estimateAdapter'
import { loadPlantPrices, savePlantPrices, upsertPlantPrice, type PriceBasis } from '@/lib/estimatePriceStore'

function formatNT(n: number): string {
  return `NT$ ${Math.round(n).toLocaleString('en-US')}`
}

function loadZoneStatistics(): ZoneStatisticsResult[] {
  try {
    const raw = sessionStorage.getItem('dxf-zone-statistics')
    if (!raw) return []
    return JSON.parse(raw) as ZoneStatisticsResult[]
  } catch {
    return []
  }
}

function loadPlantSchedule(): PlantScheduleEntry[] {
  try {
    const raw = sessionStorage.getItem('dxf-plant-schedule')
    if (!raw) return []
    return JSON.parse(raw) as PlantScheduleEntry[]
  } catch {
    return []
  }
}

type CategoryFilter = 'all' | EstimateCategory | 'missing_price' | 'missing_density' | 'ambiguous_spec'

const FILTER_OPTIONS: { id: CategoryFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'tree', label: '喬木' },
  { id: 'shrub', label: '灌木' },
  { id: 'groundcover', label: '地被' },
  { id: 'grass', label: '草皮' },
  { id: 'missing_price', label: '缺少單價' },
  { id: 'missing_density', label: '待設定種植密度' },
  { id: 'ambiguous_spec', label: '規格不明確' },
]

const PRICE_BASIS_OPTIONS: { id: PriceBasis; label: string }[] = [
  { id: 'auto', label: '自動選擇' },
  { id: 'gov', label: '工程會參考價' },
  { id: 'market', label: '苗圃市場價' },
  { id: 'manual', label: '自訂單價' },
]

export default function EstimatePage({ zoneReviewsVersion = 0 }: { zoneReviewsVersion?: number } = {}) {
  const [zoneStatistics, setZoneStatistics] = useState<ZoneStatisticsResult[]>(() => loadZoneStatistics())
  const [scheduleEntries, setScheduleEntries] = useState<PlantScheduleEntry[]>(() => loadPlantSchedule())
  const [prices, setPrices] = useState<PlantPrice[]>(() => loadPlantPrices())
  const [expandedZones, setExpandedZones] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState<CategoryFilter>('all')
  const [showPriceDb, setShowPriceDb] = useState(false)
  const [priceBasis, setPriceBasis] = useState<PriceBasis>('auto')

  // DxfReviewPage 重新分析完成（上傳新圖面/切單位/套用人工分類）後，
  // zoneReviewsVersion 會 +1，這裡重讀 sessionStorage 取得最新的分區統計／索引表
  useEffect(() => {
    setZoneStatistics(loadZoneStatistics())
    setScheduleEntries(loadPlantSchedule())
  }, [zoneReviewsVersion])

  const items = useMemo(() => buildEstimateItemsFromDxf(zoneStatistics, prices, scheduleEntries, priceBasis), [zoneStatistics, prices, scheduleEntries, priceBasis])
  const caseSummary = useMemo(() => computeCaseSummary(items), [items])

  useEffect(() => {
    // 分區資料一到，預設全部展開，讓使用者一次看到全案概算
    if (zoneStatistics.length > 0) setExpandedZones(new Set(zoneStatistics.map(z => z.zoneId)))
  }, [zoneStatistics])

  const toggleZone = (zoneId: string) => {
    setExpandedZones(prev => {
      const next = new Set(prev)
      if (next.has(zoneId)) next.delete(zoneId); else next.add(zoneId)
      return next
    })
  }

  // 編輯單一項目的材料/施工單價：優先精準更新這個項目目前實際採用的那一筆 PlantPrice
  // （item.priceId）；沒有採用中的價格時（缺少單價/規格不明確）才新增一筆「自訂單價」
  // （sourceType:'manual'），不會動到植物生態資料庫，也不會動到工程會/市場價原始資料。
  const updateItemPrice = (item: EstimateItem, field: 'material' | 'labor', value: number | undefined) => {
    setPrices(prev => {
      const existing = item.priceId ? prev.find(p => p.id === item.priceId) : undefined
      const base: PlantPrice = existing ?? {
        id: `manual__${item.plantName}__${item.dxfSpec ?? item.specification ?? ''}__${Date.now()}`,
        plantName: item.plantName,
        category: item.category,
        specification: item.dxfSpec ?? item.specification,
        pricingUnit: item.unit === '株' ? 'plant' : 'm2',
        sourceType: 'manual',
        priceSource: '人工設定',
        materialPrice: item.materialUnitPrice,
        laborPrice: item.laborUnitPrice,
      }
      const updated: PlantPrice = {
        ...base,
        materialPrice: field === 'material' ? value : base.materialPrice,
        laborPrice: field === 'labor' ? value : base.laborPrice,
      }
      const next = upsertPlantPrice(prev, updated)
      savePlantPrices(next)
      return next
    })
  }

  // 「規格不明確」項目：使用者從候選價格中手動挑一筆採用——寫成一筆新的「自訂單價」，
  // 規格沿用圖面規格（讓它之後變成規格完全相符），材料/施工單價複製自挑選的候選，
  // 並保留候選來源說明，不會偷偷把兩個不同規格當成同一筆。
  const resolveAmbiguous = (item: EstimateItem, candidate: PlantPrice) => {
    setPrices(prev => {
      const manual: PlantPrice = {
        id: `manual__${item.plantName}__${item.dxfSpec ?? candidate.specification ?? ''}__${Date.now()}`,
        plantName: item.plantName,
        category: item.category,
        specification: item.dxfSpec ?? candidate.specification,
        pricingUnit: candidate.pricingUnit,
        sourceType: 'manual',
        priceSource: `人工指定（採用 ${candidate.priceSource ?? candidate.sourceType} 的「${candidate.specification ?? '未標示規格'}」）`,
        materialPrice: candidate.materialPrice,
        laborPrice: candidate.laborPrice,
        note: `原候選規格：${candidate.specification ?? '未標示規格'}；使用者於「規格不明確」清單人工選定採用。`,
      }
      const next = upsertPlantPrice(prev, manual)
      savePlantPrices(next)
      return next
    })
  }

  const laborFeeAvailable = false // 尚未有施工單價資料來源，第一版先顯示「尚未設定」

  return (
    <div className="min-h-screen bg-[#f7f6f3]">
      <div className="max-w-6xl mx-auto px-4 md:px-6 py-6 space-y-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl md:text-2xl font-bold text-stone-800">景觀工程概算</h1>
            <p className="text-sm text-stone-500 mt-1">依據 DXF 圖面解析之植栽數量與面積，自動產生初步工程概算。</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-stone-400 font-medium">價格基準</span>
            <div className="flex items-center bg-white rounded-lg border border-stone-200 p-0.5 gap-0.5">
              {PRICE_BASIS_OPTIONS.map(opt => (
                <button key={opt.id} onClick={() => setPriceBasis(opt.id)}
                  className={`px-2.5 py-1.5 rounded-md text-xs font-semibold transition-colors whitespace-nowrap ${
                    priceBasis === opt.id ? 'bg-[#1a4731] text-white' : 'text-stone-500 hover:bg-stone-50'
                  }`}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {zoneStatistics.length === 0 ? (
          <div className="bg-white rounded-2xl border border-stone-200 p-8 text-center text-stone-500">
            <AlertTriangle className="mx-auto mb-3 text-amber-500" size={28} />
            尚未有可用的 DXF 分區資料。請先到「DXF 審查」上傳圖面並完成分區分析，
            回到此頁會自動帶入植栽數量與面積。
          </div>
        ) : (
          <>
            <SummaryCards summary={caseSummary} laborAvailable={laborFeeAvailable} onOpenPriceDb={() => setShowPriceDb(true)} />

            <div>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-base font-bold text-stone-800">分區概算</h2>
                <button onClick={() => setShowPriceDb(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-stone-200 text-stone-700 text-sm font-medium hover:bg-stone-50 transition-colors">
                  <Settings2 size={14} />單價設定
                </button>
              </div>

              <div className="flex items-center gap-1.5 flex-wrap mb-4">
                {FILTER_OPTIONS.map(opt => (
                  <button key={opt.id} onClick={() => setFilter(opt.id)}
                    className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
                      filter === opt.id
                        ? (opt.id === 'missing_price' || opt.id === 'ambiguous_spec')
                          ? 'bg-amber-500 border-amber-500 text-white'
                          : 'bg-[#1a4731] border-[#1a4731] text-white'
                        : 'bg-white border-stone-200 text-stone-600 hover:bg-stone-50'
                    }`}>
                    {opt.label}
                  </button>
                ))}
              </div>

              <div className="space-y-3">
                {zoneStatistics.map(zone => (
                  <ZoneEstimateCard
                    key={zone.zoneId}
                    zone={zone}
                    summary={computeZoneSummary(zone.zoneId, items)}
                    expanded={expandedZones.has(zone.zoneId)}
                    onToggle={() => toggleZone(zone.zoneId)}
                    filter={filter}
                    onEditPrice={updateItemPrice}
                    onResolveAmbiguous={resolveAmbiguous}
                  />
                ))}
              </div>
            </div>

            <CaseTotalCard summary={caseSummary} />
          </>
        )}
      </div>

      {showPriceDb && (
        <PriceDatabaseModal prices={prices} onChange={p => { setPrices(p); savePlantPrices(p) }} onClose={() => setShowPriceDb(false)} />
      )}
    </div>
  )
}

// ── 統計卡片 ────────────────────────────────────────────────────────────────

function SummaryCards({ summary, laborAvailable, onOpenPriceDb }: {
  summary: ReturnType<typeof computeCaseSummary>
  laborAvailable: boolean
  onOpenPriceDb: () => void
}) {
  const soilFee = undefined // 第一版保留欄位，尚未有資料來源
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      <StatCard label="預估總工程費" value={formatNT(summary.total)} big highlight />
      <StatCard label="植栽材料費" value={formatNT(summary.materialTotal)}
        sub={`喬木 ${formatNT(summary.categoryMaterialTotal.tree)}・灌木 ${formatNT(summary.categoryMaterialTotal.shrub)}`} />
      <StatCard label="種植施工費" value={laborAvailable ? formatNT(summary.laborTotal) : '尚未設定'} muted={!laborAvailable} />
      <StatCard label="土壤／資材費" value={soilFee === undefined ? '尚未設定' : formatNT(soilFee)} muted />
      <button onClick={onOpenPriceDb} className="text-left">
        <StatCard label="已計價比例" value={`${summary.pricedCount} / ${summary.totalCount} 項`}
          accent={summary.pricedCount < summary.totalCount ? 'amber' : 'green'} />
      </button>
    </div>
  )
}

function StatCard({ label, value, sub, big, highlight, muted, accent }: {
  label: string; value: string; sub?: string; big?: boolean; highlight?: boolean; muted?: boolean
  accent?: 'amber' | 'green'
}) {
  return (
    <div className={`rounded-2xl border p-4 h-full ${highlight ? 'bg-[#1a4731] border-[#1a4731]' : 'bg-white border-stone-200'}`}>
      <div className={`text-xs font-medium mb-1.5 ${highlight ? 'text-green-200' : 'text-stone-500'}`}>{label}</div>
      <div className={`font-bold leading-tight ${big ? 'text-2xl md:text-3xl' : 'text-lg'} ${
        highlight ? 'text-white' : muted ? 'text-stone-400' : accent === 'amber' ? 'text-amber-600' : accent === 'green' ? 'text-emerald-600' : 'text-stone-800'
      }`}>
        {value}
      </div>
      {sub && <div className={`text-[11px] mt-1.5 ${highlight ? 'text-green-200/80' : 'text-stone-400'}`}>{sub}</div>}
    </div>
  )
}

// ── 分區卡片 ────────────────────────────────────────────────────────────────

function ZoneEstimateCard({ zone, summary, expanded, onToggle, filter, onEditPrice, onResolveAmbiguous }: {
  zone: ZoneStatisticsResult
  summary: ReturnType<typeof computeZoneSummary>
  expanded: boolean
  onToggle: () => void
  filter: CategoryFilter
  onEditPrice: (item: EstimateItem, field: 'material' | 'labor', value: number | undefined) => void
  onResolveAmbiguous: (item: EstimateItem, candidate: PlantPrice) => void
}) {
  const filteredItems = summary.items.filter(i => {
    if (filter === 'all') return true
    if (filter === 'missing_price' || filter === 'missing_density' || filter === 'ambiguous_spec') return i.pricingStatus === filter
    return i.category === filter
  })

  return (
    <div className="bg-white rounded-2xl border border-stone-200 overflow-hidden">
      <button onClick={onToggle} className="w-full flex items-center justify-between px-5 py-4 hover:bg-stone-50 transition-colors">
        <div className="flex items-center gap-2.5">
          {expanded ? <ChevronDown size={18} className="text-stone-400" /> : <ChevronRight size={18} className="text-stone-400" />}
          <span className="font-bold text-stone-800">{zone.zoneId}</span>
          {summary.totalCount > summary.pricedCount && (
            <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-600 text-[11px] font-semibold border border-amber-200">
              {summary.totalCount - summary.pricedCount} 項尚未完成計價
            </span>
          )}
        </div>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-stone-400">
            喬木 {zone.treeTotalCount} 株・灌木/地被/草皮 {zone.plantingAreaM2.toFixed(1)} ㎡
          </span>
          <span className="font-bold text-[#1a4731]">{formatNT(summary.total)}</span>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-stone-100 px-5 py-4">
          <BoqTable items={filteredItems} onEditPrice={onEditPrice} onResolveAmbiguous={onResolveAmbiguous} />
          <ZoneTotalsFooter summary={summary} />
        </div>
      )}
    </div>
  )
}

const SOURCE_TYPE_BADGE_CLASS: Record<PriceSourceType, string> = {
  gov: 'bg-blue-50 text-blue-600 border-blue-200',
  market: 'bg-teal-50 text-teal-600 border-teal-200',
  manual: 'bg-stone-100 text-stone-600 border-stone-300',
}

function BoqTable({ items, onEditPrice, onResolveAmbiguous }: {
  items: EstimateItem[]
  onEditPrice: (item: EstimateItem, field: 'material' | 'labor', value: number | undefined) => void
  onResolveAmbiguous: (item: EstimateItem, candidate: PlantPrice) => void
}) {
  if (items.length === 0) {
    return <div className="text-sm text-stone-400 py-6 text-center">此分區沒有符合篩選條件的項目</div>
  }
  return (
    <div className="overflow-x-auto -mx-1">
      <table className="w-full text-sm border-collapse min-w-[720px]">
        <thead>
          <tr className="text-left text-stone-400 text-xs">
            <th className="font-medium px-2 py-2">項目</th>
            <th className="font-medium px-2 py-2">分類</th>
            <th className="font-medium px-2 py-2">規格</th>
            <th className="font-medium px-2 py-2 text-right">
              <span className="inline-flex items-center gap-1">
                數量
                <span title="數量／單位直接讀取 DXF 解析結果（含索引表株/M2 換算株數），唯讀不可人工修改" className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 text-[10px] font-semibold border border-blue-200 normal-case">
                  DXF 自動計算
                </span>
              </span>
            </th>
            <th className="font-medium px-2 py-2">單位</th>
            <th className="font-medium px-2 py-2 text-right">材料單價</th>
            <th className="font-medium px-2 py-2 text-right">施工單價</th>
            <th className="font-medium px-2 py-2 text-right">小計</th>
            <th className="font-medium px-2 py-2">狀態</th>
          </tr>
        </thead>
        <tbody>
          {items.map(item => (
            <tr key={item.id} className="border-t border-stone-100 align-top">
              <td className="px-2 py-2.5 font-medium text-stone-800 whitespace-nowrap">
                <span title={[item.priceSource && `價格來源：${item.priceSource}`, item.rawBlockName && `DXF 原始代碼：${item.rawBlockName}`].filter(Boolean).join('\n') || undefined}
                  className={(item.priceSource || item.rawBlockName) ? 'border-b border-dotted border-stone-300 cursor-help' : undefined}>
                  {item.plantName}
                </span>
                {item.priceSourceType && (
                  <span className={`ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-semibold border ${SOURCE_TYPE_BADGE_CLASS[item.priceSourceType]}`}>
                    {PRICE_SOURCE_TYPE_LABEL[item.priceSourceType]}
                  </span>
                )}
                {item.isProvisional && (
                  <span title="這筆單價目前是暫估（尚未找到精準同規格公開價），可正常計價，後續建議替換成正式價格"
                    className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-semibold border bg-yellow-50 text-yellow-700 border-yellow-300 cursor-help">
                    暫估
                  </span>
                )}
                {item.candidateNote && (
                  <div className="text-[10px] text-amber-600 font-normal mt-0.5 max-w-[160px]" title={item.candidateNote}>
                    {item.candidateNote.startsWith('規格待覆核') ? '' : '候選對應：'}
                    {item.candidateNote.length > 20 ? item.candidateNote.slice(0, 20) + '…' : item.candidateNote}
                  </div>
                )}
              </td>
              <td className="px-2 py-2.5 text-stone-500 whitespace-nowrap">{ESTIMATE_CATEGORY_LABEL[item.category]}</td>
              <td className="px-2 py-2.5 text-stone-500 whitespace-nowrap max-w-[220px]">
                <div className="truncate" title={item.specification}>{item.specification ?? '—'}</div>
                {item.dxfSpec && (
                  <div className="text-[10px] text-stone-400 font-normal truncate" title={`圖面規格：${item.dxfSpec}`}>圖面：{item.dxfSpec}</div>
                )}
                {(item.priceMatchKind === 'single_candidate' || item.priceMatchKind === 'name_candidate') && (
                  <div className="text-[10px] text-amber-600 font-semibold">市場參考規格</div>
                )}
              </td>
              {item.plantCount !== undefined ? (
                <>
                  <td className="px-2 py-2.5 text-right text-stone-700 whitespace-nowrap">
                    <div>{item.plantCount.toLocaleString('en-US')}</div>
                    <div className="text-[10px] text-stone-400 font-normal" title="面積來源：DXF HATCH／索引表；密度來源：DXF 植栽索引表「株/M2」">
                      面積 {item.areaM2?.toFixed(2)}㎡ × 密度 {item.plantsPerM2?.toFixed(2)}株/㎡
                    </div>
                  </td>
                  <td className="px-2 py-2.5 text-stone-500 whitespace-nowrap">株</td>
                </>
              ) : (
                <>
                  <td className="px-2 py-2.5 text-right text-stone-700 whitespace-nowrap">{item.quantity.toFixed(item.unit === '㎡' ? 1 : 0)}</td>
                  <td className="px-2 py-2.5 text-stone-500 whitespace-nowrap">{item.unit}</td>
                </>
              )}
              <td className="px-2 py-2.5 text-right"><PriceInput value={item.materialUnitPrice} onChange={v => onEditPrice(item, 'material', v)} /></td>
              <td className="px-2 py-2.5 text-right"><PriceInput value={item.laborUnitPrice} onChange={v => onEditPrice(item, 'labor', v)} /></td>
              <td className="px-2 py-2.5 text-right font-semibold text-stone-800 whitespace-nowrap">
                {item.subtotal !== undefined ? formatNT(item.subtotal) : '--'}
              </td>
              <td className="px-2 py-2.5 whitespace-nowrap">
                {item.pricingStatus === 'priced' && (
                  <span className="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 text-[11px] font-semibold border border-emerald-200">已計價</span>
                )}
                {item.pricingStatus === 'missing_price' && (
                  <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-600 text-[11px] font-semibold border border-amber-200">缺少單價</span>
                )}
                {item.pricingStatus === 'missing_density' && (
                  <span title="此項目的單價是「元/株」計價，但 DXF 只解析出 HATCH 面積，需要「每㎡種植株數」才能換算成金額"
                    className="px-2 py-0.5 rounded-full bg-purple-50 text-purple-600 text-[11px] font-semibold border border-purple-200 cursor-help">
                    待設定種植密度
                  </span>
                )}
                {item.pricingStatus === 'ambiguous_spec' && item.ambiguousCandidates && (
                  <div className="space-y-1">
                    <span title="找到多筆不同規格的市場/工程會價格，但沒有一筆跟圖面規格相符，無法自動判斷該用哪一筆，禁止跨規格計價"
                      className="inline-block px-2 py-0.5 rounded-full bg-red-50 text-red-600 text-[11px] font-semibold border border-red-200 cursor-help">
                      目前僅找到不同規格市場價格
                    </span>
                    <select
                      defaultValue=""
                      onChange={e => {
                        const candidate = item.ambiguousCandidates!.find(c => c.id === e.target.value)
                        if (candidate) onResolveAmbiguous(item, candidate)
                      }}
                      className="block w-full max-w-[180px] px-1.5 py-1 border border-stone-200 rounded-md text-[11px]">
                      <option value="" disabled>選擇規格採用…</option>
                      {item.ambiguousCandidates.map(c => (
                        <option key={c.id} value={c.id}>
                          {(c.specification ?? '未標示規格')}・{PRICE_SOURCE_TYPE_LABEL[c.sourceType]}・NT${c.materialPrice ?? '?'}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PriceInput({ value, onChange }: { value?: number; onChange: (v: number | undefined) => void }) {
  const [text, setText] = useState(value !== undefined ? String(value) : '')
  useEffect(() => { setText(value !== undefined ? String(value) : '') }, [value])
  return (
    <div className="flex items-center justify-end gap-1">
      <input
        type="number"
        value={text}
        placeholder="尚未設定"
        onChange={e => setText(e.target.value)}
        onBlur={() => onChange(text.trim() === '' ? undefined : Number(text))}
        className="w-20 px-1.5 py-1 text-right border border-stone-200 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-[#1a4731] placeholder:text-stone-300"
      />
      <span className="text-stone-400 text-xs">元</span>
    </div>
  )
}

function ZoneTotalsFooter({ summary }: { summary: ReturnType<typeof computeZoneSummary> }) {
  return (
    <div className="mt-4 pt-4 border-t border-stone-100 flex flex-col items-end gap-1 text-sm">
      <div className="font-bold text-stone-700 mb-1">本區概算</div>
      <div className="text-stone-500">材料費：{formatNT(summary.materialTotal)}</div>
      <div className="text-stone-500">施工費：{formatNT(summary.laborTotal)}</div>
      <div className="text-stone-500">其他：{formatNT(summary.otherTotal)}</div>
      <div className="font-bold text-[#1a4731] text-base mt-1">本區合計：{formatNT(summary.total)}</div>
    </div>
  )
}

function CaseTotalCard({ summary }: { summary: ReturnType<typeof computeCaseSummary> }) {
  return (
    <div className="bg-white rounded-2xl border-2 border-[#1a4731]/20 p-6">
      <h2 className="text-base font-bold text-stone-800 mb-4">全案景觀工程概算</h2>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <TotalRow label="植栽材料費" value={formatNT(summary.materialTotal)} />
        <TotalRow label="施工費" value={formatNT(summary.laborTotal)} />
        <TotalRow label="土壤／資材" value="尚未設定" muted />
        <TotalRow label="其他" value={formatNT(summary.otherTotal)} />
      </div>
      <div className="mt-5 pt-5 border-t border-stone-100 flex items-center justify-between">
        <span className="text-stone-600 font-medium">預估總工程費</span>
        <span className="text-2xl md:text-3xl font-bold text-[#1a4731]">{formatNT(summary.total)}</span>
      </div>
    </div>
  )
}

function TotalRow({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div>
      <div className="text-xs text-stone-400 mb-1">{label}</div>
      <div className={`font-bold ${muted ? 'text-stone-400' : 'text-stone-800'}`}>{value}</div>
    </div>
  )
}

// ── 單價設定 Modal：植栽單價資料庫 ─────────────────────────────────────────────

function PriceDatabaseModal({ prices, onChange, onClose }: {
  prices: PlantPrice[]
  onChange: (prices: PlantPrice[]) => void
  onClose: () => void
}) {
  const [search, setSearch] = useState('')
  const filtered = prices.filter(p => p.plantName.includes(search.trim()))

  const updateRow = (id: string, patch: Partial<PlantPrice>) => {
    onChange(prices.map(p => p.id === id ? { ...p, ...patch, updatedAt: new Date().toISOString() } : p))
  }
  const addRow = () => {
    onChange([...prices, {
      id: `manual__${Date.now()}`,
      plantName: '',
      category: 'tree',
      pricingUnit: 'plant',
      sourceType: 'manual',
      priceSource: '人工設定',
      updatedAt: new Date().toISOString(),
    }])
  }
  const removeRow = (id: string) => onChange(prices.filter(p => p.id !== id))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-4xl max-h-[85vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-stone-100">
          <div>
            <h3 className="font-bold text-stone-800">植栽單價資料庫</h3>
            <p className="text-xs text-stone-400 mt-0.5">獨立於植物生態資料庫，只用來計算工程估價</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-stone-100 text-stone-400"><X size={18} /></button>
        </div>

        <div className="px-6 py-3 border-b border-stone-100">
          <div className="relative max-w-xs">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-300" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜尋植物名稱"
              className="w-full pl-8 pr-3 py-2 rounded-lg border border-stone-200 text-sm focus:outline-none focus:ring-1 focus:ring-[#1a4731]" />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-3">
          <table className="w-full text-sm border-collapse min-w-[720px]">
            <thead>
              <tr className="text-left text-stone-400 text-xs sticky top-0 bg-white">
                <th className="font-medium px-2 py-2">植物名稱</th>
                <th className="font-medium px-2 py-2">分類</th>
                <th className="font-medium px-2 py-2">規格</th>
                <th className="font-medium px-2 py-2">計價單位</th>
                <th className="font-medium px-2 py-2 text-right">材料單價</th>
                <th className="font-medium px-2 py-2 text-right">施工單價</th>
                <th className="font-medium px-2 py-2">來源</th>
                <th className="font-medium px-2 py-2">更新日期</th>
                <th className="font-medium px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {filtered.map(p => (
                <tr key={p.id} className="border-t border-stone-100">
                  <td className="px-2 py-2">
                    <input value={p.plantName} onChange={e => updateRow(p.id, { plantName: e.target.value })}
                      className="w-28 px-2 py-1 border border-stone-200 rounded-md text-sm" />
                  </td>
                  <td className="px-2 py-2">
                    <select value={p.category} onChange={e => updateRow(p.id, { category: e.target.value as EstimateCategory })}
                      className="px-2 py-1 border border-stone-200 rounded-md text-sm">
                      {(['tree', 'shrub', 'groundcover', 'grass'] as EstimateCategory[]).map(c => (
                        <option key={c} value={c}>{ESTIMATE_CATEGORY_LABEL[c]}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-2">
                    <input value={p.specification ?? ''} onChange={e => updateRow(p.id, { specification: e.target.value })}
                      className="w-32 px-2 py-1 border border-stone-200 rounded-md text-sm" />
                  </td>
                  <td className="px-2 py-2">
                    <select value={p.pricingUnit} onChange={e => updateRow(p.id, { pricingUnit: e.target.value as PlantPrice['pricingUnit'] })}
                      className="px-2 py-1 border border-stone-200 rounded-md text-sm">
                      {(Object.keys(PRICING_UNIT_LABEL) as Array<PlantPrice['pricingUnit']>).map(u => (
                        <option key={u} value={u}>{PRICING_UNIT_LABEL[u]}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-2 text-right">
                    <input type="number" value={p.materialPrice ?? ''} placeholder="尚未設定"
                      onChange={e => updateRow(p.id, { materialPrice: e.target.value === '' ? undefined : Number(e.target.value) })}
                      className="w-20 px-2 py-1 border border-stone-200 rounded-md text-sm text-right placeholder:text-stone-300" />
                  </td>
                  <td className="px-2 py-2 text-right">
                    <input type="number" value={p.laborPrice ?? ''} placeholder="尚未設定"
                      onChange={e => updateRow(p.id, { laborPrice: e.target.value === '' ? undefined : Number(e.target.value) })}
                      className="w-20 px-2 py-1 border border-stone-200 rounded-md text-sm text-right placeholder:text-stone-300" />
                  </td>
                  <td className="px-2 py-2 whitespace-nowrap">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold border ${SOURCE_TYPE_BADGE_CLASS[p.sourceType]}`} title={p.priceSource}>
                      {PRICE_SOURCE_TYPE_LABEL[p.sourceType]}
                    </span>
                  </td>
                  <td className="px-2 py-2 text-xs text-stone-400 whitespace-nowrap">
                    {p.updatedAt ? new Date(p.updatedAt).toLocaleDateString('zh-TW') : '—'}
                  </td>
                  <td className="px-2 py-2">
                    <button onClick={() => removeRow(p.id)} className="text-stone-300 hover:text-red-500"><X size={14} /></button>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={9} className="text-center text-stone-400 py-8">尚無資料</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="px-6 py-4 border-t border-stone-100 flex items-center justify-between">
          <button onClick={addRow} className="px-3.5 py-2 rounded-lg bg-[#1a4731] text-white text-sm font-semibold hover:bg-[#2d6a4f] transition-colors">
            新增估價項目
          </button>
          <button onClick={onClose} className="px-4 py-2 rounded-lg bg-stone-100 text-stone-600 text-sm font-medium hover:bg-stone-200 transition-colors">
            關閉
          </button>
        </div>
      </div>
    </div>
  )
}
