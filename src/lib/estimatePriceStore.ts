// ── 植栽單價資料庫（本機儲存）─────────────────────────────────────────────────
// 第一版先用 localStorage 儲存，獨立於植物生態資料庫（src/data/plantStore.ts）。
// 之後如果要搬到 Supabase，只需要換掉這個檔案內部的讀寫實作，
// 呼叫端（EstimatePage / estimateAdapter）不需要跟著改。

import type { PlantPrice, PriceMatchKind } from '@/types/estimate'
import { GOV112_TREE_SHRUB_PRICE_SEED } from '@/data/estimatePriceSeedGov112'
import { GOV112_FULL_PRICE_SEED } from '@/data/estimatePriceSeedGov112Full'
import { TIANWEI_20260818_PRICE_SEED } from '@/data/estimatePriceSeedTianwei20260818'
import { GAP_FILL_20260819_PRICE_SEED } from '@/data/estimatePriceSeedGapFill20260819'
import { GAP_FILL_79_20260819_PRICE_SEED } from '@/data/estimatePriceSeedGapFill79_20260819'
import { findPriceNameCandidates, normalizeHardAliasPlantName } from '@/data/estimatePlantNameCandidates'
import { normalizeForCompare } from '@/utils/plantNameMatch'

const STORAGE_KEY = 'landscape_estimate_prices_v1'

// GOV112_TREE_SHRUB_PRICE_SEED（舊版，只有喬木14-15cm 級距）跟 GOV112_FULL_PRICE_SEED
// （完整資料庫匹配版）是同一個官方資料來源——凡是舊版裡工程會工項編碼在完整版也有的，
// 一律採用完整版那筆（規格文字更準確），避免同一筆官方資料因為排版差異被當成兩筆分別
// 保留；舊版裡完整版沒有涵蓋到的品項（例如朴樹）繼續保留，不會遺失。
const fullSeedWorkItemCodes = new Set(GOV112_FULL_PRICE_SEED.map(p => p.workItemCode).filter(Boolean))
const legacyGov112Deduped = GOV112_TREE_SHRUB_PRICE_SEED.filter(p => !p.workItemCode || !fullSeedWorkItemCodes.has(p.workItemCode))

// 舊版 estimatePriceSeedGov112.ts 是本專案第一次匯入工程會喬木價格時，使用者明確指定
// 「統一優先使用 14≦米高直徑<16cm 作為第一版參考價格」的那個級距。完整版 CSV 匯入後，
// 同一植物常常多出「270-300cm」等較小級距，造成同名多規格——這裡用工項編碼比對，把
// 完整版裡「其實就是原本那個 14-15cm 級距」的紀錄標記起來，供 resolvePlantPrice()
// 在圖面完全沒有規格資訊時當作最後一層 tie-break，而不是直接卡在「規格不明確」
// （見「茄苳價格匹配問題」修正）。
const defaultTreeSpecWorkItemCodes = new Set(GOV112_TREE_SHRUB_PRICE_SEED.map(p => p.workItemCode).filter(Boolean))
const gov112FullTagged: PlantPrice[] = GOV112_FULL_PRICE_SEED.map(p =>
  p.workItemCode && defaultTreeSpecWorkItemCodes.has(p.workItemCode) ? { ...p, isDefaultTreeSpec: true } : p
)

// 所有內建的參考價格來源——工程會官方參考價（112 完整版＋補充）、田尾玫瑰園市場參考價——
// 各自獨立保留，合併匯入時互不覆蓋（見規格「不要覆蓋既有工程會價格資料」）。之後若再
// 匯入新的價格來源（例如 110 年度工程會），直接在這裡加進陣列即可。
const ALL_SEED_PRICES: PlantPrice[] = [...legacyGov112Deduped, ...gov112FullTagged, ...TIANWEI_20260818_PRICE_SEED, ...GAP_FILL_20260819_PRICE_SEED, ...GAP_FILL_79_20260819_PRICE_SEED]

function seedKey(p: PlantPrice): string {
  return `${p.plantName}||${p.specification ?? ''}||${p.sourceType}||${p.sourceYear ?? ''}`
}

/** 匯入的參考價格表首次載入時自動補進本機價格資料庫；已存在同植物＋同規格＋同來源＋
 *  同年度的紀錄就跳過（不覆蓋使用者已編輯過的價格，也不會讓兩種來源互相覆蓋），
 *  不會重複匯入。 */
