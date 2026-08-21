// ── 工程估價：今日缺項補價（2026-08-19）──────────────────────────────────────
// 來源檔案：src/data/price-sources/景觀APP_今日缺項補價_20260819.csv
//
// 補齊 13 種先前查無單價的植物；CSV 的「價格來源」欄依內容轉成 sourceType/sourceYear：
//   112工程會 → sourceType:'gov', sourceYear:112
//   110工程會 → sourceType:'gov', sourceYear:110
//   其餘（台灣市場／市場暫參考／田尾玫瑰園）→ sourceType:'market'
// 這樣才能套用既有的價格來源優先序（人工自訂 > 112工程會 > 110工程會 > 市場價，
// 見 estimatePriceStore.ts selectPreferredPlantPrice），不是另外寫一套判斷。
//
// 茄苳這筆本次 CSV 沒有匯入：內容跟既有 GOV112_FULL_PRICE_SEED 的「茄苳
// 450≦樹高<500cm。260≦樹幅<280cm。14≦米高直徑<16cm ＝ 6558元」是同一筆官方資料
// （只是規格文字排版不同：CSV 寫「H450–500cm；W260–280cm；米高直徑14–16cm」），
// 依規則四「同植物同規格已有資料就不要重複新增」，不重複匯入。
//
// 楊梅／五葉松的備註本身就明講「僅供簡報展示／需要人工覆核」（找不到精準同規格公開價，
// 用最接近的規格暫代），依規格要求標上 candidateNote「規格待覆核」，但不阻擋顯示暫估價格。

import type { PlantPrice } from '@/types/estimate'

interface RawRow {
  plantName: string
  category: PlantPrice['category']
  spec: string
  materialPrice: number
  sourceLabel: '112工程會' | '110工程會' | '台灣市場' | '市場暫參考' | '田尾玫瑰園'
  note: string
  needsReview?: boolean
}

const ROWS: RawRow[] = [
  { plantName: '金葉金露花', category: 'shrub', spec: '10–13cm盆苗參考', materialPrice: 33, sourceLabel: '112工程會', note: '以「黃金露華」10cm≦容器直徑<13cm硬對應' },
  { plantName: '熊貓仙丹', category: 'shrub', spec: '3吋盆', materialPrice: 40, sourceLabel: '台灣市場', note: '心栽花坊/台灣市場公開價' },
  { plantName: '楊梅', category: 'tree', spec: '米徑約15cm', materialPrice: 8000, sourceLabel: '市場暫參考', note: '缺精準15cm同規格公開價；此值僅供簡報展示，正式估價前需人工覆核', needsReview: true },
  { plantName: '長紅木', category: 'shrub', spec: '3.5吋盆；高20–30cm', materialPrice: 35, sourceLabel: '田尾玫瑰園', note: '直接市場價' },
  { plantName: '五葉松', category: 'tree', spec: '約H3m（公開價最接近大型景觀規格）', materialPrice: 10000, sourceLabel: '田尾玫瑰園', note: '未找到米徑15cm同規格公開價；先用H3m景觀株參考，正式估價需覆核', needsReview: true },
  { plantName: '南天竹', category: 'shrub', spec: '一般植栽工項', materialPrice: 245, sourceLabel: '110工程會', note: '112未見同項，依優先規則採110工程會' },
  { plantName: '青楓', category: 'tree', spec: '米徑15cm；H約5–7m', materialPrice: 12000, sourceLabel: '台灣市場', note: '公開市場同規格15cm售價' },
  { plantName: '羅漢松', category: 'shrub', spec: '蘭嶼羅漢松2.5吋；高20–30cm', materialPrice: 25, sourceLabel: '田尾玫瑰園', note: '作密植小苗參考' },
  { plantName: '觀音棕竹', category: 'shrub', spec: '細葉觀音棕竹3吋', materialPrice: 70, sourceLabel: '台灣市場', note: '公開市場價' },
  { plantName: '白鶴芋', category: 'groundcover', spec: '3吋盆', materialPrice: 40, sourceLabel: '台灣市場', note: '3吋小苗市場價' },
  { plantName: '蜘蛛百合', category: 'groundcover', spec: '3吋盆', materialPrice: 40, sourceLabel: '台灣市場', note: '3吋盆市場價；田尾另有H約30cm 50元（未成列，如需採用請於單價設定手動新增）' },
  { plantName: '梔子花', category: 'shrub', spec: '3吋盆', materialPrice: 50, sourceLabel: '台灣市場', note: '玉堂春/梔子花3吋市場價' },
]

function toSourceMeta(label: RawRow['sourceLabel']): { sourceType: PlantPrice['sourceType']; sourceYear?: number; priceSource: string } {
  if (label === '112工程會') return { sourceType: 'gov', sourceYear: 112, priceSource: '112年度公共工程植栽材料價格參考表' }
  if (label === '110工程會') return { sourceType: 'gov', sourceYear: 110, priceSource: '110年度公共工程植栽材料價格參考表' }
  return { sourceType: 'market', priceSource: label === '田尾玫瑰園' ? '田尾玫瑰園／市場參考價' : label }
}

export const GAP_FILL_20260819_PRICE_SEED: PlantPrice[] = ROWS.map((r, i) => {
  const meta = toSourceMeta(r.sourceLabel)
  return {
    id: `seed-gapfill20260819-${r.plantName}-${i}`,
    plantName: r.plantName,
    category: r.category,
    specification: r.spec,
    pricingUnit: 'plant',
    // 材料參考價，不是連工帶料單價——只留在 legacyMaterialPrice 供核對用。
    legacyMaterialPrice: r.materialPrice,
    ...meta,
    note: r.note,
    candidateNote: r.needsReview ? `規格待覆核：${r.note}` : undefined,
  }
})
