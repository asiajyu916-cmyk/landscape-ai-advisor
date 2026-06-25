// ── DXF 圖塊對應規則持久化儲存 ───────────────────────────────────────────────

const RULE_KEY = 'landscape_dxf_block_rules'

export interface DxfBlockRule {
  blockName: string   // 精確圖塊名稱
  plantName: string   // 對應植物名稱
  savedAt: string     // ISO 時間戳
}

export function loadDxfRules(): DxfBlockRule[] {
  try { return JSON.parse(localStorage.getItem(RULE_KEY) ?? '[]') }
  catch { return [] }
}

export function upsertDxfRule(blockName: string, plantName: string): DxfBlockRule[] {
  const rules = loadDxfRules().filter(r => r.blockName !== blockName)
  rules.push({ blockName, plantName, savedAt: new Date().toISOString() })
  localStorage.setItem(RULE_KEY, JSON.stringify(rules))
  return rules
}

export function deleteDxfRule(blockName: string): DxfBlockRule[] {
  const rules = loadDxfRules().filter(r => r.blockName !== blockName)
  localStorage.setItem(RULE_KEY, JSON.stringify(rules))
  return rules
}

export function clearAllDxfRules(): void {
  localStorage.removeItem(RULE_KEY)
}

// ── 此圖面（session）規則 ─────────────────────────────────────────────────────

function sessionKey(projectKey: string) { return `landscape_dxf_session_${projectKey}` }

export function loadSessionRules(projectKey: string): DxfBlockRule[] {
  try { return JSON.parse(sessionStorage.getItem(sessionKey(projectKey)) ?? '[]') }
  catch { return [] }
}

export function upsertSessionRule(blockName: string, plantName: string, projectKey: string): DxfBlockRule[] {
  const rules = loadSessionRules(projectKey).filter(r => r.blockName !== blockName)
  rules.push({ blockName, plantName, savedAt: new Date().toISOString() })
  sessionStorage.setItem(sessionKey(projectKey), JSON.stringify(rules))
  return rules
}

export function clearSessionRules(projectKey: string): void {
  sessionStorage.removeItem(sessionKey(projectKey))
}

// ── Non-plant exclusion patterns ──────────────────────────────────────────────

export const NON_PLANT_LAYER_KEYWORDS = [
  // AutoCAD 系統圖層
  'defpoints', '0',
  // 圖框 / 標題欄
  '_ocad', 'paper', 'layout', 'viewport', 'vport', 'border',
  '圖框', '標題', '標題欄', 'titleblock', 'title_block',
  // 標註 / 尺寸
  '標註', '尺寸', '尺寸線', 'dimension', 'dim', 'anno', 'annotation',
  // 建築元素
  '家具', '建築', '牆', '柱', '樓板', '天花', '結構', '隔間',
  'furniture', 'arch', 'wall', 'slab', 'column', 'ceiling', 'structure',
  // 設備 / 機電
  '管線', '電氣', '給排水', '消防', '弱電', '空調', '設備',
  'pipe', 'electric', 'mep', 'hvac', 'fire', 'plumbing',
  // 其他非植栽
  '圖例', '指北針', 'legend', 'north', 'revision', 'section',
]

export const NON_PLANT_BLOCK_KEYWORDS = [
  'north_arrow', 'northarrow', '指北針', '方位',
  '圖例', 'legend', 'scale_bar', '比例尺',
  'titleblock', 'viewport', 'revision',
  'dimension', 'arrow', 'leader',
]

export function isNonPlant(blockName: string, layer: string): boolean {
  const bn = blockName.toLowerCase().trim()
  const ln = layer.toLowerCase().trim()

  // Empty or single char block names are likely CAD artifacts
  if (bn.length <= 1 && !bn.match(/[a-z一-鿿]/)) return true

  return [
    ...NON_PLANT_LAYER_KEYWORDS.map(k => ({ key: k.toLowerCase(), src: 'layer' })),
    ...NON_PLANT_BLOCK_KEYWORDS.map(k => ({ key: k.toLowerCase(), src: 'block' })),
  ].some(({ key, src }) =>
    src === 'layer' ? ln.includes(key) : bn.includes(key)
  )
}

// ── Encoding detection ────────────────────────────────────────────────────────

export async function readDxfWithEncoding(file: File): Promise<{ text: string; encoding: string }> {
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const r = new FileReader()
    r.onload  = e => resolve(e.target!.result as ArrayBuffer)
    r.onerror = reject
    r.readAsArrayBuffer(file)
  })

  const bytes = new Uint8Array(buffer)

  function tryDecode(enc: string): { text: string; errors: number } {
    try {
      const text = new TextDecoder(enc, { fatal: false }).decode(bytes)
      const errors = (text.match(/�/g) ?? []).length
      return { text, errors }
    } catch { return { text: '', errors: Infinity } }
  }

  const utf8 = tryDecode('utf-8')
  // < 0.5% replacement characters → treat as clean UTF-8
  if (utf8.errors < bytes.length * 0.005) return { text: utf8.text, encoding: 'UTF-8' }

  const big5 = tryDecode('big5')
  const gbk  = tryDecode('gbk')

  const best = [
    { enc: 'Big5',        result: big5 },
    { enc: 'GBK/GB2312',  result: gbk  },
    { enc: 'UTF-8',       result: utf8 },
  ].reduce((a, b) => (b.result.errors < a.result.errors ? b : a))

  return { text: best.result.text, encoding: best.enc }
}
