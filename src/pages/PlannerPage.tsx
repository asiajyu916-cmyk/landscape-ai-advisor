/**
 * PlannerPage.tsx — 建築前期規劃工具 v3（SVG）
 * 重點：三層圖層、多戶A1~A5、戶界線/核心拖曳、即時面積、產品配置器、方案A/B迷你預覽
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import type { SiteConfig, Regulations, Rect2D, Divider, PlannerScheme } from '@/types/planner'
import { getEnvelope, clamp, calcBCR, calcFAR, autoConfig } from '@/utils/plannerGeometry'

// ─── 產品類型 ─────────────────────────────────────────────────

type UnitTypeId = 'type1' | 'type2' | 'type3' | 'type4'

interface UnitTypeDef {
  id: UnitTypeId
  label: string
  rooms: string
  color: string
  fillAlpha: number
  defaultTarget: number
}

const UNIT_TYPES: UnitTypeDef[] = [
  { id: 'type1', label: '小坪數', rooms: '1-2房', color: '#a78bfa', fillAlpha: 0.16, defaultTarget: 40 },
  { id: 'type2', label: '標準型', rooms: '3房',   color: '#38bdf8', fillAlpha: 0.14, defaultTarget: 72 },
  { id: 'type3', label: '大坪數', rooms: '4房',   color: '#34d399', fillAlpha: 0.14, defaultTarget: 100 },
  { id: 'type4', label: '頂層戶', rooms: '複層',  color: '#fb923c', fillAlpha: 0.14, defaultTarget: 140 },
]

function getUnitTypeByArea(area: number): UnitTypeId {
  if (area < 55)  return 'type1'
  if (area < 88)  return 'type2'
  if (area < 120) return 'type3'
  return 'type4'
}

function unitTypeDef(id: UnitTypeId): UnitTypeDef {
  return UNIT_TYPES.find(t => t.id === id) ?? UNIT_TYPES[1]
}

// ─── 小工具 ──────────────────────────────────────────────────

function Num({ label, value, onChange, unit, min = 0, max = 9999, step = 1 }: {
  label: string; value: number; onChange: (v: number) => void
  unit?: string; min?: number; max?: number; step?: number
}) {
  return (
    <div className="flex items-center justify-between gap-1 py-0.5">
      <span className="text-xs text-slate-400 leading-tight flex-1 min-w-0">{label}</span>
      <div className="flex items-center gap-1 shrink-0">
        <input
          type="number" value={value} min={min} max={max} step={step}
          onChange={e => onChange(Number(e.target.value))}
          className="w-16 text-right text-xs bg-slate-800 border border-slate-600 rounded px-1.5 py-1 text-slate-200 focus:outline-none focus:border-blue-500"
          style={{ appearance: 'textfield' }}
        />
        {unit && <span className="text-xs text-slate-500 w-5 shrink-0">{unit}</span>}
      </div>
    </div>
  )
}

function SectionHead({ title }: { title: string }) {
  return (
    <div className="px-3 pt-3 pb-1 flex items-center gap-2">
      <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">{title}</span>
      <div className="flex-1 h-px bg-slate-800" />
    </div>
  )
}

// ─── Left Panel ──────────────────────────────────────────────

interface LeftPanelProps {
  site: SiteConfig; setSite: React.Dispatch<React.SetStateAction<SiteConfig>>
  regs: Regulations; setRegs: React.Dispatch<React.SetStateAction<Regulations>>
  unitTargets: Record<UnitTypeId, number>
  setUnitTargets: React.Dispatch<React.SetStateAction<Record<UnitTypeId, number>>>
  dividerCount: number
  onAutoConfig: () => void
  onAddDivider: () => void
  onRemoveDivider: () => void
}

function LeftPanel({
  site, setSite, regs, setRegs,
  unitTargets, setUnitTargets,
  dividerCount,
  onAutoConfig, onAddDivider, onRemoveDivider,
}: LeftPanelProps) {
  return (
    <div className="w-52 bg-slate-900 border-r border-slate-700 flex flex-col overflow-y-auto shrink-0 select-none">
      <SectionHead title="基地設定" />
      <div className="px-3 pb-1 space-y-0.5">
        <Num label="基地寬度" value={site.width}  onChange={v => setSite(p => ({ ...p, width: v }))}  unit="m" min={5}  max={200} step={0.5} />
        <Num label="基地深度" value={site.depth}  onChange={v => setSite(p => ({ ...p, depth: v }))}  unit="m" min={5}  max={200} step={0.5} />
        <button className="w-full mt-1.5 px-2 py-1.5 text-xs border border-dashed border-slate-600 rounded text-slate-500 hover:text-slate-400 flex items-center justify-center gap-1.5 transition-colors">
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
          </svg>
          匯入基地 DXF
        </button>
      </div>

      <SectionHead title="法規條件" />
      <div className="px-3 pb-1 space-y-0.5">
        <Num label="建蔽率上限"  value={regs.bcrLimit}      onChange={v => setRegs(p => ({ ...p, bcrLimit: v }))}      unit="%" min={10} max={80}  step={1}   />
        <Num label="容積率上限"  value={regs.farLimit}      onChange={v => setRegs(p => ({ ...p, farLimit: v }))}      unit="%" min={60} max={800} step={10}  />
        <div className="my-1 border-t border-slate-800" />
        <Num label="前院退縮"   value={regs.setbackFront}  onChange={v => setRegs(p => ({ ...p, setbackFront: v }))}  unit="m" min={0}  max={20}  step={0.5} />
        <Num label="後院退縮"   value={regs.setbackRear}   onChange={v => setRegs(p => ({ ...p, setbackRear: v }))}   unit="m" min={0}  max={20}  step={0.5} />
        <Num label="側院退縮"   value={regs.setbackSide}   onChange={v => setRegs(p => ({ ...p, setbackSide: v }))}   unit="m" min={0}  max={20}  step={0.5} />
      </div>

      <SectionHead title="建築設定" />
      <div className="px-3 pb-1 space-y-0.5">
        <Num label="地上層數"  value={regs.floors}      onChange={v => setRegs(p => ({ ...p, floors: v }))}      unit="層" min={1}   max={30}  step={1}   />
        <Num label="標準層高"  value={regs.floorHeight} onChange={v => setRegs(p => ({ ...p, floorHeight: v }))} unit="m"  min={2.8} max={5.0} step={0.1} />
      </div>

      <SectionHead title="戶界線" />
      <div className="px-3 pb-2 space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-500">{dividerCount + 1} 戶 / 最多 5 戶</span>
          <div className="flex items-center gap-1">
            <button onClick={onRemoveDivider} disabled={dividerCount === 0}
              className="w-6 h-6 flex items-center justify-center rounded border border-slate-600 text-slate-400 hover:bg-slate-800 disabled:opacity-25 disabled:cursor-not-allowed">−</button>
            <button onClick={onAddDivider} disabled={dividerCount >= 4}
              className="w-6 h-6 flex items-center justify-center rounded border border-slate-600 text-slate-400 hover:bg-slate-800 disabled:opacity-25 disabled:cursor-not-allowed">＋</button>
          </div>
        </div>
        <div className="flex gap-1">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex-1 h-6 rounded flex items-center justify-center text-xs font-mono transition-all"
              style={{
                background: i <= dividerCount ? 'rgba(56,139,253,0.15)' : 'rgba(255,255,255,0.02)',
                border: `1px solid ${i <= dividerCount ? 'rgba(56,139,253,0.35)' : 'rgba(255,255,255,0.06)'}`,
                color: i <= dividerCount ? '#58a6ff' : '#374151',
              }}>
              {i <= dividerCount ? `A${i + 1}` : ''}
            </div>
          ))}
        </div>
      </div>

      <SectionHead title="產品配置" />
      <div className="px-3 pb-2 space-y-1">
        {UNIT_TYPES.map(t => (
          <div key={t.id} className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: t.color }} />
            <span className="text-xs text-slate-400 w-12 shrink-0">{t.label}</span>
            <span className="text-xs text-slate-600 flex-1">{t.rooms}</span>
            <input
              type="number" value={unitTargets[t.id]} min={20} max={300} step={5}
              onChange={e => setUnitTargets(p => ({ ...p, [t.id]: Number(e.target.value) }))}
              className="w-12 text-right text-xs bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-slate-300 focus:outline-none focus:border-blue-500"
              style={{ appearance: 'textfield' }}
            />
            <span className="text-xs text-slate-600 w-4">㎡</span>
          </div>
        ))}
      </div>

      <div className="mt-auto px-3 pb-4 pt-3">
        <button onClick={onAutoConfig}
          className="w-full py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors">
          自動配置
        </button>
      </div>
    </div>
  )
}

// ─── Gauge Bar ───────────────────────────────────────────────

function GaugeBar({ label, value, limit, unit = '%', decimals = 1 }: {
  label: string; value: number; limit: number; unit?: string; decimals?: number
}) {
  const ratio = limit > 0 ? value / limit : 0
  const pct   = Math.min(ratio * 100, 100)
  const status = ratio < 0.85 ? 'ok' : ratio <= 1 ? 'warn' : 'over'
  const bar  = { ok: '#22c55e', warn: '#f59e0b', over: '#ef4444' }[status]
  const txt  = { ok: 'text-green-400', warn: 'text-amber-400', over: 'text-red-400' }[status]
  const tag  = { ok: '符合', warn: '接近上限', over: '超量' }[status]
  return (
    <div className="mb-3">
      <div className="flex justify-between items-baseline mb-1">
        <span className="text-xs text-slate-400">{label}</span>
        <div>
          <span className={`text-sm font-bold ${txt}`}>{value.toFixed(decimals)}</span>
          <span className="text-xs text-slate-600 ml-0.5">{unit} / {limit}{unit}</span>
        </div>
      </div>
      <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-150" style={{ width: `${pct}%`, background: bar }} />
      </div>
      <div className="flex justify-end mt-0.5"><span className={`text-xs ${txt}`}>{tag}</span></div>
    </div>
  )
}

// ─── Right Panel ──────────────────────────────────────────────

interface RightPanelProps {
  site: SiteConfig; regs: Regulations
  building: Rect2D; dividers: Divider[]
  bcr: number; far: number
  unitTypeIds: UnitTypeId[]
  unitTargets: Record<UnitTypeId, number>
  onCycleUnitType: (unitIndex: number) => void
}

function RightPanel({ site, regs, building, dividers, bcr, far, unitTypeIds, unitTargets, onCycleUnitType }: RightPanelProps) {
  const siteArea       = site.width * site.depth
  const buildingArea   = building.w * building.h
  const totalFloorArea = buildingArea * regs.floors
  const totalHeight    = regs.floors * regs.floorHeight
  const unitCount      = dividers.length + 1
  const divXs = [building.x, ...dividers.map(d => d.x).sort((a, b) => a - b), building.x + building.w]

  return (
    <div className="w-60 bg-slate-900 border-l border-slate-700 flex flex-col overflow-y-auto shrink-0 p-3 select-none">
      <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">即時分析</div>

      <GaugeBar label="建蔽率" value={bcr} limit={regs.bcrLimit} />
      <GaugeBar label="容積率" value={far} limit={regs.farLimit} />

      <div className="border-t border-slate-800 pt-2.5 mb-3 space-y-1.5">
        {([
          ['基地面積',  `${siteArea.toFixed(0)} ㎡`],
          ['建築面積',  `${buildingArea.toFixed(0)} ㎡`],
          ['總樓地板',  `${totalFloorArea.toFixed(0)} ㎡`],
          ['總樓高',    `${totalHeight.toFixed(1)} m`],
        ] as [string,string][]).map(([l, v]) => (
          <div key={l} className="flex justify-between">
            <span className="text-xs text-slate-500">{l}</span>
            <span className="text-xs font-medium text-slate-200">{v}</span>
          </div>
        ))}
      </div>

      {/* Unit list */}
      <div className="border-t border-slate-800 pt-2.5">
        <div className="flex justify-between items-center mb-2">
          <span className="text-xs font-semibold text-slate-400">戶型分析</span>
          <span className="text-sm font-bold text-blue-400">{unitCount} 戶</span>
        </div>
        <div className="space-y-1.5">
          {divXs.slice(0, -1).map((x0, i) => {
            const x1      = divXs[i + 1]
            const effArea = (x1 - x0) * building.h * 0.75
            const typeId  = unitTypeIds[i] ?? getUnitTypeByArea(effArea)
            const t       = unitTypeDef(typeId)
            const target  = unitTargets[typeId]
            const ratio   = effArea / target
            const matchCls = ratio >= 0.9 && ratio <= 1.15 ? 'text-green-400' : ratio > 1.15 ? 'text-amber-400' : 'text-red-400'
            return (
              <button key={i} onClick={() => onCycleUnitType(i)}
                className="w-full flex items-center justify-between py-1.5 px-2 rounded transition-colors hover:bg-slate-800/60 text-left"
                style={{ background: `${t.color}0d`, border: `1px solid ${t.color}30` }}
                title="點擊切換戶型">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-sm" style={{ background: t.color }} />
                  <span className="text-xs font-bold font-mono" style={{ color: t.color }}>A{i + 1}</span>
                  <span className="text-xs text-slate-500">{t.label}</span>
                </div>
                <div className="text-right">
                  <span className={`text-xs font-bold ${matchCls}`}>{effArea.toFixed(0)}</span>
                  <span className="text-xs text-slate-600">/{target}㎡</span>
                </div>
              </button>
            )
          })}
        </div>
        <p className="text-xs text-slate-600 mt-2 text-center leading-tight">點擊切換戶型分類</p>
      </div>
    </div>
  )
}

