import type {
  CsvPlantRecord, NormalizedCategory, SunReq, WaterReq,
  DroughtTolerance, WetTolerance, MaintenanceLevel, DrainageSensitivity,
  ImportResult,
} from '@/types/csvPlant'

// ── Header-name-based column mapping ──────────────────────────────────────────
// 改用「讀取 CSV header 名稱 → 對應欄位」，不再依賴固定欄位順序。
// 即使欄位順序改變、或新增欄位，只要 header 文字對得上，資料就不會錯位。
// 每個欄位可接受多個慣用寫法（別名），涵蓋舊版匯出檔與手動整理檔常見的用字差異。
type FieldKey = keyof CsvPlantRecord | 'imageUrl'

const HEADER_ALIASES: Record<FieldKey, string[]> = {
  id:                  [],   // 不從 CSV 讀取，程式自動產生
  name:                ['植物名稱', '中文名稱', '名稱', '植栽名稱', '植物名', '中文名', '品名'],
  category:            ['喬木.灌木.草本', '喬木/灌木/草本', '分類', '大分類'],
  normalizedCategory:  [],   // 由 category 推導，不從 CSV 讀取
  subCategory:         ['細分類', '子分類'],
  scientificName:      ['學名', '拉丁學名', '學名/拉丁名', 'scientificname'],

  height:              ['樹高'],
  crownWidth:          ['樹冠'],
  trunkDiameter:       ['米徑'],
  treeForm:            ['樹型'],
  soilDepth:           ['覆土深度'],
  plantingSpacing:     ['種植株距', '建議種植株距'],

  flowerColor:         ['花色'],
  flowerMonth:         ['花期月份'],
  flowerPeriod:        ['花期(花色-月份)', '花期（花色-月份）', '花期'],
  flowerSupplement:    ['花期花色補充'],

  nativeStatus:        ['台灣原生種.外來種', '台灣原生種/外來種', '原生/外來'],
  biodiversityValue:   ['誘鳥誘蝶', '生態價值'],

  maintenanceNote:     ['維護管理', '維護管理備註'],
  maintenanceLevel:    [],   // 由 maintenanceNote 推導，不從 CSV 讀取

  sunRequirement:      ['日照需求'],
  droughtTolerance:    ['耐旱性'],
  wetTolerance:        ['耐濕性'],
  waterRequirement:    ['水分需求'],
  waterToleranceTag:   ['水分耐受標籤'],
  drainageSensitivity: [],   // 由 wetTolerance 推導，不從 CSV 讀取

  soilPh:              ['土壤酸鹼性'],
  soilPhRange:         ['pH範圍', 'pH 範圍', '建議pH範圍', '建議 pH 範圍'],
  soilTexture:         ['土壤質地'],
  soilAmendment:       ['客土改良需求', '客土改良'],

  // ── 新增欄位（缺漏植栽安全 / 落葉性資料）─────────────────────────────────────
  minimumPlantSpacing: ['最小種植間距'],
  leafDropStatus:      ['是否容易落葉', '落葉性'],
  toxicity:            ['有無毒性', '毒性'],
  plantSafetyNote:     ['植栽安全備註'],

  riskTags:            [],   // 由多個欄位推導，不從 CSV 讀取

  price:               ['價格資訊', '參考價格'],
  referencePageNo:     ['圖鑑頁碼'],
  referenceNote:       ['圖鑑資料備註'],
  officialUrl:         ['官方資料連結'],
  remarks:             ['備註'],
  sunWaterSource:      ['日照水分資料來源'],
  sunWaterSourceUrl:   ['日照水分來源網址'],
  verificationStatus:  ['日照水分資料判定'],
  verifiedAt:          ['日照水分查核日期'],
  verificationSummary: ['日照水分查核摘要'],

  imageUrl:            ['圖片網址', '照片網址', 'imageUrl', 'Image URL'],

  reviewNote:          [],   // 程式自動產生，不從 CSV 讀取
  dataComplete:        [],   // 程式自動產生，不從 CSV 讀取
  isAutoSourced:       [],
  autoSourceFields:    [],
}

