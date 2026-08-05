// ── ZoneMiniPreview.tsx — 分區小圖卡的分區預覽圖 ─────────────────────────────
// 目的：「各區卡片」不要只是文字加標題，改成有分區輪廓＋高亮＋問題標記的小型
// 靜態預覽——比起整顆互動地圖元件（ZoneOverviewMap）輕量很多，13 張卡片同時
// 掛載也不會卡。純顯示，不需要點擊/縮放/拖曳，只用來讓卡片有「看得出形狀」的
// 分析感，跟 ZoneOverviewMap 用同一套座標／顏色換算（getZoneColor／ringToPoints）
// 保持視覺一致。

import { polyBounds, ringToPoints, getZoneColor } from '@/utils/dxfReportBuilder'
import type { DxfPolygon } from '@/types/dxf'

interface Props {
  boundary?: DxfPolygon
  colorIndex: number
  riskColor: string
  issuePointCount?: number
  heightPx?: number
}

export default function ZoneMiniPreview({ boundary, colorIndex, riskColor, issuePointCount, heightPx = 108 }: Props) {
  if (!boundary || boundary.vertices.length < 3) {
    return (
      <div className="w-full flex items-center justify-center bg-stone-50 rounded-xl text-stone-300 text-sm" style={{ height: heightPx }}>
        無圖面資料
      </div>
    )
  }
  const b = polyBounds(boundary.vertices)
  const spanX = Math.max(b.maxX - b.minX, 1)
  const spanY = Math.max(b.maxY - b.minY, 1)
  const pad = Math.max(spanX, spanY) * 0.14
  const viewMinX = b.minX - pad, viewMinY = b.minY - pad
  const viewW = spanX + pad * 2, viewH = spanY + pad * 2
  const points = ringToPoints(boundary.vertices)
  const color = getZoneColor(colorIndex)
  const scaleUnit = Math.max(viewW, viewH, 1)

  return (
    <svg
      viewBox={`${viewMinX} ${viewMinY} ${viewW} ${viewH}`}
      width="100%" height={heightPx}
      className="bg-[#f7faf5] rounded-xl border border-stone-100"
      preserveAspectRatio="xMidYMid meet"
    >
      <g transform={`translate(0, ${2 * viewMinY + viewH}) scale(1,-1)`}>
        <polygon points={points} fill={color} fillOpacity={0.24} stroke={riskColor} strokeWidth={scaleUnit * 0.014} />
      </g>
      {!!issuePointCount && (
        <g transform={`translate(10, 18)`}>
          <circle r="9" fill={riskColor} opacity={0.92} />
          <text textAnchor="middle" dominantBaseline="central" fontSize="10" fill="#fff" fontWeight={800}>{issuePointCount}</text>
        </g>
      )}
    </svg>
  )
}