// ─── Mini Scheme Preview (SVG) ────────────────────────────────

function MiniPreview({ site, regs, building, dividers, unitTypeIds }: {
  site: SiteConfig; regs: Regulations
  building: Rect2D; dividers: Divider[]
  unitTypeIds: UnitTypeId[]
}) {
  const W = 84, H = 64
  const PAD = 4
  const sc = Math.min((W - PAD * 2) / site.width, (H - PAD * 2) / site.depth)
  const ox = (W - site.width * sc) / 2
  const oy = (H - site.depth * sc) / 2
  const px = (m: number) => ox + m * sc
  const py = (m: number) => oy + m * sc
  const ps = (m: number) => m * sc
  const env = getEnvelope(site, regs)
  const divXs = [building.x, ...dividers.map(d => d.x).sort((a, b) => a - b), building.x + building.w]

  return (
    <svg width={W} height={H} style={{ display: 'block' }}>
      {/* Site */}
      <rect x={ox} y={oy} width={ps(site.width)} height={ps(site.depth)} fill="#0d1117" stroke="#30363d" strokeWidth={0.8} />
      {/* Envelope */}
      <rect x={px(env.x)} y={py(env.y)} width={ps(env.w)} height={ps(env.h)}
        fill="rgba(35,134,54,0.06)" stroke="#238636" strokeWidth={0.6} strokeDasharray="3,2" />
      {/* Unit fills */}
      {divXs.slice(0, -1).map((x0, i) => {
        const x1  = divXs[i + 1]
        const eff = (x1 - x0) * building.h * 0.75
        const t   = unitTypeDef(unitTypeIds[i] ?? getUnitTypeByArea(eff))
        const r   = parseInt(t.color.slice(1, 3), 16)
        const g   = parseInt(t.color.slice(3, 5), 16)
        const b   = parseInt(t.color.slice(5, 7), 16)
        return (
          <rect key={i}
            x={px(x0)} y={py(building.y)} width={ps(x1 - x0)} height={ps(building.h)}
            fill={`rgba(${r},${g},${b},0.20)`} />
        )
      })}
      {/* Building */}
      <rect x={px(building.x)} y={py(building.y)} width={ps(building.w)} height={ps(building.h)}
        fill="transparent" stroke="#388bfd" strokeWidth={0.8} />
      {/* Dividers */}
      {dividers.map(d => (
        <line key={d.id}
          x1={px(d.x)} y1={py(building.y)} x2={px(d.x)} y2={py(building.y + building.h)}
          stroke="#d29922" strokeWidth={0.6} />
      ))}
    </svg>
  )
}