/** 正規化 header 文字以利比對（去除全形/半形空白、統一大小寫）*/
function normalizeHeader(h: string): string {
  return h.replace(/[\s\u3000]+/g, '').toLowerCase()
}

/** 依 headers 陣列建立「欄位 key → 欄位索引」的對照表 */
function buildColumnIndex(headers: string[]): Partial<Record<FieldKey, number>> {
  const normalizedHeaders = headers.map(normalizeHeader)
  const index: Partial<Record<FieldKey, number>> = {}
  for (const [key, aliases] of Object.entries(HEADER_ALIASES) as [FieldKey, string[]][]) {
    if (aliases.length === 0) continue
    for (const alias of aliases) {
      const idx = normalizedHeaders.indexOf(normalizeHeader(alias))
      if (idx !== -1) { index[key] = idx; break }
    }
  }
  return index
}

const REQUIRED_FIELDS: FieldKey[] = ['name', 'category', 'sunRequirement', 'waterRequirement']
const REQUIRED_FIELD_LABELS: Record<string, string> = {
  name: '植物名稱', category: '喬木.灌木.草本', sunRequirement: '日照需求', waterRequirement: '水分需求',
}

// ── Derivation helpers ────────────────────────────────────────────────────────

function normalizeCategory(raw: string): NormalizedCategory {
  if (raw.includes('喬木')) return 'tree'
  if (raw.includes('灌木')) return 'shrub'
  return 'groundcover'
}

function normalizeSun(raw: string): SunReq {
  if (!raw || raw === '' || raw.includes('待查')) return '待查'
  if (raw.includes('全日照') && (raw.includes('半日照') || raw.includes('半陰'))) return '全日照至半日照'
  if (raw.includes('全日照')) return '全日照'
  // 真正耐陰：明確提到遮陰/全陰/陰暗等強遮蔭字眼，可長期在低光環境生長
  if (/耐陰|遮陰|全陰|陰暗|背光|光線不足/.test(raw)) return '半日照至遮陰'
  // 半日照適應／可耐半陰：仍需部分日照，只是能容忍半日照或部分遮陰，不等於真正耐陰
  if (/半日照|半陰|可耐半陰|部分遮陰/.test(raw)) return '半日照'
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
  sun: SunReq, maintenance: string, toxicity?: string,
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
  if (sun === '半日照') tags.push('半日照適應')
  if (maintenance.includes('定期修剪') || maintenance.includes('修剪')) tags.push('修剪需求')
  if (maintenance.includes('支柱')) tags.push('需立支柱')
  if (maintenance.includes('病蟲') || maintenance.includes('蟲害') || maintenance.includes('病害')) tags.push('病蟲害注意')
  if (toxicity && /有毒|毒性(強|中)|誤食|接觸.{0,2}(過敏|中毒)/.test(toxicity)) tags.push('有毒性注意')
  return [...new Set(tags)]
}

