// ── plantNameMatch.ts — 植物名稱正規化與本地資料庫比對 ────────────────────────
// 用途：在觸發「自動搜尋官方資料」之前，先確認本地資料庫是否已有這個植物
// （只是名稱寫法不同、全半形不同、或用了別名）。避免因為單純的文字差異
// 就誤判「資料庫查無」而觸發不必要的搜尋。

import type { CsvPlantRecord } from '@/types/csvPlant'
import type { PlantMatchCandidate, SimilarPlantCandidate } from '@/types/plantSearch'

// ── 常見別名對照表 ────────────────────────────────────────────────────────────
// 索引表 / 圖面常用簡稱、俗名 ↔ 資料庫慣用正式名稱。
// 可持續擴充；左側可為多個別名對一個正式名稱。
const ALIAS_GROUPS: string[][] = [
  ['蔓花生', '花生藤', '長花生藤'],
  ['沿階草', '麥門冬', '沿階草(麥門冬)'],
  ['台北草', '台北狗牙根', '假儉草(台北草)'],
  ['榕樹', '正榕', '大葉榕'],
  ['羅漢松', '羅漢柏'],
  ['桂花', '木樨'],
  ['金葉女貞', '金葉女貞木'],
  ['腎蕨', '玉蘭蕨', '波士頓蕨'],
  ['蝦蟆草', '蟛蜞菊', '南美蟛蜞菊'],
  ['細葉雪茄花', '雪茄花'],
  ['今葉石菖蒲', '金葉石菖蒲', '石菖蒲'],
  ['胡椒木', '花椒木'],
  ['紅花玉芙蓉', '玉芙蓉'],
  ['茄苳', '重陽木'],
  ['櫸木', '雞油'],
  ['九芎', '猴不爬'],
  ['辛夷', '玉蘭花', '白玉蘭'],
  ['緬梔', '雞蛋花'],
  ['白水木', '水芫花'],
  ['青楓', '楓香(青楓)'],
]

/** 建立「任一寫法 → 正式代表名稱」的查表（代表名取該組第一個） */
function buildAliasMap(): Map<string, string> {
  const m = new Map<string, string>()
  for (const group of ALIAS_GROUPS) {
    const canonical = group[0]
    for (const alt of group) m.set(normalizeForCompare(alt), canonical)
  }
  return m
}
const ALIAS_MAP = buildAliasMap()

/** 建立「正規化寫法 → 該別名組完整清單」的查表，供需要「所有同義寫法」的場景使用
 *（resolveAlias 只回傳代表名，無法反查同組其他別名，例如由「今葉石菖蒲」查不到「石菖蒲」）*/
function buildAliasGroupMap(): Map<string, string[]> {
  const m = new Map<string, string[]>()
  for (const group of ALIAS_GROUPS) {
    for (const alt of group) m.set(normalizeForCompare(alt), group)
  }
  return m
}
const ALIAS_GROUP_MAP = buildAliasGroupMap()

/** 回傳 name 所屬別名組的完整清單（含 name 本身）；查無別名組則回傳 [name] */
export function getAliasGroup(name: string): string[] {
  return ALIAS_GROUP_MAP.get(normalizeForCompare(name)) ?? [name]
}

// ── 全形/半形統一 + 去空白 ────────────────────────────────────────────────────
function toHalfWidth(s: string): string {
  return s.replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
          .replace(/\u3000/g, ' ')   // 全形空白
}

// 常見異體字統一（僅限比對用途，不影響原始資料顯示）：
// 「臺」為「台」的傳統寫法，索引表/CSV/使用者輸入常混用，例如「臺北草」應視為「台北草」。
function unifyVariantChars(s: string): string {
  return s.replace(/臺/g, '台')
}

// 常見不可見字元（零寬空白、位元組順序記號等）：CSV / 索引表文字複製貼上時常見的雜訊，
// 比對前先移除，避免「看起來一樣」卻因為藏了不可見字元而判定為不同植物。
const INVISIBLE_CHARS_RE = /[​-‏⁠﻿­]/g

