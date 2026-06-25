import type {
  CsvPlantRecord, NormalizedCategory, SunReq, WaterReq,
  DroughtTolerance, WetTolerance, MaintenanceLevel, DrainageSensitivity,
  ImportResult,
} from '@/types/csvPlant'

// ── Column index map (0-based, matches CSV header order) ─────────────────────
const COL = {
  name:               0,
  category:           1,
  subCategory:        2,
  scientificName:     3,
  height:             4,
  crownWidth:         5,
  trunkDiameter:      6,
  treeForm:           7,
  flowerColor:        8,
  flowerMonth:        9,
  flowerPeriod:       10,
  nativeStatus:       11,
  flowerSupplement:   12,
  soilDepth:          13,
  biodiversityValue:  14,
  maintenanceNote:    15,
  price:              16,
  plantingSpacing:    17,
  referencePageNo:    18,
  referenceNote:      19,
  officialUrl:        20,
  remarks:            21,
  sunRequirement:     22,
  droughtTolerance:   23,
  wetTolerance:       24,
  waterRequirement:   25,
  waterToleranceTag:  26,
  sunWaterSource:     27,
  sunWaterSourceUrl:  28,
  verificationStatus: 29,
  verifiedAt:         30,
  verificationSummary:31,
  imageUrl:           32,   // 圖片網址（選用欄，匯出時自動附加）
} as const

const REQUIRED_COLUMNS = ['植物名稱', '喬木.灌木.草本', '日照需求', '水分需求']

// ── Derivation helpers ────────────────────────────────────────────────────────

function normalizeCategory(raw: string): NormalizedCategory {
  if (raw.includes('喬木')) return 'tree'
  if (raw.includes('灌木')) return 'shrub'
  return 'groundcover'
}

function normalizeSun(raw: string): SunReq {
  if (!raw || raw === '' || raw.includes('待查')) return '待查'
  if (raw.includes('全日照') && raw.includes('半日照')) return '全日照至半日照'
  if (raw.includes('半日照') || raw.includes('遮陰') || raw.includes('耐陰')) return '半日照至遮陰'
  if (raw.includes('全日照')) return '全日照'
  return '待查'
}

function normalizeWater(raw: string): WaterReq {
  if (!raw || raw === '' || raw.includes('待查')) return '待查'
  const r = raw.trim()
  if (r === '低') return '低'
  if (r === '中') return '中'
  if (r === '高') return '高'
  if (r.includes('低至中') || r.includes('低-中')) return '低至中'
  if (r.includes('中至高') || r.includes('中-高')) return '中至高'
  return '待查'
}

function normalizeDrought(raw: string): DroughtTolerance {
  if (!raw || raw.includes('待查')) return '待查'
  if (raw.includes('耐旱') && !raw.includes('稍')) return '耐旱'
  if (raw.includes('稍耐旱')) return '稍耐旱'
  if (raw.includes('不耐旱')) return '不耐旱'
  return '待查'
}

function normalizeWet(raw: string): WetTolerance {
  if (!raw || raw.includes('待查')) return '待查'
  if (raw.includes('不耐積水') || raw.includes('不耐濕')) return '不耐積水'
  if (raw.includes('稍耐濕')) return '稍耐濕'
  if (raw.includes('耐濕') || raw.includes('耐水濕')) return '耐濕'
  return '待查'
}

function deriveMaintenanceLevel(note: string, water: WaterReq, wet: WetTolerance): MaintenanceLevel {
  if (!note) return '待查'
  const n = note
  const highKeywords = ['病蟲', '頻繁', '高頻率', '每月', '每週']
  const midKeywords = ['定期修剪', '修剪', '支柱', '排水', '施肥', '病害', '蟲害']
  const hasHigh = highKeywords.some(k => n.includes(k))
  const midCount = midKeywords.filter(k => n.includes(k)).length
  const isHighWater = water === '高' || water === '中至高'
  if (hasHigh || (midCount >= 3 && isHighWater)) return '高'
  if (midCount >= 1) return '中'
  if (water === '低' || water === '低至中') return '低'
  return '中'
}

