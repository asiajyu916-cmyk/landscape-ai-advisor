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
// 問題點（issuePoints）的可視性／可點擊性是這輪優化的重點：視覺尺寸與 hit-area
// 都是「換算成螢幕像素」再回推資料座標（unitsPerPx），不是相對 viewBox 大小的
// 比例值——否則地圖縮放時點位會忽大忽小，或在資料密集的大圖上小到點不到。

import { useMemo, useState } from 'react'
import { polyBounds, ringToPoints, fitDims, getZoneColor } from '@/utils/dxfReportBuilder'
import type { DxfPolygon } from '@/types/dxf'

export interface ZoneMapIssuePoint {
  id: string
  x: number
  y: number
  severity: 'danger' | 'caution'
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
}

export interface FocusPoint {
  x: number
  y: number
  severity: 'danger' | 'caution'
}

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
  widthPx?: number
  maxHeightPx?: number
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

export default function ZoneOverviewMap({
  zones, activeZoneName, onSelectZone, onReset, focusPoints,
  selectedIssueId, onSelectIssuePoint, widthPx = 640, maxHeightPx = 420,
}: Props) {
  const [hoverZone, setHoverZone] = useState<string | null>(null)
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null)
  const [viewMode, setViewMode] = useState<'zones' | 'zones-issues'>('zones')
  const [expandedCluster, setExpandedCluster] = useState<string | null>(null)
  const [hoverPointId, setHoverPointId] = useState<string | null>(null)

  const withBoundary = useMemo(() => zones.filter(z => z.boundary && z.boundary.vertices.length >= 3), [zones])
  const hasIssuePoints = withBoundary.some(z => (z.issuePoints?.length ?? 0) > 0)

  const view = useMemo(() => {
    if (withBoundary.length === 0) return null
    const allVerts = withBoundary.flatMap(z => z.boundary!.vertices)
    const b = polyBounds(allVerts)
    const spanX = Math.max(b.maxX - b.minX, 1)
    const spanY = Math.max(b.maxY - b.minY, 1)
    const pad = Math.max(spanX, spanY) * 0.08 // 5%~10% padding，真實比例不扭曲
    const viewMinX = b.minX - pad, viewMinY = b.minY - pad
    const viewW = spanX + pad * 2, viewH = spanY + pad * 2
    const { w: pxW, h: pxH } = fitDims(viewW / viewH, widthPx, maxHeightPx)
    return {
      viewMinX, viewMinY, viewW, viewH, pxW, pxH,
      scaleUnit: Math.max(viewW, viewH, 1),
      unitsPerPx: viewW / pxW,
      centerX: viewMinX + viewW / 2, centerY: viewMinY + viewH / 2,
      totalArea: viewW * viewH,
    }
  }, [withBoundary, widthPx, maxHeightPx])

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

  if (!view) {
    return <p className="text-sm text-stone-400 py-6 text-center">本圖面未偵測到可辨識之植栽分區邊界，無法顯示總覽圖。</p>
  }

  const fontSize = view.scaleUnit * 0.03
  const hoveredEntry = hoverZone ? zoneLayout.find(zl => zl.entry.zoneName === hoverZone)?.entry : null
  const px = (n: number) => n * view.unitsPerPx // 螢幕像素 → 資料座標單位

  return (
    <div className="relative inline-block">
      {/* 檢視切換 + 回到全區 */}
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        {hasIssuePoints ? (
          <div className="inline-flex rounded-lg border border-stone-200 overflow-hidden text-xs">
            <button
              onClick={() => setViewMode('zones')}
              className={`px-2.5 py-1 font-medium ${viewMode === 'zones' ? 'bg-green-600 text-white' : 'bg-white text-stone-500 hover:bg-stone-50'}`}
            >純分區</button>
            <button
              onClick={() => setViewMode('zones-issues')}
              className={`px-2.5 py-1 font-medium ${viewMode === 'zones-issues' ? 'bg-green-600 text-white' : 'bg-white text-stone-500 hover:bg-stone-50'}`}
            >分區＋問題點</button>
          </div>
        ) : <span />}
        {activeZoneName && onReset && (
          <button onClick={onReset} className="px-2.5 py-1 rounded-lg text-xs font-medium border border-stone-200 bg-white text-stone-600 hover:bg-stone-50">
            ↺ 回到全區
          </button>
        )}
      </div>

      <svg
        width={view.pxW} height={view.pxH}
        viewBox={`${view.viewMinX} ${view.viewMinY} ${view.viewW} ${view.viewH}`}
        className="bg-[#f7faf5] border border-stone-200 rounded-xl w-full h-auto"
        style={{ maxWidth: view.pxW }}
      >
        <g transform={`translate(0, ${2 * view.viewMinY + view.viewH}) scale(1,-1)`}>
          {zoneLayout.map(({ entry: z, vs, anchor, labelPos, needsLeader, clusters }) => {
            const identityColor = getZoneColor(z.colorIndex)
            const isActive = activeZoneName === z.zoneName
            const isDimmed = !!activeZoneName && !isActive
            const isHovered = hoverZone === z.zoneName
            const riskColor = z.dangerCount > 0 ? RISK_COLOR.danger : z.cautionCount > 0 ? RISK_COLOR.caution : RISK_COLOR.passed

            const fillOpacity = isDimmed ? 0.05 : (isActive || isHovered) ? 0.30 : 0.16
            const strokeWidth = isActive ? view.scaleUnit * 0.0075 : isHovered ? view.scaleUnit * 0.005 : view.scaleUnit * 0.0028
            const points = ringToPoints(vs)

            return (
              <g key={z.zoneName}>
                <g
                  onClick={() => onSelectZone?.(z.zoneName)}
                  onMouseEnter={() => setHoverZone(z.zoneName)}
                  onMouseMove={e => setTooltipPos({ x: e.clientX, y: e.clientY })}
                  onMouseLeave={() => { setHoverZone(null); setTooltipPos(null) }}
                  style={{ cursor: onSelectZone ? 'pointer' : 'default', opacity: isDimmed ? 0.55 : 1 }}
                >
                  {/* 分區識別色（填色）＋風險色（外框） */}
                  <polygon points={points} fill={identityColor} fillOpacity={fillOpacity} stroke={riskColor} strokeWidth={strokeWidth} />

                  {/* 狹長／小面積分區的引線 */}
                  {needsLeader && (
                    <line x1={anchor.x} y1={anchor.y} x2={labelPos.x} y2={labelPos.y}
                      stroke="#78716c" strokeWidth={view.scaleUnit * 0.0012} strokeDasharray={`${view.scaleUnit * 0.003} ${view.scaleUnit * 0.003}`} />
                  )}
                  {needsLeader && <circle cx={anchor.x} cy={anchor.y} r={view.scaleUnit * 0.004} fill="#57534e" />}

                  {/* 標籤：放在 visual center（或引線末端），文字反轉一次維持正立 */}
                  <g transform={`translate(${labelPos.x},${labelPos.y}) scale(1,-1)`}>
                    <text fontSize={fontSize} fill={isDimmed ? '#a8a29e' : '#292524'} fontWeight={700}
                      textAnchor="middle" fontFamily="'Microsoft JhengHei','Noto Sans TC',sans-serif">
                      {z.zoneName}
                    </text>
                    {(isActive || isHovered) && (
                      <text y={fontSize * 1.3} fontSize={fontSize * 0.65} fill="#44403c" textAnchor="middle"
                        fontFamily="'Microsoft JhengHei','Noto Sans TC',sans-serif">
                        {z.dangerCount > 0 ? `嚴重${z.dangerCount}` : z.cautionCount > 0 ? `提醒${z.cautionCount}` : '通過為主'}
                      </text>
                    )}
                  </g>
                </g>

                {/* 分區＋問題點檢視：放大、可點擊、重疊時聚合成徽章 */}
                {viewMode === 'zones-issues' && clusters.map(cluster => {
                  if (cluster.points.length === 1 && expandedCluster !== cluster.key) {
                    const p = cluster.points[0]
                    const isSelected = selectedIssueId === p.id
                    const isPtHovered = hoverPointId === p.id
                    const big = isSelected || isPtHovered
                    const baseDiameterPx = p.severity === 'danger' ? 14 : 11
                    const activeDiameterPx = p.severity === 'danger' ? 20 : 16
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
                        <circle cx={p.x} cy={p.y} r={r + px(6)} fill="transparent" />
                        {isSelected && (
                          <circle cx={p.x} cy={p.y} r={r + px(6)} fill="none" stroke={color} strokeWidth={px(2)} opacity={0.55} />
                        )}
                        <circle cx={p.x} cy={p.y} r={r} fill={color} stroke="#fff" strokeWidth={px(2)}
                          style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.45))' }} />
                      </g>
                    )
                  }

                  // Cluster 徽章：多個問題點聚合，顯示數量，點擊展開成個別點
                  if (expandedCluster === cluster.key) {
                    const n = cluster.points.length
                    const spreadR = px(26)
                    return (
                      <g key={cluster.key}>
                        {cluster.points.map((p, idx) => {
                          const angle = (idx / n) * Math.PI * 2
                          const ex = cluster.x + Math.cos(angle) * spreadR
                          const ey = cluster.y + Math.sin(angle) * spreadR
                          const isSelected = selectedIssueId === p.id
                          const color = p.severity === 'danger' ? RISK_COLOR.danger : RISK_COLOR.caution
                          const r = px(isSelected ? (p.severity === 'danger' ? 20 : 16) : (p.severity === 'danger' ? 14 : 11)) / 2
                          return (
                            <g key={p.id}
                              onClick={e => { e.stopPropagation(); onSelectIssuePoint?.(z.zoneName, p.id) }}
                              style={{ cursor: onSelectIssuePoint ? 'pointer' : 'default' }}
                            >
                              <line x1={cluster.x} y1={cluster.y} x2={ex} y2={ey} stroke="#78716c" strokeWidth={px(1)} opacity={0.5} />
                              <circle cx={ex} cy={ey} r={r + px(6)} fill="transparent" />
                              <circle cx={ex} cy={ey} r={r} fill={color} stroke="#fff" strokeWidth={px(2)}
                                style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.45))' }} />
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
                  const badgeR = px(Math.min(12 + cluster.points.length, 20))
                  return (
                    <g key={cluster.key}
                      onClick={e => { e.stopPropagation(); setExpandedCluster(cluster.key) }}
                      style={{ cursor: 'pointer', opacity: isDimmed ? 0.35 : 1 }}
                    >
                      <circle cx={cluster.x} cy={cluster.y} r={badgeR + px(6)} fill="transparent" />
                      <circle cx={cluster.x} cy={cluster.y} r={badgeR} fill={badgeColor} stroke="#fff" strokeWidth={px(2.5)}
                        style={{ filter: 'drop-shadow(0 1px 3px rgba(0,0,0,.5))' }} />
                      <g transform={`translate(${cluster.x},${cluster.y}) scale(1,-1)`}>
                        <text fontSize={px(12)} fill="#fff" fontWeight={800} textAnchor="middle" dominantBaseline="central">
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

      <p className="text-xs text-stone-400 mt-1.5">本圖依 DXF 可辨識植栽分區產生，不含建築底圖。</p>

      {hoveredEntry && tooltipPos && (
        <div
          className="fixed z-50 pointer-events-none bg-stone-800 text-white text-xs rounded-lg px-3 py-2 shadow-lg space-y-0.5"
          style={{ left: tooltipPos.x + 14, top: tooltipPos.y + 14 }}
        >
          <div className="font-bold text-sm">{hoveredEntry.zoneName}</div>
          {hoveredEntry.areaM2 !== undefined && <div>面積：{hoveredEntry.areaM2.toFixed(1)} ㎡</div>}
          {hoveredEntry.plantSummary && <div>{hoveredEntry.plantSummary}</div>}
          <div className="flex gap-2 pt-0.5">
            <span className="text-red-300">嚴重 {hoveredEntry.dangerCount}</span>
            <span className="text-blue-300">提醒 {hoveredEntry.cautionCount}</span>
            <span className="text-emerald-300">通過 {hoveredEntry.passedCount}</span>
          </div>
        </div>
      )}
    </div>
  )
}
