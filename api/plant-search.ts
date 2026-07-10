// ── /api/plant-search — 缺漏植栽自動補資料：官方資料搜尋（v1，速度優先）──────
// Vercel Edge Function。前端在「圖面辨識到植物但本地資料庫查無」時呼叫本 API。
//
// ⚠️ 時間預算限制（重要）：
// Vercel Edge Function 的執行時間上限是平台固定值，無法用程式碼延長
// （這跟 Node.js Serverless Function 的 `maxDuration` 不同，Edge 沒有這個設定）。
// 實測 Hobby 方案約 25 秒會被平台強制中斷，中斷時回傳的不是 JSON、而是 Vercel
// 的錯誤 HTML 頁面，導致前端 res.json() 直接拋例外（"Unexpected token 'A'..."
// 這種錯誤訊息就是把 HTML 當 JSON 解析失敗）。
//
// 因此這版做兩件事把「跑到平台強制中斷」的情況降到最低：
//   1. 大幅縮小任務範圍 —— 只搜尋 1~2 個來源、只要 5 個核心欄位，其餘欄位
//      v1 一律標記 insufficient，不逼模型為了填滿 18 個欄位而一直搜尋。
//   2. 自己設一個比平台上限更早的逾時（20 秒），時間到就主動中止並回傳
//      乾淨的 JSON「查詢逾時」訊息 —— 寧可提早放棄也不要被平台強制中斷。
//
// 環境變數需求（Vercel 專案設定 → Environment Variables）：
//   ANTHROPIC_API_KEY  — Anthropic API 金鑰

export const config = { runtime: 'edge' }

const OWN_TIMEOUT_MS = 20_000   // 自己的逾時，刻意比平台上限（~25s）早，確保還來得及回傳乾淨 JSON

// ── 官方 / 可信資料來源網域白名單 ─────────────────────────────────────────────
const ALLOWED_DOMAINS = [
  'moa.gov.tw',
  'forest.gov.tw',
  'nativetree.forest.gov.tw',
  'theme.forest.gov.tw',
  'tari.gov.tw',
  'tfri.gov.tw',
  'kmweb.moa.gov.tw',
  'kplant.biodiv.tw',
  'gov.tw',
]

// v1：只要求 5 個核心欄位（中文名/學名已是頂層欄位，不算在 fields 內）。
// 其餘 13 個欄位（droughtTolerance/wetTolerance/... 等）由伺服器端統一補上
// insufficient 佔位，維持與前端型別（PlantSearchFields）相容，但不要求模型搜尋。
const CORE_FIELD_KEYS = ['plantType', 'sunRequirement', 'waterRequirement', 'soilRequirement', 'maintenanceNote'] as const
const ALL_FIELD_KEYS = [
  'plantType', 'sunRequirement', 'waterRequirement', 'droughtTolerance', 'wetTolerance',
  'drainageRequirement', 'soilRequirement', 'height', 'crownWidth', 'soilDepth',
  'plantingSpacing', 'flowerPeriod', 'flowerColor', 'deciduous', 'deciduousLevel',
  'flowerDropRisk', 'maintenanceNote', 'maintenanceRisk',
] as const

const SYSTEM_PROMPT = `你是景觀工程植栽資料查證助理，任務是快速確認一個植物的基本資料。

時間非常有限，請遵守：
1. 最多搜尋 2 次就要根據搜尋結果作答，不要為了找到更多細節反覆搜尋。
2. 只需要確認這 5 項：植物類型（喬木/小喬木/灌木/地被/草本/草皮）、日照需求、
   水分需求、土壤需求、維護管理。其他欄位（樹高、花期、落葉性等）v1 版本不用管，
   直接留空即可，不要為了這些欄位額外搜尋。
3. 只能使用 web_search 工具實際搜尋到的內容作為依據，不能憑訓練知識或常識
   直接填寫欄位值。
4. 每個欄位標記 status：
   - official_confirmed：搜尋結果的官方來源明確記載
   - inferred：官方來源沒有直接寫這個欄位，但根據同來源其他文字合理推論
   - insufficient：搜尋不到任何官方來源提及，此時 value 留空字串
5. 找不到任何官方來源記載這個植物時，不要編造，所有欄位標 insufficient，
   searchNote 寫「目前查無足夠官方資料，建議人工確認。」
6. dataSourceUrl 必須是實際搜尋到、真實存在的網址。
7. 只採信搜尋結果中來自官方網域的內容。

只回傳單一 JSON 物件，不要加 markdown code fence、不要加任何說明文字。JSON 結構：
{
  "found": boolean,
  "matchedName": "正式中文名稱",
  "scientificName": "學名",
  "aliases": ["別名1"],
  "fields": {
    "plantType":        { "value": "喬木|小喬木|灌木|地被|草本|草皮", "status": "...", "note": "" },
    "sunRequirement":   { "value": "", "status": "...", "note": "" },
    "waterRequirement": { "value": "", "status": "...", "note": "" },
    "soilRequirement":  { "value": "", "status": "...", "note": "" },
    "maintenanceNote":  { "value": "", "status": "...", "note": "" }
  },
  "dataSourceName": "主要來源機構名稱",
  "dataSourceUrl": "https://...",
  "citedSources": [{"name":"","url":""}],
  "searchNote": "找不到資料時的說明，否則留空字串"
}`

interface SearchRequestBody {
  queryName: string
  scientificNameHint?: string
  contextNote?: string
}

