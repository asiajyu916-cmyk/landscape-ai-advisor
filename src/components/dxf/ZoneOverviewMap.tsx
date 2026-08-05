// ── ZoneOverviewMap.tsx — 「植栽分區配置總覽」───────────────────────────────
// 定位：忠實呈現 DXF 中可辨識的植栽分區／HATCH／既有邊界，不補建築物、車道或
// 任何原圖沒有的底圖資訊。viewport 完全由實際分區座標的聯集 bounds 決定（含
// 5%~10% padding），不重新排列、不扭曲比例——中央空白是真實空間關係，不是錯誤。
//
// 三個視覺語意互相獨立，不可混用同一組顏色：
//   1. 分區識別色（低透明度填色）── 只用來分辨「這是哪一區」
//   2. 風險色（紅／藍／綠）── 只用在外框、徽章、問題點，代表嚴重／提醒／通過
//   3. 選取狀態（加粗外框＋提高透明度）── 只代表「目前選到哪一區」
// 幾何運算沿用 dxfReportBuilder.ts 既有的 polyBounds／polyCentroid／ringToPoints／
// fitDims，跟 PDF 匯出用同一套換算，不重新發明座標系統。
//
// 這一輪重點：圖面本身要夠大——用 ResizeObserver 量測實際容器寬度（不是寫死
// 一個小的預設像素值），SVG 才不會變成「看起來像縮圖」；問題點／字級／AI 標籤
// 都改用「換算成螢幕像素」再回推資料座標（unitsPerPx），不是相對 viewBox 的
// 比例值，縮放時大小才會符合直覺。AI 感（AI tag／極淡網格）刻意克制，不做黑底
// 霓虹風，維持白底、可讀、專業。

import { useEffect, useMemo, useRef, useState, type WheelEventHandler, type PointerEventHandler } from 'react'
import { polyBounds, ringToPoints, fitDims, getZoneColor } from '@/utils/dxfReportBuilder'
import type { DxfPolygon } from '@/types/dxf'
import { ZoomIn, ZoomOut, Maximize2, Minimize2, RotateCcw, LayoutGrid, AlertCircle, Sprout, Sparkles } from 'lucide-react'

export interface ZoneMapIssuePoint {
  id: string
  x: number
  y: number
  severity: 'danger' | 'caution'
  /** 問題編號短標籤（例如合併問題 id "A-01" 的 "01"），畫在半透明範圍標記中央 */
  label?: string
}

export interface ZoneMapEntry {
  zoneName: string
  boundary?: DxfPolygon
  /** 原圖 zone 文字標籤位置（多半就落在分區內，比重算的頂點平均質心更貼近視覺重心）*/
  labelPosition?: { x: number; y: number }
  areaM2?: number
  plantSummary?: string
  dangerCount: number
  cautionCount: number
  passedCount: number
  colorIndex: number
  issuePoints?: ZoneMapIssuePoint[]
  /** 植物辨識信心度（0~100，已比對到資料庫的圖塊／HATCH 占全部的比例）——真實
   *  算出來的辨識成功率，不是假造的 AI 分數。未提供時該區不顯示信心值。 */
  matchConfidencePercent?: number
}

export interface FocusPoint {
  x: number
  y: number
  severity: 'danger' | 'caution'
}

type ViewMode = 'zones' | 'issues' | 'planting' | 'ai'