function deriveDrainageSensitivity(wet: WetTolerance): DrainageSensitivity {
  if (wet === '不耐積水') return '高'
  if (wet === '稍耐濕') return '中'
  if (wet === '耐濕') return '低'
  return '待查'
}

function deriveRiskTags(
  water: WaterReq, drought: DroughtTolerance, wet: WetTolerance,
  sun: SunReq, maintenance: string
): string[] {
  const tags: string[] = []
  if (wet === '不耐積水') tags.push('排水敏感', '積水風險')
  if (wet === '耐濕') tags.push('耐濕')
  if (water === '高' || water === '中至高') tags.push('高需水')
  if (water === '低' || water === '低至中') tags.push('低需水', '耐旱')
  if (drought === '耐旱') tags.push('耐旱性強')
  if (drought === '不耐旱') tags.push('不耐旱')
  if (sun === '全日照') tags.push('全日照需求')
  if (sun === '半日照至遮陰') tags.push('耐陰')
  if (maintenance.includes('定期修剪') || maintenance.includes('修剪')) tags.push('修剪需求')
  if (maintenance.includes('支柱')) tags.push('需立支柱')
  if (maintenance.includes('病蟲') || maintenance.includes('蟲害') || maintenance.includes('病害')) tags.push('病蟲害注意')
  return [...new Set(tags)]
}

function buildReviewNote(p: {
  name: string; category: string; subCategory: string
  sun: SunReq; water: WaterReq; drought: DroughtTolerance; wet: WetTolerance
  soilDepth: string; maintenance: string; height: string; spacing: string
  verificationStatus: string
}): string {
  const catLabel = p.subCategory ? `${p.category}（${p.subCategory}）` : p.category
  let note = `${p.name}為${catLabel}`
  if (p.height) note += `，樹高 ${p.height}`
  note += `。`

  const conditions: string[] = []
  if (p.sun && p.sun !== '待查') conditions.push(`日照需求${p.sun}`)
  if (p.water && p.water !== '待查') conditions.push(`水分需求${p.water}`)
  if (p.drought && p.drought !== '待查') conditions.push(`耐旱性${p.drought}`)
  if (p.wet && p.wet !== '待查') conditions.push(`耐濕性${p.wet}`)
  if (conditions.length > 0) note += conditions.join('、') + '。'

  if (p.soilDepth) note += `覆土需求：${p.soilDepth}。`
  if (p.spacing) note += `建議株距：${p.spacing}。`

  if (p.maintenance) {
    const short = p.maintenance.length > 50 ? p.maintenance.slice(0, 50) + '…' : p.maintenance
    note += `養護要點：${short}`
  }

  const isVerified = p.verificationStatus && !p.verificationStatus.includes('待查') && !p.verificationStatus.includes('初步')
  if (!isVerified) note += '（日照水分資料屬初步判定，建議人工確認）'

  return note
}

// ── Main parser ───────────────────────────────────────────────────────────────