// ─── Scheme Slot ─────────────────────────────────────────────

function SchemeSlot({ scheme, label, isActive, onSave, onLoad }: {
  scheme: PlannerScheme | null; label: string; isActive: boolean
  onSave: () => void; onLoad: () => void
}) {
  if (!scheme) {
    return (
      <div className="flex-1 min-w-0 border border-dashed border-slate-700 rounded-lg flex flex-col items-center justify-center gap-1.5 px-3 py-2">
        <span className="text-xs text-slate-600">{label}</span>
        <button onClick={onSave}
          className="text-xs text-slate-500 hover:text-slate-300 border border-slate-700 hover:border-slate-500 rounded px-2 py-1 transition-colors">
          儲存目前配置
        </button>
      </div>
    )
  }
  const regs: Regulations = {
    bcrLimit: 0, farLimit: 0,
    setbackFront: 0, setbackRear: 0, setbackSide: 0,
    floors: 0, floorHeight: 0,
  }
  return (
    <div onClick={onLoad}
      className={`flex-1 min-w-0 border rounded-lg px-2.5 py-2 cursor-pointer transition-colors flex gap-2.5 items-center ${
        isActive ? 'border-blue-500 bg-blue-950/30' : 'border-slate-700 hover:border-slate-500'
      }`}
    >
      {/* Mini preview */}
      <div className="shrink-0 rounded overflow-hidden border border-slate-700/50"
        style={{ background: '#0d1117' }}>
        <MiniPreview site={scheme.site} regs={regs} building={scheme.building}
          dividers={scheme.dividers} unitTypeIds={[]} />
      </div>
      {/* Stats */}
      <div className="flex-1 min-w-0">
        <div className="flex justify-between items-center mb-1.5">
          <span className="text-xs font-bold text-slate-200">{scheme.label}</span>
          <button onClick={e => { e.stopPropagation(); onSave() }}
            className="text-xs text-slate-600 hover:text-slate-300">更新</button>
        </div>
        <div className="grid grid-cols-3 gap-1">
          <div>
            <div className="text-xs text-slate-600">建蔽</div>
            <div className="text-xs font-bold text-blue-400">{scheme.bcr.toFixed(1)}%</div>
          </div>
          <div>
            <div className="text-xs text-slate-600">容積</div>
            <div className="text-xs font-bold text-green-400">{scheme.far.toFixed(1)}%</div>
          </div>
          <div>
            <div className="text-xs text-slate-600">戶數</div>
            <div className="text-xs font-bold text-amber-400">{scheme.units} 戶</div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Bottom Bar ───────────────────────────────────────────────

function BottomBar({ schemes, activeSchemeId, onSaveScheme, onLoadScheme }: {
  schemes: (PlannerScheme | null)[]
  activeSchemeId: string | null
  onSaveScheme: (i: number, label: string) => void
  onLoadScheme: (s: PlannerScheme) => void
}) {
  const LABELS = ['方案 A', '方案 B', '方案 C']
  return (
    <div className="h-24 bg-slate-900 border-t border-slate-700 px-4 py-2 flex items-stretch gap-3 shrink-0">
      <div className="flex flex-col justify-center pr-3 border-r border-slate-800 shrink-0">
        <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">方案比較</span>
        <span className="text-xs text-slate-600 mt-0.5">點擊載入方案</span>
      </div>
      {LABELS.map((lbl, i) => (
        <SchemeSlot key={i} label={lbl}
          scheme={schemes[i] ?? null}
          isActive={!!(schemes[i] && schemes[i]!.id === activeSchemeId)}
          onSave={() => onSaveScheme(i, lbl)}
          onLoad={() => schemes[i] && onLoadScheme(schemes[i]!)}
        />
      ))}
    </div>
  )
}

// ─── SVG Canvas ───────────────────────────────────────────────

interface DragState {
  what: 'building' | 'core' | { divId: string }
  startClientX: number; startClientY: number
  origBuilding: Rect2D; origCore: Rect2D; origDividers: Divider[]
}

interface CanvasProps {
  site: SiteConfig; regs: Regulations
  building: Rect2D; core: Rect2D; dividers: Divider[]
  showGrid: boolean; zoomFactor: number
  unitTypeIds: UnitTypeId[]
  onBuildingDragEnd: (x: number, y: number) => void
  onCoreDragEnd:     (x: number, y: number) => void
  onDividerDragEnd:  (id: string, x: number) => void
  onLiveChange:      (building: Rect2D, dividers: Divider[]) => void
}

function PlannerCanvas({
  site, regs, building, core, dividers, showGrid, zoomFactor,
  unitTypeIds,
  onBuildingDragEnd, onCoreDragEnd, onDividerDragEnd, onLiveChange,
}: CanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize]     = useState({ w: 800, h: 600 })
  const [drag, setDrag]     = useState<DragState | null>(null)
  const [curDelta, setCurDelta] = useState({ dx: 0, dy: 0 })
  const [cursor, setCursor] = useState<{ mx: number; my: number } | null>(null)

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect
      if (width > 10 && height > 10) setSize({ w: width, h: height })
    })
    if (containerRef.current) ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [])

  const PAD   = 80
  const scale = Math.min((size.w - PAD * 2) / Math.max(site.width, 1),
                         (size.h - PAD * 2) / Math.max(site.depth, 1)) * zoomFactor
  const ox    = (size.w - site.width  * scale) / 2
  const oy    = (size.h - site.depth * scale) / 2
  const env   = useMemo(() => getEnvelope(site, regs), [site, regs])

  const px = (m: number) => ox + m * scale
  const py = (m: number) => oy + m * scale
  const ps = (m: number) => m * scale

  // ── Live display positions ─────────────────────────────────
  const { dx, dy } = drag ? curDelta : { dx: 0, dy: 0 }

  const dispBuilding = useMemo<Rect2D>(() => {
    if (!drag || drag.what !== 'building') return building
    const ob = drag.origBuilding
    return { ...ob,
      x: clamp(ob.x + dx, env.x, env.x + env.w - ob.w),
      y: clamp(ob.y + dy, env.y, env.y + env.h - ob.h),
    }
  }, [drag, dx, dy, building, env])

  const bmx = dispBuilding.x - building.x
  const bmy = dispBuilding.y - building.y

  const dispCore = useMemo<Rect2D>(() => {
    if (!drag) return core
    if (drag.what === 'building') return { ...core, x: core.x + bmx, y: core.y + bmy }
    if (drag.what === 'core') {
      const oc = drag.origCore
      return { ...oc,
        x: clamp(oc.x + dx, dispBuilding.x, dispBuilding.x + dispBuilding.w - oc.w),
        y: clamp(oc.y + dy, dispBuilding.y, dispBuilding.y + dispBuilding.h - oc.h),
      }
    }
    return core
  }, [drag, dx, dy, core, dispBuilding, bmx, bmy])

  const dispDividers = useMemo<Divider[]>(() => dividers.map(d => {
    if (!drag) return d
    if (drag.what === 'building') return { ...d, x: d.x + bmx }
    if (typeof drag.what === 'object' && drag.what.divId === d.id) {
      const orig = drag.origDividers.find(o => o.id === d.id)!
      return { ...d, x: clamp(orig.x + dx, dispBuilding.x + 0.3, dispBuilding.x + dispBuilding.w - 0.3) }
    }
    return d
  }), [drag, dx, dividers, dispBuilding, bmx])

  useEffect(() => { onLiveChange(dispBuilding, dispDividers) },
    [dispBuilding, dispDividers]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Drag handlers ──────────────────────────────────────────
  const startDrag = useCallback((what: DragState['what'], e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    setCurDelta({ dx: 0, dy: 0 })
    setDrag({ what, startClientX: e.clientX, startClientY: e.clientY,
      origBuilding: { ...building }, origCore: { ...core },
      origDividers: dividers.map(d => ({ ...d })) })
  }, [building, core, dividers])

  const handleMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (drag) setCurDelta({
      dx: (e.clientX - drag.startClientX) / scale,
      dy: (e.clientY - drag.startClientY) / scale,
    })
    const rect = e.currentTarget.getBoundingClientRect()
    setCursor({ mx: (e.clientX - rect.left - ox) / scale, my: (e.clientY - rect.top - oy) / scale })
  }, [drag, scale, ox, oy])

  const handleMouseUp = useCallback(() => {
    if (drag) {
      if (drag.what === 'building') onBuildingDragEnd(dispBuilding.x, dispBuilding.y)
      else if (drag.what === 'core') onCoreDragEnd(dispCore.x, dispCore.y)
      else {
        const div = dispDividers.find(d => d.id === (drag.what as { divId: string }).divId)
        if (div) onDividerDragEnd(div.id, div.x)
      }
    }
    setDrag(null); setCurDelta({ dx: 0, dy: 0 })
  }, [drag, dispBuilding, dispCore, dispDividers, onBuildingDragEnd, onCoreDragEnd, onDividerDragEnd])

  // ── Grid ───────────────────────────────────────────────────
  const gridLines = useMemo(() => {
    if (!showGrid) return []
    const step = scale > 40 ? 1 : scale > 15 ? 2 : 5
    const lines: { key: string; x1: number; y1: number; x2: number; y2: number; major: boolean }[] = []
    for (let x = 0; x <= site.width; x += step)
      lines.push({ key: `v${x}`, x1: px(x), y1: oy, x2: px(x), y2: oy + ps(site.depth), major: x % (step * 5) === 0 })
    for (let y = 0; y <= site.depth; y += step)
      lines.push({ key: `h${y}`, x1: ox, y1: py(y), x2: ox + ps(site.width), y2: py(y), major: y % (step * 5) === 0 })
    return lines
  }, [showGrid, site, scale, ox, oy]) // eslint-disable-line react-hooks/exhaustive-deps

  const unitXs = useMemo(() => (
    [dispBuilding.x, ...dispDividers.map(d => d.x).sort((a, b) => a - b), dispBuilding.x + dispBuilding.w]
  ), [dispBuilding, dispDividers])

  const isDragging = drag !== null
  const barM = scale * 10 >= 60 ? 10 : 5

  // Setback annotation helper
  const DIM_OFF = 18

  return (
    <div ref={containerRef} className="flex-1 relative overflow-hidden"
      style={{ background: '#0d1117', userSelect: 'none', minWidth: 0 }}>
      <svg width={size.w} height={size.h}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => { handleMouseUp(); setCursor(null) }}
        style={{ display: 'block', cursor: isDragging ? 'grabbing' : 'default' }}>

        {/* Background */}
        <rect x={0} y={0} width={size.w} height={size.h} fill="#0d1117" />

        {/* Grid */}
        {showGrid && gridLines.map(l => (
          <line key={l.key} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
            stroke={l.major ? '#21262d' : '#161b22'} strokeWidth={l.major ? 0.6 : 0.3} />
        ))}

        {/* ─── Layer 1: 基地線 ───────────────────────────────── */}
        {/* Site fill */}
        <rect x={ox} y={oy} width={ps(site.width)} height={ps(site.depth)} fill="#111820" />
        {/* Setback zones (front/rear/side fills) */}
        {/* front zone */}
        <rect x={ox} y={oy} width={ps(site.width)} height={ps(regs.setbackFront)}
          fill="rgba(255,255,255,0.015)" pointerEvents="none" />
        {/* rear zone */}
        <rect x={ox} y={py(site.depth - regs.setbackRear)} width={ps(site.width)} height={ps(regs.setbackRear)}
          fill="rgba(255,255,255,0.015)" pointerEvents="none" />
        {/* side zones */}
        <rect x={ox} y={oy} width={ps(regs.setbackSide)} height={ps(site.depth)}
          fill="rgba(255,255,255,0.015)" pointerEvents="none" />
        <rect x={px(site.width - regs.setbackSide)} y={oy} width={ps(regs.setbackSide)} height={ps(site.depth)}
          fill="rgba(255,255,255,0.015)" pointerEvents="none" />
        {/* Site border */}
        <rect x={ox} y={oy} width={ps(site.width)} height={ps(site.depth)}
          fill="none" stroke="#4b5563" strokeWidth={2} />

        {/* ─── Layer 2: 退縮線 ───────────────────────────────── */}
        <rect x={px(env.x)} y={py(env.y)} width={ps(env.w)} height={ps(env.h)}
          fill="none" stroke="#16a34a" strokeWidth={1.5} strokeDasharray="8,4" />

        {/* Setback dimension callouts */}
        {/* Front setback */}
        {regs.setbackFront > 0 && (
          <g opacity={0.7}>
            <line x1={px(env.x + env.w / 2)} y1={oy + 2}
                  x2={px(env.x + env.w / 2)} y2={py(env.y) - 2}
              stroke="#16a34a" strokeWidth={0.8} markerEnd="url(#arrowG)" />
            <text x={px(env.x + env.w / 2) + 4} y={(oy + py(env.y)) / 2 + 3}
              fill="#4ade80" fontSize={8.5}>前退 {regs.setbackFront}m</text>
          </g>
        )}
        {/* Rear setback */}
        {regs.setbackRear > 0 && (
          <g opacity={0.7}>
            <line x1={px(env.x + env.w / 2)} y1={oy + ps(site.depth) - 2}
                  x2={px(env.x + env.w / 2)} y2={py(env.y + env.h) + 2}
              stroke="#16a34a" strokeWidth={0.8} />
            <text x={px(env.x + env.w / 2) + 4}
              y={(oy + ps(site.depth) + py(env.y + env.h)) / 2 + 3}
              fill="#4ade80" fontSize={8.5}>後退 {regs.setbackRear}m</text>
          </g>
        )}
        {/* Side setback left */}
        {regs.setbackSide > 0 && (
          <g opacity={0.7}>
            <line x1={ox + 2} y1={py(env.y + env.h / 2)}
                  x2={px(env.x) - 2} y2={py(env.y + env.h / 2)}
              stroke="#16a34a" strokeWidth={0.8} />
            <text x={(ox + px(env.x)) / 2}
              y={py(env.y + env.h / 2) - 4}
              fill="#4ade80" fontSize={8.5} textAnchor="middle">側 {regs.setbackSide}m</text>
          </g>
        )}
        {/* Side setback right */}
        {regs.setbackSide > 0 && (
          <g opacity={0.7}>
            <line x1={px(env.x + env.w) + 2} y1={py(env.y + env.h / 2)}
                  x2={ox + ps(site.width) - 2} y2={py(env.y + env.h / 2)}
              stroke="#16a34a" strokeWidth={0.8} />
            <text x={(px(env.x + env.w) + ox + ps(site.width)) / 2}
              y={py(env.y + env.h / 2) - 4}
              fill="#4ade80" fontSize={8.5} textAnchor="middle">側 {regs.setbackSide}m</text>
          </g>
        )}

        {/* ─── Layer 3: 可建築範圍 ────────────────────────────── */}
        <rect x={px(env.x)} y={py(env.y)} width={ps(env.w)} height={ps(env.h)}
          fill="rgba(22,163,74,0.06)" pointerEvents="none" />
        <text x={px(env.x) + 5} y={py(env.y) + 13}
          fill="#4ade80" fontSize={8} opacity={0.6} pointerEvents="none">可建築範圍</text>

        {/* ─── Layer 4: 建築配置 ──────────────────────────────── */}
        {/* Unit fills (color by type) */}
        {unitXs.slice(0, -1).map((x0, i) => {
          const x1  = unitXs[i + 1]
          const eff = (x1 - x0) * dispBuilding.h * 0.75
          const t   = unitTypeDef(unitTypeIds[i] ?? getUnitTypeByArea(eff))
          const r   = parseInt(t.color.slice(1, 3), 16)
          const g   = parseInt(t.color.slice(3, 5), 16)
          const b   = parseInt(t.color.slice(5, 7), 16)
          return (
            <rect key={`uf${i}`}
              x={px(x0)} y={py(dispBuilding.y)} width={ps(x1 - x0)} height={ps(dispBuilding.h)}
              fill={`rgba(${r},${g},${b},${t.fillAlpha})`} pointerEvents="none" />
          )
        })}

        {/* Building border (draggable) */}
        <rect
          x={px(dispBuilding.x)} y={py(dispBuilding.y)}
          width={ps(dispBuilding.w)} height={ps(dispBuilding.h)}
          fill="transparent" stroke="#3b82f6" strokeWidth={2}
          strokeDasharray={isDragging && drag?.what === 'building' ? '10,5' : undefined}
          style={{ cursor: 'move' }}
          onMouseDown={e => startDrag('building', e)}
        />

        {/* Building dim label */}
        <text x={px(dispBuilding.x + dispBuilding.w / 2)} y={py(dispBuilding.y) - 7}
          fill="#60a5fa" fontSize={9} textAnchor="middle" pointerEvents="none">
          {dispBuilding.w.toFixed(1)} × {dispBuilding.h.toFixed(1)} m
        </text>

        {/* Unit labels */}
        {unitXs.slice(0, -1).map((x0, i) => {
          const x1  = unitXs[i + 1]
          const uw  = x1 - x0
          const eff = uw * dispBuilding.h * 0.75
          const t   = unitTypeDef(unitTypeIds[i] ?? getUnitTypeByArea(eff))
          const cx  = px(x0 + uw / 2)
          const cy  = py(dispBuilding.y + dispBuilding.h / 2)
          return (
            <g key={`ul${i}`} pointerEvents="none">
              <text x={cx} y={cy - 6} fill={t.color} fontSize={11} fontWeight="bold" textAnchor="middle" opacity={0.9}>A{i + 1}</text>
              <text x={cx} y={cy + 7} fill={t.color} fontSize={8} textAnchor="middle" opacity={0.65}>{t.label}</text>
              <text x={cx} y={cy + 18} fill={t.color} fontSize={8} textAnchor="middle" opacity={0.5}>{eff.toFixed(0)}㎡</text>
            </g>
          )
        })}

        {/* Unit dividers (draggable) */}
        {dispDividers.map(div => {
          const dvx = px(div.x)
          const top = py(dispBuilding.y)
          const bot = py(dispBuilding.y + dispBuilding.h)
          const thisD = isDragging && typeof drag?.what === 'object' && drag.what.divId === div.id
          return (
            <g key={div.id} style={{ cursor: 'ew-resize' }} onMouseDown={e => startDrag({ divId: div.id }, e)}>
              <line x1={dvx} y1={top} x2={dvx} y2={bot} stroke="transparent" strokeWidth={14} />
              <line x1={dvx} y1={top} x2={dvx} y2={bot}
                stroke="#f59e0b" strokeWidth={thisD ? 1 : 1.5}
                strokeDasharray={thisD ? '5,3' : undefined} />
              {!thisD && (
                <rect x={dvx - 4} y={(top + bot) / 2 - 5} width={8} height={10} rx={2}
                  fill="#1e2433" stroke="#f59e0b" strokeWidth={0.8} pointerEvents="none" />
              )}
            </g>
          )
        })}

        {/* Core (draggable) */}
        <rect
          x={px(dispCore.x)} y={py(dispCore.y)}
          width={ps(dispCore.w)} height={ps(dispCore.h)}
          fill={isDragging && drag?.what === 'core' ? 'transparent' : 'rgba(239,68,68,0.18)'}
          stroke="#ef4444" strokeWidth={1.5}
          strokeDasharray={isDragging && drag?.what === 'core' ? '5,3' : undefined}
          style={{ cursor: 'move' }}
          onMouseDown={e => startDrag('core', e)}
        />
        <text x={px(dispCore.x + dispCore.w / 2)} y={py(dispCore.y + dispCore.h / 2) + 4}
          fill="#ef4444" fontSize={8} textAnchor="middle" pointerEvents="none">核心</text>

        {/* Site dimension labels */}
        <text x={ox + ps(site.width) / 2} y={oy - DIM_OFF}
          fill="#6b7280" fontSize={10} textAnchor="middle">{site.width} m</text>
        <text x={ox - DIM_OFF} y={oy + ps(site.depth) / 2}
          fill="#6b7280" fontSize={10} textAnchor="middle"
          transform={`rotate(-90, ${ox - DIM_OFF}, ${oy + ps(site.depth) / 2})`}>{site.depth} m</text>

        {/* N indicator */}
        <g>
          <polygon
            points={`${ox + ps(site.width) + 16},${oy + 8} ${ox + ps(site.width) + 13},${oy + 20} ${ox + ps(site.width) + 19},${oy + 20}`}
            fill="#4b5563" />
          <text x={ox + ps(site.width) + 16} y={oy + 30}
            fill="#6b7280" fontSize={9} textAnchor="middle" fontWeight="bold">N</text>
        </g>

        {/* Scale bar */}
        <g>
          <line x1={ox} y1={oy + ps(site.depth) + 28} x2={ox + ps(barM)} y2={oy + ps(site.depth) + 28}
            stroke="#4b5563" strokeWidth={1} />
          <line x1={ox} y1={oy + ps(site.depth) + 25} x2={ox} y2={oy + ps(site.depth) + 31} stroke="#4b5563" strokeWidth={1} />
          <line x1={ox + ps(barM)} y1={oy + ps(site.depth) + 25} x2={ox + ps(barM)} y2={oy + ps(site.depth) + 31} stroke="#4b5563" strokeWidth={1} />
          <text x={ox + ps(barM) / 2} y={oy + ps(site.depth) + 42} fill="#4b5563" fontSize={9} textAnchor="middle">{barM}m</text>
        </g>

        {/* Layer legend */}
        <g transform={`translate(${size.w - 116}, ${oy})`}>
          <rect x={0} y={0} width={110} height={70} rx={4} fill="rgba(13,17,23,0.85)" stroke="#21262d" strokeWidth={0.8} />
          {[
            { y: 14, color: '#4b5563',  dash: false,    label: '基地線' },
            { y: 28, color: '#16a34a',  dash: true,     label: '退縮線' },
            { y: 42, color: '#4ade80',  dash: false,    label: '可建築範圍', fill: true },
            { y: 56, color: '#3b82f6',  dash: false,    label: '建築配置' },
          ].map(({ y, color, dash, label, fill }) => (
            <g key={label}>
              {fill
                ? <rect x={8} y={y - 5} width={14} height={8} fill={`${color}20`} stroke={color} strokeWidth={0.8} />
                : <line x1={8} y1={y - 1} x2={22} y2={y - 1} stroke={color} strokeWidth={1.2}
                    strokeDasharray={dash ? '4,2' : undefined} />
              }
              <text x={28} y={y} fill="#8b949e" fontSize={8.5}>{label}</text>
            </g>
          ))}
        </g>

      </svg>

      {/* Cursor coordinates */}
      {cursor && (
        <div className="absolute bottom-2 right-2 text-xs font-mono text-slate-600 bg-slate-900/80 px-2 py-1 rounded pointer-events-none">
          {cursor.mx.toFixed(2)}, {cursor.my.toFixed(2)} m
        </div>
      )}
      {/* Drag hint */}
      {isDragging && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 text-xs text-slate-400 bg-slate-900/80 px-3 py-1 rounded pointer-events-none">
          {drag?.what === 'building' ? '移動建築外框' : drag?.what === 'core' ? '移動核心筒' : '左右拖曳移動戶界線'}
        </div>
      )}
    </div>
  )
}