interface Props {
  zones: ZoneMapEntry[]
  activeZoneName?: string | null
  onSelectZone?: (zoneName: string) => void
  onReset?: () => void
  /** 目前選取的問題卡片實際座標（同一區內，取兩實體中心點），疊加醒目 marker，
   *  用於「在圖面定位」按鈕觸發的既有 DrawingLocatorModal 流程。*/
  focusPoints?: FocusPoint[]
  /** 目前選取的單一問題點（issuePoints 的 id），點選後放大＋加外圈標示 */
  selectedIssueId?: string | null
  onSelectIssuePoint?: (zoneName: string, issueId: string) => void
  /** 目標高度（px）；寬度改由容器實際寬度自動決定，這兩個 prop 只當作找不到
   *  容器寬度時的保守預設值。 */
  widthPx?: number
  maxHeightPx?: number
  /** 圖面卡片本身的最小高度（CSS px），預設 520——「圖面高度至少 500px」的要求
   *  直接反映在容器高度上，不是只放大 SVG 內容、外框還是小卡片。 */
  minHeightPx?: number
}

function pointInPolygon(pt: { x: number; y: number }, vs: Array<{ x: number; y: number }>): boolean {
  let inside = false
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const xi = vs[i].x, yi = vs[i].y, xj = vs[j].x, yj = vs[j].y
    const intersect = ((yi > pt.y) !== (yj > pt.y)) && (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi + 1e-12) + xi)
    if (intersect) inside = !inside
  }
  return inside
}

function polyArea(vs: Array<{ x: number; y: number }>): number {
  let a = 0
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) a += (vs[j].x + vs[i].x) * (vs[j].y - vs[i].y)
  return Math.abs(a / 2)
}

interface IssueCluster {
  key: string
  x: number
  y: number
  points: ZoneMapIssuePoint[]
}

/** 單一 linkage 分群：同一群內任兩點距離 <= mergeDist 的點合併成一個徽章，
 *  n 通常只有幾十個（單區問題點數），O(n²) 完全足夠，不需要空間索引。 */
function clusterIssuePoints(zoneName: string, points: ZoneMapIssuePoint[], mergeDist: number): IssueCluster[] {
  const used = new Array(points.length).fill(false)
  const clusters: IssueCluster[] = []
  for (let i = 0; i < points.length; i++) {
    if (used[i]) continue
    const group = [points[i]]
    used[i] = true
    for (let j = i + 1; j < points.length; j++) {
      if (used[j]) continue
      if (Math.hypot(points[j].x - points[i].x, points[j].y - points[i].y) <= mergeDist) {
        group.push(points[j]); used[j] = true
      }
    }
    clusters.push({
      key: `${zoneName}-${i}`,
      x: group.reduce((s, p) => s + p.x, 0) / group.length,
      y: group.reduce((s, p) => s + p.y, 0) / group.length,
      points: group,
    })
  }
  return clusters
}

const RISK_COLOR = { danger: '#dc2626', caution: '#2563eb', passed: '#059669' }
const ZOOM_MIN = 1, ZOOM_MAX = 8, ZOOM_STEP = 1.4

const VIEW_MODE_OPTIONS: Array<{ key: ViewMode; label: string; icon: typeof LayoutGrid }> = [
  { key: 'zones', label: '分區', icon: LayoutGrid },
  { key: 'issues', label: '問題', icon: AlertCircle },
  { key: 'planting', label: '植栽', icon: Sprout },
  { key: 'ai', label: 'AI 分析', icon: Sparkles },
]

