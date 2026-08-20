// ── 工程估價：112 年度公共工程植栽材料價格參考表（資料庫匹配完整版）──────────────
// 來源檔案：src/data/price-sources/景觀APP_112工程會_資料庫匹配植栽價格_完整版.csv
// 這份 CSV 已經先把「工程會原植物名稱」對應成「資料庫植物名稱」（例如厚葉石斑木→石斑木、
// 平戶杜鵑→杜鵑、光臘樹→光蠟、沿階草→沿街草），這裡直接採用「資料庫植物名稱」當
// plantName，不需要再額外做別名候選判斷——使用者已明確指示這些名稱「直接視為相同，
// 不需要再跳人工確認」，因此不設定 candidateNote（跟桂花/女貞那種「候選、需要人工確認」
// 的情況不同，見 estimatePriceSeedTianwei20260818.ts）；原始工程會名稱保留在 note 供追溯。
//
// 這份是比舊版 estimatePriceSeedGov112.ts（只有喬木14-15cm 級距）更完整的 112 年度資料，
// 兩者若有相同工程會工項編碼（同一筆官方資料），estimatePriceStore.ts 合併時只保留這份
// 完整版本，避免同一筆資料因為規格文字排版不同（全形/半形、分隔符號）被誤判成兩筆。

import type { PlantPrice } from '@/types/estimate'

const PRICE_SOURCE = '112年度公共工程植栽材料價格參考表'
const YEAR = 112

interface RawRow {
  dbName: string
  govName: string
  category: PlantPrice['category']
  spec: string
  pricingUnit: PlantPrice['pricingUnit']
  materialPrice: number
  stdDeviationPrice: number
  workItemCode: string
}

