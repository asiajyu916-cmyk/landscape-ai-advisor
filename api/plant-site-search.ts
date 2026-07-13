// ── /api/plant-site-search — 第三層：指定植物網站優先查詢 ──────────────────────
// 搜尋順序：CSV 本地資料 → 雲端植物資料庫（Supabase，前端查）→ 這一層（指定網站）
// → 一般 AI 網路搜尋（/api/plant-search）。
//
// 只查兩個指定來源，找到就停止，不做全網搜尋：
//   1. 臺北典藏植物園 https://www.future.url.tw/plant/
//   2. 農業知識入口網 https://kmweb.moa.gov.tw/
// 建議搜尋順序（寫進 system prompt 要求模型照做）：
//   site:future.url.tw/plant 中文名稱 → site:future.url.tw/plant 學名
//   → site:kmweb.moa.gov.tw 中文名稱 → site:kmweb.moa.gov.tw 學名
//
// 沿用跟 /api/plant-search 相同的 ANTHROPIC_API_KEY，不新建、不更換金鑰。

export const config = { runtime: 'edge' }

const OWN_TIMEOUT_MS = 20_000

const SITE_DOMAINS = ['future.url.tw', 'kmweb.moa.gov.tw']

const SYSTEM_PROMPT = `你是景觀工程植栽資料查證助理，任務是「只」在兩個指定的官方植物網站查詢一個植物的完整資料。

指定來源（依優先順序）：
1. 臺北典藏植物園 https://www.future.url.tw/plant/
2. 農業知識入口網 https://kmweb.moa.gov.tw/

搜尋規則：
1. 依序嘗試：site:future.url.tw/plant 中文名稱 → site:future.url.tw/plant 學名（若有提供）
   → site:kmweb.moa.gov.tw 中文名稱 → site:kmweb.moa.gov.tw 學名（若有提供）。
2. 只要任一次搜尋在這兩個網域內找到明確符合的植物頁面，立即停止後續搜尋、根據該頁面內容作答。
3. 最多搜尋 4 次（對應上面 4 種查詢），不要超過。
4. 只能使用 web_search 工具實際搜尋到、且網域屬於上述兩個來源的內容作為依據，不能憑訓練知識或常識填寫欄位值，也不能採信這兩個網域以外的搜尋結果。
5. 兩個來源都找不到符合的植物頁面時，found 填 false，不要編造任何欄位。
6. sourceUrl 必須是實際搜尋到、真實存在於這兩個網域內的完整網址。

只回傳單一 JSON 物件，不要加 markdown code fence、不要加任何說明文字。JSON 結構：
{
  "found": boolean,
  "matchedName": "中文名稱",
  "scientificName": "學名",
  "englishName": "英文名稱",
  "family": "科名",
  "genus": "屬名",
  "aliases": ["別名1"],
  "plantType": "植物類型（喬木/小喬木/灌木/地被/草本/草皮）",
  "growthHabit": "生長習性",
  "sunRequirement": "日照需求",
  "waterRequirement": "水分需求",
  "soilRequirement": "土壤條件",
  "landscapeUse": "景觀用途",
  "matchedDomain": "future.url.tw 或 kmweb.moa.gov.tw",
  "dataSourceName": "臺北典藏植物園 或 農業知識入口網",
  "sourceUrl": "https://...",
  "searchNote": "查無資料時的說明，否則留空字串"
}`

interface SiteSearchRequestBody {
  queryName: string
  scientificNameHint?: string
}