export default function ZoneOverviewMap({
  zones, activeZoneName, onSelectZone, onReset, focusPoints,
  selectedIssueId, onSelectIssuePoint, widthPx = 640, maxHeightPx = 420, minHeightPx = 520,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(widthPx)
  const [hoverZone, setHoverZone] = useState<string | null>(null)
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('zones')
  const [expandedCluster, setExpandedCluster] = useState<string | null>(null)
  const [hoverPointId, setHoverPointId] = useState<string | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [zoomLevel, setZoomLevel] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const dragState = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null)

  // 容器實際寬度決定圖面大小——不是寫死一個小的預設像素值，圖面才不會變成縮圖。
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width
      if (w && w > 100) setContainerWidth(Math.floor(w))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const effectiveMaxHeight = isFullscreen ? window.innerHeight - 180 : Math.max(maxHeightPx, minHeightPx)
  const effectiveWidth = isFullscreen ? window.innerWidth - 80 : containerWidth

  const withBoundary = useMemo(() => zones.filter(z => z.boundary && z.boundary.vertices.length >= 3), [zones])
  const hasIssuePoints = withBoundary.some(z => (z.issuePoints?.length ?? 0) > 0)

  const view = useMemo(() => {
    if (withBoundary.length === 0) return null
    const allVerts = withBoundary.flatMap(z => z.boundary!.vertices)
    const b = polyBounds(allVerts)
    const spanX = Math.max(b.maxX - b.minX, 1)
    const spanY = Math.max(b.maxY - b.minY, 1)
    const pad = Math.max(spanX, spanY) * 0.24 // 留足夠邊界空間給 AI tag／信心值文字＋角落分區的引線位移，避免邊界分區的標籤被裁切
    const viewMinX = b.minX - pad, viewMinY = b.minY - pad
    const viewW = spanX + pad * 2, viewH = spanY + pad * 2
    const { w: pxW, h: pxH } = fitDims(viewW / viewH, effectiveWidth, effectiveMaxHeight)
    return {
      viewMinX, viewMinY, viewW, viewH, pxW, pxH,
      scaleUnit: Math.max(viewW, viewH, 1),
      unitsPerPx: viewW / pxW,
      centerX: viewMinX + viewW / 2, centerY: viewMinY + viewH / 2,
      totalArea: viewW * viewH,
    }
  }, [withBoundary, effectiveWidth, effectiveMaxHeight])

  const zoneLayout = useMemo(() => {
    if (!view) return []
    return withBoundary.map(z => {
      const vs = z.boundary!.vertices
      const bounds = polyBounds(vs)
      const bw = Math.max(bounds.maxX - bounds.minX, 1e-6)
      const bh = Math.max(bounds.maxY - bounds.minY, 1e-6)
      const area = polyArea(vs)
      const aspect = Math.max(bw, bh) / Math.max(Math.min(bw, bh), 1e-6)
      const isSmall = area < view.totalArea * 0.012
      const isElongated = aspect > 4
      const needsLeader = isSmall || isElongated

      // 標籤錨點：優先用原圖文字標籤位置（通常就落在分區內），其次用頂點平均，
      // 兩者都落在多邊形外時（凹多邊形常見狀況）才退回外接框中心。
      const vertexAvg = { x: vs.reduce((s, v) => s + v.x, 0) / vs.length, y: vs.reduce((s, v) => s + v.y, 0) / vs.length }
      let anchor = z.labelPosition && pointInPolygon(z.labelPosition, vs) ? z.labelPosition
        : pointInPolygon(vertexAvg, vs) ? vertexAvg
        : { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }

      let labelPos = anchor
      if (needsLeader) {
        const dx = anchor.x - view.centerX, dy = anchor.y - view.centerY
        const dist = Math.hypot(dx, dy) || 1
        const offset = view.scaleUnit * 0.045
        labelPos = { x: anchor.x + (dx / dist) * offset, y: anchor.y + (dy / dist) * offset }
      }

      const clusters = clusterIssuePoints(z.zoneName, z.issuePoints ?? [], view.unitsPerPx * 26)

      return { entry: z, vs, bounds, anchor, labelPos, needsLeader, clusters }
    })
  }, [withBoundary, view])

  // ── 縮放／平移：改變「有效 viewBox」大小與位置，圖形與標記一起放大，符合直覺 ──
  const effView = useMemo(() => {
    if (!view) return null
    const w = view.viewW / zoomLevel
    const h = view.viewH / zoomLevel
    const minX = view.viewMinX + (view.viewW - w) / 2 + pan.x
    const minY = view.viewMinY + (view.viewH - h) / 2 + pan.y
    return { minX, minY, w, h }
  }, [view, zoomLevel, pan])

  const clampPan = (nextZoom: number, nextPan: { x: number; y: number }) => {
    if (!view) return nextPan
    const w = view.viewW / nextZoom, h = view.viewH / nextZoom
    const maxOffX = (view.viewW - w) / 2, maxOffY = (view.viewH - h) / 2
    return {
      x: Math.max(-maxOffX, Math.min(maxOffX, nextPan.x)),
      y: Math.max(-maxOffY, Math.min(maxOffY, nextPan.y)),
    }
  }

  const zoomBy = (factor: number) => {
    setZoomLevel(z => {
      const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z * factor))
      setPan(p => clampPan(next, p))
      return next
    })
  }
  const resetView = () => { setZoomLevel(1); setPan({ x: 0, y: 0 }) }

  const handleWheel: WheelEventHandler<SVGSVGElement> = e => {
    if (!view) return
    e.preventDefault()
    zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP)
  }
  const handlePointerDown: PointerEventHandler<SVGSVGElement> = e => {
    if (zoomLevel <= 1) return
    dragState.current = { startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }
  const handlePointerMove: PointerEventHandler<SVGSVGElement> = e => {
    if (!dragState.current || !view) return
    const dxPx = e.clientX - dragState.current.startX
    const dyPx = e.clientY - dragState.current.startY
    const unitsPerPxNow = (view.viewW / zoomLevel) / view.pxW
    // SVG 內容整體做了一次 Y 翻轉（DXF 座標系 Y 向上），拖曳方向要跟著反過來對應。
    const next = { x: dragState.current.panX - dxPx * unitsPerPxNow, y: dragState.current.panY + dyPx * unitsPerPxNow }
    setPan(clampPan(zoomLevel, next))
  }
  const handlePointerUp: PointerEventHandler<SVGSVGElement> = () => { dragState.current = null }

  if (!view || !effView) {
    return <p className="text-base text-stone-400 py-6 text-center">本圖面未偵測到可辨識之植栽分區邊界，無法顯示總覽圖。</p>
  }

  const fontSize = view.scaleUnit * 0.034
  const hoveredEntry = hoverZone ? zoneLayout.find(zl => zl.entry.zoneName === hoverZone)?.entry : null
  const px = (n: number) => n * view.unitsPerPx / zoomLevel // 螢幕像素 → 資料座標單位（考慮目前縮放）

  const mapCard = (
    <div className={isFullscreen ? 'fixed inset-0 z-[100] bg-white flex flex-col p-4 md:p-6' : ''}>
      {/* 工具列：檢視模式切換 + 縮放／平移／重設／全螢幕 */}
      <div className="flex items-center justify-between mb-2.5 gap-2 flex-wrap">
        <div className="inline-flex rounded-xl border border-stone-200 overflow-hidden text-sm shadow-sm">
          {VIEW_MODE_OPTIONS.filter(o => o.key !== 'issues' || hasIssuePoints).map(opt => {
            const Icon = opt.icon
            const active = viewMode === opt.key
            return (
              <button
                key={opt.key}
                onClick={() => setViewMode(opt.key)}
                className={`px-3 py-2 font-semibold flex items-center gap-1.5 transition-colors ${
                  active ? 'bg-[#1a4731] text-white' : 'bg-white text-stone-600 hover:bg-stone-50'
                }`}
              >
                <Icon size={15} />{opt.label}
              </button>
            )
          })}
        </div>
        <div className="flex items-center gap-1.5">
          {activeZoneName && onReset && (
            <button onClick={onReset} className="px-3 py-2 rounded-lg text-sm font-semibold border border-stone-200 bg-white text-stone-600 hover:bg-stone-50">
              ↺ 回到全區
            </button>
          )}
          <div className="inline-flex rounded-lg border border-stone-200 overflow-hidden shadow-sm">
            <button onClick={() => zoomBy(1 / ZOOM_STEP)} title="縮小" className="p-2.5 bg-white hover:bg-stone-50 text-stone-600 border-r border-stone-200"><ZoomOut size={17} /></button>
            <button onClick={() => zoomBy(ZOOM_STEP)} title="放大" className="p-2.5 bg-white hover:bg-stone-50 text-stone-600 border-r border-stone-200"><ZoomIn size={17} /></button>
            <button onClick={resetView} title="重設視圖" className="p-2.5 bg-white hover:bg-stone-50 text-stone-600 border-r border-stone-200"><RotateCcw size={16} /></button>
            <button onClick={() => setIsFullscreen(v => !v)} title={isFullscreen ? '離開全螢幕' : '全螢幕檢視'} className="p-2.5 bg-white hover:bg-stone-50 text-stone-600">
              {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
          </div>
        </div>
      </div>

      <div ref={containerRef} className="relative w-full" style={{ height: isFullscreen ? undefined : minHeightPx, flex: isFullscreen ? 1 : undefined }}>
        <svg
          width={view.pxW} height={view.pxH}
          viewBox={`${effView.minX} ${effView.minY} ${effView.w} ${effView.h}`}
          className="bg-[#f8faf7] border border-stone-200 rounded-2xl w-full h-full shadow-sm"
          style={{ cursor: zoomLevel > 1 ? 'grab' : 'default', touchAction: 'none' }}
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
        >
          <defs>
            {/* 極淡 AI 掃描網格：只在 AI 分析模式顯示，透明度刻意壓低，不影響閱讀 */}
            <pattern id="ai-scan-grid" width={view.scaleUnit * 0.035} height={view.scaleUnit * 0.035} patternUnits="userSpaceOnUse">
              <path d={`M ${view.scaleUnit * 0.035} 0 L 0 0 0 ${view.scaleUnit * 0.035}`} fill="none" stroke="#15803d" strokeWidth={view.scaleUnit * 0.0006} opacity={0.5} />
            </pattern>
          </defs>

          {viewMode === 'ai' && (
            <rect x={view.viewMinX} y={view.viewMinY} width={view.viewW} height={view.viewH} fill="url(#ai-scan-grid)" opacity={0.35} />
          )}

          <g transform={`translate(0, ${2 * view.viewMinY + view.viewH}) scale(1,-1)`}>
            {zoneLayout.map(({ entry: z, vs, anchor, labelPos, needsLeader, clusters }) => {
              const identityColor = getZoneColor(z.colorIndex)
              const isActive = activeZoneName === z.zoneName
              const isDimmed = !!activeZoneName && !isActive
              const isHovered = hoverZone === z.zoneName
              const riskColor = z.dangerCount > 0 ? RISK_COLOR.danger : z.cautionCount > 0 ? RISK_COLOR.caution : RISK_COLOR.passed
              const statusLabel = z.dangerCount > 0 ? `嚴重 ${z.dangerCount}` : z.cautionCount > 0 ? `提醒 ${z.cautionCount}` : '通過'
              const showAiTag = viewMode === 'ai' || isActive || isHovered

              const fillOpacity = isDimmed ? 0.05 : (isActive || isHovered) ? 0.32 : 0.17
              const strokeWidth = isActive ? view.scaleUnit * 0.0075 : isHovered ? view.scaleUnit * 0.005 : view.scaleUnit * 0.003
              const points = ringToPoints(vs)

              // AI tag 寬度用字元數概算（中文字約 1 個字寬，數字/符號約 0.55 個字寬）
              const tagText = `${z.zoneName}｜${statusLabel}`
              const tagW = tagText.length * fontSize * 0.62 + fontSize * 1.1
              const tagH = fontSize * 1.5

              return (
                <g key={z.zoneName}>
                  <g
                    onClick={() => onSelectZone?.(z.zoneName)}
                    onMouseEnter={() => setHoverZone(z.zoneName)}
                    onMouseMove={e => setTooltipPos({ x: e.clientX, y: e.clientY })}
                    onMouseLeave={() => { setHoverZone(null); setTooltipPos(null) }}
                    style={{ cursor: onSelectZone ? 'pointer' : 'default', opacity: isDimmed ? 0.55 : 1 }}
                  >
                    {/* 分區識別色（填色）＋風險色（外框，柔和光暈感：外層一圈淡色再疊實線） */}
                    {(isActive || isHovered) && (
                      <polygon points={points} fill="none" stroke={riskColor} strokeWidth={strokeWidth * 2.6} opacity={0.18} />
                    )}
                    <polygon points={points} fill={identityColor} fillOpacity={fillOpacity} stroke={riskColor} strokeWidth={strokeWidth} />

                    {/* 狹長／小面積分區的引線 */}
                    {needsLeader && (
                      <line x1={anchor.x} y1={anchor.y} x2={labelPos.x} y2={labelPos.y}
                        stroke="#78716c" strokeWidth={view.scaleUnit * 0.0012} strokeDasharray={`${view.scaleUnit * 0.003} ${view.scaleUnit * 0.003}`} />
                    )}
                    {needsLeader && <circle cx={anchor.x} cy={anchor.y} r={view.scaleUnit * 0.004} fill="#57534e" />}

                    {/* AI tag 風格標籤：C區｜已分析 / F區｜提醒2 / A區｜通過 */}
                    <g transform={`translate(${labelPos.x},${labelPos.y}) scale(1,-1)`}>
                      {showAiTag ? (
                        <>
                          <rect x={-tagW / 2} y={-tagH / 2} width={tagW} height={tagH} rx={tagH / 2}
                            fill={isDimmed ? '#f5f5f4' : '#1a4731'} opacity={isDimmed ? 0.7 : 0.94} />
                          <text fontSize={fontSize * 0.82} fill="#ffffff" fontWeight={700} textAnchor="middle" dominantBaseline="central"
                            fontFamily="'Microsoft JhengHei','Noto Sans TC',sans-serif">
                            {z.zoneName}｜{viewMode === 'ai' && z.dangerCount === 0 && z.cautionCount === 0 ? '已分析' : statusLabel}
                          </text>
                        </>
                      ) : (
                        <text fontSize={fontSize} fill={isDimmed ? '#a8a29e' : '#292524'} fontWeight={700}
                          textAnchor="middle" fontFamily="'Microsoft JhengHei','Noto Sans TC',sans-serif">
                          {z.zoneName}
                        </text>
                      )}
                      {viewMode === 'ai' && z.matchConfidencePercent !== undefined && (
                        <text y={tagH * 0.95} fontSize={fontSize * 0.56} fill={isDimmed ? '#a8a29e' : '#15803d'} fontWeight={600}
                          textAnchor="middle" fontFamily="'Microsoft JhengHei','Noto Sans TC',sans-serif">
                          Confidence {z.matchConfidencePercent}%
                        </text>
                      )}
                      {viewMode === 'planting' && z.plantSummary && (
                        <text y={tagH * 0.95} fontSize={fontSize * 0.56} fill={isDimmed ? '#a8a29e' : '#44403c'} fontWeight={600}
                          textAnchor="middle" fontFamily="'Microsoft JhengHei','Noto Sans TC',sans-serif">
                          {z.plantSummary}
                        </text>
                      )}
                    </g>
                  </g>

                  {/* 分區＋問題點檢視：放大、可點擊、重疊時聚合成徽章 */}
                  {viewMode === 'issues' && clusters.map(cluster => {
                    if (cluster.points.length === 1 && expandedCluster !== cluster.key) {
                      const p = cluster.points[0]
                      const isSelected = selectedIssueId === p.id
                      const isPtHovered = hoverPointId === p.id
                      const big = isSelected || isPtHovered
                      // 半透明範圍標記＋問題編號，不是很小的點——最小視覺尺寸約 20~24px，
                      // hover/selected 放大到 28~32px，確保編號文字看得清楚也點得到。
                      const baseDiameterPx = p.severity === 'danger' ? 24 : 20
                      const activeDiameterPx = p.severity === 'danger' ? 32 : 28
                      const r = px(big ? activeDiameterPx : baseDiameterPx) / 2
                      const color = p.severity === 'danger' ? RISK_COLOR.danger : RISK_COLOR.caution
                      return (
                        <g key={p.id}
                          onClick={e => { e.stopPropagation(); onSelectIssuePoint?.(z.zoneName, p.id) }}
                          onMouseEnter={e => { e.stopPropagation(); setHoverPointId(p.id) }}
                          onMouseLeave={e => { e.stopPropagation(); setHoverPointId(null) }}
                          style={{ cursor: onSelectIssuePoint ? 'pointer' : 'default', opacity: isDimmed ? 0.35 : 1 }}
                        >
                          {/* 更大的透明命中區，避免小點難點擊 */}
                          <circle cx={p.x} cy={p.y} r={r + px(8)} fill="transparent" />
                          {isSelected && (
                            <circle cx={p.x} cy={p.y} r={r + px(6)} fill="none" stroke={color} strokeWidth={px(2)} opacity={0.55} />
                          )}
                          <circle cx={p.x} cy={p.y} r={r} fill={color} fillOpacity={0.35} stroke={color} strokeWidth={px(2)}
                            style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.35))' }} />
                          <g transform={`translate(${p.x},${p.y}) scale(1,-1)`}>
                            <text fontSize={px(11)} fill={color} fontWeight={800} textAnchor="middle" dominantBaseline="central"
                              fontFamily="'Microsoft JhengHei','Noto Sans TC',sans-serif">
                              {p.label ?? ''}
                            </text>
                          </g>
                        </g>
                      )
                    }

                    // Cluster 徽章：多個問題點聚合，顯示數量，點擊展開成個別半透明範圍標記
                    if (expandedCluster === cluster.key) {
                      const n = cluster.points.length
                      const spreadR = px(34)
                      return (
                        <g key={cluster.key}>
                          {cluster.points.map((p, idx) => {
                            const angle = (idx / n) * Math.PI * 2
                            const ex = cluster.x + Math.cos(angle) * spreadR
                            const ey = cluster.y + Math.sin(angle) * spreadR
                            const isSelected = selectedIssueId === p.id
                            const color = p.severity === 'danger' ? RISK_COLOR.danger : RISK_COLOR.caution
                            const r = px(isSelected ? (p.severity === 'danger' ? 32 : 28) : (p.severity === 'danger' ? 24 : 20)) / 2
                            return (
                              <g key={p.id}
                                onClick={e => { e.stopPropagation(); onSelectIssuePoint?.(z.zoneName, p.id) }}
                                style={{ cursor: onSelectIssuePoint ? 'pointer' : 'default' }}
                              >
                                <line x1={cluster.x} y1={cluster.y} x2={ex} y2={ey} stroke="#78716c" strokeWidth={px(1)} opacity={0.5} />
                                <circle cx={ex} cy={ey} r={r + px(8)} fill="transparent" />
                                <circle cx={ex} cy={ey} r={r} fill={color} fillOpacity={0.35} stroke={color} strokeWidth={px(2)}
                                  style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.35))' }} />
                                <g transform={`translate(${ex},${ey}) scale(1,-1)`}>
                                  <text fontSize={px(10)} fill={color} fontWeight={800} textAnchor="middle" dominantBaseline="central"
                                    fontFamily="'Microsoft JhengHei','Noto Sans TC',sans-serif">
                                    {p.label ?? ''}
                                  </text>
                                </g>
                              </g>
                            )
                          })}
                          <g onClick={e => { e.stopPropagation(); setExpandedCluster(null) }} style={{ cursor: 'pointer' }}>
                            <circle cx={cluster.x} cy={cluster.y} r={px(11)} fill="#57534e" stroke="#fff" strokeWidth={px(2)} />
                            <g transform={`translate(${cluster.x},${cluster.y}) scale(1,-1)`}>
                              <text fontSize={px(12)} fill="#fff" fontWeight={700} textAnchor="middle" dominantBaseline="central">×</text>
                            </g>
                          </g>
                        </g>
                      )
                    }

                    const hasDanger = cluster.points.some(p => p.severity === 'danger')
                    const badgeColor = hasDanger ? RISK_COLOR.danger : RISK_COLOR.caution
                    const badgeR = px(Math.min(16 + cluster.points.length, 26))
                    return (
                      <g key={cluster.key}
                        onClick={e => { e.stopPropagation(); setExpandedCluster(cluster.key) }}
                        style={{ cursor: 'pointer', opacity: isDimmed ? 0.35 : 1 }}
                      >
                        <circle cx={cluster.x} cy={cluster.y} r={badgeR + px(6)} fill="transparent" />
                        <circle cx={cluster.x} cy={cluster.y} r={badgeR} fill={badgeColor} fillOpacity={0.85} stroke="#fff" strokeWidth={px(2.5)}
                          style={{ filter: 'drop-shadow(0 1px 3px rgba(0,0,0,.5))' }} />
                        <g transform={`translate(${cluster.x},${cluster.y}) scale(1,-1)`}>
                          <text fontSize={px(13)} fill="#fff" fontWeight={800} textAnchor="middle" dominantBaseline="central">
                            {cluster.points.length}
                          </text>
                        </g>
                      </g>
                    )
                  })}
                </g>
              )
            })}

            {/* 目前選取問題卡片的實際座標點：先高亮分區（外層 activeZoneName 已處理），再標實際點 */}
            {focusPoints?.map((p, idx) => (
              <g key={idx}>
                <circle cx={p.x} cy={p.y} r={view.scaleUnit * 0.011}
                  fill="none" stroke={p.severity === 'danger' ? RISK_COLOR.danger : RISK_COLOR.caution}
                  strokeWidth={view.scaleUnit * 0.0035} />
                <circle cx={p.x} cy={p.y} r={view.scaleUnit * 0.005}
                  fill={p.severity === 'danger' ? RISK_COLOR.danger : RISK_COLOR.caution} />
              </g>
            ))}
          </g>
        </svg>

        {hoveredEntry && tooltipPos && (
          <div
            className="fixed z-50 pointer-events-none bg-stone-800 text-white text-sm rounded-xl px-4 py-3 shadow-lg space-y-1"
            style={{ left: tooltipPos.x + 16, top: tooltipPos.y + 16 }}
          >
            <div className="font-bold text-base">{hoveredEntry.zoneName}</div>
            {hoveredEntry.areaM2 !== undefined && <div>面積：{hoveredEntry.areaM2.toFixed(1)} ㎡</div>}
            {hoveredEntry.plantSummary && <div>{hoveredEntry.plantSummary}</div>}
            {hoveredEntry.matchConfidencePercent !== undefined && (
              <div className="text-emerald-300">辨識信心度：{hoveredEntry.matchConfidencePercent}%</div>
            )}
            <div className="flex gap-2.5 pt-0.5">
              <span className="text-red-300">嚴重 {hoveredEntry.dangerCount}</span>
              <span className="text-blue-300">提醒 {hoveredEntry.cautionCount}</span>
              <span className="text-emerald-300">通過 {hoveredEntry.passedCount}</span>
            </div>
          </div>
        )}
      </div>

      <p className="text-sm text-stone-400 mt-2">
        本圖依 DXF 可辨識植栽分區產生，不含建築底圖。{zoomLevel > 1 && '拖曳可平移，滾輪可縮放。'}
      </p>
    </div>
  )

  return mapCard
}
