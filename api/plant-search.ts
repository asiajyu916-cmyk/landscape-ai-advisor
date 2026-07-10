// ── /api/plant-search — 缺漏植栽自動補資料：官方資料搜尋 ──────────────────────
// Vercel Edge Function。前端在「圖面辨識到植物但本地資料庫查無」時呼叫本 API。
//
// 職責範圍（僅此而已，不做任何寫入）：
//   1. 用 Claude API 的 web_search 工具，限定官方 / 可信網域搜尋該植物
//   2. 將搜尋結果整理成逐欄位標記可信度（official_confirmed / inferred / insufficient）
//      的結構化 JSON，絕不允許模型在找不到依據時憑空填值
//   3. 回傳給前端 → 前端顯示「新增植栽資料確認」視窗 → 使用者確認後才寫入資料庫
//
// 環境變數需求（Vercel 專案設定 → Environment Variables）：
//   ANTHROPIC_API_KEY  — Anthropic API 金鑰

export const config = { runtime: 'edge' }

// ── 官方 / 可信資料來源網域白名單 ─────────────────────────────────────────────
// 依使用者指定：農業部、林業及自然保育署、農業試驗所、林業試驗所（隸屬農業部）、
// 各縣市農業局（*.gov.tw 概括涵蓋）、臺灣原生樹木推廣及媒合平臺、特有生物研究
// 保育中心（官方植物資料庫）。不含一般部落格、園藝商店、未標示來源網站。
const ALLOWED_DOMAINS = [
  'moa.gov.tw',                    // 農業部（含各附屬機關 *.moa.gov.tw）
  'forest.gov.tw',                 // 林業及自然保育署
  'nativetree.forest.gov.tw',      // 臺灣原生樹木推廣及媒合平臺
  'theme.forest.gov.tw',           // 臺灣原生樹木種苗網（樹種資料）
  'tari.gov.tw',                   // 農業試驗所
  'tfri.gov.tw',                   // 林業試驗所
  'kmweb.moa.gov.tw',              // 農業知識入口網（農業部官方知識平台）
  'kplant.biodiv.tw',              // 特有生物研究保育中心 台灣野生植物資料庫
  'gov.tw',                        // 概括各縣市政府 / 農業局官網（*.gov.tw）
]

const SYSTEM_PROMPT = `你是景觀工程植栽資料查證助理。任務：搜尋台灣官方植物資料來源，
確認使用者提供的植物名稱的生態習性與栽植資訊，並以結構化 JSON 回覆。

嚴格規則（違反視為任務失敗）：
1. 只能使用 web_search 工具實際搜尋到的內容作為依據，絕對不能憑訓練知識或常識
   直接填寫欄位值 —— 即使你「知道」答案，也必須先搜尋確認，並在 note 中標明依據
   的搜尋結果。
2. 每個欄位都要標記 status：
   - official_confirmed：搜尋結果的官方來源明確記載此數值
   - inferred：官方來源沒有直接寫這個欄位，但根據同來源其他文字合理推論（note 必須
     說明推論依據，例如「該來源標示為向陽性植物，推論日照需求為全日照」）
   - insufficient：搜尋不到任何官方來源提及，此時 value 留空字串
3. 找不到任何官方來源記載這個植物時，不要編造 —— 所有欄位都標 insufficient，
   並在 searchNote 寫「目前查無足夠官方資料，建議人工確認。」
4. dataSourceUrl 必須是實際搜尋到、真實存在的網址，不可捏造或用網站首頁代替
   實際查到資料的頁面。
5. 只採信搜尋結果中來自官方網域的內容；若搜尋結果混雜非官方網站，忽略非官方部分。

只回傳單一 JSON 物件，不要加 markdown code fence、不要加任何說明文字。JSON 結構：
{
  "found": boolean,
  "matchedName": "正式中文名稱",
  "scientificName": "學名",
  "aliases": ["別名1","別名2"],
  "fields": {
    "plantType":            { "value": "喬木|小喬木|灌木|地被|草本|草皮", "status": "...", "note": "" },
    "sunRequirement":       { "value": "", "status": "...", "note": "" },
    "waterRequirement":     { "value": "", "status": "...", "note": "" },
    "droughtTolerance":     { "value": "", "status": "...", "note": "" },
    "wetTolerance":         { "value": "", "status": "...", "note": "" },
    "drainageRequirement":  { "value": "", "status": "...", "note": "" },
    "soilRequirement":      { "value": "", "status": "...", "note": "" },
    "height":               { "value": "", "status": "...", "note": "" },
    "crownWidth":           { "value": "", "status": "...", "note": "" },
    "soilDepth":            { "value": "", "status": "...", "note": "" },
    "plantingSpacing":      { "value": "", "status": "...", "note": "" },
    "flowerPeriod":         { "value": "", "status": "...", "note": "" },
    "flowerColor":          { "value": "", "status": "...", "note": "" },
    "deciduous":            { "value": "落葉|常綠", "status": "...", "note": "" },
    "deciduousLevel":       { "value": "", "status": "...", "note": "" },
    "flowerDropRisk":       { "value": "", "status": "...", "note": "" },
    "maintenanceNote":      { "value": "", "status": "...", "note": "" },
    "maintenanceRisk":      { "value": "", "status": "...", "note": "" }
  },
  "dataSourceName": "主要來源機構名稱",
  "dataSourceUrl": "https://...",
  "citedSources": [{"name":"","url":""}],
  "searchNote": "找不到資料時的說明，否則留空字串"
}`

