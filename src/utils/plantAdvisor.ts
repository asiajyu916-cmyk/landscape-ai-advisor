// ── AI 配植助理：規則引擎 + 可插拔 AI 後端接口 ────────────────────────────────
//
// 目前使用規則引擎（依植栽資料庫欄位即時運算）。
// 未來升級：實作 callClaudeApi / callOpenAiApi 並在 getAdvisorReply 切換即可，
// UI 與資料結構完全不需改動。

import type { CsvPlantRecord } from '@/types/csvPlant'
import { waterScore, sunConflictLevel, drainageConflictLevel } from '@/utils/csvParser'

// ── 回覆結構（規則引擎與未來 AI 後端共用）─────────────────────────────────────
export interface AdvisorReply {
  verdict: string                                        // 配置判斷
  goodPairs: Array<{ name: string; reason: string }>     // 適合搭配
  badPairs: Array<{ name: string; reason: string }>      // 不建議搭配
  risks: string[]                                        // 可能風險
  fixes: string[]                                        // 修正建議／配置建議
  alternatives: Array<{ original: string; alt: string; reason: string }>  // 單植物替代
  score?: number                                         // 配置評分（如適用）
  disclaimer?: string                                    // 資料庫缺植物提示
  // ── 配植顧問模式（分類搭配 + 完整方案）─────────────────────────────────
  pairCategories?: Array<{ label: string; picks: Array<{
    name: string; reason: string
    // condition_search 結構化欄位（卡片式排版用）
    why?: string; use?: string; caution?: string; fromFallback?: boolean
  }> }>
  plans?: Array<{ title: string; lines: string[] }>      // 完整搭配方案（方案A/B）
  // ── condition_search 卡片式排版用 ───────────────────────────────────────
  kind?: 'condition_search'
  queryCondition?: string                                // 查詢條件標題（如「耐旱植物」）
}

export interface AdvisorContext {
  db: CsvPlantRecord[]
  zones?: Array<{ zoneName: string; shrubs: string[]; trees: string[] }>
}

// ── 後端模式（預留 API 串接）──────────────────────────────────────────────────
export type AdvisorBackend = 'rule' | 'claude' | 'openai'
const ACTIVE_BACKEND: AdvisorBackend = 'rule'

export async function getAdvisorReply(question: string, ctx: AdvisorContext): Promise<AdvisorReply> {
  switch (ACTIVE_BACKEND) {
    // 預留：case 'claude': return callClaudeApi(question, ctx)   // POST /api/advisor
    // 預留：case 'openai': return callOpenAiApi(question, ctx)
    default: return ruleAnswer(question, ctx)
  }
}

// ── 工具 ─────────────────────────────────────────────────────────────────────

function findPlant(name: string, db: CsvPlantRecord[]): CsvPlantRecord | undefined {
  const n = name.trim()
  return db.find(p => p.name === n)
    ?? db.find(p => p.name.replace(/\s/g, '') === n.replace(/\s/g, ''))
    ?? db.find(p => n.length >= 2 && (p.name.includes(n) || n.includes(p.name)))
}

/** 從問題文字抓出資料庫內的植物名稱（長名優先，避免「杜鵑」吃掉「平戶杜鵑」）*/
function extractPlants(text: string, db: CsvPlantRecord[]): { found: CsvPlantRecord[]; unknown: string[] } {
  const found: CsvPlantRecord[] = []
  let rest = text
  const sorted = [...db].sort((a, b) => b.name.length - a.name.length)
  for (const p of sorted) {
    if (p.name.length >= 2 && rest.includes(p.name)) {
      found.push(p)
      rest = rest.split(p.name).join('※')
    }
  }
  // 疑似植物但不在 DB：抓「XX木」「XX花」「XX草」「XX樹」「XX藤」等常見尾字組合
  const unknown: string[] = []
  const m = rest.match(/[一-鿿]{1,6}(木|花|草|樹|藤|蕨|竹|松|柏|楓|櫻|杜鵑)/g) ?? []
  for (const u of m) {
    if (u.length >= 2 && !found.some(f => f.name.includes(u) || u.includes(f.name)) &&
        !/喬木|灌木|草皮|地被|樹下|花色|花期|草本|路樹/.test(u)) {
      unknown.push(u)
    }
  }
  return { found, unknown: [...new Set(unknown)] }
}

const sunLabel = (p: CsvPlantRecord) => p.sunRequirement !== '待查' ? p.sunRequirement : null
const waterLabel = (p: CsvPlantRecord) => p.waterRequirement !== '待查' ? p.waterRequirement : null