function buildUserPrompt(body: SearchRequestBody): string {
  const lines = [
    `請搜尋並確認以下植物的官方資料（只需要 5 項核心欄位，最多搜尋 2 次）：`,
    `植物名稱：${body.queryName}`,
  ]
  if (body.scientificNameHint) lines.push(`學名線索：${body.scientificNameHint}`)
  if (body.contextNote) lines.push(`圖面上下文：${body.contextNote}`)
  return lines.join('\n')
}

type FieldResult = { value: string; status: string; note?: string }

/** 補齊前端型別需要的完整欄位集合：模型有回的照抄，沒回的一律標 insufficient 佔位 */
function fillAllFields(partial: Record<string, FieldResult> | undefined): Record<string, FieldResult> {
  const out: Record<string, FieldResult> = {}
  for (const key of ALL_FIELD_KEYS) {
    out[key] = partial?.[key] ?? { value: '', status: 'insufficient', note: 'v1 版本此欄位尚未搜尋，如需要請人工確認' }
  }
  return out
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, reason: '僅支援 POST' }), { status: 405 })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return new Response(JSON.stringify({
      ok: false,
      reason: '伺服器未設定 ANTHROPIC_API_KEY，請於 Vercel 專案環境變數新增。',
    }), { status: 500, headers: { 'content-type': 'application/json' } })
  }

  let body: SearchRequestBody
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ ok: false, reason: '請求格式錯誤' }), { status: 400 })
  }
  const queryName = (body.queryName ?? '').trim()
  if (!queryName) {
    return new Response(JSON.stringify({ ok: false, reason: '缺少植物名稱' }), { status: 400 })
  }

  // ── 自訂逾時：比 Vercel Edge 平台上限更早中止，確保能回傳乾淨 JSON ──────────
  // 平台強制中斷時回傳的是 HTML 錯誤頁，會讓前端 JSON.parse 直接拋例外；
  // 自己主動中止則能照常回傳結構化的「查詢逾時」訊息，且不會自動重試
  // （沒有 retry 迴圈，失敗一次就結束，不會重複消耗 API 額度）。
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), OWN_TIMEOUT_MS)

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1536,   // v1 只要 5 個欄位，不需要 4096；縮短輸出也能縮短耗時
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserPrompt(body) }],
        tools: [{
          type: 'web_search_20250305',
          name: 'web_search',
          allowed_domains: ALLOWED_DOMAINS,
          max_uses: 2,   // 明確限制搜尋次數，避免模型反覆搜尋拖長時間
        }],
      }),
    })
    clearTimeout(timeoutId)

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text().catch(() => '')
      return new Response(JSON.stringify({
        ok: false, queryName, reason: `搜尋服務暫時無法使用（${anthropicRes.status}）`,
        detail: errText.slice(0, 500),
      }), { status: 200, headers: { 'content-type': 'application/json' } })   // 200：讓前端能正常解析錯誤訊息，不要再噴 502
    }

    const data = await anthropicRes.json()
    const textBlocks: string[] = (data.content ?? [])
      .filter((b: { type: string }) => b.type === 'text')
      .map((b: { text: string }) => b.text)
    const rawText = textBlocks.join('\n').trim()
    const cleaned = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim()

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(cleaned)
    } catch {
      return new Response(JSON.stringify({
        ok: false, queryName,
        reason: '搜尋結果解析失敗，建議人工確認。',
        detail: rawText.slice(0, 500),
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }

    if (!parsed.found) {
      return new Response(JSON.stringify({
        ok: false, queryName,
        reason: (parsed.searchNote as string) || '目前查無足夠官方資料，建議人工確認。',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }

    const fields = fillAllFields(parsed.fields as Record<string, FieldResult> | undefined)
    const fieldKeys = Object.keys(fields)
    const confirmedCount = CORE_FIELD_KEYS.filter(k => fields[k]?.status === 'official_confirmed').length
    const insufficientKeys = fieldKeys.filter(k => fields[k]?.status === 'insufficient')
    // 信心度只以 5 個核心欄位計算（其餘本來就刻意不搜尋，不該拉低信心度）
    const overallConfidence = Math.round((confirmedCount / CORE_FIELD_KEYS.length) * 100)
    const coreInsufficient = CORE_FIELD_KEYS.filter(k => fields[k]?.status === 'insufficient').length
    const overallStatus =
      coreInsufficient === CORE_FIELD_KEYS.length ? 'insufficient' :
      confirmedCount === CORE_FIELD_KEYS.length ? 'official_confirmed' : 'inferred'

    const result = {
      queryName,
      matchedName: parsed.matchedName || queryName,
      scientificName: parsed.scientificName || '',
      aliases: Array.isArray(parsed.aliases) ? parsed.aliases : [],
      fields,
      dataSourceName: parsed.dataSourceName || '',
      dataSourceUrl: parsed.dataSourceUrl || '',
      retrievedAt: new Date().toISOString(),
      overallStatus,
      overallConfidence,
      missingFieldKeys: insufficientKeys,
      searchNote: parsed.searchNote || undefined,
      citedSources: Array.isArray(parsed.citedSources) ? parsed.citedSources : [],
    }

    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  } catch (err) {
    clearTimeout(timeoutId)
    const isTimeout = err instanceof Error && err.name === 'AbortError'
    return new Response(JSON.stringify({
      ok: false, queryName,
      reason: isTimeout
        ? '查詢逾時（超過 20 秒），建議稍後重試或人工確認。未自動重試，不會重複消耗額度。'
        : '搜尋過程發生錯誤，請稍後再試或人工確認。',
      detail: err instanceof Error ? err.message : String(err),
    }), { status: 200, headers: { 'content-type': 'application/json' } })   // 200：確保前端永遠拿到合法 JSON
  }
}
