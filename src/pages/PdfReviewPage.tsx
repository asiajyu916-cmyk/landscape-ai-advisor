// ── PDF / 圖片審圖頁面 ─────────────────────────────────────────────────────────
// 流程：上傳 PDF/JPG/PNG → 擷取植栽名稱 → 橋接到 LandscapeAdvisorPage 進行 AI 審查

import { useState, useRef, useCallback } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import {
  Upload, FileText, AlertTriangle, CheckCircle,
  ChevronDown, ChevronUp, X, ArrowRight, Image as ImageIcon,
} from 'lucide-react'
import { loadPlantsFromStorage } from '@/data/plantStore'
import type { CsvPlantRecord } from '@/types/csvPlant'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString()

// ── 非植栽文字排除邏輯 ───────────────────────────────────────────────────────────

const NON_PLANT_KEYWORDS = [
  // 圖框 / 標題欄
  '圖框', '圖名', '圖號', '標題', '標題欄', '頁次', '頁碼', '索引表', '圖例',
  '平面圖', '配置圖', '立面圖', '剖面圖', '大樣圖', '詳圖', '總圖',
  // 設計資訊
  '設計', '製圖', '審核', '校核', '描圖', '業主', '甲方', '乙方',
  '公司', '事務所', '工作室', '顧問', '承包', '發包', '施工單位',
  // 日期 / 版本
  '日期', '版本', '修改', '簽名', '蓋章',
  // 說明文字
  '說明', '備注', '備註', '注意', '注意事項', '附記', '施工說明',
  '工程說明', '植栽說明', '一般說明',
  // 尺度 / 比例
  '比例', 'SCALE', 'scale', '單位', '方位', '北向', '指北針',
  // 數字 / 量測
  '座標', '高程', '標高', '距離', '面積', '坡度',
  // 建築 / 土木 / 水電非植物
  '鋪面', '鋪裝', '混凝土', '瀝青', '磁磚', '石材', '木材', '鋼', '鐵',
  '排水', '坡排', '截水', '化糞', '污水', '雨水', '給水', '電氣',
  '結構', '基礎', '鋼筋', '防水', '隔熱', '外牆', '內牆', '地板', '天花',
  '工程', '施工', '模板', '鷹架', '安全', '管線', '電纜',
  // 圖框英文
  'No.', 'NO.', 'DATE', 'DRAWN', 'CHECKED', 'APPROVED', 'REV', 'DWG',
]

// 植栽相關正向信號
const PLANT_UNIT_PATTERN = /[株棵本叢桿盆]/u
const PLANT_CONTEXT_WORDS = [
  '喬木', '灌木', '草皮', '地被', '植栽', '花卉', '水生植物', '攀藤', '竹類',
  '常綠', '落葉', '開花', '觀葉', '觀果', '行道樹', '景觀樹',
]
const PLANT_CODE_PATTERN = /^[A-Z]{1,2}\d{1,2}$/ // T1, S2, G3, SH1 等植栽代號

function isNonPlantLine(line: string): { excluded: boolean; reason?: string } {
  const t = line.trim()

  if (t.length < 2)  return { excluded: true, reason: '太短' }
  if (t.length > 20) return { excluded: true, reason: '字串太長（可能是說明文字）' }

  // 純數字 / 符號
  if (/^[\d\s\-—_=.:/,()（）【】《》""''「」°%＄＠＃＆＊]+$/.test(t))
    return { excluded: true, reason: '純數字或符號' }

  // 比例尺格式 1:200
  if (/\d+\s*[:：]\s*\d+/.test(t))
    return { excluded: true, reason: '比例尺格式' }

  // 日期格式
  if (/\d{4}[\-\/年]\d{1,2}/.test(t))
    return { excluded: true, reason: '日期格式' }

  // 包含非植栽關鍵字
  const hit = NON_PLANT_KEYWORDS.find(kw => t.includes(kw))
  if (hit) return { excluded: true, reason: `包含非植栽關鍵字「${hit}」` }

  // 包含純量測單位（無植栽單位）
  if (/[\d.]+\s*(㎡|m²|m³|mm|cm|km|ha|公頃|公尺|公分|英尺)/.test(t))
    return { excluded: true, reason: '含量測單位' }

  // 含大量英文（超過半數字元為 ASCII 英數）→ 可能是圖號或代碼說明
  const asciiCount = (t.match(/[A-Za-z0-9]/g) ?? []).length
  if (asciiCount > t.length * 0.5 && !PLANT_CODE_PATTERN.test(t))
    return { excluded: true, reason: '大量英文字元' }

  return { excluded: false }
}

