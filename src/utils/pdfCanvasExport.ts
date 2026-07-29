// ── pdfCanvasExport.ts — 共用的「html2canvas 截圖 + 智慧分頁 + canvas 文字頁首/頁尾」
// PDF 匯出引擎，供 AI 配植評估報告與 DXF 分區審查報告共用（原本兩份各自一套，DXF
// 那份用 window.open()+window.print()，跳出的瀏覽器列印視窗常被彈出視窗封鎖或列印
// 被瀏覽器安靜擋掉，使用者點了沒反應；改成跟 AI 配植評估報告一樣直接下載檔案，
// 不依賴瀏覽器的列印/彈出視窗權限）。
//
// 呼叫端只需要準備好報告 HTML（794px 寬、用 .no-break／.page-break／.sec-hdr／
// table 這幾個 class 標記版面邊界，語意見下方 exportHtmlAsPaginatedPdf 內註解），
// 分頁演算法會自己量測 DOM 邊界決定安全切點，不會把卡片/表格切到一半。

export interface PaginatedPdfResult {
  totalPages: number
  /** 匯出後資料層級驗證發現的問題（密度偏低/偏高、末頁留白過多、仍有區塊被切開）；
   * 空陣列代表沒有異狀。呼叫端可以決定要不要顯示給使用者看。 */
  warnings: string[]
}

function drawTextStrip(opts: { widthMm: number; heightMm: number; left?: string; center?: string; right?: string; fontPx?: number }): string {
  const dpiScale = 4
  const c = document.createElement('canvas')
  const wPx = opts.widthMm * 3.78 * dpiScale, hPx = opts.heightMm * 3.78 * dpiScale
  c.width = wPx; c.height = hPx
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, wPx, hPx)
  // Canvas2D fillText 原生支援中文，不像 jsPDF 內建字型（Helvetica）完全沒有中文字
  // 形——這是頁首英文標題/頁尾時間亂碼問題的根本解法，不是排版微調。
  ctx.font = `${(opts.fontPx ?? 9) * dpiScale}px "Microsoft JhengHei","Noto Sans TC",sans-serif`
  ctx.fillStyle = '#78716c'
  ctx.textBaseline = 'middle'
  const midY = hPx / 2
  if (opts.left)   { ctx.textAlign = 'left';   ctx.fillText(opts.left,   0, midY) }
  if (opts.center) { ctx.textAlign = 'center'; ctx.fillText(opts.center, wPx / 2, midY) }
  if (opts.right)  { ctx.textAlign = 'right';  ctx.fillText(opts.right,  wPx, midY) }
  return c.toDataURL('image/png')
}

/**
 * 把一份 794px 寬的報告 HTML 轉成分頁 A4 PDF 並直接觸發下載。
 *
 * reportHtml 版面協定（呼叫端組 HTML 字串時要遵守）：
 * - 整份內容以 794px 寬設計（對應 A4 扣邊界後的內容寬度）
 * - `.no-break`：不可切割的區塊（問題卡片、替代植栽群組、審查回覆文字框…）
 * - `table`：所有表格自動視為不可切割（列數不多時整張表當一個單位，避免重複表頭
 *   的複雜度；真的超大表格才會退回允許在該表格內硬切）
 * - `.page-break`：這個元素前面強制換頁（例如章節開頭），使用要節制——每個小節都
 *   強制換頁會讓很多頁留白過多，只在真的需要清楚分隔（例如封面/管理摘要結束、
 *   分區之間）的地方用
 * - `.sec-hdr`：章節標題列，會自動跟緊接著內容的開頭合併成不可切割範圍，避免
 *   切出來標題單獨留在頁尾、內容全部到下一頁
 */