function buildUserPrompt(body: SiteSearchRequestBody): string {
  const lines = [
    `請只在「臺北典藏植物園」與「農業知識入口網」這兩個指定網站查詢以下植物：`,
    `植物名稱：${body.queryName}`,
  ]
  if (body.scientificNameHint) lines.push(`學名線索：${body.scientificNameHint}`)
  return lines.join('\n')
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, reason: '僅支援 POST' }), { status: 405 })
  }
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return new Response(JSON.stringify({ ok: false, reason: '伺服器未設定 ANTHROPIC_API_KEY' }),
      { status: 500, headers: { 'content-type': 'application/json' } })
  }

  let body: SiteSearchRequestBody
  try { body = await req.json() } catch {
    return new Response(JSON.stringify({ ok: false, reason: '請求格式錯誤' }), { status: 400 })
  }
  const queryName = (body.queryName ?? '').trim()
  if (!queryName) {
    return new Response(JSON.stringify({ ok: false, reason: '缺少植物名稱' }), { status: 400 })
  }
  const startedAt = Date.now()

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), OWN_TIMEOUT_MS)

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1536,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserPrompt(body) }],
        tools: [{
          type: 'web_search_20250305', name: 'web_search',
          allowed_domains: SITE_DOMAINS, max_uses: 4,
        }],
      }),
    })
    clearTimeout(timeoutId)

    if (!res.ok) {
      return new Response(JSON.stringify({
        ok: false, queryName, reason: `指定網站查詢服務暫時無法使用（${res.status}）`,
        telemetry: [{
          tier: 'site_search', searchQuery: queryName, searchDurationMs: Date.now() - startedAt,
          jsonParseOk: false, timedOut: false, failureReason: `anthropic_api_error_${res.status}`,
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }

    const data = await res.json()
    const text = (data.content ?? []).filter((b: { type: string }) => b.type === 'text')
      .map((b: { text: string }) => b.text).join('\n').trim()
    const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim()

    let parsed: Record<string, unknown>
    try { parsed = JSON.parse(cleaned) } catch {
      return new Response(JSON.stringify({
        ok: false, queryName, reason: '指定網站查詢結果解析失敗，建議人工確認。',
        detail: text.slice(0, 500),
        telemetry: [{
          tier: 'site_search', searchQuery: queryName, searchDurationMs: Date.now() - startedAt,
          jsonParseOk: false, timedOut: false, failureReason: 'json_parse_error',
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }

    if (!parsed.found) {
      return new Response(JSON.stringify({
        ok: false, queryName,
        reason: (parsed.searchNote as string) || '臺北典藏植物園、農業知識入口網皆查無此植物。',
        telemetry: [{
          tier: 'site_search', searchQuery: queryName, searchDurationMs: Date.now() - startedAt,
          jsonParseOk: true, timedOut: false, failureReason: 'not_found_in_designated_sites',
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }

    const matchedDomain = String(parsed.matchedDomain || '')
    const dataSource = matchedDomain.includes('kmweb.moa.gov.tw') ? 'moa_agriculture' : 'taipei_botanical'

    const result = {
      queryName,
      matchedName: (parsed.matchedName as string) || queryName,
      scientificName: (parsed.scientificName as string) || '',
      englishName: (parsed.englishName as string) || '',
      family: (parsed.family as string) || '',
      genus: (parsed.genus as string) || '',
      aliases: Array.isArray(parsed.aliases) ? parsed.aliases : [],
      plantType: (parsed.plantType as string) || '',
      growthHabit: (parsed.growthHabit as string) || '',
      sunRequirement: (parsed.sunRequirement as string) || '',
      waterRequirement: (parsed.waterRequirement as string) || '',
      soilRequirement: (parsed.soilRequirement as string) || '',
      landscapeUse: (parsed.landscapeUse as string) || '',
      dataSourceName: (parsed.dataSourceName as string) || (dataSource === 'moa_agriculture' ? '農業知識入口網' : '臺北典藏植物園'),
      dataSourceUrl: (parsed.sourceUrl as string) || '',
      dataSource,
      retrievedAt: new Date().toISOString(),
    }

    return new Response(JSON.stringify({
      ok: true, result,
      telemetry: [{
        tier: 'site_search', searchQuery: queryName, searchDurationMs: Date.now() - startedAt,
        matchedDomain, matchedUrl: result.dataSourceUrl,
        respondedAt: result.retrievedAt, jsonParseOk: true, timedOut: false,
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  } catch (err) {
    clearTimeout(timeoutId)
    const isTimeout = err instanceof Error && err.name === 'AbortError'
    return new Response(JSON.stringify({
      ok: false, queryName,
      reason: isTimeout
        ? '指定網站查詢逾時，建議稍後重試或改用一般網路搜尋。'
        : '指定網站查詢過程發生錯誤。',
      detail: err instanceof Error ? err.message : String(err),
      telemetry: [{
        tier: 'site_search', searchQuery: queryName, searchDurationMs: Date.now() - startedAt,
        jsonParseOk: false, timedOut: isTimeout,
        failureReason: isTimeout ? 'timeout' : (err instanceof Error ? err.message : String(err)),
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
}