function buildReviewNote(p: {
  name: string; category: string; subCategory: string
  sun: SunReq; water: WaterReq; drought: DroughtTolerance; wet: WetTolerance
  soilDepth: string; maintenance: string; height: string; spacing: string
  verificationStatus: string; toxicity?: string; leafDropStatus?: string; safetyNote?: string
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

  if (p.toxicity && !/^(無|無明確|低毒性或無明確毒性資料)/.test(p.toxicity)) {
    note += `安全提醒：${p.toxicity}。`
  }
  if (p.leafDropStatus && /落葉性強|容易落葉/.test(p.leafDropStatus)) {
    note += `落葉性：${p.leafDropStatus}。`
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
  const colIndex = buildColumnIndex(headers)

  // 缺少必要欄位（依欄位名稱比對，不是位置）
  const missingColumns = REQUIRED_FIELDS
    .filter(key => colIndex[key] === undefined)
    .map(key => REQUIRED_FIELD_LABELS[key] ?? key)

  const columnMap: Record<string, boolean> = {}
  for (const key of Object.keys(HEADER_ALIASES) as FieldKey[]) {
    columnMap[key] = colIndex[key] !== undefined
  }

  const plants: CsvPlantRecord[] = []
  const imageUrls: Record<string, string> = {}
  let skippedRows = 0

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t')
    if (cols.length < 2) { skippedRows++; continue }

    // 依欄位名稱對應到的索引取值；該欄位若不在此 CSV 中（colIndex 無此 key）則回傳空字串，
    // 不會誤讀到其他欄位的內容（這是修正舊版「依固定順序取值」錯位問題的核心）。
    const get = (key: FieldKey): string => {
      const idx = colIndex[key]
      return idx === undefined ? '' : (cols[idx] ?? '').trim()
    }

    const name = get('name')
    if (!name) { skippedRows++; continue }

    const sunRaw      = get('sunRequirement')
    const waterRaw     = get('waterRequirement')
    const droughtRaw   = get('droughtTolerance')
    const wetRaw        = get('wetTolerance')
    const mainNote      = get('maintenanceNote')
    const categoryRaw   = get('category')
    const subCat        = get('subCategory')
    const height         = get('height')
    const spacing        = get('plantingSpacing')
    const soilDepth       = get('soilDepth')
    const verStatus        = get('verificationStatus')

    const sun    = normalizeSun(sunRaw)
    const water  = normalizeWater(waterRaw)
    const drought = normalizeDrought(droughtRaw)
    const wet    = normalizeWet(wetRaw)
    const mLevel = deriveMaintenanceLevel(mainNote, water, wet)
    const drain  = deriveDrainageSensitivity(wet)
    const toxicityRaw = get('toxicity')
    const riskTags = deriveRiskTags(water, drought, wet, sun, mainNote, toxicityRaw)
    const dataComplete = sun !== '待查' && water !== '待查' && drought !== '待查' && wet !== '待查'

    const record: CsvPlantRecord = {
      id: `csv-${i}`,
      name,
      category: categoryRaw,
      normalizedCategory: normalizeCategory(categoryRaw),
      subCategory: subCat,
      scientificName: get('scientificName'),
      height,
      crownWidth: get('crownWidth'),
      trunkDiameter: get('trunkDiameter'),
      treeForm: get('treeForm'),
      soilDepth,
      plantingSpacing: spacing,
      flowerColor: get('flowerColor'),
      flowerMonth: get('flowerMonth'),
      flowerPeriod: get('flowerPeriod'),
      flowerSupplement: get('flowerSupplement'),
      nativeStatus: get('nativeStatus'),
      biodiversityValue: get('biodiversityValue'),
      maintenanceNote: mainNote,
      maintenanceLevel: mLevel,
      sunRequirement: sun,
      droughtTolerance: drought,
      wetTolerance: wet,
      waterRequirement: water,
      waterToleranceTag: get('waterToleranceTag'),
      drainageSensitivity: drain,
      riskTags,
      price: get('price'),
      referencePageNo: get('referencePageNo'),
      referenceNote: get('referenceNote'),
      officialUrl: get('officialUrl'),
      remarks: get('remarks'),
      sunWaterSource: get('sunWaterSource'),
      sunWaterSourceUrl: get('sunWaterSourceUrl'),
      verificationStatus: verStatus,
      verifiedAt: get('verifiedAt'),
      verificationSummary: get('verificationSummary'),
      soilPh:        get('soilPh'),
      soilPhRange:   get('soilPhRange'),
      soilTexture:   get('soilTexture'),
      soilAmendment: get('soilAmendment'),
      minimumPlantSpacing: get('minimumPlantSpacing'),
      leafDropStatus:      get('leafDropStatus'),
      toxicity:            toxicityRaw,
      plantSafetyNote:     get('plantSafetyNote'),
      reviewNote: buildReviewNote({
        name, category: categoryRaw, subCategory: subCat,
        sun, water, drought, wet,
        soilDepth, maintenance: mainNote, height, spacing,
        verificationStatus: verStatus,
        toxicity: toxicityRaw, leafDropStatus: get('leafDropStatus'), safetyNote: get('plantSafetyNote'),
      }),
      dataComplete,
    }
    plants.push(record)

    // 若 CSV 含圖片網址欄，記錄下來（依欄位名稱找到，不是固定第 33 欄）
    const imgUrl = get('imageUrl')
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