function seedIfMissing(existing: PlantPrice[]): PlantPrice[] {
  const existingKeys = new Set(existing.map(seedKey))
  const missing = ALL_SEED_PRICES.filter(s => !existingKeys.has(seedKey(s)))
  if (missing.length === 0) return existing
  const merged = [...existing, ...missing]
  savePlantPrices(merged)
  return merged
}

/** 修正既有 localStorage 裡在「isDefaultTreeSpec」這個標記加入之前就已經匯入的舊資料
 *  （例如今天稍早已經開過工程估價頁的瀏覽器）：依工項編碼比對，把應該標記的紀錄補上
 *  標記，只改這一個欄位，不動使用者可能已經手動修改過的價格數字。 */
function patchDefaultTreeSpecFlags(existing: PlantPrice[]): PlantPrice[] {
  const defaultCodes = new Set(gov112FullTagged.filter(p => p.isDefaultTreeSpec).map(p => p.workItemCode))
  let changed = false
  const patched = existing.map(p => {
    if (p.workItemCode && defaultCodes.has(p.workItemCode) && !p.isDefaultTreeSpec) {
      changed = true
      return { ...p, isDefaultTreeSpec: true }
    }
    return p
  })
  if (!changed) return existing
  savePlantPrices(patched)
  return patched
}

export function loadPlantPrices(): PlantPrice[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const stored = raw ? (JSON.parse(raw) as PlantPrice[]) : []
    return patchDefaultTreeSpecFlags(seedIfMissing(stored))
  } catch {
    return patchDefaultTreeSpecFlags(seedIfMissing([]))
  }
}

export function savePlantPrices(prices: PlantPrice[]): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prices))
    return true
  } catch {
    return false
  }
}

/** 依植物名稱＋規格找單價（規格不同視為不同項目，找不到規格相符的就退而求其次比對名稱）。
 *  名稱比對用 normalizeForCompare（全半形/空白/不可見字元統一），避免因為單純的寫法
 *  差異（例如複製貼上帶了不可見字元）就誤判為查無價格。
 *  注意：這是舊版簡化比對（單一結果），保留給還沒改用 resolvePlantPrice 的地方使用；
 *  正式估價流程請用下面的 resolvePlantPrice，才有規格比對與「規格不明確」的保護。 */
export function findPlantPrice(prices: PlantPrice[], plantName: string, specification?: string): PlantPrice | undefined {
  const nameKey = normalizeForCompare(plantName)
  const bySpec = prices.find(p => normalizeForCompare(p.plantName) === nameKey && (p.specification ?? '') === (specification ?? ''))
  if (bySpec) return bySpec
  return prices.find(p => normalizeForCompare(p.plantName) === nameKey)
}

export type PriceBasis = 'auto' | 'gov' | 'market' | 'manual'

export interface ResolvePriceResult {
  status: 'priced' | 'missing_price' | 'ambiguous_spec'
  selected?: PlantPrice
  matchKind: PriceMatchKind
  candidateNote?: string
  /** 找到的所有候選價格（同名或候選對應命中，同規格已依優先序去重只留一筆）——
   *  status 為 ambiguous_spec 時，UI 用這個清單讓使用者手動挑選要採用哪一筆規格。 */
  candidates: PlantPrice[]
}

function specsRoughlyMatch(priceSpec: string | undefined, dxfSpec: string | undefined): boolean {
  if (!priceSpec || !dxfSpec) return false
  const a = normalizeForCompare(priceSpec)
  const b = normalizeForCompare(dxfSpec)
  if (!a || !b) return false
  if (a.includes(b) || b.includes(a)) return true
  // 規格常見寫法差異（「米徑15cm」vs「米徑約15cm」）：兩邊都抓得到的數字有重疊就視為相符，
  // 只做「數字比對」，不做任何沒有依據的推測（例如不會把 15cm 當成「接近」14cm 而誤判相符）。
  const numsA: string[] = a.match(/\d+(?:\.\d+)?/g) ?? []
  const numsB: string[] = b.match(/\d+(?:\.\d+)?/g) ?? []
  return numsA.length > 0 && numsB.length > 0 && numsA.some(n => numsB.includes(n))
}