// 判斷一行文字是否有足夠正向信號，可列為「疑似植栽」
function hasPlantSignal(line: string): { yes: boolean; reason: string } {
  const t = line.trim()

  // 植栽代號（T1, S2, SH1 等）
  if (PLANT_CODE_PATTERN.test(t))
    return { yes: true, reason: '符合植栽代號格式' }

  // 2-6 個純中文字，且附近有數量單位
  if (PLANT_UNIT_PATTERN.test(t) && /[一-鿿]{2,6}/.test(t))
    return { yes: true, reason: '含植栽數量單位' }

  // 含喬木/灌木等上下文詞
  const ctx = PLANT_CONTEXT_WORDS.find(w => t.includes(w))
  if (ctx) return { yes: true, reason: `含植栽上下文「${ctx}」` }

  // 純中文 2-6 字，且不含括號說明、不含動詞
  const pureChinese = t.match(/^[一-鿿]{2,6}$/)
  if (pureChinese) {
    // 排除常見非植物中文短語
    const NON_PLANT_SHORT = ['平面', '配置', '立面', '剖面', '詳圖', '說明', '備註',
      '注意', '業主', '設計者', '審核', '日期', '版本', '圖號', '頁碼',
      '索引', '圖例', '施工', '結構', '基礎', '防水', '排水', '鋪面']
    if (!NON_PLANT_SHORT.some(s => t.includes(s)))
      return { yes: true, reason: '2-6字純中文，疑似植物名稱' }
  }

  return { yes: false, reason: '無植栽正向信號' }
}

// ── 植栽擷取與資料庫比對 ──────────────────────────────────────────────────────────

interface ExtractResult {
  matched:  Array<{ plantName: string; quantity?: number; matchReason: string }>
  possible: Array<{ text: string; reason: string }>   // 疑似植物但找不到
  excluded: Array<{ text: string; reason: string }>   // 非植栽被排除
  rawLines: string[]
}

function extractQuantity(line: string): number | undefined {
  const m = line.match(/[×xX*]\s*(\d+)|(\d+)\s*[株棵本叢桿]/u)
  if (m) return parseInt(m[1] ?? m[2])
  return undefined
}

function extractPlants(rawText: string, db: CsvPlantRecord[]): ExtractResult {
  const lines = rawText.split(/\n+/).map(l => l.trim()).filter(Boolean)
  const matched:  ExtractResult['matched']  = []
  const possible: ExtractResult['possible'] = []
  const excluded: ExtractResult['excluded'] = []
  const seen = new Set<string>()

  for (const line of lines) {
    const { excluded: isExcl, reason } = isNonPlantLine(line)
    if (isExcl) { excluded.push({ text: line, reason: reason! }); continue }

    // 精確比對
    const exact = db.find(p => line.includes(p.name))
    if (exact && !seen.has(exact.name)) {
      seen.add(exact.name)
      matched.push({ plantName: exact.name, quantity: extractQuantity(line), matchReason: '名稱完全符合' })
      continue
    }
    if (exact) continue  // 重複，跳過

    // 部分比對（2字以上）
    const partial = db.find(p => p.name.length >= 2 &&
      p.name.split('').some((_, i) => i < p.name.length - 1 && line.includes(p.name.slice(i, i + 2))))
    if (partial && !seen.has(partial.name)) {
      seen.add(partial.name)
      matched.push({ plantName: partial.name, quantity: extractQuantity(line), matchReason: '部分名稱符合' })
      continue
    }
    if (partial) continue

    // 需有正向植栽信號才列為疑似
    const signal = hasPlantSignal(line)
    if (signal.yes) {
      possible.push({ text: line, reason: signal.reason })
    } else {
      excluded.push({ text: line, reason: `無植栽信號（${signal.reason}）` })
    }
  }

  return { matched, possible, excluded, rawLines: lines }
}

// ── PDF 文字提取 ──────────────────────────────────────────────────────────────────

async function extractPdfText(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise
  const pages: string[] = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    pages.push(content.items.map((item: any) => item.str ?? '').join('\n'))
  }
  return pages.join('\n\n')
}

// ── Shared tab nav (同三頁共用) ───────────────────────────────────────────────────

type AppTab = 'pdf' | 'landscape' | 'dxf'

