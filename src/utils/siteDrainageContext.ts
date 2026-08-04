// ── siteDrainageContext.ts — 排水衝突「場地積水證據」判定 ───────────────────────
// 背景：舊邏輯只比較兩株植物的耐濕等級差距（WET_LEVEL gap），完全沒有「這個場地
// 是否真的會積水」這個前提，導致一樓自然土種植的台北草（耐濕）＋桂花（不耐積水）
// 這種再普通不過的庭園配置被判定為「嚴重排水衝突」——這是這個檔案要修正的根本
// 原因：耐濕等級不同 ≠ 會積水，兩件事被錯誤地劃上等號。
//
// 新規則（使用者原話）：
//   1. 一樓戶外景觀、自然土層或一般綠地，預設排水正常。
//   5. 排水衝突必須同時存在「場地積水證據」，才可成立。
//   6. 無法確認地下是否為自然土（地下室頂板／人工花台／屋頂綠化），只能「提醒」。
//   7. 只有偵測到低窪、集水區、不透水底板、排水不良、無排水花台、滯洪區或灌溉
//      過量等明確跡象，才能判定「嚴重」。
//   10. 不寫死特定植物名稱豁免，改用通用的場地判斷邏輯。
//
// 這裡的「場地積水證據」完全從既有 DXF 資料（分區名稱＋HATCH／邊界圖層名稱）用
// 關鍵字掃描取得，不是憑空假造的判斷，也不需要新的圖面標記規範——圖面既有的分區
// 命名、圖層命名習慣（例如「地下室景觀」「B1花台」「滯洪池」）已經足夠當作訊號。
// 掃不到任何關鍵字時，依規則 1 預設為一樓自然土層（ground-natural），這是刻意的
// 保守預設，不是「找不到就當作安全」的偷懶——多數 DXF 分區審查案件本來就是一樓
// 戶外景觀，這個預設值符合實務常態。

export type SiteDrainageEvidence = 'ground-natural' | 'unknown-structure' | 'impervious-evidence'

export const SITE_DRAINAGE_LABEL: Record<SiteDrainageEvidence, string> = {
  'ground-natural': '一樓自然土層（預設）',
  'unknown-structure': '無法確認地下構造',
  'impervious-evidence': '偵測到積水／不透水證據',
}

// 明確的積水/不透水跡象：低窪、集水、滯洪、不透水底板、排水不良、無排水設計等。
// 只有命中這一組關鍵字才可能判定「嚴重」。
const IMPERVIOUS_EVIDENCE_RE = /滯洪|集水|貯留|沉砂|低窪|窪地|排水不良|不透水|無排水|積水區|逕流/

// 無法確認是否為自然土層的構造跡象：地下室、屋突、屋頂、人工花台等——本身不代表
// 會積水，但無法排除人工底板阻隔排水的可能，只能升級為「提醒」，不能直接判嚴重。
const UNKNOWN_STRUCTURE_EVIDENCE_RE = /地下室|地下層|地下車道|地下|夾層|屋突|屋頂|屋顶|人工花台|花台|頂板|底板|人工地盤|停車場頂|露台|露臺|\bB[1-5]\b/i

/**
 * 從既有可取得的文字（分區名稱、HATCH／邊界圖層名稱）掃描場地積水證據。
 * 純字串比對，不新增圖面標記規範、不讀取任何未提供的欄位。
 */
export function detectSiteDrainageEvidence(texts: Array<string | undefined>): SiteDrainageEvidence {
  const joined = texts.filter((t): t is string => !!t).join('｜')
  if (IMPERVIOUS_EVIDENCE_RE.test(joined)) return 'impervious-evidence'
  if (UNKNOWN_STRUCTURE_EVIDENCE_RE.test(joined)) return 'unknown-structure'
  return 'ground-natural'
}
