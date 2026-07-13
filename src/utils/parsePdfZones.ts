export interface ZonePlantingRow {
  zoneName: string
  shrubs: string[]
  trees: string[]
}

// PDF 分區可信度：純文字解析先天上限是「中」——沒有幾何座標可確認邊界。
// 「高」保留給未來具備視覺/向量路徑分析、可確認封閉區域時使用（目前不會出現）。
export type ZoneConfidence = 'low' | 'medium' | 'high'

// 圖名 / 表頭 / 說明文字關鍵字：逐區表格解析器把「相鄰文字片段」當作植物名稱時，
// 常誤抓到圖名尾巴（如「區配置圖」「示意圖」）或表頭殘留字。這些字樣不可能是
// 植物名稱，一律從候選清單中剔除，避免（例如）標題「A、B、C區配置圖」被
// pdfjs 拆成 "A區"/"B區"/"C區" + "區配置圖" 後，"區配置圖" 被誤判成 C 區的植栽。
export const CAPTION_EXCLUDE_RE = /配置圖|示意圖|平面圖|立面圖|剖面圖|大樣圖|詳圖|索引圖|植栽表|圖例|項次|備註|規格|學名|名稱|數量|單位|小計|合計|SCALE|比例|分區|區域|區別/i

/**
 * 掃描全文尋找「A、B、C區」這類聯合分區標題（常見於「A、B、C區配置圖」圖名）。
 * pdfjs 擷取順序不保證與版面一致，這類標題常被拆成兩種常見碎片型態：
 *   1. 同一行內完整殘留：「A、B、C區」
 *   2. 逐字拆散：「A區」「B區」「C區」各自獨立成一行，加上散落的「、」「區配置圖」
 * 用途：防呆——呼叫端應比對「解析出的分區集合」是否涵蓋聯合標題列出的全部分區，
 * 若沒有涵蓋全部（典型錯誤：只抓到最後一個「C區」），代表結果不可信，必須整體
 * 改採「聯合配置評估」，不可假裝完成各區獨立檢核。
 */
export function detectJointZoneTitle(rawText: string): string[] | null {
  const found = new Set<string>()

  // 型態 1：同一行內就是「A、B、C區」聯合標題
  const inlineMatch = /([A-Za-z0-9](?:\s*[、,，]\s*[A-Za-z0-9]){1,9})\s*區/.exec(rawText)
  if (inlineMatch) {
    for (const l of inlineMatch[1].split(/[、,，]/).map(s => s.trim()).filter(Boolean)) found.add(`${l}區`)
  }

  // 型態 2：字母各自獨立成一行的「X區」（如 A區/B區/C區 各一行）
  const lines = rawText.split(/\n+/).map(l => l.trim()).filter(Boolean)
  for (const l of lines) {
    if (/^[A-Za-z]\s*區$/.test(l)) found.add(l.replace(/\s/g, ''))
  }

  return found.size >= 2 ? [...found].sort() : null
}

/**
 * 從 pdfjs 逐格輸出的原始文字解析「分區｜灌木配置｜喬木配置」三欄表格
 * 每個分區以 [zone, shrubs, trees] 三行為一組
 */
export function parsePdfZonePlantingTable(rawText: string): ZonePlantingRow[] {
  const lines = rawText.split(/\n+/).map(l => l.trim()).filter(Boolean)

  const splitPlants = (text: string): string[] =>
    text.split(/[、，,\/・•]+/)
      .map(s => s.replace(/[（(][^)）]*[）)]/g, '').replace(/[×xX]\s*\d+/g, '').trim())
      .filter(s => s.length >= 2 && /[一-鿿]/.test(s) && !CAPTION_EXCLUDE_RE.test(s))

  const ZONE_RE = /^([A-Ia-i])\s*區$|^第([一二三四五六七八九])區$/

  // 找含「分區」的表頭行，且附近有灌木/喬木
  let headerIdx = -1
  for (let i = 0; i < Math.min(lines.length, 40); i++) {
    const l = lines[i]
    if (l.includes('分區') || l === '區域' || l === '區別') {
      const win = lines.slice(i, i + 5).join(' ')
      if (win.includes('灌木') || win.includes('喬木')) { headerIdx = i; break }
    }
  }
  if (headerIdx === -1) return []

  // 跳過所有表頭欄位行（含分區/灌木/喬木的行）
  let dataStart = headerIdx
  while (dataStart < lines.length) {
    const l = lines[dataStart]
    if (l.includes('分區') || l.includes('灌木') || l.includes('喬木') ||
        l === '區域' || l === '區別') {
      dataStart++
    } else break
  }

  const rows: ZonePlantingRow[] = []
  let i = dataStart
  while (i < lines.length - 1) {
    if (ZONE_RE.test(lines[i])) {
      const zoneName = lines[i].replace(/\s/g, '')
      const shrubLine = lines[i + 1] ?? ''
      const treeLine  = lines[i + 2] ?? ''
      if (!ZONE_RE.test(shrubLine)) {
        const shrubs = splitPlants(shrubLine)
        const trees  = ZONE_RE.test(treeLine) ? [] : splitPlants(treeLine)
        const stride  = ZONE_RE.test(treeLine) ? 2 : 3
        if (shrubs.length > 0 || trees.length > 0) {
          rows.push({ zoneName, shrubs, trees })
          i += stride; continue
        }
      }
    }
    i++
  }
  return rows
}
