// ── exportEstimatePdf.ts ─────────────────────────────────────────────────────
// 工程估價 PDF 匯出——直接在目前分頁用瀏覽器原生列印輸出，不開新視窗。
//
// 原本跟 exportReviewPdf.ts 一樣用 window.open() 開新視窗寫入 HTML 再列印，
// 但這個做法很容易被瀏覽器的彈出視窗封鎖擋下來，擋下來的時候使用者完全看不到
// 任何反應（連備援的 alert() 有時都會被封鎖），等於整個按鈕像壞掉一樣。改成把
// 報表內容注入目前頁面一個「只在列印時顯示」的隱藏區塊，直接對目前分頁呼叫
// window.print()——不會被彈出視窗封鎖擋下來，因為根本沒有開新視窗。
//
// 「有資料才顯示」：施工費／土壤客土／運搬／吊車／其他工程費等章節，只在真的有對應
// 金額（> 0）時才輸出；目前系統還沒有土壤/運搬/吊車/其他工程費的資料來源，因此這幾個
// 章節現階段一律不會出現，不是漏做，是刻意不虛構空章節（見規格「有資料才顯示原則」）。
// 材料表本身也只列出「已計價」的項目——缺少單價的植栽不塞進正式估價表充數，改在表格
// 下方用一行提示「還有 N 項尚未計價」，不是用「—」或「尚未設定」佔位。

import type { EstimateCategory, EstimateItem, EstimateZoneSummary, EstimateCaseSummary } from '@/types/estimate'
import { ESTIMATE_CATEGORY_LABEL } from '@/types/estimate'
import { itemMaterialCost } from '@/utils/estimateAdapter'

export interface EstimatePdfMeta {
  projectName?: string   // 專案／DXF 圖面名稱
}

const PRINT_ROOT_ID = 'estimate-pdf-print-root'
const PRINT_STYLE_ID = 'estimate-pdf-print-style'

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function formatNT(n: number): string {
  return `NT$ ${Math.round(n).toLocaleString('en-US')}`
}

function formatQuantity(item: EstimateItem): string {
  if (item.plantCount !== undefined) return `${item.plantCount.toLocaleString('en-US')} 株`
  return `${item.quantity.toFixed(item.unit === '㎡' ? 2 : 0)} ${item.unit}`
}

// PDF 只收錄「有材料單價可用」的項目——注意這裡刻意不是用 item.pricingStatus==='priced'
// （那個要求材料+施工單價都填齊才算數，見 estimateAdapter.ts buildItem），而是跟畫面上
// 「植栽材料費」卡片、分區小計同一套標準：只要有材料單價、且不是「待設定種植密度／
// 規格不明確」（這兩種狀態下 quantity 基礎不可靠，不能直接乘），就算「材料估價表」裡
// 可以出現的一筆——這樣 PDF 呈現的材料費才會跟畫面上看到的數字 100% 一致。
// 施工單價缺少不影響材料表：那是另一個獨立章節（見下方 hasLabor 判斷），不是「未取得單價」。
function hasMaterialCost(item: EstimateItem): boolean {
  return item.materialUnitPrice !== undefined
    && item.pricingStatus !== 'missing_density'
    && item.pricingStatus !== 'ambiguous_spec'
}

function pricedItems(items: EstimateItem[]): EstimateItem[] {
  return items.filter(hasMaterialCost)
}

const CATEGORY_ORDER: EstimateCategory[] = ['tree', 'shrub', 'groundcover', 'grass']

function itemRows(items: EstimateItem[]): string {
  const sorted = [...items].sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category))
  return sorted.map(i => `
    <tr>
      <td>${esc(i.plantName)}</td>
      <td>${ESTIMATE_CATEGORY_LABEL[i.category]}</td>
      <td>${esc(i.specification ?? '')}</td>
      <td class="ep-num">${esc(formatQuantity(i))}</td>
      <td class="ep-num">${formatNT(i.materialUnitPrice ?? 0)}</td>
      <td class="ep-num ep-strong">${formatNT(itemMaterialCost(i))}</td>
    </tr>`).join('')
}

