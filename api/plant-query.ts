// ── /api/plant-query — AI 配植助理：本地資料庫查無時的建議補充 ──────────────────
// 只有「本地植栽資料庫過濾後完全沒有符合條件的植物」時，前端才會呼叫這支 API。
// 回傳的是「建議可能符合條件的植物名稱」，明確標示為建議、非本地資料庫資料，
// 使用者需要另外透過「植栽資料庫」的自動搜尋功能個別核實、新增。
//
// 跟 /api/plant-search（查單一植物的完整欄位）不同，這支是「依條件找植物清單」，
// 範圍更模糊，因此刻意壓低來源需求（最多 1 次搜尋）、只回傳簡短建議，
// 避免無根據地列出一長串真假難辨的植物名稱。

export const config = { runtime: 'edge' }

const OWN_TIMEOUT_MS = 18_000

const ALLOWED_DOMAINS = [
  'moa.gov.tw', 'forest.gov.tw', 'nativetree.forest.gov.tw', 'theme.forest.gov.tw',
  'tari.gov.tw', 'tfri.gov.tw', 'kmweb.moa.gov.tw', 'kplant.biodiv.tw', 'gov.tw',
]

const SYSTEM_PROMPT = `你是景觀工程植栽建議助理。使用者的本地植栽資料庫裡，查不到符合條件的植物，
請根據官方來源搜尋 1 次，建議 3~5 種可能符合條件的植物，讓使用者之後自行核實、加入資料庫。

規則：
1. 最多搜尋 1 次，搜尋後就要根據結果作答，不要反覆搜尋。
2. 只有官方來源明確支持的建議才列入，若搜尋不到，誠實回覆「查無建議」。
3. 不能保證這些植物實際符合使用者當下基地的所有條件，只是名稱層級的建議。
4. 每個建議附一句簡短理由跟來源，不需要完整欄位資料。

只回傳單一 JSON 物件，不要加 markdown code fence：
{
  "found": boolean,
  "suggestions": [{"name":"中文名稱","reason":"簡短理由","sourceUrl":"https://..."}],
  "note": "查無建議時的說明，否則留空"
}`

interface QueryBody {
  typeLabel: string        // 例如「喬木」「灌木」
  conditionLabels: string[] // 例如 ["耐旱植物","低維護植物"]
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

  let body: QueryBody
  try { body = await req.json() } catch {
    return new Response(JSON.stringify({ ok: false, reason: '請求格式錯誤' }), { status: 400 })
  }
  const conditionText = body.conditionLabels?.join('、') || ''
  const question = `請建議符合「${body.typeLabel || '不限類型'}」${conditionText ? `且「${conditionText}」` : ''}的植物`

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), OWN_TIMEOUT_MS)

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: question }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', allowed_domains: ALLOWED_DOMAINS, max_uses: 1 }],
      }),
    })
    clearTimeout(timeoutId)

    if (!res.ok) {
      return new Response(JSON.stringify({ ok: false, reason: `搜尋服務暫時無法使用（${res.status}）` }),
        { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const data = await res.json()
    const text = (data.content ?? []).filter((b: { type: string }) => b.type === 'text')
      .map((b: { text: string }) => b.text).join('\n').trim()
    const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim()

    let parsed: { found?: boolean; suggestions?: Array<{ name: string; reason: string; sourceUrl?: string }>; note?: string }
    try { parsed = JSON.parse(cleaned) } catch {
      return new Response(JSON.stringify({ ok: false, reason: '搜尋結果解析失敗，建議人工確認。' }),
        { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (!parsed.found || !parsed.suggestions?.length) {
      return new Response(JSON.stringify({ ok: false, reason: parsed.note || '查無建議，建議人工確認。' }),
        { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ ok: true, suggestions: parsed.suggestions }),
      { status: 200, headers: { 'content-type': 'application/json' } })
  } catch (err) {
    clearTimeout(timeoutId)
    const isTimeout = err instanceof Error && err.name === 'AbortError'
    return new Response(JSON.stringify({
      ok: false,
      reason: isTimeout ? '查詢逾時，建議稍後再試或人工確認。' : '搜尋過程發生錯誤。',
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
}
