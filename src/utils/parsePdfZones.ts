export interface ZonePlantingRow {
  zoneName: string
  shrubs: string[]
  trees: string[]
}

// PDF 分區可信度：純文字解析先天上限是「中」——沒有幾何座標可確認邊界。
// 「高」保留給未來具備視覺/向量路徑分析、可確認封閉區域時使用（目前不會出現）。
export type ZoneConfidence = 'low' | 'medium' | 'high'

/**
 * 掃描全文尋找「A、B、C區」這類聯合分區標題（常見於「A、B、C區配置圖」圖名）。
 * 用途：防呆——PDF 逐區表格解析器（parsePdfZonePlantingTable / parseZoneTable）
 * 是純文字/行序解析，pdfjs 擷取順序不保證與版面一致，容易把這種聯合標題誤判
 * 成「只有最後一個字母（如 C區）」的單一分區資料。呼叫端應比對：解析出的分區
 * 集合是否涵蓋聯合標題列出的全部分區，若沒有涵蓋全部，代表結果不可信，
 * 必須整體改採「聯合配置評估」，不可假裝完成各區獨立檢核。
 */
export function detectJointZoneTitle(rawText: string): string[] | null {
  const re = /([A-Za-z0-9](?:\s*[、,，]\s*[A-Za-z0-9]){1,9})\s*區/g
  let best: string[] | null = null
  let m: RegExpExecArray | null
  while ((m = re.exec(rawText)) !== null) {
    const letters = [...new Set(m[1].split(/[、,，]/).map(s => s.trim()).filter(Boolean))]
    if (letters.length >= 2 && (!best || letters.length > best.length)) {
      best = letters.map(l => `${l}區`)
    }
  }
  return best
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
      .filter(s => s.length >= 2 && /[一-鿿]/.test(s))

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