const ROWS: RawRow[] = [
  { dbName: '台北草', govName: '台北草', category: 'grass', spec: '', pricingUnit: 'm2', materialPrice: 152, stdDeviationPrice: 69, workItemCode: 'M0292000022' },
  { dbName: '地毯草', govName: '地毯草', category: 'grass', spec: '', pricingUnit: 'm2', materialPrice: 105, stdDeviationPrice: 20, workItemCode: 'M0292000052' },
  { dbName: '腎蕨', govName: '腎蕨', category: 'groundcover', spec: '30≦高度<40cm。20≦寬度<30cm', pricingUnit: 'plant', materialPrice: 128, stdDeviationPrice: 4, workItemCode: 'M0292212330' },
  { dbName: '台灣百合', govName: '台灣百合', category: 'groundcover', spec: '10cm≦容器直徑<13cm', pricingUnit: 'plant', materialPrice: 35, stdDeviationPrice: 1, workItemCode: 'M029228A002' },
  { dbName: '麥門冬', govName: '麥門冬', category: 'groundcover', spec: '容器直徑<10cm盆苗', pricingUnit: 'plant', materialPrice: 31, stdDeviationPrice: 1, workItemCode: 'M029228E001' },
  { dbName: '沿街草', govName: '沿階草', category: 'groundcover', spec: '容器直徑<10cm盆苗', pricingUnit: 'plant', materialPrice: 30, stdDeviationPrice: 1, workItemCode: 'M029228G001' },
  { dbName: '射干', govName: '射干', category: 'groundcover', spec: '20≦高度<30cm。20≦寬度<30cm', pricingUnit: 'plant', materialPrice: 129, stdDeviationPrice: 4, workItemCode: 'M02922D3230' },
  { dbName: '石斑木', govName: '厚葉石斑木', category: 'shrub', spec: '10cm≦容器直徑<13cm', pricingUnit: 'plant', materialPrice: 149, stdDeviationPrice: 5, workItemCode: 'M029322G002' },
  { dbName: '鵝掌藤', govName: '鵝掌藤', category: 'shrub', spec: '10cm≦容器直徑<13cm', pricingUnit: 'plant', materialPrice: 60, stdDeviationPrice: 1, workItemCode: 'M029325F002' },
  { dbName: '鵝掌藤', govName: '鵝掌藤', category: 'shrub', spec: '高度<30cm。寬度<20cm', pricingUnit: 'plant', materialPrice: 70, stdDeviationPrice: 0, workItemCode: 'M029325F110' },
  { dbName: '撒金變葉木', govName: '撒金變葉木', category: 'shrub', spec: '13cm≦容器直徑<16cm', pricingUnit: 'plant', materialPrice: 155, stdDeviationPrice: 4, workItemCode: 'M02932A9003' },
  { dbName: '錫蘭葉下珠', govName: '錫蘭葉下珠', category: 'shrub', spec: '高度<30cm', pricingUnit: 'plant', materialPrice: 111, stdDeviationPrice: 3, workItemCode: 'M02932AW100' },
  { dbName: '杜鵑', govName: '平戶杜鵑', category: 'shrub', spec: '寬度<20cm', pricingUnit: 'plant', materialPrice: 73, stdDeviationPrice: 11, workItemCode: 'M02932CG010' },
  { dbName: '樹蘭', govName: '樹蘭', category: 'shrub', spec: '13cm≦容器直徑<16cm', pricingUnit: 'plant', materialPrice: 203, stdDeviationPrice: 5, workItemCode: 'M02932J4003' },
  { dbName: '六月雪', govName: '六月雪', category: 'shrub', spec: '寬度<20cm', pricingUnit: 'plant', materialPrice: 36, stdDeviationPrice: 1, workItemCode: 'M02932N2010' },
  { dbName: '矮仙丹', govName: '矮仙丹', category: 'shrub', spec: '高度<30cm。寬度<20cm', pricingUnit: 'plant', materialPrice: 33, stdDeviationPrice: 8, workItemCode: 'M02932N7110' },
  { dbName: '馬纓丹', govName: '馬纓丹', category: 'shrub', spec: '高度<30cm。寬度<20cm', pricingUnit: 'plant', materialPrice: 9, stdDeviationPrice: 0, workItemCode: 'M02932Q8110' },
  { dbName: '樟樹', govName: '樟樹', category: 'tree', spec: '270≦樹高<300cm。100≦樹幅<120cm', pricingUnit: 'plant', materialPrice: 1668, stdDeviationPrice: 148, workItemCode: 'M029383EAA0' },
  { dbName: '樟樹', govName: '樟樹', category: 'tree', spec: '450≦樹高<500cm。260≦樹幅<280cm。14≦米高直徑<16cm', pricingUnit: 'plant', materialPrice: 6558, stdDeviationPrice: 315, workItemCode: 'M029383EEJ7' },
  { dbName: '楓香', govName: '楓香', category: 'tree', spec: '270≦樹高<300cm。100≦樹幅<120cm', pricingUnit: 'plant', materialPrice: 3656, stdDeviationPrice: 364, workItemCode: 'M029386JAA0' },
  { dbName: '楓香', govName: '楓香', category: 'tree', spec: '450≦樹高<500cm。260≦樹幅<280cm。14≦米高直徑<16cm', pricingUnit: 'plant', materialPrice: 5246, stdDeviationPrice: 252, workItemCode: 'M029386JEJ7' },
  { dbName: '櫸木', govName: '櫸木', category: 'tree', spec: '270≦樹高<300cm。100≦樹幅<120cm', pricingUnit: 'plant', materialPrice: 2325, stdDeviationPrice: 4, workItemCode: 'M0293886AA0' },
  { dbName: '櫸木', govName: '櫸木', category: 'tree', spec: '450≦樹高<500cm。260≦樹幅<280cm。14≦米高直徑<16cm', pricingUnit: 'plant', materialPrice: 5246, stdDeviationPrice: 252, workItemCode: 'M0293886EJ7' },
  { dbName: '茄苳', govName: '茄苳', category: 'tree', spec: '270≦樹高<300cm。100≦樹幅<120cm', pricingUnit: 'plant', materialPrice: 2107, stdDeviationPrice: 187, workItemCode: 'M02938BCAA0' },
  { dbName: '茄苳', govName: '茄苳', category: 'tree', spec: '450≦樹高<500cm。260≦樹幅<280cm。14≦米高直徑<16cm', pricingUnit: 'plant', materialPrice: 6558, stdDeviationPrice: 315, workItemCode: 'M02938BCEJ7' },
  { dbName: '大花紫薇', govName: '大花紫薇', category: 'tree', spec: '240≦樹高<270cm。90≦樹幅<100cm', pricingUnit: 'plant', materialPrice: 4109, stdDeviationPrice: 98, workItemCode: 'M02938CG990' },
  { dbName: '大花紫薇', govName: '大花紫薇', category: 'tree', spec: '270≦樹高<300cm。100≦樹幅<120cm', pricingUnit: 'plant', materialPrice: 2195, stdDeviationPrice: 196, workItemCode: 'M02938CGAA0' },
  { dbName: '小葉欖仁', govName: '小葉欖仁', category: 'tree', spec: '270≦樹高<300cm。100≦樹幅<120cm', pricingUnit: 'plant', materialPrice: 2019, stdDeviationPrice: 180, workItemCode: 'M02938CSAA0' },
  { dbName: '苦楝', govName: '苦楝', category: 'tree', spec: '270≦樹高<300cm。100≦樹幅<120cm', pricingUnit: 'plant', materialPrice: 1971, stdDeviationPrice: 57, workItemCode: 'M02938H5AA0' },
  { dbName: '苦楝', govName: '苦楝', category: 'tree', spec: '350≦樹高<400cm。160≦樹幅<180cm', pricingUnit: 'plant', materialPrice: 3888, stdDeviationPrice: 548, workItemCode: 'M02938H5CD0' },
  { dbName: '黃連木', govName: '黃連木', category: 'tree', spec: '270≦樹高<300cm。100≦樹幅<120cm', pricingUnit: 'plant', materialPrice: 3385, stdDeviationPrice: 79, workItemCode: 'M02938HMAA0' },
  { dbName: '流蘇', govName: '流蘇', category: 'tree', spec: '210≦樹高<240cm。90≦樹幅<100cm', pricingUnit: 'plant', materialPrice: 3400, stdDeviationPrice: 60, workItemCode: 'M02938J1890' },
  { dbName: '光蠟', govName: '光臘樹', category: 'tree', spec: '240≦樹高<270cm。90≦樹幅<100cm', pricingUnit: 'plant', materialPrice: 1690, stdDeviationPrice: 138, workItemCode: 'M02938J2990' },
  { dbName: '光蠟', govName: '光臘樹', category: 'tree', spec: '270≦樹高<300cm。100≦樹幅<120cm', pricingUnit: 'plant', materialPrice: 3369, stdDeviationPrice: 184, workItemCode: 'M02938J2AA0' },
  { dbName: '光蠟', govName: '光臘樹', category: 'tree', spec: '300≦樹高<350cm。120≦樹幅<140cm', pricingUnit: 'plant', materialPrice: 3395, stdDeviationPrice: 1742, workItemCode: 'M02938J2BB0' },
  { dbName: '緬梔', govName: '緬梔', category: 'tree', spec: '300≦樹高<350cm。260≦樹幅<280cm', pricingUnit: 'plant', materialPrice: 8744, stdDeviationPrice: 420, workItemCode: 'M02938K3BJ0' },
  { dbName: '黃花風鈴木', govName: '黃花風鈴木', category: 'tree', spec: '270≦樹高<300cm。100≦樹幅<120cm', pricingUnit: 'plant', materialPrice: 2810, stdDeviationPrice: 250, workItemCode: 'M02938LGAA0' },
]

export const GOV112_FULL_PRICE_SEED: PlantPrice[] = ROWS.map((r, i) => ({
  id: `seed-gov112full-${r.workItemCode}-${i}`,
  plantName: r.dbName,
  category: r.category,
  specification: r.spec || undefined,
  pricingUnit: r.pricingUnit,
  materialPrice: r.materialPrice,
  sourceType: 'gov',
  sourceYear: YEAR,
  priceSource: PRICE_SOURCE,
  workItemCode: r.workItemCode,
  region: '全區',
  stdDeviationPrice: r.stdDeviationPrice,
  note: r.dbName !== r.govName ? `工程會原始名稱：${r.govName}（已依資料庫標準名稱對應，不需人工確認）` : undefined,
}))