interface SearchRequestBody {
  queryName: string
  scientificNameHint?: string
  contextNote?: string   // 例如「出現在 J 區、H 區的草皮」，幫助搜尋鎖定正確物種
}

function buildUserPrompt(body: SearchRequestBody): string {
  const lines = [
    `請搜尋並確認以下植物的官方資料：`,
    `植物名稱：${body.queryName}`,
  ]
  if (body.scientificNameHint) lines.push(`學名線索：${body.scientificNameHint}`)
  if (body.contextNote) lines.push(`圖面上下文：${body.contextNote}`)
  lines.push(
    '',
    '請先搜尋確認正式中文名稱與學名（同名異物很常見，例如「沿階草」與「麥門冬」',
    '在不同地區可能指不同物種，請以搜尋到的官方分類資料為準），再搜尋景觀應用相關',
    '的生態習性資料（日照、水分、耐旱耐濕、排水、土壤、樹高樹冠、花期花色、落葉性、',
    '維護管理與常見養護風險）。搜尋時優先使用中文名稱 + 學名 + 官方機構名稱組合查詢。',
  )
  return lines.join('\n')
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

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserPrompt(body) }],
        tools: [{
          type: 'web_search_20250305',
          name: 'web_search',
          allowed_domains: ALLOWED_DOMAINS,
        }],
      }),
    })

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text().catch(() => '')
      return new Response(JSON.stringify({
        ok: false, queryName, reason: `搜尋服務暫時無法使用（${anthropicRes.status}）`,
        detail: errText.slice(0, 500),
      }), { status: 502, headers: { 'content-type': 'application/json' } })
    }

    const data = await anthropicRes.json()
    const textBlocks: string[] = (data.content ?? [])
      .filter((b: { type: string }) => b.type === 'text')
      .map((b: { text: string }) => b.text)
    const rawText = textBlocks.join('\n').trim()

    // 模型可能仍包了 ```json fence，即使系統提示已禁止 —— 保守地剝除
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

    // ── 計算整體信心度與缺漏欄位 ──────────────────────────────────────────────
    const fields = (parsed.fields ?? {}) as Record<string, { value: string; status: string; note?: string }>
    const fieldKeys = Object.keys(fields)
    const confirmedCount = fieldKeys.filter(k => fields[k]?.status === 'official_confirmed').length
    const insufficientKeys = fieldKeys.filter(k => fields[k]?.status === 'insufficient')
    const overallConfidence = fieldKeys.length > 0 ? Math.round((confirmedCount / fieldKeys.length) * 100) : 0
    const overallStatus =
      insufficientKeys.length === fieldKeys.length ? 'insufficient' :
      confirmedCount === fieldKeys.length ? 'official_confirmed' : 'inferred'

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
    return new Response(JSON.stringify({
      ok: false, queryName,
      reason: '搜尋過程發生錯誤，請稍後再試或人工確認。',
      detail: err instanceof Error ? err.message : String(err),
    }), { status: 500, headers: { 'content-type': 'application/json' } })
  }
}
