// ── exportReviewPdf.ts ────────────────────────────────────────────────────────
// 景觀 AI 審查報告 PDF 匯出（瀏覽器原生列印，零額外套件，支援中文）

import type { SelectedCsvPlant } from '@/types/csvPlant'
import type { EvalResult } from '@/utils/plantEvaluator'

export interface ReportMeta {
  projectName?: string          // 專案名稱
  sourceFile?: string           // 圖面來源
  reviewType?: string           // 'AI 配植評估' | 'PDF 審圖' | 'DXF 審查'
  zoneName?: string             // 分區名稱（如有）
}

// ── Color helpers ─────────────────────────────────────────────────────────────

function compatColor(level: string): string {
  if (level === '配置良好')        return '#059669'
  if (level === '可行但需補充說明') return '#d97706'
  if (level === '需調整配置')      return '#ea580c'
  return '#dc2626'
}

function compatBg(level: string): string {
  if (level === '配置良好')        return '#ecfdf5'
  if (level === '可行但需補充說明') return '#fffbeb'
  if (level === '需調整配置')      return '#fff7ed'
  return '#fef2f2'
}

function issueBg(level: string): string {
  return level === 'danger' ? '#fef2f2' : '#fffbeb'
}

function issueColor(level: string): string {
  return level === 'danger' ? '#dc2626' : '#d97706'
}

function issueBorder(level: string): string {
  return level === 'danger' ? '#fca5a5' : '#fcd34d'
}

function issueLabel(level: string): string {
  return level === 'danger' ? '⚠ 高風險' : '注意'
}

function scoreColor(score: number): string {
  if (score >= 80) return '#059669'
  if (score >= 60) return '#d97706'
  return '#dc2626'
}

// ── HTML builder ──────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function plantTableRows(plants: SelectedCsvPlant[]): string {
  return plants.map(p => `
    <tr>
      <td>${esc(p.name)}</td>
      <td>${esc(p.subCategory || p.category)}</td>
      <td>${esc(p.sunRequirement)}</td>
      <td>${esc(p.waterRequirement)}</td>
      <td>${esc(p.wetTolerance)}</td>
      <td>${esc(p.droughtTolerance)}</td>
      <td class="${p.dataComplete ? 'ok' : 'warn'}">${p.dataComplete ? '完整' : '待補'}</td>
    </tr>`).join('')
}

function issueCards(result: EvalResult): string {
  const active = result.issues.filter(i => i.level !== 'ok')
  if (active.length === 0) return '<p class="ok-note">✅ 本次審查未發現需調整之問題項目。</p>'
  return active.map(i => `
    <div class="issue-card" style="background:${issueBg(i.level)};border-color:${issueBorder(i.level)}">
      <div class="issue-header">
        <span class="issue-tag" style="background:${issueColor(i.level)}">${issueLabel(i.level)}</span>
        <strong>${esc(i.category)}</strong>
      </div>
      <table class="issue-detail">
        <tr><th>問題原因</th><td>${esc(i.cause)}</td></tr>
        <tr><th>實務影響</th><td>${esc(i.impact)}</td></tr>
        <tr><th>修正建議</th><td>${esc(i.suggestion)}</td></tr>
      </table>
    </div>`).join('')
}

function categoryTable(result: EvalResult): string {
  return result.categories.map(c => {
    const color = c.level === 'danger' ? '#dc2626' : c.level === 'caution' ? '#d97706' : '#059669'
    const bg    = c.level === 'danger' ? '#fef2f2' : c.level === 'caution' ? '#fffbeb' : '#ecfdf5'
    return `<tr style="background:${bg}">
      <td>${esc(c.label)}</td>
      <td style="text-align:center">${c.count > 0 ? c.count : '—'}</td>
      <td style="color:${color};font-weight:700">${esc(c.statusLabel)}</td>
      <td class="summary-cell">${esc(c.summary)}</td>
    </tr>`
  }).join('')
}

function sourceRows(plants: SelectedCsvPlant[]): string {
  const rows = plants.filter(p => p.sunWaterSource || p.referenceNote)
  if (rows.length === 0) return '<tr><td colspan="3" style="color:#9ca3af">（無附加資料來源）</td></tr>'
  return rows.map(p => `
    <tr>
      <td>${esc(p.name)}</td>
      <td>${esc(p.sunWaterSource || '—')}</td>
      <td>${p.verifiedAt ? esc(p.verifiedAt) : '—'}</td>
    </tr>`).join('')
}

// ── Main export function ──────────────────────────────────────────────────────

