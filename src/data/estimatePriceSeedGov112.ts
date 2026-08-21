// ── 工程估價：112 年度公共工程植栽材料價格參考表（喬木 14-15cm 級距）匯入資料 ──────
// 來源檔案：src/data/price-sources/景觀APP_植栽價格表_112工程會_喬木14-15cm.csv
// （原始檔案保留在該路徑供未來核對／更新；這裡是解析後的靜態資料，供 estimatePriceStore
// 首次載入時自動匯入到本機價格資料庫，不影響植物生態資料庫）
//
// 匯入原則（依使用者指示）：
//   - 只包含喬木／灌木「植栽本體材料價格」，不含土壤/肥料/支柱/運輸/人工/機具等施工配料
//   - 材料單價_元 → materialPrice；施工單價目前沒有資料來源，一律不猜、留 undefined
//   - 喬木規格統一採「14≦米高直徑<16cm」級距（CSV 本身即此級距）
//   - 工程會工項編碼／價格來源／地區別／標準差_元 保留供未來價格追溯，不參與目前計價公式
//   - 鵝掌藤在來源 CSV 中有兩筆不同規格／價格（10cm≦容器直徑<13cm＝60元、
//     高度<30cm；寬度<20cm＝70元）：目前 DXF 解析結果不帶規格資訊，估價比對只用植物
//     名稱，因此會固定命中陣列中先出現的那一筆（60元），第二筆規格保留但暫時無法被
//     自動比對到——如果需要依規格分開計價，需要等 DXF 端也能提供規格資訊後才能支援。

import type { PlantPrice } from '@/types/estimate'

const PRICE_SOURCE = '112年度公共工程植栽材料價格參考表'

export const GOV112_TREE_SHRUB_PRICE_SEED: PlantPrice[] = [
  {
    id: 'seed-gov112-樟樹',
    plantName: '樟樹', category: 'tree',
    specification: '樹高450≦H<500cm；樹幅260≦W<280cm；14≦米高直徑<16cm',
    pricingUnit: 'plant', legacyMaterialPrice: 6558,
    sourceType: 'gov', sourceYear: 112, priceSource: PRICE_SOURCE, workItemCode: 'M029383EEJ7', region: '全區', stdDeviationPrice: 315,
  },
  {
    id: 'seed-gov112-楓香',
    plantName: '楓香', category: 'tree',
    specification: '樹高450≦H<500cm；樹幅260≦W<280cm；14≦米高直徑<16cm',
    pricingUnit: 'plant', legacyMaterialPrice: 5246,
    sourceType: 'gov', sourceYear: 112, priceSource: PRICE_SOURCE, workItemCode: 'M029386JEJ7', region: '全區', stdDeviationPrice: 252,
  },
  {
    id: 'seed-gov112-朴樹',
    plantName: '朴樹', category: 'tree',
    specification: '樹高450≦H<500cm；樹幅260≦W<280cm；14≦米高直徑<16cm',
    pricingUnit: 'plant', legacyMaterialPrice: 7869,
    sourceType: 'gov', sourceYear: 112, priceSource: PRICE_SOURCE, workItemCode: 'M0293883EJ7', region: '全區', stdDeviationPrice: 378,
  },
  {
    id: 'seed-gov112-櫸木',
    plantName: '櫸木', category: 'tree',
    specification: '樹高450≦H<500cm；樹幅260≦W<280cm；14≦米高直徑<16cm',
    pricingUnit: 'plant', legacyMaterialPrice: 5246,
    sourceType: 'gov', sourceYear: 112, priceSource: PRICE_SOURCE, workItemCode: 'M0293886EJ7', region: '全區', stdDeviationPrice: 252,
  },
  {
    id: 'seed-gov112-茄苳',
    plantName: '茄苳', category: 'tree',
    specification: '樹高450≦H<500cm；樹幅260≦W<280cm；14≦米高直徑<16cm',
    pricingUnit: 'plant', legacyMaterialPrice: 6558,
    sourceType: 'gov', sourceYear: 112, priceSource: PRICE_SOURCE, workItemCode: 'M02938BCEJ7', region: '全區', stdDeviationPrice: 315,
  },
  {
    id: 'seed-gov112-六月雪',
    plantName: '六月雪', category: 'shrub',
    specification: '寬度<20cm',
    pricingUnit: 'plant', legacyMaterialPrice: 36,
    sourceType: 'gov', sourceYear: 112, priceSource: PRICE_SOURCE, workItemCode: 'M02932N2010', region: '全區', stdDeviationPrice: 1,
  },
  {
    id: 'seed-gov112-馬纓丹',
    plantName: '馬纓丹', category: 'shrub',
    specification: '高度<30cm；寬度<20cm',
    pricingUnit: 'plant', legacyMaterialPrice: 9,
    sourceType: 'gov', sourceYear: 112, priceSource: PRICE_SOURCE, workItemCode: 'M02932Q8110', region: '全區', stdDeviationPrice: 0,
  },
  {
    id: 'seed-gov112-撒金變葉木',
    plantName: '撒金變葉木', category: 'shrub',
    specification: '13cm≦容器直徑<16cm',
    pricingUnit: 'plant', legacyMaterialPrice: 155,
    sourceType: 'gov', sourceYear: 112, priceSource: PRICE_SOURCE, workItemCode: 'M02932A9003', region: '全區', stdDeviationPrice: 4,
  },
  {
    id: 'seed-gov112-錫蘭葉下珠',
    plantName: '錫蘭葉下珠', category: 'shrub',
    specification: '高度<30cm',
    pricingUnit: 'plant', legacyMaterialPrice: 111,
    sourceType: 'gov', sourceYear: 112, priceSource: PRICE_SOURCE, workItemCode: 'M02932AW100', region: '全區', stdDeviationPrice: 3,
  },
  {
    id: 'seed-gov112-鵝掌藤-1',
    plantName: '鵝掌藤', category: 'shrub',
    specification: '10cm≦容器直徑<13cm',
    pricingUnit: 'plant', legacyMaterialPrice: 60,
    sourceType: 'gov', sourceYear: 112, priceSource: PRICE_SOURCE, workItemCode: 'M029325F002', region: '全區', stdDeviationPrice: 1,
  },
  {
    id: 'seed-gov112-鵝掌藤-2',
    plantName: '鵝掌藤', category: 'shrub',
    specification: '高度<30cm；寬度<20cm',
    pricingUnit: 'plant', legacyMaterialPrice: 70,
    sourceType: 'gov', sourceYear: 112, priceSource: PRICE_SOURCE, workItemCode: 'M029325F110', region: '全區', stdDeviationPrice: 0,
  },
  {
    id: 'seed-gov112-樹蘭',
    plantName: '樹蘭', category: 'shrub',
    specification: '13cm≦容器直徑<16cm',
    pricingUnit: 'plant', legacyMaterialPrice: 203,
    sourceType: 'gov', sourceYear: 112, priceSource: PRICE_SOURCE, workItemCode: 'M02932J4003', region: '全區', stdDeviationPrice: 5,
  },
  {
    id: 'seed-gov112-矮仙丹',
    plantName: '矮仙丹', category: 'shrub',
    specification: '高度<30cm；寬度<20cm',
    pricingUnit: 'plant', legacyMaterialPrice: 33,
    sourceType: 'gov', sourceYear: 112, priceSource: PRICE_SOURCE, workItemCode: 'M02932N7110', region: '全區', stdDeviationPrice: 8,
  },
]