/** 供比對用的正規化：去除不可見字元、換行、所有空白、全形轉半形、統一為小寫（英數部分）*/
export function normalizeForCompare(raw: string): string {
  return unifyVariantChars(toHalfWidth(raw))
    .replace(INVISIBLE_CHARS_RE, '')
    .replace(/[\s\u00A0]+/g, '')
    .replace(/[（）]/g, m => (m === '（' ? '(' : ')'))
    .toLowerCase()
    .trim()
}

/** 學名正規化：統一空白為單一半形空格、去除命名者縮寫括號等雜訊，僅比對屬種二名 */
export function normalizeScientificName(raw: string): string {
  const half = toHalfWidth(raw).trim()
  // 只取前兩個字詞（屬名 + 種小名），忽略命名者、變種等後綴
  const parts = half.replace(/[.,].*$/, '').split(/\s+/).filter(Boolean)
  return parts.slice(0, 2).join(' ').toLowerCase()
}

/** 別名正規化：查表得到代表名稱；查無則回傳正規化後的原字串 */
export function resolveAlias(raw: string): string {
  const key = normalizeForCompare(raw)
  return ALIAS_MAP.get(key) ?? raw
}

/**
 * 在本地資料庫中尋找符合的植物記錄。
 * 依序嘗試：
 *   1. 中文名稱完全比對（正規化後）
 *   2. 別名比對（查表後再比對正規化中文名）
 *   3. 學名比對（正規化後）
 *   4. 中文名 / 學名交叉比對（查詢名稱可能誤填成學名欄位，或反之）
 * 回傳依信心排序的候選清單（可能為空）。
 */
export function findLocalPlantMatch(
  queryName: string,
  plants: CsvPlantRecord[],
  scientificNameHint?: string,
): PlantMatchCandidate[] {
  const candidates: PlantMatchCandidate[] = []
  const qNorm = normalizeForCompare(queryName)
  const qAlias = normalizeForCompare(resolveAlias(queryName))
  const qSci = scientificNameHint ? normalizeScientificName(scientificNameHint) : ''

  for (const p of plants) {
    const pNameNorm = normalizeForCompare(p.name)
    const pSciNorm = p.scientificName ? normalizeScientificName(p.scientificName) : ''

    // 1. 完全比對
    if (pNameNorm === qNorm) {
      candidates.push({ plant: p, matchType: 'exact_name', score: 100 })
      continue
    }
    // 2. 別名比對
    if (qAlias !== qNorm && pNameNorm === qAlias) {
      candidates.push({ plant: p, matchType: 'alias', score: 95 })
      continue
    }
    // 也檢查資料庫端名稱是否為查詢名稱的別名（雙向）
    if (normalizeForCompare(resolveAlias(p.name)) === qNorm) {
      candidates.push({ plant: p, matchType: 'alias', score: 95 })
      continue
    }
    // 3. 學名比對
    if (qSci && pSciNorm && pSciNorm === qSci) {
      candidates.push({ plant: p, matchType: 'exact_scientific', score: 90 })
      continue
    }
    // 4. 交叉比對：查詢名稱其實是學名，或資料庫學名欄位其實填了中文名
    if (pSciNorm && normalizeScientificName(queryName) === pSciNorm) {
      candidates.push({ plant: p, matchType: 'cross_reference', score: 80 })
      continue
    }
    if (scientificNameHint && normalizeForCompare(scientificNameHint) === pNameNorm) {
      candidates.push({ plant: p, matchType: 'cross_reference', score: 80 })
      continue
    }
  }

  return candidates.sort((a, b) => b.score - a.score)
}