function zoneSection(zone: EstimateZoneSummary): string {
  const priced = pricedItems(zone.items)
  if (priced.length === 0) return ''
  const skippedCount = zone.items.length - priced.length
  // 跟畫面上「本區合計」用同一個欄位（zone.materialTotal 本身就是 itemMaterialCost 加總），
  // 不要在這裡另外重算，避免兩邊算法分岔又對不上。
  const materialTotal = zone.materialTotal

  // 刻意不強制換頁（沒有 ep-page-break）——分區之間改成連續流式排列，讓瀏覽器依照
  // 實際內容高度自動判斷要不要換頁：.ep-section 的 page-break-inside:avoid 讓「小分區」
  // 整塊留在同一頁（放不下就整塊移到下一頁，不會被攔腰切開)；分區大到連一整頁都放不下時，
  // 瀏覽器才會被迫在 .ep-table 內部（tr 之間）換頁，並靠 thead 的 table-header-group
  // 自動在下一頁重複表頭（見規格五、規格七）。
  return `
<div class="ep-section">
  <div class="ep-section-title">${esc(zone.zoneId)}　植栽材料估價</div>
  <table class="ep-table">
    <thead>
      <tr>
        <th>植物名稱</th><th>分類</th><th>規格</th>
        <th class="ep-num">數量</th><th class="ep-num">材料單價</th><th class="ep-num">材料小計</th>
      </tr>
    </thead>
    <tbody>${itemRows(priced)}</tbody>
  </table>
  ${skippedCount > 0 ? `<div class="ep-skip-note">另有 ${skippedCount} 項植栽尚未取得單價，未列入本表。</div>` : ''}
  <div class="ep-zone-total">${esc(zone.zoneId)} 植栽材料費小計：<span class="ep-amount">${formatNT(materialTotal)}</span></div>
</div>`
}

function buildReportBodyHtml(zones: EstimateZoneSummary[], caseSummary: EstimateCaseSummary, meta: EstimatePdfMeta): string {
  const now = new Date()
  const dateStr = now.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: 'long', day: 'numeric' })

  const zonesWithPricedItems = zones.filter(z => pricedItems(z.items).length > 0)
  // 跟畫面上「全案植栽材料費」卡片用同一個欄位（caseSummary.materialTotal），不要另外
  // 重新加總——這正是這次修的問題：PDF 之前另外用 item.subtotal 重算，跟畫面上的
  // itemMaterialCost 加總標準不一致，才會出現畫面有價格、PDF 卻判斷「未取得單價」。
  const totalMaterial = caseSummary.materialTotal
  const totalPricedCount = zonesWithPricedItems.reduce((s, z) => s + pricedItems(z.items).length, 0)
  const totalSkippedCount = zones.reduce((s, z) => s + z.items.length, 0) - totalPricedCount

  // 施工費／土壤客土／運搬／吊車／其他工程費：只有真的有金額時才輸出對應章節
  // （見規格「動態判斷」）。目前系統沒有這幾類的資料來源，laborTotal 也一律是 0，
  // 因此現階段這段邏輯運作起來就是「完全不顯示」，等未來有資料再自然出現。
  const hasLabor = caseSummary.laborTotal > 0
  const reportSubtitle = hasLabor ? '完整景觀工程估價' : '植栽材料估價'

  return `
<div class="ep-report-header">
  <div class="ep-report-title">景觀工程估價表</div>
  <div class="ep-report-subtitle">${esc(reportSubtitle)}</div>
  <div class="ep-report-meta">
    ${meta.projectName ? `<span>專案／圖面名稱：<b>${esc(meta.projectName)}</b></span>` : ''}
    <span>估價產生日期：<b>${esc(dateStr)}</b></span>
  </div>
</div>

${zonesWithPricedItems.map(z => zoneSection(z)).join('')}

<div class="ep-section">
  <div class="ep-section-title">全案總計</div>
  <div class="ep-grand-total-box">
    <div class="ep-grand-total-row">
      <span class="ep-grand-total-label">全案植栽材料費總計</span>
      <span class="ep-grand-total-value">${formatNT(totalMaterial)}</span>
    </div>
    ${hasLabor ? `<div class="ep-grand-total-row">
      <span class="ep-grand-total-label">種植施工費總計</span>
      <span class="ep-grand-total-value">${formatNT(caseSummary.laborTotal)}</span>
    </div>` : ''}
    <div class="ep-grand-total-row ep-final">
      <span class="ep-grand-total-label">預估總工程費</span>
      <span class="ep-grand-total-value">${formatNT(totalMaterial + (hasLabor ? caseSummary.laborTotal : 0))}</span>
    </div>
  </div>
  ${totalSkippedCount > 0 ? `<div class="ep-skip-note" style="margin-top:3mm">全案另有 ${totalSkippedCount} 項植栽尚未取得單價，未列入本估價表金額。</div>` : ''}
</div>

<div class="ep-report-footer">
  <span>景觀 AI 設計審查顧問 2.0　｜　工程估價表</span>
  <span>${esc(dateStr)}</span>
</div>`
}