// ─── Main PlannerPage ─────────────────────────────────────────

interface Props { onBack: () => void }

const DEFAULT_SITE: SiteConfig = { width: 30, depth: 40 }
const DEFAULT_REGS: Regulations = {
  bcrLimit: 60, farLimit: 240,
  setbackFront: 4, setbackRear: 3, setbackSide: 2,
  floors: 12, floorHeight: 3.2,
}
const DEFAULT_TARGETS: Record<UnitTypeId, number> = {
  type1: 40, type2: 72, type3: 100, type4: 140,
}

export default function PlannerPage({ onBack }: Props) {
  const init = useMemo(() => autoConfig(DEFAULT_SITE, DEFAULT_REGS), [])

  const [site,     setSite]     = useState<SiteConfig>(DEFAULT_SITE)
  const [regs,     setRegs]     = useState<Regulations>(DEFAULT_REGS)
  const [building, setBuilding] = useState<Rect2D>(init.building)
  const [core,     setCore]     = useState<Rect2D>(init.core)
  const [dividers, setDividers] = useState<Divider[]>(init.dividers)
  const [showGrid,    setShowGrid]    = useState(true)
  const [zoomFactor,  setZoomFactor]  = useState(1.0)
  const [schemes,     setSchemes]     = useState<(PlannerScheme | null)[]>([null, null, null])
  const [activeId,    setActiveId]    = useState<string | null>(null)
  const [unitTargets, setUnitTargets] = useState<Record<UnitTypeId, number>>(DEFAULT_TARGETS)
  const [unitTypeIds, setUnitTypeIds] = useState<UnitTypeId[]>([])
  const [liveBuilding, setLiveBuilding] = useState<Rect2D>(init.building)
  const [liveDividers, setLiveDividers] = useState<Divider[]>(init.dividers)

  const bcr = useMemo(() => calcBCR(liveBuilding, site), [liveBuilding, site])
  const far = useMemo(() => calcFAR(liveBuilding, site, regs.floors), [liveBuilding, site, regs])
  const unitCount = dividers.length + 1

  // Auto-assign unit types from live positions
  useEffect(() => {
    const xs = [liveBuilding.x, ...liveDividers.map(d => d.x).sort((a, b) => a - b), liveBuilding.x + liveBuilding.w]
    setUnitTypeIds(prev =>
      xs.slice(0, -1).map((x0, i) => {
        const eff = (xs[i + 1] - x0) * liveBuilding.h * 0.75
        return prev[i] ?? getUnitTypeByArea(eff)
      })
    )
  }, [liveBuilding, liveDividers]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleCycleUnitType = useCallback((idx: number) => {
    const order: UnitTypeId[] = ['type1', 'type2', 'type3', 'type4']
    setUnitTypeIds(prev => {
      const next = [...prev]
      next[idx] = order[(order.indexOf(next[idx] ?? 'type2') + 1) % order.length]
      return next
    })
  }, [])

  const handleAutoConfig = useCallback(() => {
    const c = autoConfig(site, regs)
    setBuilding(c.building); setCore(c.core); setDividers(c.dividers)
    setLiveBuilding(c.building); setLiveDividers(c.dividers)
    setUnitTypeIds([])
  }, [site, regs])

  const handleBuildingDragEnd = useCallback((nx: number, ny: number) => {
    const dx = nx - building.x, dy = ny - building.y
    setBuilding(b => ({ ...b, x: nx, y: ny }))
    setCore(c => ({ ...c, x: c.x + dx, y: c.y + dy }))
    setDividers(ds => ds.map(d => ({ ...d, x: d.x + dx })))
  }, [building.x, building.y])

  const handleAddDivider = useCallback(() => {
    if (dividers.length >= 4) return
    const xs = [building.x, ...dividers.map(d => d.x).sort((a, b) => a - b), building.x + building.w]
    let bestI = 0, bestGap = 0
    for (let i = 0; i < xs.length - 1; i++) {
      const g = xs[i + 1] - xs[i]
      if (g > bestGap) { bestGap = g; bestI = i }
    }
    setDividers(prev => [...prev, { id: `d${Date.now()}`, x: (xs[bestI] + xs[bestI + 1]) / 2 }])
  }, [building, dividers])

  const handleRemoveDivider = useCallback(() => {
    setDividers(prev => prev.slice(0, -1))
  }, [])

  const handleSaveScheme = useCallback((i: number, label: string) => {
    const s: PlannerScheme = {
      id: `s-${Date.now()}`, label, site: { ...site },
      building: { ...building }, core: { ...core },
      dividers: dividers.map(d => ({ ...d })),
      bcr, far, units: unitCount,
    }
    setSchemes(prev => { const n = [...prev]; n[i] = s; return n })
    setActiveId(s.id)
  }, [site, building, core, dividers, bcr, far, unitCount])

  const handleLoadScheme = useCallback((s: PlannerScheme) => {
    setBuilding({ ...s.building }); setCore({ ...s.core })
    setDividers(s.dividers.map(d => ({ ...d }))); setActiveId(s.id)
    setLiveBuilding({ ...s.building }); setLiveDividers(s.dividers.map(d => ({ ...d })))
    setUnitTypeIds([])
  }, [])

  const handleLiveChange = useCallback((b: Rect2D, ds: Divider[]) => {
    setLiveBuilding(b); setLiveDividers(ds)
  }, [])

  return (
    <div className="h-screen flex flex-col overflow-hidden" style={{ background: '#0d1117' }}>
      {/* Top Bar */}
      <div className="h-11 flex items-center px-4 gap-3 shrink-0 border-b border-slate-700" style={{ background: '#161b22' }}>
        <button onClick={onBack} className="flex items-center gap-1 text-slate-400 hover:text-slate-200 text-xs transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7"/>
          </svg>
          返回
        </button>
        <div className="w-px h-4 bg-slate-700" />
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 bg-blue-700 rounded flex items-center justify-center shrink-0">
            <span className="text-white text-xs font-bold">YF</span>
          </div>
          <span className="text-sm font-semibold text-slate-200">前期規劃</span>
          <span className="text-xs text-slate-600 border border-slate-700 rounded px-1.5 py-0.5">Beta</span>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-1">
          <button onClick={() => setShowGrid(p => !p)}
            className={`px-2 h-7 text-xs rounded border transition-colors ${showGrid ? 'border-blue-600 text-blue-400 bg-blue-950/40' : 'border-slate-700 text-slate-500 hover:text-slate-300'}`}>
            網格
          </button>
          <button onClick={() => setZoomFactor(p => Math.min(p * 1.25, 5))}
            className="w-7 h-7 flex items-center justify-center rounded border border-slate-700 text-slate-400 hover:bg-slate-800 text-sm">＋</button>
          <button onClick={() => setZoomFactor(1)}
            className="px-2 h-7 text-xs rounded border border-slate-700 text-slate-400 hover:bg-slate-800 font-mono">
            {Math.round(zoomFactor * 100)}%
          </button>
          <button onClick={() => setZoomFactor(p => Math.max(p / 1.25, 0.2))}
            className="w-7 h-7 flex items-center justify-center rounded border border-slate-700 text-slate-400 hover:bg-slate-800 text-sm">－</button>
        </div>
        <div className="w-px h-4 bg-slate-700" />
        <button className="h-7 px-3 text-xs rounded border border-slate-600 text-slate-400 hover:bg-slate-800 flex items-center gap-1.5">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
          </svg>
          匯出 DXF
        </button>
      </div>

      {/* Main */}
      <div className="flex flex-1 overflow-hidden min-h-0">
        <LeftPanel
          site={site} setSite={setSite}
          regs={regs} setRegs={setRegs}
          unitTargets={unitTargets} setUnitTargets={setUnitTargets}
          dividerCount={dividers.length}
          onAutoConfig={handleAutoConfig}
          onAddDivider={handleAddDivider}
          onRemoveDivider={handleRemoveDivider}
        />
        <PlannerCanvas
          site={site} regs={regs}
          building={building} core={core} dividers={dividers}
          showGrid={showGrid} zoomFactor={zoomFactor}
          unitTypeIds={unitTypeIds}
          onBuildingDragEnd={handleBuildingDragEnd}
          onCoreDragEnd={(x, y) => setCore(p => ({ ...p, x, y }))}
          onDividerDragEnd={(id, x) => setDividers(ps => ps.map(d => d.id === id ? { ...d, x } : d))}
          onLiveChange={handleLiveChange}
        />
        <RightPanel
          site={site} regs={regs}
          building={liveBuilding} dividers={liveDividers}
          bcr={bcr} far={far}
          unitTypeIds={unitTypeIds}
          unitTargets={unitTargets}
          onCycleUnitType={handleCycleUnitType}
        />
      </div>

      {/* Bottom Bar */}
      <BottomBar
        schemes={schemes}
        activeSchemeId={activeId}
        onSaveScheme={handleSaveScheme}
        onLoadScheme={handleLoadScheme}
      />
    </div>
  )
}