function TabNav({ active, onChange }: { active: AppTab; onChange: (t: AppTab) => void }) {
  return (
    <div className="flex items-center bg-[#0f2d1d] rounded-xl p-1 gap-0.5">
      {([
        { id: 'pdf'       as const, label: 'PDF 審圖' },
        { id: 'landscape' as const, label: 'AI 配植評估' },
        { id: 'dxf'       as const, label: 'DXF 審查' },
      ]).map(t => (
        <button key={t.id} onClick={() => onChange(t.id)}
          className={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
            active === t.id ? 'bg-[#2d6a4f] text-white shadow-sm' : 'text-green-300/80 hover:text-white hover:bg-[#1a4731]'
          }`}>
          {t.label}
        </button>
      ))}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────────

export default function PdfReviewPage({
  activeTab = 'pdf',
  onTabChange,
  onImport,
}: {
  activeTab?: AppTab
  onTabChange?: (tab: AppTab) => void
  onImport?: (plantNames: string[]) => void
} = {}) {
  type Stage = 'upload' | 'processing' | 'confirm'

  const [stage, setStage]         = useState<Stage>('upload')
  const [fileName, setFileName]   = useState('')
  const [imageSrc, setImageSrc]   = useState('')
  const [extractResult, setExtractResult] = useState<ExtractResult | null>(null)
  const [dragOver, setDragOver]   = useState(false)
  const [parseError, setParseError] = useState('')
  const [procMsg, setProcMsg]     = useState('')
  const [showDebug, setShowDebug] = useState(false)
  const [manualText, setManualText] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const db = loadPlantsFromStorage() ?? []

  const handleFile = useCallback(async (file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    const isPdf   = ext === 'pdf'
    const isImage = ['jpg', 'jpeg', 'png', 'webp'].includes(ext)
    if (!isPdf && !isImage) { setParseError('請上傳 PDF、JPG 或 PNG 檔案'); return }

    setParseError(''); setFileName(file.name); setStage('processing')

    if (isPdf) {
      try {
        setProcMsg('正在解析 PDF 文字…')
        const text = await extractPdfText(file)
        setProcMsg('正在比對植栽資料庫…')
        setExtractResult(extractPlants(text, db))
        setStage('confirm')
      } catch { setParseError('PDF 解析失敗'); setStage('upload') }
    } else {
      // 圖片：顯示圖面，讓使用者貼入文字
      const reader = new FileReader()
      reader.onload = e => { setImageSrc(e.target?.result as string); setStage('confirm') }
      reader.readAsDataURL(file)
    }
  }, [db])

  const handleManualParse = () => {
    const result = extractPlants(manualText, db)
    setExtractResult(result)
  }

  const handleImport = () => {
    if (!extractResult) return
    const names = extractResult.matched.map(m => m.plantName)
    onImport?.(names)
  }

  // ── Upload stage ──────────────────────────────────────────────────────────────

  if (stage === 'upload') {
    return (
      <div className="min-h-screen" style={{ background: 'radial-gradient(circle at 72% 8%, rgba(111,168,120,0.07) 0%, transparent 30%), linear-gradient(155deg, #f7fbf7 0%, #f1f7f3 40%, #eaf4ed 75%, #e4f1e8 100%)' }}>
        <header className="bg-[#1a4731] sticky top-0 z-40 shadow-md">
          <div className="max-w-[1536px] mx-auto px-8 h-16 flex items-center justify-between">
            <div>
              <h1 className="text-base font-bold text-white leading-tight tracking-wide">PDF / 圖片審圖</h1>
              <p className="text-xs text-green-200/70 leading-tight">上傳景觀設計圖面，自動擷取植栽資料後進行 AI 審查</p>
            </div>
            {onTabChange && <TabNav active={activeTab} onChange={onTabChange} />}
            <div />
          </div>
        </header>

        <main className="max-w-[1536px] mx-auto px-8 py-16 flex flex-col items-center">
          <div
            onDragOver={e => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f) }}
            onClick={() => fileRef.current?.click()}
            className={`w-full max-w-2xl border-2 border-dashed rounded-2xl p-16 text-center cursor-pointer transition-all ${
              dragOver ? 'border-green-400 bg-green-50' : 'border-stone-300 hover:border-green-400 hover:bg-stone-50'
            }`}>
            <div className="flex justify-center gap-6 mb-6 text-stone-300">
              <FileText size={48} /><ImageIcon size={48} />
            </div>
            <p className="text-xl font-semibold text-stone-700 mb-2">拖放或點擊上傳景觀設計圖面</p>
            <p className="text-stone-400 text-sm mb-1">PDF → 自動解析植栽索引表</p>
            <p className="text-stone-400 text-sm">JPG / PNG → 顯示圖面，手動貼入植栽清單文字</p>
            <input ref={fileRef} type="file" accept=".pdf,.jpg,.jpeg,.png,.webp"
              className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = '' }} />
          </div>

          {parseError && (
            <div className="mt-6 flex items-center gap-3 px-5 py-3 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm max-w-2xl">
              <AlertTriangle size={16} />{parseError}
            </div>
          )}
          {db.length === 0 && (
            <div className="mt-6 flex items-center gap-3 px-5 py-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-700 text-sm max-w-2xl">
              <AlertTriangle size={16} className="flex-shrink-0" />
              植栽資料庫未載入。請先至「AI 配植評估」匯入 CSV 資料庫，才能進行植栽比對。
            </div>
          )}
        </main>
      </div>
    )
  }

  // ── Processing stage ──────────────────────────────────────────────────────────

  if (stage === 'processing') {
    return (
      <div className="min-h-screen bg-[#f7f5f0] flex flex-col items-center justify-center gap-6">
        <div className="w-12 h-12 border-4 border-green-700 border-t-transparent rounded-full animate-spin" />
        <p className="text-stone-700 font-medium text-lg">{procMsg}</p>
        <p className="text-stone-400 text-sm">{fileName}</p>
      </div>
    )
  }

  // ── Confirm stage — 確認識別結果，按下後進入 AI 審查 ─────────────────────────

  const result = extractResult
  const matched   = result?.matched ?? []
  const possible  = result?.possible ?? []
  const excluded  = result?.excluded ?? []

  return (
    <div className="min-h-screen" style={{ background: 'radial-gradient(circle at 72% 8%, rgba(111,168,120,0.07) 0%, transparent 30%), linear-gradient(155deg, #f7fbf7 0%, #f1f7f3 40%, #eaf4ed 75%, #e4f1e8 100%)' }}>
      <header className="bg-[#1a4731] sticky top-0 z-40 shadow-md">
        <div className="max-w-[1536px] mx-auto px-8 h-16 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-base font-bold text-white leading-tight tracking-wide">PDF / 圖片審圖</h1>
            <p className="text-xs text-green-200/70 leading-tight">{fileName}</p>
          </div>
          {onTabChange && <TabNav active={activeTab} onChange={onTabChange} />}
          <button onClick={() => { setStage('upload'); setFileName(''); setExtractResult(null); setImageSrc('') }}
            className="flex items-center gap-2 px-3.5 py-1.5 rounded-lg bg-white/10 border border-white/20 text-xs text-white hover:bg-white/20 transition-colors">
            <X size={13} />重新上傳
          </button>
        </div>
      </header>

      <main className="max-w-[1536px] mx-auto px-8 py-8">
        <div className="grid gap-6 items-start" style={{ gridTemplateColumns: imageSrc ? '1fr 1fr' : '480px 1fr' }}>

          {/* 左側：圖面預覽 或 植栽清單 */}
          <div className="space-y-5">
            {imageSrc ? (
              /* 圖片預覽 + 手動輸入 */
              <div className="border border-stone-200 rounded-2xl overflow-hidden bg-white">
                <div className="flex items-center justify-between px-5 py-3.5 bg-stone-50 border-b border-stone-100">
                  <p className="text-sm font-semibold text-stone-700">圖面預覽</p>
                </div>
                <div className="p-4">
                  <img src={imageSrc} alt="上傳圖面" className="w-full rounded-xl" />
                </div>
                <div className="border-t border-stone-100 px-5 py-4">
                  <p className="text-sm font-semibold text-stone-700 mb-2">貼入植栽索引表文字</p>
                  <p className="text-xs text-stone-400 mb-3">從圖說書或說明書中複製植栽清單後貼入，系統自動比對資料庫</p>
                  <textarea
                    value={manualText}
                    onChange={e => setManualText(e.target.value)}
                    className="w-full h-36 px-3 py-2.5 border border-stone-200 rounded-xl text-sm text-stone-700 resize-none focus:outline-none focus:border-green-400"
                    placeholder={'阿勃勒 × 5&#10;桂花 × 3&#10;黑板樹 × 2'}
                  />
                  <button onClick={handleManualParse}
                    className="mt-2 w-full py-2.5 rounded-xl bg-stone-700 text-white text-sm font-semibold hover:bg-stone-800">
                    解析植栽清單
                  </button>
                </div>
              </div>
            ) : (
              /* PDF 識別結果清單 */
              <div className="border border-stone-200 rounded-2xl overflow-hidden bg-white">
                <div className="flex items-center justify-between px-5 py-3.5 bg-stone-50 border-b border-stone-100">
                  <p className="text-sm font-semibold text-stone-700">
                    已識別植栽
                    <span className="ml-2 text-green-700 font-bold">{matched.length} 種</span>
                  </p>
                </div>
                <div className="divide-y divide-stone-100">
                  {matched.map((m, i) => (
                    <div key={i} className="flex items-center gap-3 px-5 py-3">
                      <CheckCircle size={14} className="text-green-500 flex-shrink-0" />
                      <span className="font-medium text-stone-800 flex-1">{m.plantName}</span>
                      {m.quantity && <span className="text-sm text-stone-400">× {m.quantity}</span>}
                      <span className="text-xs text-stone-300">{m.matchReason}</span>
                    </div>
                  ))}
                  {matched.length === 0 && (
                    <div className="px-5 py-6 text-center text-stone-400 text-sm">
                      未能從 PDF 識別到植栽名稱
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* 疑似植栽（待確認） */}
            {possible.length > 0 && (
              <div className="border border-amber-200 rounded-2xl overflow-hidden bg-white">
                <div className="px-5 py-3.5 bg-amber-50 border-b border-amber-100">
                  <p className="text-sm font-semibold text-amber-800">
                    疑似植栽，請確認（{possible.length} 筆）
                  </p>
                  <p className="text-xs text-amber-600 mt-0.5">以下文字符合植物名稱格式，但找不到對應資料庫記錄</p>
                </div>
                <div className="divide-y divide-stone-100">
                  {possible.map((p, i) => (
                    <div key={i} className="flex items-center gap-3 px-5 py-2.5">
                      <AlertTriangle size={13} className="text-amber-400 flex-shrink-0" />
                      <span className="text-stone-700 text-sm flex-1">{p.text}</span>
                      <span className="text-xs text-stone-400">{p.reason}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* 右側：操作區 */}
          <div className="space-y-5">
            <div className="border border-stone-200 rounded-2xl overflow-hidden bg-white">
              <div className="px-5 py-3.5 bg-stone-50 border-b border-stone-100">
                <p className="text-sm font-semibold text-stone-700">下一步</p>
              </div>
              <div className="px-5 py-6 space-y-4">
                {matched.length > 0 ? (
                  <>
                    <div className="flex items-center gap-3 p-4 bg-green-50 rounded-xl border border-green-200">
                      <CheckCircle size={20} className="text-green-600 flex-shrink-0" />
                      <div>
                        <p className="text-sm font-semibold text-green-800">
                          成功識別 {matched.length} 種植栽
                        </p>
                        <p className="text-xs text-green-600 mt-0.5">
                          已自動排除圖框、標題欄、尺寸文字等非植栽資訊
                        </p>
                      </div>
                    </div>
                    <button onClick={handleImport}
                      className="w-full flex items-center justify-center gap-2 py-4 rounded-xl bg-green-700 text-white text-base font-bold hover:bg-green-800 transition-colors">
                      <ArrowRight size={18} />進行 AI 景觀審查
                    </button>
                    <p className="text-xs text-stone-400 text-center">
                      點擊後自動進入「AI 配植評估」頁面，顯示相容性分析與風險評估結果
                    </p>
                  </>
                ) : (
                  <div className="flex items-start gap-3 p-4 bg-amber-50 rounded-xl border border-amber-200">
                    <AlertTriangle size={18} className="text-amber-500 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-semibold text-amber-800">未識別到植栽</p>
                      <p className="text-xs text-amber-600 mt-1">
                        {imageSrc
                          ? '請在左側輸入植栽清單文字並按「解析植栽清單」'
                          : 'PDF 中未找到可比對的植物名稱。請確認 PDF 是否包含植栽索引表，或圖文是否可選取。'}
                      </p>
                    </div>
                  </div>
                )}

                {/* 除錯區（預設收合） */}
                {result && (
                  <div className="border border-stone-100 rounded-xl overflow-hidden">
                    <button onClick={() => setShowDebug(v => !v)}
                      className="w-full flex items-center justify-between px-4 py-3 bg-stone-50 text-xs text-stone-400 hover:bg-stone-100">
                      <span>除錯區（已排除 {excluded.length} 筆非植栽文字）</span>
                      {showDebug ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                    </button>
                    {showDebug && (
                      <div className="px-4 py-3 max-h-60 overflow-y-auto space-y-1">
                        {excluded.map((e, i) => (
                          <div key={i} className="flex gap-2 text-xs text-stone-400">
                            <span className="flex-shrink-0 text-stone-300">✕</span>
                            <span className="flex-1 truncate">{e.text}</span>
                            <span className="text-stone-300 whitespace-nowrap">{e.reason}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
