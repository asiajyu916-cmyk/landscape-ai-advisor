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
import { parsePdfZonePlantingTable, detectJointZoneTitle, CAPTION_EXCLUDE_RE, type ZonePlantingRow, type ZoneConfidence } from '@/utils/parsePdfZones'
import { evaluateZone, type ZoneReviewResult } from '@/utils/evaluateZone'

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

  // 分區名稱（A區～Z區、第X區）不是植物，直接排除
  if (/^[A-Za-z一二三四五六七八九十]\s*區$/.test(t))
    return { excluded: true, reason: '分區名稱' }
  // 表格欄位標頭
  if (/^(分區|灌木配置|喬木配置|灌木|喬木|區域|區別)$/.test(t))
    return { excluded: true, reason: '表格欄位標頭' }

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

// ── 分區植栽表解析 ───────────────────────────────────────────────────────────────

// ZonePlantingRow 已移至 @/utils/parsePdfZones

interface ZoneTableResult {
  rows: ZonePlantingRow[]
  parseSuccess: boolean
  failReason?: string
  headerDetected?: string   // 偵測到的欄位標頭
  confidence: ZoneConfidence
  // 偵測到「A、B、C區配置圖」這類聯合標題，但表格解析涵蓋不到全部分區時填入：
  // 代表不可信任逐區解析結果，改採整體混植配置評估。
  jointZoneNames?: string[]
  jointConfigNote?: string
}

/** 從 PDF 原始文字解析「分區｜灌木配置｜喬木配置」表格 */
function parseZoneTable(rawText: string): ZoneTableResult {
  const lines = rawText.split(/\n+/).map(l => l.trim()).filter(Boolean)

  // 1. 找表頭行（含「分區」+「灌木」或「喬木」）
  const ZONE_HEADER_KWS  = ['分區', '區域', '區別']
  const SHRUB_HEADER_KWS = ['灌木', '地被', '草皮', '鋪面植栽', '灌木配置', '地被配置']
  const TREE_HEADER_KWS  = ['喬木', '喬木配置', '喬木類', '行道樹']
  const ZONE_CELL_PATTERN = /^[A-Ia-i１-９一二三四五六七八九][\s區]|^[A-Ia-i]\s*區|^第[一二三四五六七八九]區/

  let headerLineIdx = -1
  let shrubColHint  = -1
  let treeColHint   = -1
  let headerText    = ''

  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    const l = lines[i]
    const hasZone  = ZONE_HEADER_KWS.some(kw => l.includes(kw))
    const hasShrub = SHRUB_HEADER_KWS.some(kw => l.includes(kw))
    const hasTree  = TREE_HEADER_KWS.some(kw => l.includes(kw))
    if (hasZone && (hasShrub || hasTree)) {
      headerLineIdx = i; headerText = l
      // 粗估欄位 hint（供後續行判斷）
      shrubColHint = hasShrub ? SHRUB_HEADER_KWS.findIndex(kw => l.includes(kw)) : -1
      treeColHint  = hasTree  ? TREE_HEADER_KWS.findIndex(kw => l.includes(kw))  : -1
      break
    }
  }

  if (headerLineIdx === -1) {
    // 嘗試直接偵測分區行（即使沒找到標頭）
    const zoneLines = lines.filter(l => ZONE_CELL_PATTERN.test(l))
    if (zoneLines.length < 2) {
      return {
        rows: [], parseSuccess: false, confidence: 'low',
        failReason: '未偵測到分區表格欄位（需包含「分區」+「灌木配置」/「喬木配置」欄頭），請確認 PDF 表格結構。',
      }
    }
  }

  // 2. 從表頭後逐行解析分區列
  const rows: ZonePlantingRow[] = []
  const startIdx = headerLineIdx >= 0 ? headerLineIdx + 1 : 0

  // 把後續所有行合成一大字串，依分區 pattern 切割
  const dataText = lines.slice(startIdx).join('\n')
  const zoneSegments = dataText.split(/(?=(?:[A-Ia-i][區\s]|第[一二三四五六七八九]區))/g)

  const splitPlants = (text: string): string[] =>
    text
      .split(/[、，,\n\/・•]+/)
      .map(s => s.replace(/[（(][^)）]*[）)]/g, '').replace(/[×xX]\s*\d+/g, '').trim())
      .filter(s => s.length >= 2 && /[一-鿿]/.test(s) && !/^\d+$/.test(s) && !CAPTION_EXCLUDE_RE.test(s))

  for (const seg of zoneSegments) {
    const zoneMatch = seg.match(/^([A-Ia-i]\s*區|第[一二三四五六七八九]區)/)
    if (!zoneMatch) continue
    const zoneName = zoneMatch[1].replace(/\s/g, '')
    const rest = seg.slice(zoneMatch[0].length).trim()

    // 嘗試依「灌木」「喬木」關鍵字切分
    const shrubMatch = rest.match(/灌木[配置]*[\s:：]*([^喬木]*)/s)
    const treeMatch  = rest.match(/喬木[配置]*[\s:：]*([^灌木]*)/s)

    let shrubs: string[] = []
    let trees:  string[] = []

    if (shrubMatch || treeMatch) {
      shrubs = shrubMatch ? splitPlants(shrubMatch[1]) : []
      trees  = treeMatch  ? splitPlants(treeMatch[1])  : []
    } else {
      // fallback：把所有中文植物名稱全部列出（無法分類）
      const allPlants = splitPlants(rest)
      // 無法區分灌木/喬木，全放到 shrubs
      shrubs = allPlants
    }

    if (shrubs.length > 0 || trees.length > 0) {
      rows.push({ zoneName, shrubs, trees })
    }
  }

  if (rows.length === 0) {
    return {
      rows: [], parseSuccess: false, confidence: 'low',
      headerDetected: headerText || undefined,
      failReason: '已偵測植物名稱，但未成功解析分區表格，請確認 PDF 表格欄位是否包含：分區、灌木配置、喬木配置。',
    }
  }

  return { rows, parseSuccess: true, confidence: 'medium', headerDetected: headerText || undefined }
}