/**
 * 嚴格版存在判斷：只認「完全相同的中文名稱」或「完全相同的學名」，
 * 不使用別名表、不使用交叉比對。
 *
 * 用途：決定「要不要顯示自動搜尋按鈕」。別名表是我方自行整理、未逐一跟使用者
 * 確認學名是否真的相同，若拿別名表來判定「已有資料」，會跟「植栽資料庫」頁面
 * 的純文字搜尋（找不到別名對應的另一個名稱）產生矛盾 —— 系統顯示已比對，但
 * 使用者直接搜尋卻查無此植物。改用嚴格比對後，兩邊的判斷依據一致。
 */
export function existsExactInLocalDatabase(
  queryName: string,
  plants: CsvPlantRecord[],
  scientificNameHint?: string,
): boolean {
  const qNorm = normalizeForCompare(queryName)
  const qSci = scientificNameHint ? normalizeScientificName(scientificNameHint) : ''
  return plants.some(p => {
    if (normalizeForCompare(p.name) === qNorm) return true
    if (qSci && p.scientificName && normalizeScientificName(p.scientificName) === qSci) return true
    return false
  })
}

/** 便利函式：只要「是否已有可用資料」的布林結果 */
export function existsInLocalDatabase(
  queryName: string,
  plants: CsvPlantRecord[],
  scientificNameHint?: string,
): boolean {
  return findLocalPlantMatch(queryName, plants, scientificNameHint).length > 0
}

// ── 相近植物搜尋（供「相近植物替代測試」人工確認流程使用）─────────────────────
// 用途：本地資料庫找不到完全相符植物時，找出名稱最相近的候選——僅供使用者
// 參考、人工確認是否要暫代評估，程式本身不得自動判定為同一植物。

/** Levenshtein 編輯距離 */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length; const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i)
  for (let i = 1; i <= m; i++) {
    let prevDiag = dp[0]
    dp[0] = i
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]
      dp[j] = a[i - 1] === b[j - 1] ? prevDiag : 1 + Math.min(prevDiag, dp[j], dp[j - 1])
      prevDiag = tmp
    }
  }
  return dp[n]
}

/** 名稱相似度 0~100（正規化後比對；100 = 完全相同，0 = 完全不同）*/
function nameSimilarityScore(a: string, b: string): number {
  const na = normalizeForCompare(a); const nb = normalizeForCompare(b)
  if (!na || !nb) return 0
  if (na === nb) return 100
  const maxLen = Math.max(na.length, nb.length)
  if (maxLen === 0) return 0
  const dist = levenshteinDistance(na, nb)
  return Math.round((1 - dist / maxLen) * 100)
}

/** 取學名屬名（scientificName 的第一個字詞）*/
function genusOf(scientificName: string | undefined): string | null {
  if (!scientificName) return null
  const parts = scientificName.trim().split(/\s+/).filter(Boolean)
  return parts[0] || null
}

/**
 * 找出資料庫中名稱最相近的候選植物，供「相近植物替代測試」人工確認流程使用。
 * 只回傳「名稱相近但不完全相同」的候選（完全相同的名稱應該已由 findLocalPlantMatch
 * 命中，不會走到這裡）；依相似度由高到低排序，最多回傳 topN 筆。
 */
export function findSimilarPlants(
  queryName: string,
  plants: CsvPlantRecord[],
  scientificNameHint?: string,
  topN = 3,
): SimilarPlantCandidate[] {
  const queryGenus = genusOf(scientificNameHint)
  return plants
    .map((plant): SimilarPlantCandidate => {
      const nameSimilarity = nameSimilarityScore(queryName, plant.name)
      const candidateGenus = genusOf(plant.scientificName)
      const sameGenus = queryGenus && candidateGenus
        ? normalizeScientificName(queryGenus) === normalizeScientificName(candidateGenus)
        : null
      return { plant, nameSimilarity, genus: candidateGenus, sameGenus }
    })
    .filter(c => c.nameSimilarity > 0 && c.nameSimilarity < 100)
    .sort((a, b) => b.nameSimilarity - a.nameSimilarity)
    .slice(0, topN)
}