/** 兩植物是否日照/水分相容（用於推薦搭配）*/
function isCompatible(a: CsvPlantRecord, b: CsvPlantRecord): { ok: boolean; reason?: string } {
  if (sunConflictLevel([a.sunRequirement, b.sunRequirement]) === 'severe')
    return { ok: false, reason: `日照需求衝突（${a.sunRequirement} vs ${b.sunRequirement}）` }
  const wa = waterScore(a.waterRequirement); const wb = waterScore(b.waterRequirement)
  if (Math.abs(wa - wb) >= 1.5)
    return { ok: false, reason: `水分需求差距大（${a.waterRequirement} vs ${b.waterRequirement}）` }
  // 只有「耐濕 vs 不耐積水」視為衝突；稍耐濕與不耐積水可透過排水設計共存
  const wets = [a.wetTolerance, b.wetTolerance]
  if (wets.includes('耐濕') && wets.includes('不耐積水'))
    return { ok: false, reason: '排水需求衝突（耐濕與不耐積水混植）' }
  return { ok: true }
}

/** 找同類替代植物（同大類，日照/水分接近，優先低維護）*/
function findAlternatives(target: CsvPlantRecord, db: CsvPlantRecord[], count = 3): Array<{ alt: string; reason: string }> {
  return db
    .filter(p => p.name !== target.name && p.normalizedCategory === target.normalizedCategory)
    .map(p => {
      let score = 0
      if (p.subCategory === target.subCategory) score += 3
      if (sunConflictLevel([p.sunRequirement, target.sunRequirement]) === 'none') score += 2
      const wp = waterScore(p.waterRequirement); const wt = waterScore(target.waterRequirement)
      if (Math.abs(wp - wt) <= 0.5) score += 2
      if (p.maintenanceLevel === '低') score += 1
      if (p.nativeStatus.includes('原生')) score += 1
      return { p, score }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .map(({ p }) => ({
      alt: p.name,
      reason: [
        p.subCategory || p.category,
        p.sunRequirement !== '待查' ? `日照${p.sunRequirement}` : null,
        p.maintenanceLevel === '低' ? '低維護' : null,
        p.nativeStatus.includes('原生') ? '台灣原生' : null,
      ].filter(Boolean).join('・'),
    }))
}

/** 依條件推薦植物 */
function recommend(db: CsvPlantRecord[], filter: (p: CsvPlantRecord) => boolean, count = 5): CsvPlantRecord[] {
  return db.filter(filter)
    .sort((a, b) => {
      const am = a.maintenanceLevel === '低' ? 1 : 0
      const bm = b.maintenanceLevel === '低' ? 1 : 0
      const an = a.nativeStatus.includes('原生') ? 1 : 0
      const bn = b.nativeStatus.includes('原生') ? 1 : 0
      return (bm + bn) - (am + an)
    })
    .slice(0, count)
}

// ── 內建預設植栽清單（資料庫不足時補足，台灣常用景觀植物）───────────────────
const FALLBACK_PLANTS: Record<'tree' | 'shrub' | 'groundcover' | 'lawn', Array<{ name: string; reason: string; traits: string[] }>> = {
  tree: [
    { name: '台灣欒樹', reason: '台灣原生・秋季金黃季相，與春花喬木錯開觀賞期', traits: ['drought', 'fullsun', 'native', 'lowmaint', 'showy'] },
    { name: '樟樹',     reason: '常綠遮蔭穩定，作背景襯托開花喬木',             traits: ['drought', 'fullsun', 'native', 'lowmaint', 'evergreen'] },
    { name: '光蠟樹',   reason: '台灣原生・誘蝶誘蟲，枝葉細緻不搶主景',         traits: ['fullsun', 'native', 'lowmaint', 'evergreen'] },
    { name: '楓香',     reason: '原生大喬木，秋色葉與春花形成雙季相',           traits: ['fullsun', 'native', 'showy'] },
    { name: '大葉欖仁', reason: '層狀樹形，秋冬紅葉季相',                       traits: ['drought', 'fullsun'] },
  ],
  shrub: [
    { name: '樹蘭',       reason: '常綠耐修剪，香花型收邊灌木',       traits: ['drought', 'fullsun', 'lowmaint', 'evergreen'] },
    { name: '春不老',     reason: '低維護常綠，新葉紅色具景深層次',   traits: ['drought', 'shade', 'lowmaint', 'evergreen', 'native'] },
    { name: '厚葉石斑木', reason: '耐旱耐風，白花系穩定型灌木',       traits: ['drought', 'fullsun', 'lowmaint', 'evergreen', 'native', 'showy'] },
    { name: '矮仙丹',     reason: '全年開花紅橙色系，入口亮點首選',   traits: ['drought', 'fullsun', 'evergreen', 'showy'] },
    { name: '七里香',     reason: '香花綠籬，耐修剪塑形',             traits: ['drought', 'fullsun', 'lowmaint', 'evergreen', 'native', 'showy'] },
    { name: '雪茄花',     reason: '紫紅色小花密集，低矮前景收邊',     traits: ['fullsun', 'evergreen', 'showy', 'wet'] },
  ],
  groundcover: [
    { name: '沿階草',   reason: '極耐陰，樹下地被首選',               traits: ['shade', 'lowmaint', 'evergreen', 'drought'] },
    { name: '麥門冬',   reason: '耐陰耐旱，樹蔭至半日照皆穩定',       traits: ['shade', 'lowmaint', 'evergreen', 'drought', 'native'] },
    { name: '蔓花生',   reason: '黃花地毯狀覆蓋，抑制雜草',           traits: ['drought', 'fullsun', 'lowmaint', 'evergreen', 'showy'] },
    { name: '蚌蘭',     reason: '紫背葉色，色彩對比前景',             traits: ['drought', 'shade', 'lowmaint', 'evergreen'] },
    { name: '翠蘆莉',   reason: '紫花耐旱，日照充足處大面積覆蓋',     traits: ['drought', 'fullsun', 'lowmaint', 'evergreen', 'showy', 'wet'] },
    { name: '腎蕨',     reason: '耐陰耐濕，樹下與北向牆邊適用',       traits: ['shade', 'wet', 'lowmaint', 'evergreen', 'native'] },
  ],
  lawn: [
    { name: '台北草',   reason: '質地細緻，開放草坪主流選擇（需水較高）', traits: ['fullsun', 'evergreen'] },
    { name: '假儉草',   reason: '低維護耐踐踏，粗放管理首選',             traits: ['drought', 'fullsun', 'lowmaint', 'evergreen'] },
    { name: '百慕達草', reason: '耐旱恢復力強，全日照開放區適用',         traits: ['drought', 'fullsun', 'evergreen'] },
    { name: '地毯草',   reason: '稍耐陰稍耐旱草皮，半日照區可用',         traits: ['shade', 'lowmaint', 'evergreen', 'drought'] },
  ],
}

/** DB 撈同類相容植物，不足時用內建清單補到 minCount */
function pickCategory(
  subject: CsvPlantRecord | null,
  db: CsvPlantRecord[],
  cat: 'tree' | 'shrub' | 'groundcover' | 'lawn',
  minCount = 3,
): Array<{ name: string; reason: string; fromDB: boolean }> {
  const isLawn = (p: CsvPlantRecord) =>
    /草皮|草坪/.test(p.subCategory + p.category) || ['台北草', '假儉草', '百慕達草', '地毯草', '奧古斯丁草'].some(n => p.name.includes(n))
  const catFilter = (p: CsvPlantRecord) =>
    cat === 'lawn' ? isLawn(p) : (p.normalizedCategory === cat && !isLawn(p))

  const picks: Array<{ name: string; reason: string; fromDB: boolean }> = []
  const dbPicks = db
    .filter(p => catFilter(p) && (!subject || p.name !== subject.name))
    .filter(p => !subject || isCompatible(subject, p).ok)
    .sort((a, b) => {
      const sc = (p: CsvPlantRecord) =>
        (p.maintenanceLevel === '低' ? 2 : 0) + (p.nativeStatus.includes('原生') ? 1 : 0) + (p.flowerColor ? 1 : 0)
      return sc(b) - sc(a)
    })
  for (const p of dbPicks.slice(0, minCount + 1)) {
    picks.push({
      name: p.name,
      reason: [
        p.sunRequirement !== '待查' ? `日照${p.sunRequirement}` : null,
        p.waterRequirement !== '待查' ? `需水${p.waterRequirement}` : null,
        p.maintenanceLevel === '低' ? '低維護' : null,
        p.flowerColor ? `${p.flowerColor}花${p.flowerMonth ? `(${p.flowerMonth}月)` : ''}` : null,
        p.nativeStatus.includes('原生') ? '原生' : null,
      ].filter(Boolean).join('・') || (p.subCategory || p.category),
      fromDB: true,
    })
  }
  // 內建清單補足
  for (const f of FALLBACK_PLANTS[cat]) {
    if (picks.length >= minCount) break
    if (picks.some(x => x.name === f.name)) continue
    if (subject && f.name === subject.name) continue
    picks.push({ name: f.name, reason: f.reason + '（通用配植原則）', fromDB: false })
  }
  return picks.slice(0, Math.max(minCount, 3))
}

/** 配植顧問模式：針對單一主題植物輸出完整搭配建議 */
function buildPairingReply(subject: CsvPlantRecord, db: CsvPlantRecord[], disclaimer?: string): AdvisorReply {
  const isTree = subject.normalizedCategory === 'tree'
  const hasFlower = !!subject.flowerColor
  const deciduous = /落葉/.test(subject.category + subject.subCategory + subject.treeForm + subject.maintenanceNote)

  // 1. 配植判斷
  const roles: string[] = []
  if (isTree) {
    if (hasFlower) roles.push(`${subject.flowerMonth ? subject.flowerMonth + '月' : ''}${subject.flowerColor}花主景喬木、入口迎賓、道路列植`)
    else roles.push('綠蔭背景喬木、緩衝帶列植')
    if (subject.droughtTolerance === '耐旱') roles.push('低澆灌區位適用')
  } else {
    roles.push(hasFlower ? '開花灌木／前景亮點' : '結構性收邊植栽')
  }
  const verdict = `${subject.name}（${subject.subCategory || subject.category}｜日照${subject.sunRequirement}｜需水${subject.waterRequirement}｜維護${subject.maintenanceLevel}）——適合作為：${roles.join('；')}。`

  // 2. 分類搭配
  const trees  = pickCategory(subject, db, 'tree', 3)
  const shrubs = pickCategory(subject, db, 'shrub', 3)
  const gcs    = pickCategory(subject, db, 'groundcover', 3)
  const lawns  = pickCategory(subject, db, 'lawn', 3)
  const pairCategories = [
    ...(isTree ? [{ label: '可搭配喬木（列植間植/背景）', picks: trees }] : [{ label: '可搭配喬木（上層）', picks: trees }]),
    { label: '可搭配灌木', picks: shrubs },
    { label: '可搭配地被', picks: gcs },
    { label: '可搭配草皮', picks: lawns },
  ]

  // 3. 不建議搭配
  const badPairs: AdvisorReply['badPairs'] = []
  const dbConflicts = db.filter(p => p.name !== subject.name && !isCompatible(subject, p).ok).slice(0, 3)
  for (const p of dbConflicts) badPairs.push({ name: p.name, reason: isCompatible(subject, p).reason! })
  if (isTree) {
    badPairs.push({ name: '全日照草皮（樹冠正下方）', reason: '成樹後樹蔭致草皮退化稀疏' })
    if (subject.waterRequirement === '低' || subject.droughtTolerance === '耐旱')
      badPairs.push({ name: '高需水草花（同澆灌迴路）', reason: '澆灌需求不同，同迴路必有一方受害' })
  }
  const highM = db.filter(p => p.maintenanceLevel === '高').slice(0, 1)
  for (const p of highM) if (!badPairs.some(b => b.name === p.name)) badPairs.push({ name: p.name, reason: '維護量高，與低維護組合目標不符' })

  // 4. 配置建議（可直接改圖）
  const gcNames = gcs.slice(0, 2).map(g => g.name).join('或')
  const lawnNames = lawns.slice(0, 2).map(l => l.name).join('或')
  const shrubNames = shrubs.slice(0, 2).map(s => s.name).join('、')
  const fixes = isTree ? [
    `${subject.name}作為${hasFlower ? '列植主景（株距 6–8m）' : '背景列植（株距 5–6m）'}。`,
    `樹下 1.5m 範圍內避免草皮，改用${gcNames}。`,
    `外圈開放區用${lawnNames}作為草坪。`,
    `前景以${shrubNames}低矮收邊（高度 40–80cm），界定動線。`,
  ] : [
    `${subject.name}以群植 3–5 株為單元，配置於${hasFlower ? '視線焦點處' : '邊界收邊帶'}。`,
    `下層鋪${gcNames}銜接地面。`,
    `後方可立喬木層（${trees.slice(0, 2).map(t => t.name).join('、')}）形成背景。`,
  ]

  // 5. 完整方案 ×2
  const dedupe = (arr: typeof shrubs) => arr.filter((x, i) => arr.findIndex(y => y.name === x.name) === i)
  const lowMaint = (arr: typeof shrubs) => dedupe(arr.filter(x => /低維護|通用/.test(x.reason)).concat(arr)).slice(0, 3)
  const showy    = (arr: typeof shrubs) => dedupe(arr.filter(x => /花/.test(x.reason)).concat(arr)).slice(0, 3)
  const plans = [
    {
      title: '方案 A｜低維護穩定型',
      lines: [
        `喬木：${subject.normalizedCategory === 'tree' ? subject.name : trees[0]?.name ?? '—'}`,
        `灌木：${lowMaint(shrubs).map(x => x.name).join('、')}`,
        `地被：${lowMaint(gcs).slice(0, 2).map(x => x.name).join('、')}`,
        `草皮：${lawns.find(l => /假儉草|低維護/.test(l.name + l.reason))?.name ?? lawns[0]?.name ?? '假儉草'}`,
      ],
    },
    {
      title: '方案 B｜入口亮點型',
      lines: [
        `喬木：${subject.normalizedCategory === 'tree' ? subject.name : trees.find(t => /花/.test(t.reason))?.name ?? trees[0]?.name ?? '—'}`,
        `灌木：${showy(shrubs).map(x => x.name).join('、')}`,
        `地被：${showy(gcs).slice(0, 2).map(x => x.name).join('、')}`,
        `草皮：${lawns.find(l => /台北草/.test(l.name))?.name ?? lawns[0]?.name ?? '台北草'}`,
      ],
    },
  ]

  // 6. 風險提醒
  const risks: string[] = []
  if (deciduous || (isTree && hasFlower)) risks.push(`${subject.name}${deciduous ? '為落葉樹種，冬季景觀空窗' : ''}${hasFlower ? '花期落花量大，鋪面與排水溝需定期清理' : ''}。`)
  if (isTree) risks.push('成樹後樹冠擴張，樹下日照逐年減少——地被應預選耐陰品種，草皮僅配置於滴水線外。')
  if (subject.wetTolerance === '不耐積水') risks.push(`${subject.name}不耐積水，種植穴需確保排水，避免配置於低窪匯水處。`)
  risks.push('新植前 1–2 年為關鍵養護期，需定期澆灌至根系穩定，之後才可粗放管理。')

  const dbCount = [...trees, ...shrubs, ...gcs, ...lawns].filter(x => x.fromDB).length
  const finalDisclaimer = dbCount < 6
    ? (disclaimer ? disclaimer + ' ' : '') + '部分建議植物取自內建通用清單（標註「通用配植原則」），建議補入資料庫以提升比對精度。'
    : disclaimer

  return { verdict, goodPairs: [], badPairs, risks, fixes, alternatives: [], pairCategories, plans, disclaimer: finalDisclaimer }
}

// ── Intent 分類 ───────────────────────────────────────────────────────────────
export type QueryIntent =
  | 'zone_review'            // 分區配置審查
  | 'plant_pairing'          // 單一植物搭配建議
  | 'combo_check'            // 多植物組合合理性
  | 'condition_search'       // 依條件查詢植栽（耐旱/耐陰/低維護…）
  | 'replacement_suggestion' // 替代植栽建議
  | 'irrigation_advice'      // 澆灌衝突原則
  | 'general_design_advice'  // 一般配植建議

// ── 條件查詢引擎（condition_search）──────────────────────────────────────────

interface PlantCondition {
  key: string
  label: string                                    // 「耐旱植物」
  pattern: RegExp                                  // 問題關鍵字
  test: (p: CsvPlantRecord) => boolean
  why: (p: CsvPlantRecord) => string               // 為什麼符合
  fallbackNote: string                             // 內建清單的符合說明
}

const CONDITIONS: PlantCondition[] = [
  {
    key: 'drought', label: '耐旱植物', pattern: /耐旱|抗旱|少澆水|不太.*澆|乾旱/,
    test: p => p.droughtTolerance === '耐旱' || p.waterRequirement === '低',
    why: p => `耐旱性${p.droughtTolerance}・需水${p.waterRequirement}`,
    fallbackNote: '耐旱性佳',
  },
  {
    key: 'shade', label: '耐陰植物', pattern: /耐陰|樹下|遮陰|陰暗|背光|光線不足/,
    test: p => p.sunRequirement.includes('遮陰'),
    why: p => `日照${p.sunRequirement}，樹蔭下仍可穩定生長`,
    fallbackNote: '耐陰性佳，適合樹下',
  },
  {
    key: 'lowmaint', label: '低維護植物', pattern: /低維護|好照顧|免維護|好養|省人力|不用管|粗放/,
    test: p => p.maintenanceLevel === '低',
    why: p => `維護難度${p.maintenanceLevel}${p.droughtTolerance === '耐旱' ? '・耐旱' : ''}`,
    fallbackNote: '低維護，適合粗放管理',
  },
  {
    key: 'fullsun', label: '全日照植物', pattern: /全日照|向陽|太陽大|日照充足|西曬|曝曬/,
    test: p => p.sunRequirement.includes('全日照'),
    why: p => `日照${p.sunRequirement}，向陽處生長旺盛`,
    fallbackNote: '適合全日照環境',
  },
  {
    key: 'wet', label: '耐濕植物', pattern: /耐濕|積水|潮濕|排水不良|低窪|水邊/,
    test: p => p.wetTolerance === '耐濕' || p.wetTolerance === '稍耐濕',
    why: p => `耐濕性${p.wetTolerance}`,
    fallbackNote: '耐濕性較佳',
  },
  {
    key: 'showy', label: '開花觀賞植物（入口主景適用）', pattern: /入口|主景|開花|有花|迎賓|亮點|焦點/,
    test: p => !!p.flowerColor,
    why: p => `${p.flowerColor}花${p.flowerMonth ? `（${p.flowerMonth}月）` : ''}，具觀賞焦點性`,
    fallbackNote: '開花性佳，適合視覺焦點',
  },
  {
    key: 'evergreen', label: '常綠植物（落葉少）', pattern: /常綠|不落葉|落葉少|不容易落葉|不掉葉/,
    test: p => !/落葉/.test(p.category + p.subCategory + p.treeForm + p.maintenanceNote),
    why: () => '常綠性，全年維持綠量、落葉清理負擔低',
    fallbackNote: '常綠樹種',
  },
  {
    key: 'native', label: '台灣原生植物', pattern: /原生|本土|在地種/,
    test: p => p.nativeStatus.includes('原生'),
    why: p => `${p.nativeStatus}，生態適應性與誘鳥誘蝶價值高`,
    fallbackNote: '台灣原生種',
  },
]

/** 類別使用建議與注意事項（依欄位動態組合）*/
function usageAdvice(p: CsvPlantRecord | null, cat: 'tree' | 'shrub' | 'groundcover' | 'lawn'): { use: string; caution: string } {
  const use = cat === 'tree' ? (p?.flowerColor ? '適合道路列植、入口主景' : '適合背景綠蔭、緩衝帶列植')
    : cat === 'shrub' ? '適合綠籬、收邊、前景層次'
    : cat === 'groundcover' ? '適合大面積覆蓋、抑制雜草'
    : '適合開放草坪'
  const cautions: string[] = []
  if (p) {
    if (p.wetTolerance === '不耐積水') cautions.push('不耐積水，避免低窪處')
    if (p.maintenanceLevel === '高') cautions.push('維護需求高')
    if (p.flowerColor && cat === 'tree') cautions.push('落花期需清理')
    if (p.sunRequirement === '全日照') cautions.push('樹蔭下不適用')
  }
  return { use, caution: cautions.join('；') || '無特殊注意事項' }
}

/** condition_search：依條件篩選 DB → 喬/灌/地/草 分類清單 */
function conditionSearchReply(q: string, conds: PlantCondition[], db: CsvPlantRecord[]): AdvisorReply {
  const isLawn = (p: CsvPlantRecord) =>
    /草皮|草坪/.test(p.subCategory + p.category) || ['台北草', '假儉草', '百慕達草', '地毯草', '奧古斯丁草'].some(n => p.name.includes(n))

  // 問題是否限定類別（「低維護灌木有哪些」→ 只出灌木）
  const catAsked: Array<'tree' | 'shrub' | 'groundcover' | 'lawn'> = []
  if (/喬木|大樹|行道樹/.test(q)) catAsked.push('tree')
  if (/灌木|綠籬/.test(q))        catAsked.push('shrub')
  if (/地被|地披/.test(q))        catAsked.push('groundcover')
  if (/草皮|草坪/.test(q))        catAsked.push('lawn')
  const cats: Array<'tree' | 'shrub' | 'groundcover' | 'lawn'> =
    catAsked.length > 0 ? catAsked : ['tree', 'shrub', 'groundcover', 'lawn']

  const CAT_LABEL: Record<string, string> = { tree: '喬木', shrub: '灌木', groundcover: '地被', lawn: '草皮' }
  let usedFallback = false

  const pairCategories: AdvisorReply['pairCategories'] = cats.map(cat => {
    const catFilter = (p: CsvPlantRecord) =>
      cat === 'lawn' ? isLawn(p) : (p.normalizedCategory === cat && !isLawn(p))
    const matches = db
      .filter(p => catFilter(p) && conds.every(c => c.test(p)))
      .sort((a, b) => (b.maintenanceLevel === '低' ? 1 : 0) - (a.maintenanceLevel === '低' ? 1 : 0))
      .slice(0, 5)
    const picks: NonNullable<AdvisorReply['pairCategories']>[number]['picks'] = matches.map(p => {
      const { use, caution } = usageAdvice(p, cat)
      const why = conds.map(c => c.why(p)).join('・')
      return { name: p.name, reason: `${why}｜${use}｜注意：${caution}`, why, use, caution, fromFallback: false }
    })
    // 內建清單補足到 3 — 只補「特性標籤符合所有條件」的預設植物
    if (picks.length < 3) {
      for (const f of FALLBACK_PLANTS[cat]) {
        if (picks.length >= 3) break
        if (picks.some(x => x.name === f.name)) continue
        if (!conds.every(c => f.traits.includes(c.key))) continue
        usedFallback = true
        const { use } = usageAdvice(null, cat)
        const why = `${conds.map(c => c.fallbackNote).join('・')}・${f.reason}`
        picks.push({ name: f.name, reason: `${why}（系統預設）｜${use}`, why, use, fromFallback: true })
      }
    }
    return { label: CAT_LABEL[cat], picks }
  }).filter(c => c.picks.length > 0)

  const condLabel = conds.map(c => c.label).join('且')
  const dbHits = pairCategories.reduce((s, c) => s + c.picks.filter(p => !p.reason.includes('系統預設')).length, 0)

  return {
    kind: 'condition_search',
    queryCondition: condLabel,
    verdict: `${condLabel}建議清單（資料庫符合 ${dbHits} 筆${usedFallback ? '，不足部分以系統預設補足' : ''}）：`,
    goodPairs: [],
    badPairs: [],
    risks: conds.some(c => c.key === 'shade')
      ? ['樹下環境隨樹冠鬱閉度變化，新植喬木下方 2–3 年後光量會再下降，選種時預留餘裕。']
      : conds.some(c => c.key === 'drought')
        ? ['耐旱植物在成活期（前 1–2 年）仍需定期澆灌，根系穩定後才可減少灌溉。']
        : [],
    fixes: catAsked.length === 0
      ? ['可進一步限定類別提問，例如「' + condLabel.replace('植物', '') + '灌木有哪些」。']
      : [],
    alternatives: [],
    pairCategories,
    disclaimer: usedFallback ? '部分植栽為系統預設建議，建議後續補入資料庫完整欄位。' : undefined,
  }
}

// ── 組合分析（多植物相容性 → 完整回覆）────────────────────────────────────────

function analyzeCombo(plants: CsvPlantRecord[], db: CsvPlantRecord[], zoneName?: string): AdvisorReply {
  const risks: string[] = []
  const fixes: string[] = []
  const badPairs: AdvisorReply['badPairs'] = []
  let score = 90

  // 兩兩相容性
  for (let i = 0; i < plants.length; i++) {
    for (let j = i + 1; j < plants.length; j++) {
      const c = isCompatible(plants[i], plants[j])
      if (!c.ok) {
        badPairs.push({ name: `${plants[i].name} × ${plants[j].name}`, reason: c.reason! })
        score -= 12
      }
    }
  }
  if (badPairs.length > 0) {
    risks.push(`${badPairs.length} 組植物存在環境需求衝突，混植後弱勢方生長不良、後期補植成本高。`)
    fixes.push('衝突組合建議分區配置（依水分/日照分開），或擇一替換為需求相近的植種。')
  }

  // 維護
  const highMaint = plants.filter(p => p.maintenanceLevel === '高')
  if (highMaint.length >= 2) {
    score -= 8
    risks.push(`${highMaint.map(p => p.name).join('、')} 維護需求高，整體養護人力與預算偏重。`)
    fixes.push('高維護植栽建議集中於可及性高的區位，或以低維護同類植物替換部分數量。')
  }

  // 層次結構
  const trees = plants.filter(p => p.normalizedCategory === 'tree')
  const shrubs = plants.filter(p => p.normalizedCategory === 'shrub')
  const gc = plants.filter(p => p.normalizedCategory === 'groundcover')
  if (plants.length >= 2) {
    if (trees.length === 0) { risks.push('組合缺乏喬木層，垂直尺度與遮蔭效果不足。'); score -= 4 }
    if (shrubs.length === 0 && gc.length === 0) { risks.push('缺中低層灌木/地被，地表裸露、層次單薄。'); score -= 4 }
  }

  // 樹下地被日照檢查：有喬木時，地被若是全日照品種 → 提醒
  if (trees.length > 0) {
    for (const g of [...gc, ...shrubs]) {
      if (g.sunRequirement === '全日照') {
        risks.push(`${g.name} 為全日照植物，配置於${trees.map(t => t.name).join('、')}樹冠下方時易徒長稀疏。`)
        fixes.push(`${g.name} 建議配置於樹冠滴水線外側；樹蔭正下方改用耐陰地被。`)
        score -= 5
        break
      }
    }
  }

  // 花期/季相
  const flowering = plants.filter(p => p.flowerColor && p.flowerMonth)
  if (flowering.length >= 2) {
    const months = flowering.map(p => `${p.name}（${p.flowerMonth}月/${p.flowerColor}）`)
    fixes.push(`季相參考：${months.join('、')}——可檢視花期是否錯開以延長觀賞期。`)
  }

  // 適合搭配（從 DB 補充建議）
  const goodPairs: AdvisorReply['goodPairs'] = []
  if (trees.length > 0 && gc.length === 0) {
    const shade = recommend(db, p => p.normalizedCategory === 'groundcover' &&
      p.sunRequirement.includes('遮陰'), 3)
    for (const s of shade) goodPairs.push({ name: s.name, reason: `耐陰地被，適合${trees[0].name}樹下補植` })
  }
  // 現有組合中相容的配對也列出
  for (let i = 0; i < plants.length; i++) {
    for (let j = i + 1; j < plants.length; j++) {
      if (isCompatible(plants[i], plants[j]).ok && goodPairs.length < 5) {
        goodPairs.push({ name: `${plants[i].name} × ${plants[j].name}`, reason: '日照/水分需求相容，可安心混植' })
      }
    }
  }

  // 替代方案（衝突植物優先）
  const alternatives: AdvisorReply['alternatives'] = []
  const conflictNames = new Set(badPairs.flatMap(b => b.name.split(' × ')))
  for (const name of conflictNames) {
    const p = plants.find(x => x.name === name)
    if (p) for (const a of findAlternatives(p, db, 2)) {
      alternatives.push({ original: p.name, alt: a.alt, reason: a.reason })
    }
  }

  score = Math.max(40, Math.min(100, score))
  const label = score >= 80 ? '配置良好' : score >= 65 ? '可行但需調整' : '需重新檢視配置'
  const verdict = `${zoneName ? zoneName + '：' : ''}${plants.map(p => p.name).join('、')} 共 ${plants.length} 種——${label}（${score} 分）。` +
    (badPairs.length > 0 ? `發現 ${badPairs.length} 組需求衝突。` : '未發現明顯環境需求衝突。')

  return { verdict, goodPairs, badPairs, risks, fixes, alternatives, score }
}

// ── 意圖處理 ─────────────────────────────────────────────────────────────────

function ruleAnswer(question: string, ctx: AdvisorContext): AdvisorReply {
  const { db, zones } = ctx
  const q = question.trim()

  // condition_search（耐旱/耐陰/低維護…）即使資料庫尚未載入，仍可用內建預設清單回答
  const earlyConds = CONDITIONS.filter(c => c.pattern.test(q))
  if (db.length === 0 && earlyConds.length > 0) {
    return conditionSearchReply(q, earlyConds, db)
  }

  if (db.length === 0) {
    return {
      verdict: '植栽資料庫尚未載入，無法進行資料庫比對分析。',
      goodPairs: [], badPairs: [], risks: [],
      fixes: ['請先於右上角「匯入 CSV」載入植栽資料庫。'], alternatives: [],
    }
  }

  // ── 分區審查模式：問題提到「X區」且有分區資料 ─────────────────────────────
  const zoneMatch = q.match(/([A-Za-z一二三四五六七八九十])\s*區/)
  if (zoneMatch && zones && zones.length > 0) {
    const zName = zoneMatch[1].toUpperCase() + '區'
    const zone = zones.find(z => z.zoneName === zName || z.zoneName.startsWith(zoneMatch[1].toUpperCase()))
    if (zone) {
      const names = [...zone.trees, ...zone.shrubs]
      const found: CsvPlantRecord[] = []
      const unknown: string[] = []
      for (const n of names) {
        const p = findPlant(n, db)
        if (p) found.push(p); else unknown.push(n)
      }
      // 加上問題中額外提到的植物
      const extra = extractPlants(q, db)
      for (const p of extra.found) if (!found.some(f => f.name === p.name)) found.push(p)

      const reply = analyzeCombo(found, db, zone.zoneName)
      if (unknown.length > 0) {
        reply.disclaimer = `目前資料庫尚未建立「${unknown.join('、')}」完整資料，以下建議為一般景觀配置原則，建議後續補入資料庫以提升審查準確度。`
      }
      return reply
    }
  }

  // ── 從問題抓植物 ─────────────────────────────────────────────────────────
  const { found, unknown } = extractPlants(q, db)
  const disclaimer = unknown.length > 0
    ? `目前資料庫尚未建立「${unknown.join('、')}」完整資料，以下建議為一般景觀配置原則，建議後續補入資料庫以提升審查準確度。`
    : undefined

  // ── intent: replacement_suggestion — 替代植栽（有植物名 + 替換詞）─────────
  if (found.length >= 1 && /替代|換掉|取代|換什麼|可以換|改種|替換/.test(q)) {
    const alternatives: AdvisorReply['alternatives'] = []
    for (const p of found) {
      for (const a of findAlternatives(p, db, 3)) {
        alternatives.push({ original: p.name, alt: a.alt, reason: a.reason })
      }
    }
    return {
      verdict: `${found.map(p => p.name).join('、')} 的替代植栽建議（同類別、日照/水分條件相近，優先低維護與原生種）：`,
      goodPairs: [], badPairs: [],
      risks: ['替換時確認新植種的成熟尺寸與原設計空間相符，避免後期擁擠。'],
      fixes: ['替換後建議重新執行「AI 配植評估」確認與同區其他植物的相容性。'],
      alternatives, disclaimer,
    }
  }

  // ── intent: condition_search — 條件查詢（耐旱/耐陰/低維護/全日照…）────────
  // 無論是否有「有哪些」等疑問詞，只要命中條件關鍵字且未指定植物就走查詢
  const matchedConds = CONDITIONS.filter(c => c.pattern.test(q))
  if (found.length === 0 && matchedConds.length > 0) {
    return conditionSearchReply(q, matchedConds, db)
  }

  // ── intent: plant_pairing — 單一植物 → 完整分類搭配 + 方案（不限問法）─────
  if (found.length === 1) {
    return buildPairingReply(found[0], db, disclaimer)
  }

  // ── intent: combo_check — 多植物組合是否合理 ─────────────────────────────
  if (found.length >= 2) {
    const reply = analyzeCombo(found, db)
    reply.disclaimer = disclaimer
    return reply
  }

  // ── intent: irrigation_advice — 澆灌衝突原則 ─────────────────────────────
  if (/澆灌|灌溉|給水|水分.*衝突|衝突.*水/.test(q)) {
    return {
      verdict: '澆灌需求衝突判斷原則：同一噴灌迴路內植物的需水等級差距不宜超過一級（低↔低至中 OK；低↔高 = 衝突）。',
      goodPairs: [],
      badPairs: [],
      risks: [
        '高需水與耐旱植物同迴路：配合前者澆→後者爛根；配合後者→前者缺水。',
        '喬木深根 vs 草皮淺根：同迴路淺層頻澆會讓喬木根系上浮，抗風力下降。',
      ],
      fixes: [
        '在畫面左側加入本區植栽後執行「AI 配植評估」，系統會逐一比對需水等級並標出衝突組合。',
        '或直接輸入植物名稱組合（例：「黃花風鈴木、蔓花生、台北草 這樣合理嗎」），我會立即分析。',
      ],
      alternatives: [],
      disclaimer,
    }
  }

  // ── intent: general_design_advice — 無法識別 → 引導範例 ─────────────────
  return {
    verdict: '請提供植物名稱、分區或篩選條件，我會依資料庫進行分析。',
    goodPairs: [], badPairs: [], risks: [],
    fixes: [
      '搭配建議：「黃花風鈴木有沒有建議搭配？」',
      '分區審查：「A區 用黃花風鈴木、蔓花生、台北草合理嗎？」',
      '條件查詢：「耐旱植物有哪些？」「低維護灌木有哪些？」「適合樹下的地被有哪些？」',
      '替代植栽：「台北草可以換什麼？」',
    ],
    alternatives: [],
    disclaimer,
  }
}