export function parsePlantCsv(text: string): ImportResult {
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '')
  if (lines.length < 2) {
    return { plants: [], totalRows: 0, successRows: 0, missingColumns: ['（檔案無資料）'], skippedRows: 0, columnMap: {}, imageUrls: {} }
  }

  const headerLine = lines[0]
  const headers = headerLine.split('\t').map(h => h.trim())

  // Check required columns
  const missingColumns = REQUIRED_COLUMNS.filter(req => !headers.includes(req))
  const columnMap: Record<string, boolean> = {}
  Object.entries(COL).forEach(([key]) => {
    const humanName = headers[COL[key as keyof typeof COL]] ?? ''
    columnMap[key] = humanName !== ''
  })

  const plants: CsvPlantRecord[] = []
  const imageUrls: Record<string, string> = {}
  let skippedRows = 0

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t')
    if (cols.length < 4) { skippedRows++; continue }

    const get = (idx: number) => (cols[idx] ?? '').trim()
    const name = get(COL.name)
    if (!name) { skippedRows++; continue }

    const sunRaw      = get(COL.sunRequirement)
    const waterRaw    = get(COL.waterRequirement)
    const droughtRaw  = get(COL.droughtTolerance)
    const wetRaw      = get(COL.wetTolerance)
    const mainNote    = get(COL.maintenanceNote)
    const categoryRaw = get(COL.category)
    const subCat      = get(COL.subCategory)
    const height      = get(COL.height)
    const spacing     = get(COL.plantingSpacing)
    const soilDepth   = get(COL.soilDepth)
    const verStatus   = get(COL.verificationStatus)

    const sun    = normalizeSun(sunRaw)
    const water  = normalizeWater(waterRaw)
    const drought = normalizeDrought(droughtRaw)
    const wet    = normalizeWet(wetRaw)
    const mLevel = deriveMaintenanceLevel(mainNote, water, wet)
    const drain  = deriveDrainageSensitivity(wet)
    const riskTags = deriveRiskTags(water, drought, wet, sun, mainNote)
    const dataComplete = sun !== '待查' && water !== '待查' && drought !== '待查' && wet !== '待查'

    const record: CsvPlantRecord = {
      id: `csv-${i}`,
      name,
      category: categoryRaw,
      normalizedCategory: normalizeCategory(categoryRaw),
      subCategory: subCat,
      scientificName: get(COL.scientificName),
      height,
      crownWidth: get(COL.crownWidth),
      trunkDiameter: get(COL.trunkDiameter),
      treeForm: get(COL.treeForm),
      soilDepth,
      plantingSpacing: spacing,
      flowerColor: get(COL.flowerColor),
      flowerMonth: get(COL.flowerMonth),
      flowerPeriod: get(COL.flowerPeriod),
      flowerSupplement: get(COL.flowerSupplement),
      nativeStatus: get(COL.nativeStatus),
      biodiversityValue: get(COL.biodiversityValue),
      maintenanceNote: mainNote,
      maintenanceLevel: mLevel,
      sunRequirement: sun,
      droughtTolerance: drought,
      wetTolerance: wet,
      waterRequirement: water,
      waterToleranceTag: get(COL.waterToleranceTag),
      drainageSensitivity: drain,
      riskTags,
      price: get(COL.price),
      referencePageNo: get(COL.referencePageNo),
      referenceNote: get(COL.referenceNote),
      officialUrl: get(COL.officialUrl),
      remarks: get(COL.remarks),
      sunWaterSource: get(COL.sunWaterSource),
      sunWaterSourceUrl: get(COL.sunWaterSourceUrl),
      verificationStatus: verStatus,
      verifiedAt: get(COL.verifiedAt),
      verificationSummary: get(COL.verificationSummary),
      reviewNote: buildReviewNote({
        name, category: categoryRaw, subCategory: subCat,
        sun, water, drought, wet,
        soilDepth, maintenance: mainNote, height, spacing,
        verificationStatus: verStatus,
      }),
      dataComplete,
    }
    plants.push(record)

    // 若 CSV 含圖片網址欄（col 32），記錄下來
    const imgUrl = get(COL.imageUrl)
    if (imgUrl) imageUrls[name] = imgUrl
  }

  return {
    plants,
    totalRows: lines.length - 1,
    successRows: plants.length,
    missingColumns,
    skippedRows,
    columnMap,
    imageUrls,
  }
}

// ── Water conflict score (for evaluation) ─────────────────────────────────────

export function waterScore(w: WaterReq): number {
  const map: Record<WaterReq, number> = { '低': 1, '低至中': 1.5, '中': 2, '中至高': 2.5, '高': 3, '待查': 2 }
  return map[w] ?? 2
}

export function sunConflictLevel(suns: SunReq[]): 'none' | 'mild' | 'severe' {
  const unique = [...new Set(suns.filter(s => s !== '待查'))]
  if (unique.includes('全日照') && unique.includes('半日照至遮陰')) return 'severe'
  if (unique.length > 1) return 'mild'
  return 'none'
}

export function drainageConflictLevel(wets: WetTolerance[]): 'none' | 'caution' {
  const filtered = wets.filter(w => w !== '待查')
  if (filtered.includes('不耐積水') && filtered.includes('耐濕')) return 'caution'
  if (filtered.includes('不耐積水') && filtered.some(w => w === '稍耐濕')) return 'caution'
  return 'none'
}