export async function exportHtmlAsPaginatedPdf(opts: {
  reportHtml: string
  filename: string
  headerText: string
  footerLeft: string
}): Promise<PaginatedPdfResult> {
  let reportEl: HTMLDivElement | null = null
  const overlay = document.createElement('div')
  overlay.setAttribute('data-pdf-overlay', '1')
  overlay.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:99998;pointer-events:none;'
  document.body.appendChild(overlay)

  try {
    reportEl = document.createElement('div')
    reportEl.id = 'printRoot'
    reportEl.style.cssText = 'position:fixed;top:0;left:0;width:794px;z-index:99999;pointer-events:none;opacity:1;background:#fff;overflow:visible;'
    reportEl.innerHTML = opts.reportHtml
    document.body.appendChild(reportEl)

    if (reportEl.innerHTML.length === 0) throw new Error('報告內容為空')

    // 等字型與圖片渲染完成
    await new Promise(r => setTimeout(r, 900))
    const elH = reportEl.scrollHeight
    const elW = reportEl.offsetWidth
    if (elH === 0) throw new Error('報告容器高度為 0，內容未渲染')

    // 截圖前量測「不可切割」與「強制換頁」的 DOM 邊界（單位：DOM px，未縮放）——
    // html2canvas 只是拍照，這些量測是分頁演算法唯一能拿到的真實版面資訊
    const unbreakableEls = [...reportEl.querySelectorAll('.no-break, table')] as HTMLElement[]
    const unbreakables = unbreakableEls.map(el => ({ top: el.offsetTop, bottom: el.offsetTop + el.offsetHeight }))
    for (const hdr of [...reportEl.querySelectorAll('.sec-hdr')] as HTMLElement[]) {
      const next = hdr.nextElementSibling as HTMLElement | null
      if (next) unbreakables.push({ top: hdr.offsetTop, bottom: next.offsetTop + Math.min(next.offsetHeight, 60) })
    }
    const forcedBreaks = [...reportEl.querySelectorAll('.page-break')]
      .map(el => (el as HTMLElement).offsetTop)
      .sort((a, b) => a - b)

    // 瀏覽器（Chrome/Skia）對單一 <canvas> 的軸向像素數有上限，實測約在 65535px
    // 上下——報告一長，html2canvas 原本「整份報告拍成一張 canvas」的做法產生的
    // 高度會超過這個上限，超過後瀏覽器不會報錯，而是回傳一張「尺寸看起來正確、
    // 但實際完全沒畫到任何內容」的透明 canvas；這張透明 canvas 後續被切頁、轉成
    // JPEG（JPEG 沒有透明通道）時，瀏覽器會把透明像素直接補成黑色——這就是「整頁
    // 變成黑色矩形」的根本原因，只有另外用 Canvas2D 畫的頁首/頁尾小圖不受影響
    // （見下方 drawTextStrip，那些圖很小，遠低於任何尺寸上限）。
    //
    // 解法：不要求 html2canvas 一次畫出整份報告，改成依 DOM 高度分段擷取，每段
    // 光柵高度都遠低於上限，再依分頁需要的 Y 範圍從對應的一或多段裡拼出每一頁的
    // 圖片——不會有任何一張 canvas 大到觸發瀏覽器的隱性失敗。
    const SEGMENT_DOM_HEIGHT = 10000
    interface CaptureSegment { canvas: HTMLCanvasElement; domTop: number }
    const html2canvas = (await import('html2canvas')).default
    const segments: CaptureSegment[] = []
    let domY = 0
    while (domY < elH) {
      const domHeight = Math.min(SEGMENT_DOM_HEIGHT, elH - domY)
      const segCanvas = await html2canvas(reportEl, {
        scale: 1.5,
        useCORS: true,
        allowTaint: false,
        backgroundColor: '#ffffff',
        logging: false,
        width: 794,
        height: domHeight,
        x: 0,
        y: domY,
        windowWidth: 794,
        windowHeight: elH,
        scrollX: 0,
        scrollY: 0,
      })
      segments.push({ canvas: segCanvas, domTop: domY })
      domY += domHeight
    }

    document.body.removeChild(reportEl)
    document.body.removeChild(overlay)
    reportEl = null

    if (segments.length === 0 || segments[0].canvas.width === 0 || segments.some(s => s.canvas.height === 0)) {
      throw new Error('canvas 尺寸為 0（截圖失敗）')
    }

    const { jsPDF } = await import('jspdf')
    const PDF_W_MM = 210, PDF_H_MM = 297
    const MARGIN_MM = 14
    const TOP_MM    = 20
    const BOT_MM    = 18
    const CONTENT_W_MM = PDF_W_MM - MARGIN_MM * 2
    const CONTENT_H_MM = PDF_H_MM - TOP_MM - BOT_MM

    const canvasWidth = segments[0].canvas.width
    const canvasHeight = segments.reduce((sum, s) => sum + s.canvas.height, 0)
    const pxPerMm = canvasWidth / CONTENT_W_MM
    const pageCanvasH = Math.floor(CONTENT_H_MM * pxPerMm)
    const rasterScale = canvasWidth / elW

    // 把 [y0, y1) 這段 canvas-px 範圍畫到目的地 ctx（可能橫跨一或多個分段）
    function drawSegmentRange(destCtx: CanvasRenderingContext2D, y0: number, y1: number) {
      for (const seg of segments) {
        const segTop = seg.domTop * rasterScale
        const segBottom = segTop + seg.canvas.height
        const top = Math.max(y0, segTop)
        const bottom = Math.min(y1, segBottom)
        if (bottom <= top) continue
        destCtx.drawImage(seg.canvas, 0, top - segTop, canvasWidth, bottom - top, 0, top - y0, canvasWidth, bottom - top)
      }
    }

    const unbreakablesPx = unbreakables.map(b => ({ top: b.top * rasterScale, bottom: b.bottom * rasterScale }))
    const forcedBreaksPx = forcedBreaks.map(f => f * rasterScale)

    function computePageBreaks(totalH: number, pageH: number): number[] {
      const breaks = [0]
      let y = 0
      while (y < totalH) {
        let next = Math.min(y + pageH, totalH)
        const forced = forcedBreaksPx.find(f => f > y && f < next)
        if (forced !== undefined) {
          next = forced
        } else {
          // 反覆拉回直到沒有任何不可切割區塊還跨在 next 這條線上——單次拉回只處理
          // 第一個撞到的區塊，遇到巢狀/重疊區塊（例如章節標題跟緊接著的表格重疊）
          // 拉回一次可能又撞進另一個，要迴圈到穩定為止，不然還是會切到
          for (let guard = 0; guard < 50; guard++) {
            const straddling = unbreakablesPx.find(b => b.top < next && b.bottom > next)
            if (!straddling || straddling.top <= y) break
            next = straddling.top
          }
        }
        breaks.push(next)
        y = next
      }
      return breaks
    }
    const pageBreaks = computePageBreaks(canvasHeight, pageCanvasH)
    const totalPages = pageBreaks.length - 1

    const headerStripW = PDF_W_MM - MARGIN_MM * 2
    const headerImg = drawTextStrip({ widthMm: headerStripW, heightMm: 6, left: opts.headerText, fontPx: 10 })

    const pdf = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' })
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const genTime = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`

    for (let i = 0; i < totalPages; i++) {
      if (i > 0) pdf.addPage()
      const pageNum = i + 1
      const y0 = pageBreaks[i], y1 = pageBreaks[i + 1]
      const sliceH = y1 - y0

      const pc = document.createElement('canvas')
      pc.width = canvasWidth; pc.height = sliceH
      const pcCtx = pc.getContext('2d')!
      pcCtx.fillStyle = '#ffffff'
      pcCtx.fillRect(0, 0, canvasWidth, sliceH)
      drawSegmentRange(pcCtx, y0, y1)
      const imgData = pc.toDataURL('image/jpeg', 0.92)
      const imgH = sliceH / pxPerMm
      pdf.addImage(imgData, 'JPEG', MARGIN_MM, TOP_MM, CONTENT_W_MM, imgH)

      pdf.setDrawColor(26, 71, 49); pdf.setLineWidth(0.35)
      pdf.line(MARGIN_MM, TOP_MM - 3, PDF_W_MM - MARGIN_MM, TOP_MM - 3)
      pdf.addImage(headerImg, 'PNG', MARGIN_MM, TOP_MM - 9, headerStripW, 6)

      const footerY = PDF_H_MM - BOT_MM + 3
      pdf.line(MARGIN_MM, footerY, PDF_W_MM - MARGIN_MM, footerY)
      const footerImg = drawTextStrip({
        widthMm: headerStripW, heightMm: 6,
        left: opts.footerLeft, center: genTime, right: `第 ${pageNum} 頁／共 ${totalPages} 頁`,
      })
      pdf.addImage(footerImg, 'PNG', MARGIN_MM, footerY + 1, headerStripW, 6)
    }

    // 匯出後驗證（資料層級：高度使用率／是否仍有區塊被切開／末頁留白）
    const warnings: string[] = []
    console.group('[PDF 驗證]')
    console.log(`共 ${totalPages} 頁`)
    for (let i = 0; i < totalPages; i++) {
      const used = pageBreaks[i + 1] - pageBreaks[i]
      const pct = Math.round((used / pageCanvasH) * 100)
      const tag = i === totalPages - 1 ? '（末頁）' : ''
      if (pct < 75 && i !== totalPages - 1) console.warn(`第 ${i + 1} 頁${tag} 使用率 ${pct}%（偏低，未預期的大量留白）`)
      else if (pct > 100) console.error(`第 ${i + 1} 頁${tag} 使用率 ${pct}%（超出頁面高度，理論上不應發生）`)
      else console.log(`第 ${i + 1} 頁${tag} 使用率 ${pct}%`)
    }
    const lastPagePct = Math.round(((pageBreaks[totalPages] - pageBreaks[totalPages - 1]) / pageCanvasH) * 100)
    if (lastPagePct < 65) console.warn(`末頁留白約 ${100 - lastPagePct}%（>35%）`)
    const stillSplit = unbreakablesPx.filter(b => pageBreaks.some(brk => brk > b.top && brk < b.bottom))
    if (stillSplit.length > 0) {
      console.error(`偵測到 ${stillSplit.length} 個區塊仍被跨頁切開`, stillSplit)
      warnings.push(`偵測到 ${stillSplit.length} 個區塊可能被跨頁切開，請人工檢查後再使用。`)
    }
    console.groupEnd()

    pdf.save(opts.filename)
    return { totalPages, warnings }
  } catch (err) {
    if (reportEl && document.body.contains(reportEl)) document.body.removeChild(reportEl)
    document.querySelectorAll('[data-pdf-overlay]').forEach(n => n.remove())
    throw err
  }
}