const PRINT_CSS = `
@media screen {
  #${PRINT_ROOT_ID} { display: none; }
}
@media print {
  @page { size: A4 portrait; margin: 12mm 12mm 14mm 12mm; }
  /* 用 display:none 而不是 visibility:hidden 隱藏頁面其餘內容——visibility:hidden 的元素
     還是會保留原本的版面高度（只是看不到），這個 SPA 其他分頁/面板疊起來高度很可觀，
     結果列印引擎會為了那些「看不到但還占著版面」的內容多印出一堆空白頁。display:none
     直接把它們從版面移除，印出的頁數才會單純由列印區塊自己的內容高度決定。 */
  body > *:not(#${PRINT_ROOT_ID}) { display: none !important; }
  #${PRINT_ROOT_ID} {
    display: block !important;
    position: static;
    font-family: 'Noto Sans TC', 'Microsoft JhengHei', 'PingFang TC', sans-serif;
    font-size: 10.5pt;
    color: #1c1917;
    line-height: 1.5;
  }
  #${PRINT_ROOT_ID} .ep-report-header { border-bottom: 2.5px solid #1a4731; padding-bottom: 4mm; margin-bottom: 6mm; }
  #${PRINT_ROOT_ID} .ep-report-title { font-size: 22pt; font-weight: 800; color: #14532d; line-height: 1.3; }
  #${PRINT_ROOT_ID} .ep-report-subtitle { font-size: 12pt; font-weight: 600; color: #4b5563; margin-top: 1.5mm; }
  #${PRINT_ROOT_ID} .ep-report-meta { margin-top: 3mm; font-size: 10pt; color: #4b5563; }
  #${PRINT_ROOT_ID} .ep-report-meta span { margin-right: 8mm; }
  #${PRINT_ROOT_ID} .ep-report-meta b { color: #1c1917; font-weight: 700; }
  /* 分區之間連續流式排列（不強制換頁）：page-break-inside:avoid 讓一個分區盡量整塊留在
     同一頁，放不下才整塊移到下一頁；分區本身大到連一整頁都放不下時，瀏覽器會被迫在
     .ep-table 內部換頁，交給下面 thead/tr 的規則處理（見規格一、二、五）。 */
  #${PRINT_ROOT_ID} .ep-section { margin-bottom: 6mm; page-break-inside: avoid; }
  /* 避免孤立標題：標題後面不能馬上斷頁，至少要跟表頭+第一列資料同頁（見規格四）。 */
  #${PRINT_ROOT_ID} .ep-section-title { font-size: 13pt; font-weight: 800; color: #14532d; border-left: 4px solid #1a4731; padding-left: 3mm; margin-bottom: 2mm; page-break-after: avoid; page-break-inside: avoid; }
  #${PRINT_ROOT_ID} table.ep-table { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
  #${PRINT_ROOT_ID} table.ep-table thead { display: table-header-group; }
  #${PRINT_ROOT_ID} table.ep-table th { background: #f0fdf4; color: #166534; font-weight: 700; padding: 1.8mm 2.6mm; border: 1px solid #d1fae5; text-align: left; white-space: nowrap; page-break-after: avoid; }
  #${PRINT_ROOT_ID} table.ep-table td { padding: 1.8mm 2.6mm; border: 1px solid #e5e7eb; vertical-align: top; }
  #${PRINT_ROOT_ID} table.ep-table tr:nth-child(even) td { background: #f9fafb; }
  #${PRINT_ROOT_ID} table.ep-table .ep-num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  #${PRINT_ROOT_ID} table.ep-table .ep-strong { font-weight: 700; color: #1c1917; }
  #${PRINT_ROOT_ID} table.ep-table tr { page-break-inside: avoid; }
  #${PRINT_ROOT_ID} .ep-skip-note { font-size: 8.5pt; color: #92400e; margin-top: 1.5mm; }
  /* 分區小計直接接在表格下方，不額外留大段空白 */
  #${PRINT_ROOT_ID} .ep-zone-total { text-align: right; margin-top: 2mm; padding-top: 1.5mm; border-top: 1.5px solid #d1d5db; font-size: 11pt; font-weight: 700; page-break-inside: avoid; }
  #${PRINT_ROOT_ID} .ep-zone-total .ep-amount { color: #1a4731; margin-left: 3mm; }
  #${PRINT_ROOT_ID} .ep-grand-total-box { margin-top: 3mm; padding: 5mm 6mm; background: #f0fdf4; border: 2px solid #1a4731; border-radius: 3mm; }
  #${PRINT_ROOT_ID} .ep-grand-total-row { display: flex; justify-content: space-between; align-items: baseline; padding: 1.2mm 0; }
  #${PRINT_ROOT_ID} .ep-grand-total-row.ep-final { margin-top: 1.5mm; padding-top: 2.5mm; border-top: 1.5px solid #86efac; }
  #${PRINT_ROOT_ID} .ep-grand-total-label { font-size: 10.5pt; color: #374151; }
  #${PRINT_ROOT_ID} .ep-grand-total-value { font-size: 11pt; font-weight: 700; color: #1c1917; font-variant-numeric: tabular-nums; }
  #${PRINT_ROOT_ID} .ep-grand-total-row.ep-final .ep-grand-total-label { font-size: 13pt; font-weight: 800; color: #14532d; }
  #${PRINT_ROOT_ID} .ep-grand-total-row.ep-final .ep-grand-total-value { font-size: 20pt; font-weight: 900; color: #14532d; }
  #${PRINT_ROOT_ID} .ep-report-footer { margin-top: 8mm; padding-top: 3mm; border-top: 1px solid #e5e7eb; display: flex; justify-content: space-between; font-size: 8.5pt; color: #9ca3af; }
}
`