export function exportReviewReportPdf(
  plants: SelectedCsvPlant[],
  result: EvalResult,
  meta: ReportMeta = {},
  options: { returnHtml?: boolean } = {},
): void | string {
  const now       = new Date()
  const dateStr   = now.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })
  const scoreCol  = scoreColor(result.score)
  const compatCol = compatColor(result.compatLevel)
  const compatBg_ = compatBg(result.compatLevel)
  const dangerCnt = result.issues.filter(i => i.level === 'danger').length
  const cautionCnt= result.issues.filter(i => i.level === 'caution').length

  const html = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<title>景觀 AI 設計審查顧問 2.0｜植栽配置評估報告</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  @page {
    size: A4 portrait;
    margin: 18mm 15mm 18mm 15mm;
  }

  body {
    font-family: 'Noto Sans TC', 'Microsoft JhengHei', 'PingFang TC', sans-serif;
    font-size: 11pt;
    color: #1c1917;
    background: #fff;
    line-height: 1.7;
  }

  /* ── Cover ── */
  .cover {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: flex-start;
    padding: 0 4mm;
    page-break-after: always;
  }
  .cover-logo {
    font-size: 10pt;
    color: #6b7280;
    letter-spacing: .05em;
    margin-bottom: 12mm;
  }
  .cover-title {
    font-size: 28pt;
    font-weight: 800;
    color: #14532d;
    line-height: 1.25;
    margin-bottom: 4mm;
  }
  .cover-subtitle {
    font-size: 16pt;
    font-weight: 600;
    color: #166534;
    margin-bottom: 14mm;
  }
  .cover-meta {
    border-top: 2px solid #d1fae5;
    padding-top: 7mm;
    width: 100%;
  }
  .cover-meta table {
    border-collapse: collapse;
    width: 100%;
    font-size: 11pt;
  }
  .cover-meta td {
    padding: 3mm 4mm;
    vertical-align: top;
  }
  .cover-meta td:first-child {
    color: #6b7280;
    width: 28mm;
    font-weight: 600;
  }
  .cover-meta td:last-child {
    color: #1c1917;
    font-weight: 500;
  }
  .cover-score-box {
    margin-top: 10mm;
    display: inline-flex;
    align-items: center;
    gap: 8mm;
    background: ${compatBg_};
    border: 2px solid ${compatCol};
    border-radius: 6mm;
    padding: 5mm 8mm;
  }
  .cover-score-num {
    font-size: 42pt;
    font-weight: 900;
    color: ${scoreCol};
    line-height: 1;
  }
  .cover-score-label {
    font-size: 9pt;
    color: #6b7280;
  }
  .cover-compat {
    font-size: 16pt;
    font-weight: 700;
    color: ${compatCol};
    margin-top: 1mm;
  }
  .cover-risk-chips {
    display: flex;
    gap: 4mm;
    margin-top: 5mm;
  }
  .chip {
    display: inline-block;
    padding: 1.5mm 4mm;
    border-radius: 20px;
    font-size: 9.5pt;
    font-weight: 700;
  }
  .chip-danger  { background: #fef2f2; color: #dc2626; border: 1.5px solid #fca5a5; }
  .chip-caution { background: #fffbeb; color: #d97706; border: 1.5px solid #fcd34d; }
  .chip-ok      { background: #ecfdf5; color: #059669; border: 1.5px solid #6ee7b7; }

  /* ── Sections ── */
  .section {
    margin-bottom: 9mm;
    page-break-inside: avoid;
  }
  .section-title {
    font-size: 14pt;
    font-weight: 800;
    color: #14532d;
    border-left: 4px solid #16a34a;
    padding-left: 4mm;
    margin-bottom: 4mm;
  }
  .section-subtitle {
    font-size: 10pt;
    color: #6b7280;
    margin-bottom: 3mm;
  }

  /* ── Tables ── */
  table.data-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 10pt;
    margin-top: 2mm;
  }
  table.data-table th {
    background: #f0fdf4;
    color: #166534;
    font-weight: 700;
    padding: 2.5mm 3mm;
    border: 1px solid #d1fae5;
    text-align: left;
    white-space: nowrap;
  }
  table.data-table td {
    padding: 2.5mm 3mm;
    border: 1px solid #e5e7eb;
    vertical-align: top;
    line-height: 1.5;
  }
  table.data-table tr:nth-child(even) td { background: #f9fafb; }
  td.ok   { color: #059669; font-weight: 600; }
  td.warn { color: #d97706; font-weight: 600; }

  /* category summary table */
  table.cat-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 10pt;
    margin-top: 2mm;
  }
  table.cat-table th {
    background: #f8fafc;
    color: #374151;
    font-weight: 700;
    padding: 2.5mm 3mm;
    border: 1px solid #e5e7eb;
    text-align: left;
  }
  table.cat-table td {
    padding: 2.5mm 3mm;
    border: 1px solid #e5e7eb;
    vertical-align: top;
  }
  .summary-cell { font-size: 9pt; color: #6b7280; }

  /* ── Issue cards ── */
  .issue-card {
    border: 1.5px solid;
    border-radius: 4mm;
    padding: 4mm 5mm;
    margin-bottom: 4mm;
    page-break-inside: avoid;
  }
  .issue-header {
    display: flex;
    align-items: center;
    gap: 3mm;
    margin-bottom: 2.5mm;
  }
  .issue-tag {
    color: #fff;
    font-size: 8.5pt;
    font-weight: 700;
    padding: 0.5mm 2.5mm;
    border-radius: 3mm;
    white-space: nowrap;
  }
  table.issue-detail {
    width: 100%;
    border-collapse: collapse;
    font-size: 10pt;
  }
  table.issue-detail th {
    width: 20mm;
    font-weight: 700;
    color: #374151;
    padding: 1.5mm 2mm;
    vertical-align: top;
    text-align: left;
    white-space: nowrap;
  }
  table.issue-detail td {
    padding: 1.5mm 2mm;
    color: #374151;
    line-height: 1.6;
  }

  /* ── AI suggestion & review text ── */
  .ai-box {
    background: #f0fdf4;
    border: 1.5px solid #bbf7d0;
    border-radius: 4mm;
    padding: 4mm 5mm;
    font-size: 11pt;
    line-height: 1.85;
    color: #14532d;
  }
  .review-text-box {
    background: #f8fafc;
    border: 1.5px solid #d1d5db;
    border-radius: 4mm;
    padding: 5mm 6mm;
    font-size: 11pt;
    line-height: 2;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .adj-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .adj-list li {
    display: flex;
    gap: 2mm;
    padding: 1.5mm 0;
    font-size: 11pt;
    line-height: 1.75;
  }
  .adj-list li::before {
    content: '→';
    color: #16a34a;
    font-weight: 700;
    flex-shrink: 0;
    margin-top: 0.2mm;
  }
  .ok-note {
    color: #059669;
    font-weight: 600;
    padding: 3mm 0;
  }

  /* ── Page break helpers ── */
  .page-break { page-break-before: always; }

  /* ── Footer (via @page cannot do dynamic, use body::after trick) ── */
  .report-footer {
    margin-top: 8mm;
    border-top: 1px solid #e5e7eb;
    padding-top: 3mm;
    font-size: 8.5pt;
    color: #9ca3af;
    display: flex;
    justify-content: space-between;
  }

  /* ── Screen-only helpers ── */
  @media screen {
    body { padding: 8mm; background: #f3f4f6; }
    .cover, .section, .issue-card { max-width: 190mm; margin-left: auto; margin-right: auto; }
    .print-btn {
      position: fixed; top: 16px; right: 16px;
      background: #16a34a; color: #fff;
      border: none; border-radius: 8px;
      padding: 10px 22px; font-size: 14px; font-weight: 700;
      cursor: pointer; z-index: 1000; box-shadow: 0 2px 12px rgba(0,0,0,.18);
    }
    .print-btn:hover { background: #15803d; }
  }
  @media print {
    .print-btn { display: none; }
  }
</style>
</head>
<body>

<button class="print-btn" onclick="window.print()">列印 / 儲存為 PDF</button>

<!-- ══════════════ 封面 ══════════════ -->
<div class="cover">
  <div class="cover-logo">景觀 AI 設計審查顧問 2.0　Landscape AI Design Review</div>
  <div class="cover-title">植栽配置<br>評估報告</div>
  <div class="cover-subtitle">Planting Configuration Assessment Report</div>

  <div class="cover-score-box">
    <div>
      <div style="font-size:9pt;color:#6b7280;margin-bottom:1mm">配置相容性分數</div>
      <div class="cover-score-num">${result.score}</div>
      <div style="font-size:9pt;color:#6b7280;margin-top:0.5mm">/ 100</div>
    </div>
    <div>
      <div class="cover-score-label">評估結果</div>
      <div class="cover-compat">${esc(result.compatLevel)}</div>
      <div class="cover-risk-chips" style="margin-top:3mm">
        ${dangerCnt  > 0 ? `<span class="chip chip-danger">⚠ 高風險 ${dangerCnt} 項</span>`  : ''}
        ${cautionCnt > 0 ? `<span class="chip chip-caution">需注意 ${cautionCnt} 項</span>` : ''}
        ${(dangerCnt + cautionCnt) === 0 ? '<span class="chip chip-ok">✅ 無重大問題</span>' : ''}
      </div>
    </div>
  </div>

  <div class="cover-meta" style="margin-top:10mm">
    <table>
      <tr><td>審查類型</td><td>${esc(meta.reviewType || 'AI 配植評估')}</td></tr>
      ${meta.projectName ? `<tr><td>專案名稱</td><td>${esc(meta.projectName)}</td></tr>` : ''}
      ${meta.sourceFile  ? `<tr><td>圖面來源</td><td>${esc(meta.sourceFile)}</td></tr>`  : ''}
      ${meta.zoneName    ? `<tr><td>審查分區</td><td>${esc(meta.zoneName)}</td></tr>`    : ''}
      <tr><td>植栽種類</td><td>${plants.length} 種</td></tr>
      <tr><td>產生時間</td><td>${esc(dateStr)}</td></tr>
    </table>
  </div>
</div>

<!-- ══════════════ 第一頁：植栽清單 ══════════════ -->
<div class="section page-break">
  <div class="section-title">§1　本區植栽組合</div>
  <div class="section-subtitle">共 ${plants.length} 種植物，欄位包含日照、水分、耐濕、耐旱等關鍵養護參數。</div>
  <table class="data-table">
    <thead>
      <tr>
        <th>植物名稱</th><th>類型</th><th>日照</th>
        <th>水分</th><th>耐濕 / 排水</th><th>耐旱</th><th>資料狀態</th>
      </tr>
    </thead>
    <tbody>${plantTableRows(plants)}</tbody>
  </table>
</div>

<!-- ══════════════ 第二頁：問題分類總覽 ══════════════ -->
<div class="section page-break">
  <div class="section-title">§2　問題分類總覽</div>
  <div class="section-subtitle">各問題類型審查結果摘要，高風險項目請優先處理。</div>
  <table class="cat-table">
    <thead>
      <tr><th>問題類型</th><th style="width:14mm;text-align:center">數量</th><th style="width:22mm">風險等級</th><th>摘要說明</th></tr>
    </thead>
    <tbody>${categoryTable(result)}</tbody>
  </table>
</div>

<!-- ══════════════ 第三頁：審查問題明細 ══════════════ -->
<div class="section page-break">
  <div class="section-title">§3　審查問題明細</div>
  <div class="section-subtitle">每項問題附有原因、實務影響與修正建議，供設計修改參考。</div>
  ${issueCards(result)}
</div>

<!-- ══════════════ 第四頁：AI 建議與調整方案 ══════════════ -->
<div class="section page-break">
  <div class="section-title">§4　AI 配置修正建議</div>
  <div class="ai-box">${esc(result.aiSuggestion)}</div>

  ${result.adjustmentPlan.length > 0 ? `
  <div class="section-title" style="margin-top:8mm">§5　配置調整方案</div>
  <ul class="adj-list">
    ${result.adjustmentPlan.map(p => `<li>${esc(p)}</li>`).join('')}
  </ul>` : ''}
</div>

<!-- ══════════════ 審查回覆文字（獨立頁）══════════════ -->
<div class="section page-break">
  <div class="section-title">§6　審查回覆文字</div>
  <div class="section-subtitle">以下文字可直接複製至審查回覆表單使用，無須修改格式。</div>
  <div class="review-text-box">${esc(result.reviewText)}</div>
</div>

<!-- ══════════════ 附錄：植栽資料來源引用 ══════════════ -->
<div class="section page-break">
  <div class="section-title">附錄　植栽資料來源引用</div>
  <div class="section-subtitle">各植栽數據來源說明，供審查委員核對參考。</div>
  <table class="data-table">
    <thead>
      <tr><th>植物名稱</th><th>資料來源</th><th>查核日期</th></tr>
    </thead>
    <tbody>${sourceRows(plants)}</tbody>
  </table>
</div>

<div class="report-footer">
  <span>景觀 AI 設計審查顧問 2.0　｜　植栽配置評估報告</span>
  <span>${esc(dateStr)}</span>
</div>

</body>
</html>`

  if (options.returnHtml) return html

  const win = window.open('', '_blank', 'width=900,height=700')
  if (!win) {
    alert('請允許彈出視窗以開啟 PDF 報告。\n（瀏覽器設定 → 允許此網站的彈出視窗）')
    return
  }
  win.document.write(html)
  win.document.close()
  setTimeout(() => { win.print() }, 800)
}

// ── DXF 分區審查 PDF ──────────────────────────────────────────────────────────

export interface ZoneBlockPdfEntry {
  blockName: string
  plantName?: string
  detectedType?: string
  count: number
  matchStatus: 'db-matched' | 'name-only' | 'unmatched' | 'same-hatch-disambiguated-by-layer'
}

export interface ZoneReviewPdfData {
  zoneName: string
  status: string
  blockEntries: ZoneBlockPdfEntry[]
  plants: SelectedCsvPlant[]
  evalResult?: EvalResult
}

function zoneBlockTable(entries: ZoneBlockPdfEntry[]): string {
  if (entries.length === 0) return '<p style="color:#9ca3af">（此區無圖塊）</p>'
  return `<table class="data-table" style="font-size:9.5pt">
    <thead><tr>
      <th>圖塊名稱</th><th>植物名稱</th><th>識別類型</th>
      <th style="text-align:center">數量</th><th>狀態</th>
    </tr></thead>
    <tbody>${entries.map(b => `
      <tr style="background:${b.matchStatus==='db-matched'?'#ecfdf5':b.matchStatus==='name-only'?'#fffbeb':b.matchStatus==='same-hatch-disambiguated-by-layer'?'#f0f9ff':'#fef2f2'}">
        <td style="font-family:monospace">${esc(b.blockName)}</td>
        <td style="font-weight:600">${b.plantName ? esc(b.plantName) : '<span style="color:#9ca3af">未對應</span>'}</td>
        <td>${esc(b.detectedType ?? '—')}</td>
        <td style="text-align:center;font-weight:700">${b.count}</td>
        <td style="font-size:8.5pt">${
          b.matchStatus==='db-matched' ? '✅ DB 已比對' :
          b.matchStatus==='name-only'  ? '⚠ 索引表名稱' : '❌ 待對應'
        }</td>
      </tr>`).join('')}
    </tbody>
  </table>`
}

function zoneCard(z: ZoneReviewPdfData, idx: number): string {
  const dangerN  = z.evalResult?.issues.filter(i => i.level==='danger').length  ?? 0
  const cautionN = z.evalResult?.issues.filter(i => i.level==='caution').length ?? 0
  const scoreCol = z.evalResult ? scoreColor(z.evalResult.score) : '#6b7280'
  const total    = z.blockEntries.reduce((s, b) => s + b.count, 0)
  const activeIssues = z.evalResult?.issues.filter(i => i.level !== 'ok') ?? []

  return `
<div class="section${idx > 0 ? ' page-break' : ''}">
  <div class="section-title">§${idx + 2}　${esc(z.zoneName)}</div>

  <!-- 區摘要 -->
  <div style="display:flex;gap:4mm;flex-wrap:wrap;margin-bottom:5mm">
    <div style="padding:3mm 5mm;border-radius:3mm;border:1.5px solid #d1d5db;font-size:10pt">
      圖塊種類：<strong>${z.blockEntries.length}</strong>　共 <strong>${total}</strong> 株
    </div>
    ${z.evalResult ? `
    <div style="padding:3mm 5mm;border-radius:3mm;border:1.5px solid ${compatColor(z.evalResult.compatLevel)};background:${compatBg(z.evalResult.compatLevel)};font-size:10pt">
      分數：<strong style="color:${scoreCol}">${z.evalResult.score}/100</strong>　${esc(z.evalResult.compatLevel)}
    </div>` : ''}
    ${dangerN  > 0 ? `<div style="padding:3mm 5mm;border-radius:3mm;background:#fef2f2;border:1.5px solid #fca5a5;font-size:10pt;color:#dc2626">⚠ 高風險 ${dangerN} 項</div>` : ''}
    ${cautionN > 0 ? `<div style="padding:3mm 5mm;border-radius:3mm;background:#fffbeb;border:1.5px solid #fcd34d;font-size:10pt;color:#d97706">注意 ${cautionN} 項</div>` : ''}
    ${z.status !== '可審查' ? `<div style="padding:3mm 5mm;border-radius:3mm;background:#fffbeb;border:1.5px solid #fcd34d;font-size:10pt;color:#92400e">${esc(z.status)}</div>` : ''}
  </div>

  <!-- 圖塊清單 -->
  <p style="font-size:9pt;color:#6b7280;margin-bottom:2mm">本區植栽圖塊清單</p>
  ${zoneBlockTable(z.blockEntries)}

  <!-- AI 審查（有時才顯示）-->
  ${z.evalResult ? `
  <div style="margin-top:5mm">
    <p style="font-size:11pt;font-weight:700;color:#14532d;margin-bottom:2mm">AI 審查建議</p>
    <div class="ai-box">${esc(z.evalResult.aiSuggestion)}</div>
  </div>
  ${activeIssues.length > 0 ? `
  <div style="margin-top:4mm">
    <p style="font-size:10pt;font-weight:700;color:#374151;margin-bottom:2mm">問題明細</p>
    ${activeIssues.map(iss => `
    <div class="issue-card" style="background:${issueBg(iss.level)};border-color:${issueBorder(iss.level)};margin-bottom:3mm">
      <div class="issue-header">
        <span class="issue-tag" style="background:${issueColor(iss.level)}">${issueLabel(iss.level)}</span>
        <strong>${esc(iss.category)}</strong>
      </div>
      <table class="issue-detail">
        <tr><th>問題原因</th><td>${esc(iss.cause)}</td></tr>
        <tr><th>實務影響</th><td>${esc(iss.impact)}</td></tr>
        <tr><th>修正建議</th><td>${esc(iss.suggestion)}</td></tr>
      </table>
    </div>`).join('')}
  </div>` : ''}
  ${z.evalResult.reviewText ? `
  <div style="margin-top:4mm">
    <p style="font-size:10pt;font-weight:700;color:#374151;margin-bottom:2mm">${esc(z.zoneName)} 審查回覆文字</p>
    <div class="review-text-box" style="font-size:10pt">${esc(z.evalResult.reviewText)}</div>
  </div>` : ''}` : `
  <div style="margin-top:4mm;padding:4mm 5mm;background:#fffbeb;border:1.5px solid #fcd34d;border-radius:4mm;font-size:10pt;color:#92400e">
    ${z.status === '植物待確認'
      ? '本區有圖塊尚未對應植物名稱，無法產生完整審查評分。請至圖塊對應頁面完成指定後重新匯出。'
      : '本區尚無可審查植物。'}
  </div>`}
</div>`
}

export function exportZoneReviewPdf(
  zones: ZoneReviewPdfData[],
  sourceFile = '',
  options: { returnHtml?: boolean } = {},
): void | string {
  const now     = new Date()
  const dateStr = now.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })
  const reviewed    = zones.filter(z => z.evalResult)
  const overallScore= reviewed.length > 0
    ? Math.round(reviewed.reduce((s, z) => s + (z.evalResult!.score), 0) / reviewed.length)
    : 0
  const totalBlocks = zones.reduce((s, z) => s + z.blockEntries.reduce((a, b) => a + b.count, 0), 0)
  const allDanger   = zones.reduce((s, z) => s + (z.evalResult?.issues.filter(i=>i.level==='danger').length??0), 0)
  const allCaution  = zones.reduce((s, z) => s + (z.evalResult?.issues.filter(i=>i.level==='caution').length??0), 0)

  const html = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<title>景觀 AI 設計審查顧問 2.0｜DXF 分區審查報告</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
@page { size: A4 portrait; margin: 18mm 15mm 18mm 15mm; }
body { font-family: 'Noto Sans TC', 'Microsoft JhengHei', 'PingFang TC', sans-serif; font-size: 11pt; color: #1c1917; background: #fff; line-height: 1.7; }
.cover { min-height: 100vh; display: flex; flex-direction: column; justify-content: center; page-break-after: always; padding: 0 4mm; }
.cover-title { font-size: 26pt; font-weight: 800; color: #14532d; line-height: 1.25; margin-bottom: 4mm; }
.cover-subtitle { font-size: 14pt; font-weight: 600; color: #166534; margin-bottom: 14mm; }
.cover-meta { border-top: 2px solid #d1fae5; padding-top: 7mm; width: 100%; }
.cover-meta table { border-collapse: collapse; width: 100%; font-size: 11pt; }
.cover-meta td { padding: 3mm 4mm; vertical-align: top; }
.cover-meta td:first-child { color: #6b7280; width: 28mm; font-weight: 600; }
.section { margin-bottom: 9mm; page-break-inside: avoid; }
.section-title { font-size: 14pt; font-weight: 800; color: #14532d; border-left: 4px solid #16a34a; padding-left: 4mm; margin-bottom: 4mm; }
table.data-table { width: 100%; border-collapse: collapse; font-size: 10pt; margin-top: 2mm; }
table.data-table th { background: #f0fdf4; color: #166534; font-weight: 700; padding: 2.5mm 3mm; border: 1px solid #d1fae5; text-align: left; }
table.data-table td { padding: 2.5mm 3mm; border: 1px solid #e5e7eb; vertical-align: top; line-height: 1.5; }
.ai-box { background:#f0fdf4;border:1.5px solid #bbf7d0;border-radius:4mm;padding:4mm 5mm;font-size:11pt;line-height:1.85;color:#14532d; }
.review-text-box { background:#f8fafc;border:1.5px solid #d1d5db;border-radius:4mm;padding:5mm 6mm;font-size:11pt;line-height:2;white-space:pre-wrap;word-break:break-word; }
.issue-card { border:1.5px solid;border-radius:4mm;padding:4mm 5mm;margin-bottom:4mm;page-break-inside:avoid; }
.issue-header { display:flex;align-items:center;gap:3mm;margin-bottom:2.5mm; }
.issue-tag { color:#fff;font-size:8.5pt;font-weight:700;padding:0.5mm 2.5mm;border-radius:3mm;white-space:nowrap; }
table.issue-detail { width:100%;border-collapse:collapse;font-size:10pt; }
table.issue-detail th { width:20mm;font-weight:700;color:#374151;padding:1.5mm 2mm;vertical-align:top;text-align:left;white-space:nowrap; }
table.issue-detail td { padding:1.5mm 2mm;color:#374151;line-height:1.6; }
.page-break { page-break-before: always; }
.report-footer { margin-top:8mm;border-top:1px solid #e5e7eb;padding-top:3mm;font-size:8.5pt;color:#9ca3af;display:flex;justify-content:space-between; }
@media screen { body { padding:8mm;background:#f3f4f6; } .print-btn { position:fixed;top:16px;right:16px;background:#16a34a;color:#fff;border:none;border-radius:8px;padding:10px 22px;font-size:14px;font-weight:700;cursor:pointer;z-index:1000;box-shadow:0 2px 12px rgba(0,0,0,.18); } .print-btn:hover { background:#15803d; } }
@media print { .print-btn { display:none; } }
</style>
</head>
<body>
<button class="print-btn" onclick="window.print()">列印 / 儲存為 PDF</button>

<!-- 封面 -->
<div class="cover">
  <div style="font-size:10pt;color:#6b7280;margin-bottom:12mm">景觀 AI 設計審查顧問 2.0　Landscape AI Design Review</div>
  <div class="cover-title">DXF 分區植栽<br>審查報告</div>
  <div class="cover-subtitle">Zone-by-Zone Planting Assessment Report</div>
  <div style="display:flex;gap:5mm;flex-wrap:wrap;margin-bottom:10mm">
    <div style="padding:4mm 6mm;border-radius:4mm;border:2px solid #16a34a;background:#ecfdf5">
      <div style="font-size:9pt;color:#6b7280">分析分區</div>
      <div style="font-size:24pt;font-weight:900;color:#15803d">${zones.length}</div>
    </div>
    <div style="padding:4mm 6mm;border-radius:4mm;border:2px solid #6b7280;background:#f9fafb">
      <div style="font-size:9pt;color:#6b7280">總植栽數</div>
      <div style="font-size:24pt;font-weight:900;color:#374151">${totalBlocks}</div>
    </div>
    ${reviewed.length > 0 ? `<div style="padding:4mm 6mm;border-radius:4mm;border:2px solid ${scoreColor(overallScore)};background:#f9fafb">
      <div style="font-size:9pt;color:#6b7280">整體平均分</div>
      <div style="font-size:24pt;font-weight:900;color:${scoreColor(overallScore)}">${overallScore}</div>
    </div>` : ''}
    ${allDanger  > 0 ? `<div style="padding:4mm 6mm;border-radius:4mm;border:1.5px solid #fca5a5;background:#fef2f2"><div style="font-size:9pt;color:#6b7280">高風險問題</div><div style="font-size:24pt;font-weight:900;color:#dc2626">${allDanger}</div></div>` : ''}
    ${allCaution > 0 ? `<div style="padding:4mm 6mm;border-radius:4mm;border:1.5px solid #fcd34d;background:#fffbeb"><div style="font-size:9pt;color:#6b7280">需注意</div><div style="font-size:24pt;font-weight:900;color:#d97706">${allCaution}</div></div>` : ''}
  </div>
  <div class="cover-meta">
    <table>
      ${sourceFile ? `<tr><td>圖面來源</td><td>${esc(sourceFile)}</td></tr>` : ''}
      <tr><td>審查類型</td><td>DXF 分區植栽審查</td></tr>
      <tr><td>分析分區</td><td>${zones.map(z => z.zoneName).join('、')}</td></tr>
      <tr><td>產生時間</td><td>${esc(dateStr)}</td></tr>
    </table>
  </div>
</div>

<!-- 第 1 頁：分區總覽 -->
<div class="section">
  <div class="section-title">§1　各分區審查總覽</div>
  <table class="data-table">
    <thead><tr><th>分區</th><th style="text-align:center">圖塊種類</th><th style="text-align:center">株數</th><th style="text-align:center">分數</th><th>風險</th><th>審查狀態</th></tr></thead>
    <tbody>
      ${zones.map(z => {
        const cnt = z.blockEntries.reduce((s,b)=>s+b.count,0)
        const d = z.evalResult?.issues.filter(i=>i.level==='danger').length??0
        const c = z.evalResult?.issues.filter(i=>i.level==='caution').length??0
        return `<tr>
          <td style="font-weight:700">${esc(z.zoneName)}</td>
          <td style="text-align:center">${z.blockEntries.length}</td>
          <td style="text-align:center">${cnt}</td>
          <td style="text-align:center;font-weight:700;color:${z.evalResult?scoreColor(z.evalResult.score):'#9ca3af'}">${z.evalResult?z.evalResult.score+'分':'—'}</td>
          <td>${d>0?`<span style="color:#dc2626">⚠ 高風險 ${d}</span>`:''}${c>0?`<span style="color:#d97706;margin-left:2mm">注意 ${c}</span>`:''}&nbsp;</td>
          <td>${esc(z.status)}</td>
        </tr>`
      }).join('')}
    </tbody>
  </table>
</div>

<!-- 第 2 頁：各區審查比較 -->
${reviewed.length >= 2 ? `<div class="section page-break">
  <div class="section-title">§2　各區審查比較</div>
  <table class="data-table">
    <thead><tr>
      <th>分區</th>
      <th style="text-align:center">分數</th>
      <th style="text-align:center">風險等級</th>
      <th style="text-align:center">問題數</th>
      <th style="text-align:center">高風險數</th>
      <th>主要問題類型</th>
    </tr></thead>
    <tbody>
      ${zones.map(z => {
        const dangerN  = z.evalResult?.issues.filter(i=>i.level==='danger').length ?? 0
        const cautionN = z.evalResult?.issues.filter(i=>i.level==='caution').length ?? 0
        const mainIss  = z.evalResult?.issues.filter(i=>i.level!=='ok').slice(0,3).map(i=>i.category).join('、') ?? '—'
        const riskTxt  = dangerN > 0 ? '高風險' : cautionN > 0 ? '中風險' : z.evalResult ? '低風險' : '待審查'
        const riskClr  = dangerN > 0 ? '#dc2626' : cautionN > 0 ? '#d97706' : '#16a34a'
        return `<tr>
          <td style="font-weight:800;font-size:12pt">${esc(z.zoneName)}</td>
          <td style="text-align:center;font-weight:800;color:${z.evalResult?scoreColor(z.evalResult.score):'#9ca3af'};font-size:13pt">
            ${z.evalResult ? z.evalResult.score + '/100' : '—'}
          </td>
          <td style="text-align:center">
            <span style="color:${riskClr};font-weight:700;font-size:10pt">${riskTxt}</span>
          </td>
          <td style="text-align:center;font-weight:700">${z.evalResult ? dangerN + cautionN : '—'}</td>
          <td style="text-align:center;color:#dc2626;font-weight:700">${z.evalResult ? dangerN : '—'}</td>
          <td style="font-size:9.5pt">${z.evalResult ? esc(mainIss || '無問題') : '<span style="color:#9ca3af">待審查</span>'}</td>
        </tr>`
      }).join('')}
    </tbody>
  </table>
</div>` : ''}

<!-- 各分區詳細 -->
${zones.map((z, i) => zoneCard(z, i)).join('')}

<div class="report-footer">
  <span>景觀 AI 設計審查顧問 2.0　｜　DXF 分區植栽審查報告</span>
  <span>${esc(dateStr)}</span>
</div>
</body>
</html>`

  if (options.returnHtml) return html

  const win = window.open('', '_blank', 'width=900,height=700')
  if (!win) { alert('請允許彈出視窗以開啟 PDF 報告。'); return }
  win.document.write(html)
  win.document.close()
  setTimeout(() => { win.print() }, 800)
}
