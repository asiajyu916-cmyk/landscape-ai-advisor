export interface ZonePlantingRow {
  zoneName: string
  shrubs: string[]
  trees: string[]
}

/**
 * 從 pdfjs 逐格輸出的原始文字解析「分區｜灌木配置｜喬木配置」三欄表格
 * 每個分區以 [zone, shrubs, trees] 三行為一組
 */
export function parsePdfZonePlantingTable(rawText: string): ZonePlantingRow[] {
  console.log('[parsePdfZonePlantingTable] called, rawText length:', rawText.length)

  const lines = rawText.split(/\n+/).map(l => l.trim()).filter(Boolean)
  console.log('[parsePdfZonePlantingTable] lines:', lines.slice(0, 12))

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
  console.log('[parsePdfZonePlantingTable] headerIdx:', headerIdx)
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
  console.log('[parsePdfZonePlantingTable] dataStart:', dataStart, '→', lines[dataStart])

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
  console.log('[parsePdfZonePlantingTable] result rows:', rows.length)
  return rows
}
