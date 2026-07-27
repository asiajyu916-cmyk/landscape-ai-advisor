// ── DrawingLocatorModal.tsx — 「在圖面定位」視覺化 ─────────────────────────────
// 獨立、自成一體的彈窗：不依賴任何既有的 DXF 畫布（本專案目前沒有），自己畫一個
// 縮放到目標配對範圍的簡易 SVG 示意圖——目標兩個植栽高亮，其餘同分區植栽淡化，
// 兩者中心點之間畫一條距離線。距離數字仍直接沿用既有管線算出的 distanceCm，
// 這裡的連線只是視覺示意（中心點對中心點），不重新計算最近點幾何。

import type { SpatialPlantInstance } from '@/types/dxf'
import { X } from 'lucide-react'

interface Props {
  instances: SpatialPlantInstance[]
  targetIds: [string, string]
  distanceCm: number
  relationshipLabel: string
  onClose: () => void
}

export default function DrawingLocatorModal({ instances, targetIds, distanceCm, relationshipLabel, onClose }: Props) {
  const targetA = instances.find(i => i.id === targetIds[0])
  const targetB = instances.find(i => i.id === targetIds[1])

  if (!targetA || !targetB) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
        <div className="bg-white rounded-2xl p-6 max-w-sm" onClick={e => e.stopPropagation()}>
          <p className="text-sm text-stone-600">找不到對應的圖面幾何資料，無法定位。</p>
          <button type="button" onClick={onClose} className="mt-4 px-4 py-2 rounded-lg bg-stone-100 text-sm text-stone-700">關閉</button>
        </div>
      </div>
    )
  }

  const unionMinX = Math.min(targetA.bbox.minX, targetB.bbox.minX)
  const unionMaxX = Math.max(targetA.bbox.maxX, targetB.bbox.maxX)
  const unionMinY = Math.min(targetA.bbox.minY, targetB.bbox.minY)
  const unionMaxY = Math.max(targetA.bbox.maxY, targetB.bbox.maxY)
  const spanX = unionMaxX - unionMinX
  const spanY = unionMaxY - unionMinY
  const scaleUnit = Math.max(spanX, spanY, 1)
  const padding = scaleUnit * 0.3
  const viewMinX = unionMinX - padding
  const viewMinY = unionMinY - padding
  const viewW = spanX + padding * 2
  const viewH = spanY + padding * 2

  const dimStroke = scaleUnit * 0.003
  const targetStroke = scaleUnit * 0.007
  const minRadius = scaleUnit * 0.008

  // 只淡化顯示「範圍真的落在可視區域內」的其他植栽——分區內可能有樹冠 buffer
  // 半徑很大的喬木（尤其資料庫查無冠幅、退回用 block bbox 估算的粗略半徑），
  // 中心點雖在畫面外，巨大的圓仍可能掃進可視範圍，看起來像來源不明的大色塊。
  const viewBounds = { minX: viewMinX, maxX: viewMinX + viewW, minY: viewMinY, maxY: viewMinY + viewH }
  const others = instances.filter(i => {
    if (i.id === targetA.id || i.id === targetB.id) return false
    return !(i.bbox.maxX < viewBounds.minX || i.bbox.minX > viewBounds.maxX ||
             i.bbox.maxY < viewBounds.minY || i.bbox.minY > viewBounds.maxY)
  })

  const renderInstance = (inst: SpatialPlantInstance, fillClass: string, strokeClass: string, strokeWidth: number) => {
    if (inst.kind === 'tree') {
      return (
        <circle
          key={inst.id} cx={inst.center.x} cy={inst.center.y}
          r={Math.max(inst.canopyRadius ?? 0, minRadius)}
          className={`${fillClass} ${strokeClass}`} strokeWidth={strokeWidth}
        />
      )
    }
    if (inst.polygonRings?.[0]) {
      const points = inst.polygonRings[0].map(v => `${v.x},${v.y}`).join(' ')
      return <polygon key={inst.id} points={points} className={`${fillClass} ${strokeClass}`} strokeWidth={strokeWidth} />
    }
    return null
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-5 w-full max-w-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className="text-sm font-bold text-stone-800">{targetA.plantName ?? targetA.label} × {targetB.plantName ?? targetB.label}</p>
            <p className="text-xs text-stone-500 mt-0.5">{relationshipLabel}｜最近距離 {distanceCm} cm</p>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-stone-100 text-stone-500">
            <X size={18} />
          </button>
        </div>

        <svg
          viewBox={`${viewMinX} ${viewMinY} ${viewW} ${viewH}`}
          className="w-full aspect-square bg-stone-50 rounded-xl border border-stone-200"
        >
          {/* DXF/CAD 座標 Y 軸向上為正，SVG viewBox 的 Y 軸向下為正——不翻轉的話畫面會
              上下顛倒（跟 AutoCAD 實際圖面相反），容易誤判植栽的相對位置。這裡把所有
              幾何包在一個垂直翻轉的群組裡，翻轉後的畫面方向才會跟原始圖面一致。 */}
          <g transform={`translate(0, ${2 * viewMinY + viewH}) scale(1, -1)`}>
            {others.map(inst => renderInstance(inst, 'fill-stone-300/30', 'stroke-stone-300', dimStroke))}
            {renderInstance(targetA, 'fill-blue-400/40', 'stroke-blue-600', targetStroke)}
            {renderInstance(targetB, 'fill-rose-400/40', 'stroke-rose-600', targetStroke)}
            <line
              x1={targetA.center.x} y1={targetA.center.y}
              x2={targetB.center.x} y2={targetB.center.y}
              className="stroke-emerald-600"
              strokeWidth={scaleUnit * 0.004}
              strokeDasharray={`${scaleUnit * 0.012} ${scaleUnit * 0.008}`}
            />
          </g>
        </svg>

        <div className="flex flex-wrap items-center gap-4 mt-3 text-[11px] text-stone-500">
          <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-blue-500 inline-block" />{targetA.plantName ?? targetA.label}</span>
          <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-rose-500 inline-block" />{targetB.plantName ?? targetB.label}</span>
          <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-stone-300 inline-block" />其他植栽（淡化）</span>
        </div>
        <p className="text-[11px] text-stone-400 mt-2">＊示意圖：依圖面座標比例繪製，供空間關係參考，非精確測繪圖。</p>
      </div>
    </div>
  )
}