// ── 價格來源優先序：人工自訂 > 112年工程會 > 110年工程會 > ... > 田尾/市場參考價。
// 集中在這一個函式，UI／estimateAdapter 都呼叫這裡，不要各自散落判斷。
// 數字越小優先序越高：manual 固定 0（絕對最優先）；gov 依年度給 1000 區間內的分數
// （年度越新分數越小、越優先，但不管年度多小都不會小於 0，不會超過人工自訂）；
// market 固定一個遠大於任何 gov 分數的數字，保證一定排在所有工程會資料之後。
function sourceRank(p: PlantPrice): number {
  if (p.sourceType === 'manual') return 0
  if (p.sourceType === 'gov') return 1000 - (p.sourceYear ?? 0)   // 112 → 888；110 → 890（112 排在 110 前面）
  return 100000   // market，一定排在人工自訂／任何年度工程會之後
}

/** 統一的價格來源優先序選擇函式：同一組候選裡挑出應該採用的那一筆
 *  （人工自訂 > 新年度工程會 > 舊年度工程會 > 市場價）。不要在 UI component 裡各自判斷。 */
export function selectPreferredPlantPrice(candidates: PlantPrice[]): PlantPrice | undefined {
  if (candidates.length === 0) return undefined
  return [...candidates].sort((a, b) => sourceRank(a) - sourceRank(b))[0]
}

/** 同一植物、同一規格如果有多個來源（例如工程會＋田尾都有），依優先序只留一筆——
 *  被淘汰的來源完全不進入候選清單，畫面上不會多方並列顯示（見規格四、五）。
 *  不同規格則各自保留（見規格六）。 */
function dedupeBySpecKeepPreferred(pool: PlantPrice[]): PlantPrice[] {
  const groups = new Map<string, PlantPrice[]>()
  for (const p of pool) {
    const key = normalizeForCompare(p.specification ?? '')
    const arr = groups.get(key) ?? []
    arr.push(p)
    groups.set(key, arr)
  }
  return [...groups.values()].map(group => selectPreferredPlantPrice(group)!)
}

/**
 * 依「植物名稱＋圖面規格＋價格規格」解析出應採用的單價（見規格二～八）。
 * 絕不會在規格不明確時自動選一筆冒充正確價格——找不到相符規格且候選不只一筆時，
 * 回傳 status='ambiguous_spec'，交給使用者人工挑選或自訂單價。
 * 同一植物、同一規格若有多來源，只回傳依優先序選出的唯一一筆，不會多方並列。
 */
