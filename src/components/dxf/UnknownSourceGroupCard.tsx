// ── UnknownSourceGroupCard.tsx — 「人工確認」單筆來源卡 ─────────────────────
// 每一筆人工確認都必須清楚知道：1. 需要確認的具體事項 2. 系統為什麼無法自動
// 判斷 3. 涉及的分區與植物 4. 圖面定位 5. 可以直接選擇的確認答案 6. 確認後
// 重新計算——前五項是純顯示，第 6 項完全沿用既有 App.tsx 的 layerOverrides
// 狀態機制（onApply 呼叫 onApplyLayerOverride 後，既有管線會自動重跑整個分區
// 分析），這裡不新增任何判斷或重算邏輯。
//
// 只允許 5 種情況出現在這裡（見 dxfReportBuilder.ts 的 buildUnknownSourceGroups
// 說明）：植物名稱無法辨識／圖層或圖塊歸屬不明／缺少圖面本身無法提供的環境資訊
// （上下層配置／同類型套疊／範圍重疊）。一般日照、耐旱、耐濕等級差距有明確判斷
// 依據，不會被分類進來，走「審查問題」分頁的正常問題卡。

import { MapPin } from 'lucide-react'
import type { UnknownSourceGroup } from '@/utils/dxfReportBuilder'
import { UNKNOWN_SOURCE_TYPE_LABEL, UNKNOWN_SOURCE_WHY_LABEL } from '@/utils/dxfReportBuilder'
import type { LayerOverrideAction } from '@/types/dxf'

interface Props {
  group: UnknownSourceGroup
  onLocate?: () => void
  onApply?: (action: LayerOverrideAction) => void
}

const CONFIRM_OPTIONS: Array<[LayerOverrideAction, string]> = [
  ['shrub', '灌木'], ['groundcover', '地被'], ['lawn', '草皮'], ['exclude', '非植栽／排除'],
]
const OVERRIDE_LABEL: Record<LayerOverrideAction, string> = {
  shrub: '灌木', groundcover: '地被', lawn: '草皮', exclude: '非植栽／排除',
}

export default function UnknownSourceGroupCard({ group, onLocate, onApply }: Props) {
  return (
    <div className="bg-white rounded-2xl border border-amber-200 overflow-hidden">
      <div className="h-1 bg-amber-400" />
      <div className="p-4 space-y-2.5">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <span className="text-xs px-2 py-0.5 rounded-full border border-amber-300 bg-amber-50 text-amber-800 font-semibold">
            {UNKNOWN_SOURCE_TYPE_LABEL[group.unknownSourceType]}{group.unknownSourceType === 'unknown-hatch' && `：${group.layerName}`}
          </span>
          <span className="text-xs text-stone-400">影響 {group.pairCount} 組配對</span>
        </div>

        {/* 1. 需要確認的具體事項 */}
        <div>
          <p className="text-xs font-semibold text-stone-400 mb-0.5">需要確認的具體事項</p>
          <p className="text-sm font-semibold text-stone-800">{UNKNOWN_SOURCE_WHY_LABEL[group.unknownSourceType]}</p>
        </div>

        {/* 2. 系統為什麼無法自動判斷 */}
        <div>
          <p className="text-xs font-semibold text-stone-400 mb-0.5">系統為什麼無法自動判斷</p>
          <p className="text-sm text-stone-700">{group.unknownReason}</p>
        </div>

        {/* 3. 涉及的分區與植物 */}
        <div>
          <p className="text-xs font-semibold text-stone-400 mb-0.5">涉及的分區與植物</p>
          <p className="text-sm text-stone-700">{group.zoneName}｜{group.plantNames.join('、')}</p>
          {group.locationLabels.length > 0 && (
            <p className="text-xs text-stone-400 mt-0.5">種植區塊：{group.locationLabels.join('、')}</p>
          )}
        </div>

        {/* 4. 圖面定位 */}
        {onLocate && (
          <button onClick={onLocate} className="text-xs font-semibold text-[#1a4731] hover:underline flex items-center gap-1">
            <MapPin size={12} /> 在圖面定位
          </button>
        )}

        {/* 5. 可以直接選擇的確認答案；6. 選擇後既有管線自動重新計算審查結果 */}
        <div className="pt-1 border-t border-stone-100">
          {group.overrideApplied ? (
            <p className="text-sm text-emerald-700 font-semibold">✓ 已確認為「{OVERRIDE_LABEL[group.overrideApplied]}」，審查結果已重新計算</p>
          ) : group.singleLayer && onApply ? (
            <div className="flex flex-wrap gap-1.5">
              <span className="text-xs text-stone-500 self-center mr-1">確認為：</span>
              {CONFIRM_OPTIONS.map(([action, label]) => (
                <button key={action} onClick={() => onApply(action)}
                  className="text-xs px-2.5 py-1 rounded-full bg-amber-50 border border-amber-200 text-amber-700 hover:bg-amber-100 font-medium">
                  {label}
                </button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-stone-400">此類型無單一圖層可批次分類，請於圖面定位後現場或圖面覆核確認</p>
          )}
        </div>
      </div>
    </div>
  )
}
