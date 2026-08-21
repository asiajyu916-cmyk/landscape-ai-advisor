// ── 工程估價：田尾玫瑰園／市場參考價（2026-08-18 補充匯入）──────────────────────
// 來源檔案：src/data/price-sources/景觀APP_植栽價格補充_田尾玫瑰園_20260818.csv
// （原始檔案保留在該路徑供未來核對／更新）
//
// 跟 estimatePriceSeedGov112.ts（公共工程官方參考價）是完全獨立的第二份價格來源，
// 兩者都會被 estimatePriceStore 的 seedIfMissing() 合併匯入，不會互相覆蓋
// （合併 key 是 plantName+specification+sourceType，同名同規格但來源不同會各自保留）。
//
// 重要：同一種植物允許多筆不同規格的價格（見規格二），一律原樣保留，不合併成單一價格；
// 估價比對時要依規格挑選（見 estimatePriceStore.ts resolvePlantPrice），不是直接取第一筆。

import type { PlantPrice } from '@/types/estimate'

const PRICE_SOURCE = '田尾玫瑰園／市場參考價'

export const TIANWEI_20260818_PRICE_SEED: PlantPrice[] = [
  {
    // CSV 原始植物名稱就是「厚葉石斑木」（市場商品名），跟資料庫的「石斑木」不完全一樣，
    // 保留原始名稱、不擅自改成「石斑木」——比對時透過 estimatePlantNameCandidates.ts
    // 的候選對應表去找，UI 需標示「候選對應」，不可視為完全相同植物（見規格八）。
    id: 'seed-tianwei-厚葉石斑木-0',
    plantName: '厚葉石斑木', category: 'shrub',
    specification: '2.5吋盆；高約30cm',
    pricingUnit: 'plant', legacyMaterialPrice: 30,
    sourceType: 'market', priceSource: PRICE_SOURCE,
    sourceUrl: 'https://www.twr.com.tw/product_one.asp?guid=5A82E674-9A88-FC49-BD5E-039BF5CF26C2',
    checkedAt: '2026-08-18',
    note: '資料庫植物「石斑木」之網站商品名稱為「厚葉石斑木」；建議以別名/近似名稱對應，但保留原商品名稱。',
  },
  {
    id: 'seed-tianwei-流蘇-1',
    plantName: '流蘇', category: 'tree',
    specification: '移植袋；高4–5尺',
    pricingUnit: 'plant', legacyMaterialPrice: 400,
    sourceType: 'market', priceSource: PRICE_SOURCE,
    sourceUrl: 'https://www.twr.com.tw/product_one.asp?guid=90EB2A3F-B1BE-AF4D-92A8-C480280123B8',
    checkedAt: '2026-08-18',
    note: '小規格苗木市場價；不得直接拿來代表14–15cm米徑工程規格。',
  },
  {
    id: 'seed-tianwei-流蘇-2',
    plantName: '流蘇', category: 'tree',
    specification: '米徑約3cm',
    pricingUnit: 'plant', legacyMaterialPrice: 3000,
    sourceType: 'market', priceSource: PRICE_SOURCE,
    sourceUrl: 'https://www.twr.com.tw/productlist.asp?Page=3&mode=&pid=81E14249-4F4B-4231-9FAF-A15C2B5C8C93&pricemode=createdate',
    checkedAt: '2026-08-18',
    note: '同植物不同規格，估價時必須依規格選價。',
  },
  {
    id: 'seed-tianwei-白水木-3',
    plantName: '白水木', category: 'tree',
    specification: '2.5吋盆；高20–30cm',
    pricingUnit: 'plant', legacyMaterialPrice: 30,
    sourceType: 'market', priceSource: PRICE_SOURCE,
    sourceUrl: 'https://www.twr.com.tw/product_one.asp?guid=8808D8D1-A3A2-E34B-A146-9D2F687A1407',
    checkedAt: '2026-08-18',
    note: '屬小苗規格。',
  },
  {
    id: 'seed-tianwei-白水木-4',
    plantName: '白水木', category: 'tree',
    specification: '高約1m',
    pricingUnit: 'plant', legacyMaterialPrice: 1200,
    sourceType: 'market', priceSource: PRICE_SOURCE,
    sourceUrl: 'https://www.twr.com.tw/product_one.asp?guid=2A569C1D-2D82-5D42-AAB3-F4BF16A81388',
    checkedAt: '2026-08-18',
    note: '景觀用較大規格；估價時依圖面規格選價。',
  },
  {
    id: 'seed-tianwei-紅花玉芙蓉-5',
    plantName: '紅花玉芙蓉', category: 'shrub',
    specification: '3吋盆',
    pricingUnit: 'plant', legacyMaterialPrice: 45,
    sourceType: 'market', priceSource: PRICE_SOURCE,
    sourceUrl: 'https://www.twr.com.tw/product_one.asp?guid=892DFD59-5A49-E94C-B168-BCFFE2753DC8',
    checkedAt: '2026-08-18',
    note: '可直接作為灌木單株市場參考價。',
  },
  {
    id: 'seed-tianwei-七里香-6',
    plantName: '七里香', category: 'shrub',
    specification: '2.5吋盆；高20–30cm',
    pricingUnit: 'plant', legacyMaterialPrice: 20,
    sourceType: 'market', priceSource: PRICE_SOURCE,
    sourceUrl: 'https://www.twr.com.tw/product_one.asp?guid=9B81E52B-803B-DE48-9D3E-C4184AA54540',
    checkedAt: '2026-08-18',
    note: '網站同頁亦列3.5吋30元/株。',
  },
  {
    id: 'seed-tianwei-七里香-7',
    plantName: '七里香', category: 'shrub',
    specification: '3.5吋盆',
    pricingUnit: 'plant', legacyMaterialPrice: 30,
    sourceType: 'market', priceSource: PRICE_SOURCE,
    sourceUrl: 'https://www.twr.com.tw/product_one.asp?guid=9B81E52B-803B-DE48-9D3E-C4184AA54540',
    checkedAt: '2026-08-18',
    note: '同植物不同盆徑。',
  },
  {
    id: 'seed-tianwei-七里香-8',
    plantName: '七里香', category: 'shrub',
    specification: '5吋盆；高約40cm',
    pricingUnit: 'plant', legacyMaterialPrice: 100,
    sourceType: 'market', priceSource: PRICE_SOURCE,
    sourceUrl: 'https://www.twr.com.tw/product_one.asp?guid=9B81E52B-803B-DE48-9D3E-C4184AA54540',
    checkedAt: '2026-08-18',
    note: '較大盆規格。',
  },
  {
    id: 'seed-tianwei-福建茶-9',
    plantName: '福建茶', category: 'shrub',
    specification: '球型約30×30cm',
    pricingUnit: 'plant', legacyMaterialPrice: 300,
    sourceType: 'market', priceSource: PRICE_SOURCE,
    sourceUrl: 'https://www.twr.com.tw/product_one.asp?guid=C862EEC6-2155-D741-AFB5-CE931FE39418',
    checkedAt: '2026-08-18',
    note: '球型整形苗；規格與一般小苗不同。',
  },
  {
    id: 'seed-tianwei-蔓花生-10',
    plantName: '蔓花生', category: 'groundcover',
    specification: '3吋盆',
    pricingUnit: 'plant', legacyMaterialPrice: 12,
    sourceType: 'market', priceSource: PRICE_SOURCE,
    sourceUrl: 'https://www.twr.com.tw/product_one.asp?guid=9482E52A-12BE-634B-930E-0A01579875A3',
    checkedAt: '2026-08-18',
    note: '若DXF以HATCH面積計量，可搭配種植間距/密度換算株數後計價。',
  },
  {
    id: 'seed-tianwei-越橘葉蔓榕-11',
    plantName: '越橘葉蔓榕', category: 'groundcover',
    specification: '3吋盆',
    pricingUnit: 'plant', legacyMaterialPrice: 20,
    sourceType: 'market', priceSource: PRICE_SOURCE,
    sourceUrl: 'https://www.twr.com.tw/product_one.asp?guid=19E543E3-7BA5-6C43-9C95-14B6F387E001',
    checkedAt: '2026-08-18',
    note: '網站商品名為越橘蔓榕；資料庫名稱為越橘葉蔓榕，建議建立別名對應。',
  },
  {
    id: 'seed-tianwei-九芎-12',
    plantName: '九芎', category: 'tree',
    specification: '移植袋；米徑約5cm',
    pricingUnit: 'plant', legacyMaterialPrice: 2500,
    sourceType: 'market', priceSource: PRICE_SOURCE,
    sourceUrl: 'https://www.twr.com.tw/product_one.asp?guid=4B525D6D-93AB-7E48-AD90-6A7EDB68BAD2',
    checkedAt: '2026-08-18',
    note: '小於工程會常用14–15cm級距，不可跨規格直接套價。',
  },
  {
    id: 'seed-tianwei-九芎-13',
    plantName: '九芎', category: 'tree',
    specification: '移植袋；米徑約15cm',
    pricingUnit: 'plant', legacyMaterialPrice: 30000,
    sourceType: 'market', priceSource: PRICE_SOURCE,
    sourceUrl: 'https://www.twr.com.tw/product_one.asp?guid=6B740596-C530-C24E-A119-228DB772DC9F',
    checkedAt: '2026-08-18',
    note: '與14–15cm級距較接近，可作市場參考價，但仍非公共工程官方價格。',
  },
  {
    // CSV 植物名稱欄已經是資料庫標準名稱「女貞」，規格欄才寫「日本女貞／厚葉女貞」——
    // 不是名稱層級的候選對應問題，而是「這筆市場價格實際對應的是特定品種」，用
    // candidateNote 提醒使用者，不要自動當成完全同種同規格（見規格八）。
    id: 'seed-tianwei-女貞-14',
    plantName: '女貞', category: 'shrub',
    specification: '日本女貞／厚葉女貞；3吋盆；高20–30cm',
    pricingUnit: 'plant', legacyMaterialPrice: 25,
    sourceType: 'market', priceSource: PRICE_SOURCE,
    sourceUrl: 'https://www.twr.com.tw/product_one.asp?guid=27E67A15-21B8-B246-886B-210D349C7EE8',
    checkedAt: '2026-08-18',
    note: '若資料庫植物為一般「女貞」，請不要自動視為完全同種；建議以別名/品種候選方式對應。',
    candidateNote: '此市場價格對應「日本女貞／厚葉女貞」，非一般女貞的確認同種同規格，僅供參考。',
  },
  {
    // 同理，CSV 植物名稱欄已經是「桂花」，規格欄寫「四季桂」（桂花的栽培品種）。
    id: 'seed-tianwei-桂花-15',
    plantName: '桂花', category: 'shrub',
    specification: '四季桂；高約150cm',
    pricingUnit: 'plant', legacyMaterialPrice: 600,
    sourceType: 'market', priceSource: PRICE_SOURCE,
    sourceUrl: 'https://www.twr.com.tw/product_one.asp?guid=E1B75868-89A4-0D44-92F1-E86709DF4822',
    checkedAt: '2026-08-18',
    note: '四季桂屬桂花栽培品種；只能作桂花市場參考候選，介面需保留品種/規格。',
    candidateNote: '參考品種：四季桂（桂花栽培品種），非一般桂花的確認同種同規格，僅供參考。',
  },
]