/**
 * 產出並列印工程估價 PDF——直接對目前分頁呼叫 window.print()，不開新視窗，
 * 不會被瀏覽器的彈出視窗封鎖擋下來。做法：把排版好的報表內容注入一個平常
 * display:none、只在 @media print 時顯示的隱藏區塊，同時用 visibility 把畫面上
 * 其他內容藏起來，讓瀏覽器的列印/另存 PDF 只印出這個區塊。
 */
export function exportEstimatePdf(
  zones: EstimateZoneSummary[],
  caseSummary: EstimateCaseSummary,
  meta: EstimatePdfMeta = {},
): void {
  if (typeof document === 'undefined') return

  let styleEl = document.getElementById(PRINT_STYLE_ID) as HTMLStyleElement | null
  if (!styleEl) {
    styleEl = document.createElement('style')
    styleEl.id = PRINT_STYLE_ID
    document.head.appendChild(styleEl)
  }
  styleEl.textContent = PRINT_CSS

  let rootEl = document.getElementById(PRINT_ROOT_ID)
  if (!rootEl) {
    rootEl = document.createElement('div')
    rootEl.id = PRINT_ROOT_ID
    document.body.appendChild(rootEl)
  }
  rootEl.innerHTML = buildReportBodyHtml(zones, caseSummary, meta)

  window.print()
}