export function resolvePlantPrice(
  prices: PlantPrice[],
  plantName: string,
  dxfSpec: string | undefined,
  priceBasis: PriceBasis = 'auto',
): ResolvePriceResult {
  // 硬別名（規格七）：確定同一種植物、不需要人工確認，直接正規化成資料庫標準名稱再比對。
  const hardAliasedName = normalizeHardAliasPlantName(plantName)
  const nameKey = normalizeForCompare(hardAliasedName)
  let candidates = prices.filter(p => normalizeForCompare(p.plantName) === nameKey)
  let nameCandidateNote: string | undefined

  if (candidates.length === 0) {
    // 完全同名（含硬別名）都找不到價格：嘗試估價專用的候選商品名稱對應表（見規格八，
    // 例如越橘葉蔓榕→越橘蔓榕）。這不是正式的植物別名，只是價格比對的候選嘗試，
    // 命中時仍要標示「候選對應」。
    for (const cand of findPriceNameCandidates(hardAliasedName)) {
      const key = normalizeForCompare(cand.candidateName)
      const found = prices.filter(p => normalizeForCompare(p.plantName) === key)
      if (found.length > 0) { candidates = found; nameCandidateNote = cand.note; break }
    }
  }

  if (candidates.length === 0) {
    return { status: 'missing_price', matchKind: 'none', candidates: [] }
  }

  const basisFiltered = priceBasis === 'auto' ? candidates : candidates.filter(p => p.sourceType === priceBasis)
  if (basisFiltered.length === 0) {
    return { status: 'missing_price', matchKind: 'none', candidates: [] }
  }

  // 同規格多來源先去重，只留依優先序選出的一筆——工程會跟田尾同規格不會同時出現（規格四）。
  const pool = dedupeBySpecKeepPreferred(basisFiltered)
  const isNameCandidate = nameCandidateNote !== undefined

  // 使用者曾在「規格不明確」清單手動指定過採用哪一筆（sourceType='manual'）：只要
  // 恰好有一筆人工指定紀錄，就是明確的使用者決定，優先採用，不需要再比對圖面規格
  // ——否則沒有圖面規格資訊時，手動選擇會因為又落回「多筆候選」而失效。
  // 有兩筆以上人工紀錄時代表選擇本身也不明確，才繼續往下走一般比對流程。
  const manualPicks = pool.filter(p => p.sourceType === 'manual')
  if (manualPicks.length === 1 && (priceBasis === 'auto' || priceBasis === 'manual')) {
    const selected = manualPicks[0]
    return { status: 'priced', selected, matchKind: 'exact_spec', candidateNote: selected.candidateNote ?? nameCandidateNote, candidates: pool }
  }

  // Priority 1：植物名稱相符 ＋ 規格最接近
  if (dxfSpec) {
    const specMatches = pool.filter(p => specsRoughlyMatch(p.specification, dxfSpec))
    if (specMatches.length > 0) {
      const selected = selectPreferredPlantPrice(specMatches)!
      return {
        status: 'priced',
        selected,
        matchKind: isNameCandidate ? 'name_candidate' : 'exact_spec',
        candidateNote: selected.candidateNote ?? nameCandidateNote,
        candidates: pool,
      }
    }
  }

  // Priority 1b：找不到跟圖面規格相符的候選、但同一植物有多筆不同規格候選時，
  // 若其中「恰好一筆」被標記為系統預設規格（isDefaultTreeSpec——使用者第一次匯入
  // 工程會喬木價格時明確指定的 14-15cm 米徑級距，見 estimatePriceSeedGov112.ts），
  // 採用它並清楚標註「規格待覆核」，而不是直接卡在「規格不明確」讓價格整個消失
  // （見「茄苳價格匹配問題」修正：茄苳同時有 270-300cm＝2107 元跟 450-500cm/14-16cm
  // 米徑＝6558 元兩筆，圖面沒有規格資訊時，兩者都不比對相符會落入 Priority 3，
  // 導致原本已存在的 6558 元反而抓不到）。有多筆都帶標記（理論上不會發生）仍視為不明確。
  if (pool.length > 1) {
    const defaultSpecMatches = pool.filter(p => p.isDefaultTreeSpec)
    if (defaultSpecMatches.length === 1) {
      const selected = defaultSpecMatches[0]
      const reviewNote = dxfSpec
        ? `規格待覆核：圖面規格「${dxfSpec}」與此價格規格不同，因缺乏更相符的候選，暫採系統預設的14-15cm米徑標準規格。`
        : '規格待覆核：圖面未提供規格資訊，暫採系統預設的14-15cm米徑標準規格，如有不同規格請人工覆核或於「單價設定」指定。'
      return {
        status: 'priced',
        selected,
        matchKind: isNameCandidate ? 'name_candidate' : 'single_candidate',
        candidateNote: selected.candidateNote ?? reviewNote,
        candidates: pool,
      }
    }
  }

  // Priority 2：植物名稱相符但找不到相符規格——只有「唯一」候選時才能自動採用，
  // 並標示為市場參考規格；有多筆不同規格的候選一律不自動選（見規格七）。
  if (pool.length === 1) {
    const selected = pool[0]
    return {
      status: 'priced',
      selected,
      matchKind: isNameCandidate ? 'name_candidate' : 'single_candidate',
      candidateNote: selected.candidateNote ?? nameCandidateNote,
      candidates: pool,
    }
  }

  // Priority 3：有多筆不同規格候選、且沒有一筆跟圖面規格相符——規格不明確，
  // 不自動套價，禁止跨規格計價（見規格七）。
  return { status: 'ambiguous_spec', matchKind: 'ambiguous', candidateNote: nameCandidateNote, candidates: pool }
}

/** 新增或更新一筆單價（依 id 比對，沒有就新增） */
export function upsertPlantPrice(prices: PlantPrice[], price: PlantPrice): PlantPrice[] {
  const idx = prices.findIndex(p => p.id === price.id)
  const withTimestamp = { ...price, updatedAt: new Date().toISOString() }
  if (idx === -1) return [...prices, withTimestamp]
  const next = [...prices]
  next[idx] = withTimestamp
  return next
}

export function deletePlantPrice(prices: PlantPrice[], id: string): PlantPrice[] {
  return prices.filter(p => p.id !== id)
}