// parsePdfZonePlantingTable 已移至 @/utils/parsePdfZones（避免 Vite Fast Refresh export 衝突）

// ── 植栽擷取與資料庫比對 ──────────────────────────────────────────────────────────

interface ExtractResult {
  matched:  Array<{ plantName: string; quantity?: number; matchReason: string }>
  possible: Array<{ text: string; reason: string }>   // 疑似植物但找不到
  excluded: Array<{ text: string; reason: string }>   // 非植栽被排除
  rawLines: string[]
  zoneTable?: ZoneTableResult   // 新增：分區表格解析結果
}

function extractQuantity(line: string): number | undefined {
  const m = line.match(/[×xX*]\s*(\d+)|(\d+)\s*[株棵本叢桿]/u)
  if (m) return parseInt(m[1] ?? m[2])
  return undefined
}

// 分區名稱（A區～Z區）靜默跳過，不進任何列表
const ZONE_NAME_RE = /^[A-Za-z一二三四五六七八九十]\s*區$/

function extractPlants(rawText: string, db: CsvPlantRecord[]): ExtractResult {
  const lines = rawText.split(/\n+/).map(l => l.trim()).filter(Boolean)
  const matched:  ExtractResult['matched']  = []
  const possible: ExtractResult['possible'] = []
  const excluded: ExtractResult['excluded'] = []
  const seen = new Set<string>()

  for (const line of lines) {
    // 分區名稱或表格欄位標頭：靜默跳過，不進任何列表
    if (ZONE_NAME_RE.test(line) ||
        /^(分區|灌木配置|喬木配置|灌木|喬木|區域|區別)$/.test(line)) continue

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

  // 優先用三欄群組解析；若取不到 ≥2 區才 fallback 到 parseZoneTable
  const newRows = parsePdfZonePlantingTable(rawText)
  let zoneTable: ZoneTableResult = newRows.length >= 2
    ? { rows: newRows, parseSuccess: true, confidence: 'medium' }
    : parseZoneTable(rawText)

  // 防呆：PDF 逐區表格解析純靠文字行序，pdfjs 擷取順序不保證與版面一致。
  // 若圖面標題本身就是「A、B、C區配置圖」這種聯合標題，但上面解析出的分區
  // 沒有涵蓋標題列出的全部分區（典型錯誤：只抓到最後一個「C區」），
  // 代表解析結果不可信 —— 不可假裝完成各區獨立檢核，整體改採聯合配置評估。
  const jointZoneNames = detectJointZoneTitle(rawText)
  if (jointZoneNames && jointZoneNames.length >= 2) {
    const parsedNames = new Set(zoneTable.rows.map(r => r.zoneName))
    const coversAll = jointZoneNames.every(n => parsedNames.has(n))
    if (!coversAll) {
      zoneTable = {
        rows: [], parseSuccess: false, confidence: 'low',
        jointZoneNames,
        jointConfigNote: `本圖為 ${jointZoneNames.join('、')} 聯合配置區，目前未辨識各區獨立幾何邊界，本次採整體混植配置評估。`,
      }
    }
  }

  if (zoneTable.parseSuccess && zoneTable.rows.length > 0) {
    console.table(zoneTable.rows.map(r => ({
      分區: r.zoneName,
      灌木配置: r.shrubs.join('、'),
      喬木配置: r.trees.join('、'),
    })))
  }

  return { matched, possible, excluded, rawLines: lines, zoneTable }
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

type AppTab = 'pdf' | 'landscape' | 'dxf' | 'advisor'

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
  onZoneParsed,
  onZoneReviewed,
}: {
  activeTab?: AppTab
  onTabChange?: (tab: AppTab) => void
  onImport?: (plantNames: string[], zoneTable?: ZonePlantingRow[]) => void
  onZoneParsed?: (rows: ZonePlantingRow[]) => void
  onZoneReviewed?: (results: ZoneReviewResult[]) => void
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
  const [activeZone, setActiveZone] = useState<string>('全案')
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
        // 印出 PDF 原始文字前 3000 字，供 debug parser 問題
setProcMsg('正在比對植栽資料庫及分區表格…')
        const result = extractPlants(text, db)
        setExtractResult(result)
        // 立刻通知父層，不等 handleImport
        const zRows = result.zoneTable?.rows ?? []
        console.table(zRows)
        onZoneParsed?.(zRows)
        // 同時計算並傳遞分區審查結果
        if (zRows.length > 0) {
          const reviews = zRows.map(z => evaluateZone(z, db))
          onZoneReviewed?.(reviews)
        }
        // 若成功解析分區，預設選第一個分區
        if (result.zoneTable?.parseSuccess && result.zoneTable.rows.length > 0) {
          setActiveZone(result.zoneTable.rows[0].zoneName)
        } else {
          setActiveZone('全案')
        }
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
    if (result.zoneTable?.parseSuccess && result.zoneTable.rows.length > 0) {
      setActiveZone(result.zoneTable.rows[0].zoneName)
    }
  }

  const handleImport = () => {
    if (!extractResult) return
    const names = extractResult.matched.map(m => m.plantName)
    // 永遠傳 rows（空陣列代表解析失敗），讓 LandscapeAdvisorPage 顯示驗收訊息
    const zoneRows = extractResult.zoneTable?.rows ?? []
    onImport?.(names, zoneRows)
  }

  // ── Upload stage ──────────────────────────────────────────────────────────────

  if (stage === 'upload') {
    return (
      <div className="min-h-screen" style={{ background: 'radial-gradient(circle at 85% 15%, rgba(121,190,140,0.16) 0%, transparent 30%), radial-gradient(circle at 20% 85%, rgba(183,220,190,0.18) 0%, transparent 35%), linear-gradient(135deg, #f7faf5 0%, #eef6ef 48%, #e5f1e8 100%)' }}>
        <main className="max-w-[1536px] mx-auto px-4 md:px-8 py-6 md:py-8 flex flex-col items-center">
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

  // 分區審查結果（從 zonePlantingTable 對照 DB 逐區評分）
  const zoneRows = result?.zoneTable?.rows ?? []
  const zoneReviewResults: ZoneReviewResult[] = zoneRows.map(z => evaluateZone(z, db))

  return (
    <div className="min-h-screen" style={{ background: 'radial-gradient(circle at 85% 15%, rgba(121,190,140,0.16) 0%, transparent 30%), radial-gradient(circle at 20% 85%, rgba(183,220,190,0.18) 0%, transparent 35%), linear-gradient(135deg, #f7faf5 0%, #eef6ef 48%, #e5f1e8 100%)' }}>
      <div className="max-w-[1536px] mx-auto px-4 md:px-8 pt-3 pb-1 flex items-center justify-between gap-2">
        <p className="text-xs text-stone-500 truncate min-w-0">{fileName}</p>
        <button onClick={() => { setStage('upload'); setFileName(''); setExtractResult(null); setImageSrc('') }}
          className="flex items-center gap-1.5 px-3 py-1 rounded-lg border border-stone-300 text-xs text-stone-600 hover:bg-stone-100 transition-colors flex-shrink-0 whitespace-nowrap">
          <X size={12} />重新上傳
        </button>
      </div>
      <main className="max-w-[1536px] mx-auto px-4 md:px-8 py-4">
        <div className={`grid gap-4 md:gap-6 items-start ${imageSrc ? 'md:grid-cols-2' : 'md:grid-cols-[480px_1fr]'}`}>

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

            {/* ── PDF 分區植栽審查結果（含評分）─────────────────────────── */}
            {zoneRows.length > 0 && (
              <div className="border-2 border-blue-500 rounded-2xl overflow-hidden bg-white">
                <div className="px-5 py-3.5 bg-blue-600 border-b border-blue-400">
                  <p className="text-sm font-bold text-white">PDF 分區植栽審查結果</p>
                  <p className="text-xs text-blue-100 mt-0.5">共 {zoneRows.length} 個分區獨立審查</p>
                </div>
                <div className="divide-y divide-stone-100">
                  {zoneRows.map((z, idx) => {
                    const r = zoneReviewResults[idx]
                    return (
                      <div key={z.zoneName} className="px-5 py-4">
                        {/* 區名 + 分數 + 風險 */}
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-base font-bold text-stone-800">{z.zoneName}</p>
                          {r && (
                            <div className="flex items-center gap-2">
                              <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${
                                r.riskLevel === '低' ? 'bg-green-100 text-green-800' :
                                r.riskLevel === '中' ? 'bg-amber-100 text-amber-800' :
                                'bg-red-100 text-red-800'
                              }`}>風險：{r.riskLevel}</span>
                              <span className="text-sm font-bold text-stone-700">{r.score} / 100</span>
                            </div>
                          )}
                        </div>
                        {/* 植栽 */}
                        <p className="text-xs text-stone-600 mb-0.5">
                          <span className="font-semibold">灌木配置：</span>{z.shrubs.join('、') || '—'}
                        </p>
                        <p className="text-xs text-stone-600 mb-3">
                          <span className="font-semibold">喬木配置：</span>{z.trees.join('、') || '—'}
                        </p>
                        {/* 問題與建議 */}
                        {r && r.issues.map((issue, i) => (
                          <div key={i} className="mb-1.5 bg-stone-50 rounded-lg px-3 py-2">
                            <p className="text-xs font-semibold text-stone-700">
                              {i + 1}. [{issue.type}] {issue.description}
                            </p>
                            <p className="text-xs text-blue-700 mt-0.5">→ {issue.suggestion}</p>
                          </div>
                        ))}
                        {r && (
                          <p className="text-xs text-stone-500 mt-2 leading-relaxed">{r.summary}</p>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* 疑似植栽（待確認）— 過濾掉分區名稱和表格欄位標頭 */}
            {(() => {
              const ZONE_FILTER = /^[A-Za-z一二三四五六七八九十]\s*區$|^(分區|灌木配置|喬木配置|灌木|喬木)$/
              const filteredPossible = possible.filter(p => !ZONE_FILTER.test(p.text.trim()))
              return filteredPossible.length > 0 ? (
                <div className="border border-amber-200 rounded-2xl overflow-hidden bg-white">
                  <div className="px-5 py-3.5 bg-amber-50 border-b border-amber-100">
                    <p className="text-sm font-semibold text-amber-800">
                      疑似植栽，請確認（{filteredPossible.length} 筆）
                    </p>
                    <p className="text-xs text-amber-600 mt-0.5">以下文字符合植物名稱格式，但找不到對應資料庫記錄</p>
                  </div>
                  <div className="divide-y divide-stone-100">
                    {filteredPossible.map((p, i) => (
                      <div key={i} className="flex items-center gap-3 px-5 py-2.5">
                        <AlertTriangle size={13} className="text-amber-400 flex-shrink-0" />
                        <span className="text-stone-700 text-sm flex-1">{p.text}</span>
                        <span className="text-xs text-stone-400">{p.reason}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null
            })()}
          </div>

          {/* 右側：操作區 */}
          <div className="space-y-5">

            {/* ── 分區可信度徽章 ──────────────────────────────────────────────── */}
            {result?.zoneTable && (() => {
              const zt = result.zoneTable!
              const badge: Record<ZoneConfidence, { label: string; desc: string; cls: string }> = {
                low:    { label: '可信度：低', desc: '僅文字辨識', cls: 'bg-stone-100 text-stone-600 border-stone-300' },
                medium: { label: '可信度：中', desc: '文字＋表格結構', cls: 'bg-amber-100 text-amber-700 border-amber-300' },
                high:   { label: '可信度：高', desc: '具可確認的封閉區域', cls: 'bg-emerald-100 text-emerald-700 border-emerald-300' },
              }
              const b = badge[zt.confidence]
              return (
                <div className={`inline-flex items-center gap-2 border rounded-lg px-3 py-1.5 text-xs font-medium ${b.cls}`}>
                  <span>{b.label}</span>
                  <span className="opacity-70">（{b.desc}）</span>
                </div>
              )
            })()}

            {/* ── 聯合配置區提示（無法取得各區獨立幾何邊界時）────────────────────── */}
            {result?.zoneTable?.jointConfigNote && (
              <div className="border border-sky-200 rounded-xl px-4 py-3 bg-sky-50 flex items-start gap-3">
                <AlertTriangle size={16} className="text-sky-500 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-sky-800">{result.zoneTable.jointConfigNote}</p>
              </div>
            )}

            {/* ── 分區植栽表格解析結果 ─────────────────────────────────────────── */}
            {result?.zoneTable && (() => {
              const zt = result.zoneTable!
              return zt.parseSuccess ? (
                <div className="border border-emerald-200 rounded-2xl overflow-hidden bg-white">
                  <div className="px-5 py-3.5 bg-emerald-50 border-b border-emerald-100 flex items-center justify-between">
                    <div>
                      <p className="text-sm font-semibold text-emerald-800">✅ 分區植栽表格已解析</p>
                      <p className="text-xs text-emerald-600 mt-0.5">偵測到 {zt.rows.length} 個分區，AI 審查將以分區為單位進行</p>
                    </div>
                  </div>
                  {/* 分區 tabs */}
                  <div className="px-4 py-3 flex gap-2 flex-wrap border-b border-stone-100">
                    <button
                      onClick={() => setActiveZone('全案')}
                      className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${activeZone === '全案' ? 'bg-emerald-700 text-white' : 'bg-stone-100 text-stone-600 hover:bg-stone-200'}`}>
                      全案總覽
                    </button>
                    {zt.rows.map(r => (
                      <button key={r.zoneName}
                        onClick={() => setActiveZone(r.zoneName)}
                        className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${activeZone === r.zoneName ? 'bg-emerald-700 text-white' : 'bg-stone-100 text-stone-600 hover:bg-stone-200'}`}>
                        {r.zoneName}
                      </button>
                    ))}
                  </div>
                  {/* 分區內容 */}
                  <div className="px-5 py-4 space-y-3">
                    {activeZone === '全案' ? (
                      <div className="space-y-2">
                        {zt.rows.map(r => (
                          <div key={r.zoneName} className="p-3 bg-stone-50 rounded-xl">
                            <p className="text-xs font-semibold text-stone-700 mb-1">{r.zoneName}</p>
                            {r.trees.length > 0 && <p className="text-xs text-stone-500">喬木：{r.trees.join('、')}</p>}
                            {r.shrubs.length > 0 && <p className="text-xs text-stone-500">灌木／地被：{r.shrubs.join('、')}</p>}
                          </div>
                        ))}
                      </div>
                    ) : (() => {
                      const row = zt.rows.find(r => r.zoneName === activeZone)
                      if (!row) return null
                      return (
                        <div className="space-y-3">
                          {row.trees.length > 0 && (
                            <div>
                              <p className="text-xs font-semibold text-stone-500 mb-1.5">喬木配置</p>
                              <div className="flex flex-wrap gap-1.5">
                                {row.trees.map((t, i) => (
                                  <span key={i} className="px-2.5 py-1 bg-green-50 border border-green-200 text-green-800 rounded-lg text-xs font-medium">{t}</span>
                                ))}
                              </div>
                            </div>
                          )}
                          {row.shrubs.length > 0 && (
                            <div>
                              <p className="text-xs font-semibold text-stone-500 mb-1.5">灌木／地被配置</p>
                              <div className="flex flex-wrap gap-1.5">
                                {row.shrubs.map((s, i) => (
                                  <span key={i} className="px-2.5 py-1 bg-lime-50 border border-lime-200 text-lime-800 rounded-lg text-xs font-medium">{s}</span>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })()}
                  </div>
                </div>
              ) : (
                <div className="border border-amber-200 rounded-2xl px-5 py-4 bg-amber-50">
                  <div className="flex items-start gap-3">
                    <AlertTriangle size={16} className="text-amber-500 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-semibold text-amber-800">分區表格解析失敗</p>
                      <p className="text-xs text-amber-700 mt-1">{zt.failReason ?? zt.jointConfigNote ?? '無法解析分區表格。'}</p>
                      {zt.headerDetected && <p className="text-xs text-amber-600 mt-0.5">偵測到表頭：{zt.headerDetected}</p>}
                      <p className="text-xs text-amber-600 mt-1.5">AI 審查將以全案植栽清單模式進行，不分區評估。</p>
                    </div>
                  </div>
                </div>
              )
            })()}

            {/* ── PDF 分區植栽審查結果 ───────────────────────────────────────── */}
            {zoneReviewResults.length > 0 && (
              <div className="border border-blue-200 rounded-2xl overflow-hidden bg-white">
                <div className="px-5 py-3.5 bg-blue-50 border-b border-blue-100">
                  <p className="text-sm font-semibold text-blue-900">PDF 分區植栽審查結果</p>
                  <p className="text-xs text-blue-600 mt-0.5">共 {zoneReviewResults.length} 個分區獨立審查</p>
                </div>
                <div className="divide-y divide-stone-100">
                  {zoneReviewResults.map(r => (
                    <div key={r.zoneName} className="px-5 py-4">
                      {/* 區名 + 分數 + 風險 */}
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-base font-bold text-stone-800">{r.zoneName}審查結果</p>
                        <div className="flex items-center gap-2">
                          <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${
                            r.riskLevel === '低' ? 'bg-green-100 text-green-800' :
                            r.riskLevel === '中' ? 'bg-amber-100 text-amber-800' :
                            'bg-red-100 text-red-800'
                          }`}>風險：{r.riskLevel}</span>
                          <span className="text-sm font-bold text-stone-700">{r.score} 分</span>
                        </div>
                      </div>
                      {/* 植栽組成 */}
                      <p className="text-xs text-stone-500 mb-1">
                        <span className="font-medium text-stone-600">灌木配置：</span>{r.shrubs.join('、') || '—'}
                      </p>
                      <p className="text-xs text-stone-500 mb-3">
                        <span className="font-medium text-stone-600">喬木配置：</span>{r.trees.join('、') || '—'}
                      </p>
                      {/* 問題分析 */}
                      <p className="text-xs font-semibold text-stone-600 mb-1.5">主要問題：</p>
                      <div className="space-y-2 mb-3">
                        {r.issues.map((issue, i) => (
                          <div key={i} className="bg-stone-50 rounded-lg px-3 py-2">
                            <p className="text-xs font-semibold text-stone-700 mb-0.5">
                              {i + 1}. [{issue.type}] {issue.description}
                            </p>
                            <p className="text-xs text-stone-500">→ {issue.suggestion}</p>
                          </div>
                        ))}
                      </div>
                      {/* 審查摘要 */}
                      <p className="text-xs font-semibold text-stone-600 mb-1">審查摘要：</p>
                      <p className="text-xs text-stone-500 leading-relaxed">{r.summary}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

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
                          {result?.zoneTable?.parseSuccess && ` · 已解析 ${result.zoneTable.rows.length} 個分區`}
                        </p>
                        <p className="text-xs text-green-600 mt-0.5">
                          {result?.zoneTable?.parseSuccess
                            ? 'AI 審查將以分區為單位，個別評估各區植栽配置。'
                            : '已自動排除圖框、標題欄、尺寸文字等非植栽資訊'}
                        </p>
                      </div>
                    </div>
                    <button onClick={handleImport}
                      className="w-full flex items-center justify-center gap-2 py-4 rounded-xl bg-green-700 text-white text-base font-bold hover:bg-green-800 transition-colors">
                      <ArrowRight size={18} />{result?.zoneTable?.parseSuccess ? '進行分區 AI 景觀審查' : '進行 AI 景觀審查'}
                    </button>
                    <p className="text-xs text-stone-400 text-center">
                      {result?.zoneTable?.parseSuccess
                        ? '點擊後進入「AI 配植評估」，可切換 A/B/C/D/E 區個別審查'
                        : '點擊後自動進入「AI 配植評估」頁面，顯示相容性分析與風險評估結果'}
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

                {/* ── PDF 分區解析結果（在除錯區上方）────────────────── */}
                {zoneRows.length > 0 && (
                  <div className="border-2 border-blue-500 rounded-xl overflow-hidden">
                    <div className="px-4 py-3 bg-blue-600">
                      <p className="text-sm font-bold text-white">PDF 分區解析結果</p>
                    </div>
                    <div className="divide-y divide-stone-100">
                      {zoneRows.map(zone => (
                        <div key={zone.zoneName} className="px-4 py-3">
                          <h4 className="text-sm font-bold text-stone-800 mb-1">{zone.zoneName}</h4>
                          <p className="text-xs text-stone-600">灌木配置：{zone.shrubs.join('、') || '—'}</p>
                          <p className="text-xs text-stone-600">喬木配置：{zone.trees.join('、') || '—'}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* PDF 分區解析結果（取代舊除錯區）*/}
                {zoneRows.length > 0 ? (
                  <div className="border-2 border-blue-500 rounded-xl overflow-hidden">
                    <div className="px-4 py-3 bg-blue-600">
                      <p className="text-sm font-bold text-white">PDF 分區解析結果</p>
                    </div>
                    <div className="divide-y divide-stone-100">
                      {zoneRows.map(zone => (
                        <div key={zone.zoneName} className="px-4 py-3">
                          <h4 className="text-sm font-bold text-stone-800 mb-1">{zone.zoneName}</h4>
                          <p className="text-xs text-stone-600">灌木配置：{zone.shrubs.join('、') || '—'}</p>
                          <p className="text-xs text-stone-600">喬木配置：{zone.trees.join('、') || '—'}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="px-4 py-3 text-xs text-stone-400 border border-stone-100 rounded-xl">
                    尚未解析到 PDF 分區表格。
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
