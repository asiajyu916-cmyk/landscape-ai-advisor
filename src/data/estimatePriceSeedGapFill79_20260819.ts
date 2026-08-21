// ── 工程估價：缺價植栽單價補齊（2026-08-19）──────────────────────────────────
// 來源檔案：src/data/price-sources/景觀APP_缺價植栽單價補齊_20260819.csv
//
// 補齊先前查無單價的 79 種植物。CSV 的「價格來源」欄依內容轉成 sourceType/sourceYear：
//   110工程會 → sourceType:'gov', sourceYear:110
//   其餘（田尾市場價／市場近似／市場暫估／台灣市場價）→ sourceType:'market'
// CSV「狀態」欄的『暫估』對應 isProvisional:true，UI 顯示黃色「暫估」標籤，仍可正常計價，
// 只是提示未來要換成正式價格；『正式參考』『市場參考』維持一般顯示。
// 這批全部是先前完全查無單價的植物，跟既有 112 工程會資料沒有同植物同規格重複，
// 不會覆蓋任何既有資料——優先序仍是 112工程會 > 110工程會 > 市場參考 > 暫估（sourceRank）。

import type { PlantPrice } from '@/types/estimate'

interface RawRow {
  plantName: string
  category: PlantPrice['category']
  spec: string
  materialPrice: number
  sourceLabel: string
  status: string
  note: string
  sourceUrl?: string
}

const ROWS: RawRow[] = [
  { plantName: '土肉桂', category: 'tree', spec: '工程會一般喬木工項', materialPrice: 5000, sourceLabel: '110工程會', status: '正式參考', note: '110工程會全區平均', sourceUrl: 'https://www.pcc.gov.tw/' },
  { plantName: '小葉桑', category: 'shrub', spec: '苗木參考', materialPrice: 210, sourceLabel: '市場近似', status: '暫估', note: '以桑椹苗公開價格作近似，正式估價前覆核（小葉桑實為大灌木，非喬木）', sourceUrl: 'https://shop.knownyou.com/categories/%E6%9E%9C%E6%A8%B9%E8%8B%97' },
  { plantName: '台灣欒樹', category: 'tree', spec: '工程會一般喬木工項', materialPrice: 4225, sourceLabel: '110工程會', status: '正式參考', note: '110工程會全區平均', sourceUrl: 'https://www.pcc.gov.tw/' },
  { plantName: '玉蘭花', category: 'tree', spec: '小苗/盆苗參考', materialPrice: 200, sourceLabel: '市場參考', status: '暫估', note: '玉蘭類公開苗價簡報暫用', sourceUrl: 'https://www.twr.com.tw/' },
  { plantName: '白玉蘭', category: 'tree', spec: '工程會一般喬木工項', materialPrice: 6285, sourceLabel: '110工程會', status: '正式參考', note: '110工程會全區平均', sourceUrl: 'https://www.pcc.gov.tw/' },
  { plantName: '竹柏', category: 'tree', spec: '工程會一般喬木工項', materialPrice: 2051, sourceLabel: '110工程會', status: '正式參考', note: '110工程會全區平均', sourceUrl: 'https://www.pcc.gov.tw/' },
  { plantName: '辛夷', category: 'tree', spec: '3.5吋，高約30cm', materialPrice: 200, sourceLabel: '田尾市場價', status: '市場參考', note: '公開商品價', sourceUrl: 'https://www.twr.com.tw/product_one.asp?guid=BDA32C29-2B7C-F145-A7F7-7C1F4A9223BE' },
  { plantName: '臥柏', category: 'tree', spec: '6吋級盆苗參考', materialPrice: 150, sourceLabel: '市場暫估', status: '暫估', note: '柏類小苗暫估' },
  { plantName: '南洋含笑', category: 'tree', spec: '盆苗參考', materialPrice: 300, sourceLabel: '市場暫估', status: '暫估', note: '簡報暫用' },
  { plantName: '南洋櫻', category: 'tree', spec: '工程會一般喬木工項', materialPrice: 4670, sourceLabel: '110工程會', status: '正式參考', note: '110工程會全區平均', sourceUrl: 'https://www.pcc.gov.tw/' },
  { plantName: '厚皮香', category: 'tree', spec: '約3.5吋、高30cm級參考', materialPrice: 60, sourceLabel: '市場近似', status: '暫估', note: '以田尾假厚皮香同級苗木作暫估', sourceUrl: 'https://shopee.tw/q99a99z99' },
  { plantName: '柚子樹', category: 'tree', spec: '果樹苗參考', materialPrice: 250, sourceLabel: '市場暫估', status: '暫估', note: '果樹苗市場級距' },
  { plantName: '洋玉蘭', category: 'tree', spec: '6吋、約2尺', materialPrice: 200, sourceLabel: '田尾市場價', status: '市場參考', note: '公開商品價', sourceUrl: 'https://www.twr.com.tw/productlist.asp?Page=3&mode=&pid=0A0CB705-A7EC-4C5B-B53C-0AB3E87F1433&pricemode=high' },
  { plantName: '洋紅風鈴木', category: 'tree', spec: '8吋美植袋/景觀苗參考', materialPrice: 500, sourceLabel: '田尾市場價', status: '市場參考', note: '公開市場景觀苗價', sourceUrl: 'https://shopee.tw/list/%E9%A2%A8%E9%88%B4%E6%9C%A8' },
  { plantName: '重瓣紅石榴', category: 'tree', spec: '盆苗參考', materialPrice: 200, sourceLabel: '市場暫估', status: '暫估', note: '簡報暫用' },
  { plantName: '烏桕', category: 'tree', spec: '工程會『烏臼』工項', materialPrice: 3269, sourceLabel: '110工程會', status: '正式參考', note: '名稱依常用別名對應', sourceUrl: 'https://www.pcc.gov.tw/' },
  { plantName: '魚木', category: 'tree', spec: '工程會一般喬木工項', materialPrice: 1990, sourceLabel: '110工程會', status: '正式參考', note: '110工程會全區平均', sourceUrl: 'https://www.pcc.gov.tw/' },
  { plantName: '紫薇', category: 'tree', spec: '工程會喬木工項', materialPrice: 6680, sourceLabel: '110工程會', status: '正式參考', note: '110工程會全區平均', sourceUrl: 'https://www.pcc.gov.tw/' },
  { plantName: '黃玉蘭', category: 'tree', spec: '盆苗參考', materialPrice: 300, sourceLabel: '市場暫估', status: '暫估', note: '簡報暫用' },
  { plantName: '黃金蒲桃', category: 'tree', spec: '8吋盆、高約4尺', materialPrice: 500, sourceLabel: '田尾市場價', status: '市場參考', note: '公開商品價', sourceUrl: 'https://www.twr.com.tw/product_one.asp?guid=5967EF93-3FFD-2746-8B4B-286ED3C64F6B' },
  { plantName: '黃槿', category: 'tree', spec: '工程會喬木工項', materialPrice: 2548, sourceLabel: '110工程會', status: '正式參考', note: '採喬木項，不採灌木小苗項', sourceUrl: 'https://www.pcc.gov.tw/' },
  { plantName: '黃鐘花', category: 'tree', spec: '盆苗參考', materialPrice: 120, sourceLabel: '市場暫估', status: '暫估', note: '簡報暫用' },
  { plantName: '黑松', category: 'tree', spec: '3.5吋、高約25cm', materialPrice: 50, sourceLabel: '田尾市場價', status: '市場參考', note: '公開商品價', sourceUrl: 'https://shopee.tw/q99a99z99' },
  { plantName: '黑板樹', category: 'tree', spec: '景觀苗參考', materialPrice: 400, sourceLabel: '市場暫估', status: '暫估', note: '簡報暫用，正式估價建議依樹徑更新' },
  { plantName: '榔榆', category: 'tree', spec: '工程會一般喬木工項', materialPrice: 2324, sourceLabel: '110工程會', status: '正式參考', note: '110工程會全區平均', sourceUrl: 'https://www.pcc.gov.tw/' },
  { plantName: '榕樹', category: 'tree', spec: '工程會『正榕』工項', materialPrice: 824, sourceLabel: '110工程會', status: '正式參考', note: '名稱硬對正榕', sourceUrl: 'https://www.pcc.gov.tw/' },
  { plantName: '臺灣三角楓', category: 'tree', spec: '苗木參考', materialPrice: 300, sourceLabel: '市場暫估', status: '暫估', note: '簡報暫用' },
  { plantName: '鳳凰木', category: 'tree', spec: '工程會一般喬木工項', materialPrice: 13272, sourceLabel: '110工程會', status: '正式參考', note: '110工程會全區平均', sourceUrl: 'https://www.pcc.gov.tw/' },
  { plantName: '樹葡萄', category: 'tree', spec: '3.5吋、高20–30cm', materialPrice: 100, sourceLabel: '田尾市場價', status: '市場參考', note: '嘉寶果/樹葡萄公開商品價', sourceUrl: 'https://www.twr.com.tw/product_one.asp?guid=6B7D621A-77D6-B445-A947-97B3094282BD' },
  { plantName: '龍柏', category: 'tree', spec: '高約2m', materialPrice: 1500, sourceLabel: '田尾市場價', status: '市場參考', note: '公開商品價', sourceUrl: 'https://www.twr.com.tw/ProductList.asp?categoryid=&mode=&pid=BC3E440F-9DCA-49B4-AE56-9A33F10DA0E4&pricemode=createdate' },
  { plantName: '鵝掌柴', category: 'tree', spec: '苗木參考', materialPrice: 100, sourceLabel: '市場暫估', status: '暫估', note: '簡報暫用' },
  { plantName: '蘭嶼羅漢松', category: 'tree', spec: '工程會一般喬木工項', materialPrice: 2025, sourceLabel: '110工程會', status: '正式參考', note: '110工程會全區平均', sourceUrl: 'https://www.pcc.gov.tw/' },
  { plantName: '鐵刀木', category: 'tree', spec: '苗木參考', materialPrice: 100, sourceLabel: '市場暫估', status: '暫估', note: '簡報暫用' },
  { plantName: '艷紫荊', category: 'tree', spec: '4吋盆、高約80cm', materialPrice: 100, sourceLabel: '田尾市場價', status: '市場參考', note: '公開商品價', sourceUrl: 'https://www.twr.com.tw/product_one.asp?guid=4AC4B4BD-1170-F14A-AF22-8A96DED744A3' },
  { plantName: '五彩千年木', category: 'shrub', spec: '3吋盆', materialPrice: 50, sourceLabel: '台灣市場價', status: '市場參考', note: '田尾同級約45–55元，採50', sourceUrl: 'https://shopee.tw/search?keyword=%E4%BA%94%E5%BD%A9%E5%8D%83%E5%B9%B4%E6%9C%A8' },
  { plantName: '月橘', category: 'shrub', spec: '工程會灌木工項', materialPrice: 61, sourceLabel: '110工程會', status: '正式參考', note: '110工程會全區平均', sourceUrl: 'https://www.pcc.gov.tw/' },
  { plantName: '四季樹蘭', category: 'shrub', spec: '3.5吋、高25–30cm', materialPrice: 28, sourceLabel: '田尾市場價', status: '市場參考', note: '以樹蘭公開商品價採用', sourceUrl: 'https://www.twr.com.tw/productlist.asp?Page=2&mode=&pid=&pricemode=low' },
  { plantName: '朱槿', category: 'shrub', spec: '10–13cm容器', materialPrice: 80, sourceLabel: '110工程會', status: '正式參考', note: '工程會明確規格', sourceUrl: 'https://www.pcc.gov.tw/' },
  { plantName: '金葉女貞', category: 'shrub', spec: '6吋盆級參考', materialPrice: 140, sourceLabel: '台灣市場價', status: '市場參考', note: '公開商品價約140', sourceUrl: 'https://shopee.tw/search?keyword=%E5%A5%B3%E8%B2%9E' },
  { plantName: '厚葉女貞', category: 'shrub', spec: '10–13cm容器', materialPrice: 110, sourceLabel: '110工程會', status: '正式參考', note: '工程會明確規格', sourceUrl: 'https://www.pcc.gov.tw/' },
  { plantName: '春不老', category: 'shrub', spec: '寬20–30cm、10–13cm容器', materialPrice: 75, sourceLabel: '110工程會', status: '正式參考', note: '採較具體規格工項', sourceUrl: 'https://www.pcc.gov.tw/' },
  { plantName: '紅花繼木', category: 'shrub', spec: '高20–30cm', materialPrice: 120, sourceLabel: '田尾市場價', status: '市場參考', note: '紅繼木/紅彩木公開商品價', sourceUrl: 'https://tw.bid.yahoo.com/item/100142033417' },
  { plantName: '美葉蘇鐵', category: 'shrub', spec: '盆苗參考', materialPrice: 500, sourceLabel: '市場暫估', status: '暫估', note: '簡報暫用' },
  { plantName: '胡椒木', category: 'shrub', spec: '工程會一般工項', materialPrice: 157, sourceLabel: '110工程會', status: '正式參考', note: '110工程會全區平均', sourceUrl: 'https://www.pcc.gov.tw/' },
  { plantName: '茶花', category: 'shrub', spec: '盆苗參考', materialPrice: 200, sourceLabel: '市場暫估', status: '暫估', note: '簡報暫用' },
  { plantName: '馬茶花', category: 'shrub', spec: '5吋、高約30cm', materialPrice: 140, sourceLabel: '田尾市場價', status: '市場參考', note: '依既有別名規則以珍珠馬茶花價採用', sourceUrl: 'https://www.twr.com.tw/productlist.asp?Page=4&mode=detail&pid=0A0CB705-A7EC-4C5B-B53C-0AB3E87F1433&pricemode=high' },
  { plantName: '彩葉山漆莖', category: 'shrub', spec: '工程會一般工項', materialPrice: 105, sourceLabel: '110工程會', status: '正式參考', note: '110工程會全區平均', sourceUrl: 'https://www.pcc.gov.tw/' },
  { plantName: '細葉雪茄花', category: 'shrub', spec: '寬<20cm、盆苗', materialPrice: 36, sourceLabel: '110工程會', status: '正式參考', note: '採具體小苗規格', sourceUrl: 'https://www.pcc.gov.tw/' },
  { plantName: '斑葉海桐', category: 'shrub', spec: '5吋盆', materialPrice: 170, sourceLabel: '台灣市場價', status: '市場參考', note: '公開商品價', sourceUrl: 'https://shopee.tw/%E5%BF%83%E6%A0%BD%E8%8A%B1%E5%9D%8A-%E6%96%91%E8%91%89%E6%B5%B7%E6%A1%90-%E6%B5%B7%E6%A1%90-5%E5%90%8B-%E7%B6%A0%E5%8C%96%E7%92%B0%E5%A2%83-%E8%B3%9E%E8%91%89%E6%A4%8D%E7%89%A9-%E9%80%A0%E5%9E%8B%E6%A8%B9-%E7%89%B9%E5%83%B9170-i.11454839.8112537668' },
  { plantName: '斑葉鵝掌藤', category: 'shrub', spec: '工程會一般工項', materialPrice: 109, sourceLabel: '110工程會', status: '正式參考', note: '110工程會全區平均', sourceUrl: 'https://www.pcc.gov.tw/' },
  { plantName: '棕竹', category: 'shrub', spec: '3吋級參考', materialPrice: 70, sourceLabel: '市場參考', status: '市場參考', note: '沿用觀音棕竹同級苗暫用' },
  { plantName: '紫花馬櫻丹', category: 'shrub', spec: '6吋盆、高約20cm', materialPrice: 120, sourceLabel: '田尾市場價', status: '市場參考', note: '公開商品價', sourceUrl: 'https://shopee.tw/%E7%94%B0%E5%B0%BE%E7%8E%AB%E7%91%B0%E5%9C%92-l-%E7%B4%AB%E8%89%B2%E9%A6%AC%E7%BA%93%E4%B8%B9%E3%80%81%E8%94%93%E6%80%A7%E7%B4%AB%E8%8A%B1%E9%A6%AC%E7%BA%93%E4%B8%B9%E3%80%81%E9%8B%AA%E5%9C%B0%E8%87%AD%E9%87%91%E9%B3%B3%E3%80%90-6%E5%90%8B%E7%9B%86-%E9%AB%98%E5%BA%A6%E7%B4%8420cm%E3%80%91%E8%A7%80%E8%8A%B1-%E5%9C%8D%E7%B1%AC%E6%A4%8D%E7%89%A9-%28%E6%A4%8D%E7%89%A9%E7%9C%BE%E5%A4%9A%E6%AD%A1%E8%BF%8E%E8%A9%A2%E5%95%8F%29-i.1123967.24615844679' },
  { plantName: '銀葉菊', category: 'shrub', spec: '3吋盆', materialPrice: 50, sourceLabel: '台灣市場價', status: '市場參考', note: '公開商品價', sourceUrl: 'https://shopee.tw/%E9%8A%80%E8%91%89%E8%8F%8A%E2%8B%AF%E8%A7%80%E8%91%89%E6%A4%8D%E7%89%A9%EF%BD%9E3%E5%90%8B%E7%9B%86%E2%8B%AF-i.4774993.29969828253' },
  { plantName: '變葉木', category: 'shrub', spec: '工程會灌木工項', materialPrice: 42, sourceLabel: '110工程會', status: '正式參考', note: '110工程會全區平均', sourceUrl: 'https://www.pcc.gov.tw/' },
  { plantName: '三星果藤', category: 'groundcover', spec: '3吋級地被苗', materialPrice: 50, sourceLabel: '市場暫估', status: '暫估', note: '簡報暫用' },
  { plantName: '大鄧伯花', category: 'groundcover', spec: '工程會一般工項', materialPrice: 46, sourceLabel: '110工程會', status: '正式參考', note: '110工程會全區平均', sourceUrl: 'https://www.pcc.gov.tw/' },
  { plantName: '文殊蘭', category: 'groundcover', spec: '工程會一般工項', materialPrice: 150, sourceLabel: '110工程會', status: '正式參考', note: '110工程會全區平均', sourceUrl: 'https://www.pcc.gov.tw/' },
  { plantName: '木玫瑰', category: 'groundcover', spec: '盆苗參考', materialPrice: 100, sourceLabel: '市場暫估', status: '暫估', note: '簡報暫用' },
  { plantName: '毛蝦蟆草', category: 'groundcover', spec: '3吋級地被苗', materialPrice: 40, sourceLabel: '市場暫估', status: '暫估', note: '簡報暫用' },
  { plantName: '石菖蒲', category: 'groundcover', spec: '3吋級地被苗', materialPrice: 50, sourceLabel: '市場暫估', status: '暫估', note: '簡報暫用' },
  { plantName: '尖尾姑婆芋', category: 'groundcover', spec: '盆苗參考', materialPrice: 120, sourceLabel: '市場暫估', status: '暫估', note: '簡報暫用' },
  { plantName: '使君子', category: 'groundcover', spec: '10–20cm寬、盆苗', materialPrice: 76, sourceLabel: '110工程會', status: '正式參考', note: '工程會具體規格', sourceUrl: 'https://www.pcc.gov.tw/' },
  { plantName: '波斯頓蕨', category: 'groundcover', spec: '5吋吊盆', materialPrice: 100, sourceLabel: '田尾市場價', status: '市場參考', note: '公開商品價', sourceUrl: 'https://www.twr.com.tw/productlist.asp?Page=59&mode=&pid=&pricemode=high' },
  { plantName: '爬牆虎', category: 'groundcover', spec: '3吋級藤本苗', materialPrice: 50, sourceLabel: '市場暫估', status: '暫估', note: '簡報暫用' },
  { plantName: '狐尾武竹', category: 'groundcover', spec: '5吋盆', materialPrice: 110, sourceLabel: '台灣市場價', status: '市場參考', note: '公開商品價', sourceUrl: 'https://www.flowerworld.com.tw/products/index.php?group_id=17&keyword=&page=4&second_id=&useno=flowerworld' },
  { plantName: '金邊露兜', category: 'groundcover', spec: '盆苗參考', materialPrice: 120, sourceLabel: '市場暫估', status: '暫估', note: '簡報暫用' },
  { plantName: '洋紅西番蓮', category: 'groundcover', spec: '藤本盆苗參考', materialPrice: 100, sourceLabel: '市場暫估', status: '暫估', note: '簡報暫用' },
  { plantName: '炮仗花', category: 'groundcover', spec: '藤本盆苗參考', materialPrice: 100, sourceLabel: '市場暫估', status: '暫估', note: '簡報暫用' },
  { plantName: '凌霄花', category: 'groundcover', spec: '藤本盆苗參考', materialPrice: 120, sourceLabel: '市場暫估', status: '暫估', note: '簡報暫用' },
  { plantName: '馬蹄金', category: 'groundcover', spec: '3吋盆', materialPrice: 40, sourceLabel: '台灣市場價', status: '市場參考', note: '公開商品價', sourceUrl: 'https://www.ruten.com.tw/item/22452494940667/' },
  { plantName: '斑葉月桃', category: 'groundcover', spec: '盆苗參考', materialPrice: 100, sourceLabel: '市場暫估', status: '暫估', note: '簡報暫用' },
  { plantName: '雲南黃馨', category: 'groundcover', spec: '盆苗參考', materialPrice: 80, sourceLabel: '市場暫估', status: '暫估', note: '簡報暫用' },
  { plantName: '臺灣油點草', category: 'groundcover', spec: '高度<20cm、寬<10cm、小盆苗', materialPrice: 30, sourceLabel: '110工程會', status: '正式參考', note: '以工程會『山油點草』硬對應', sourceUrl: 'https://www.pcc.gov.tw/' },
  { plantName: '臺灣野牡丹藤', category: 'groundcover', spec: '約10cm小苗', materialPrice: 15, sourceLabel: '市場參考', status: '市場參考', note: '原生植物/田尾同類公開價', sourceUrl: 'https://taiwanplant.org.tw/%E5%8E%9F%E7%94%9F%E6%A4%8D%E7%89%A9%E8%B3%BC%E8%B2%B7%E6%9C%8D%E5%8B%99%E5%B0%88%E5%8D%80/' },
  { plantName: '鳶尾花', category: 'groundcover', spec: '工程會『台灣鳶尾』工項', materialPrice: 125, sourceLabel: '110工程會', status: '正式參考', note: '名稱直接對應', sourceUrl: 'https://www.pcc.gov.tw/' },
  { plantName: '蔓綠絨', category: 'groundcover', spec: '3吋盆參考', materialPrice: 75, sourceLabel: '台灣市場價', status: '市場參考', note: '以3吋蔓綠絨公開商品價採用', sourceUrl: 'https://tw.bid.yahoo.com/item/101177915233' },
  { plantName: '錫葉藤', category: 'groundcover', spec: '藤本盆苗參考', materialPrice: 100, sourceLabel: '市場暫估', status: '暫估', note: '簡報暫用；後續再補正式商品規格' },
  { plantName: '薜荔', category: 'groundcover', spec: '3吋盆', materialPrice: 20, sourceLabel: '田尾市場價', status: '市場參考', note: '公開商品價', sourceUrl: 'https://www.twr.com.tw/product_one.asp?guid=B7E55758-5499-4D42-B00A-A17513CA8AEF' },
  { plantName: '闊葉麥門冬', category: 'groundcover', spec: '3吋盆、高15–20cm', materialPrice: 72, sourceLabel: '台灣市場價', status: '市場參考', note: '公開商品最低規格價', sourceUrl: 'https://shopee.tw/%E8%8A%B1%E7%94%B0%E9%87%8C_%E8%8D%89%E6%9C%AC%E6%A4%8D%E7%89%A9-%E9%97%8A%E8%91%89%E9%BA%A5%E9%96%80%E5%86%AC-%E5%A4%A7%E8%91%89%E9%BA%A5%E9%96%80%E5%86%AC-3%E5%90%8B-6%E5%90%8B%E7%9B%86%E9%AB%9815~20CM-i.116400467.11609413740' },
];

function toSourceMeta(label: string): { sourceType: PlantPrice['sourceType']; sourceYear?: number; priceSource: string } {
  if (label === '110工程會') return { sourceType: 'gov', sourceYear: 110, priceSource: '110年度公共工程植栽材料價格參考表' }
  if (label === '112工程會') return { sourceType: 'gov', sourceYear: 112, priceSource: '112年度公共工程植栽材料價格參考表' }
  return { sourceType: 'market', priceSource: label }
}

export const GAP_FILL_79_20260819_PRICE_SEED: PlantPrice[] = ROWS.map((r, i) => {
  const meta = toSourceMeta(r.sourceLabel)
  return {
    id: `seed-gapfill79-20260819-${r.plantName}-${i}`,
    plantName: r.plantName,
    category: r.category,
    specification: r.spec,
    pricingUnit: 'plant' as const,
    // 這批是「材料參考價」，不是連工帶料單價——不能直接當成正式計價用的 unitPrice，
    // 只留在 legacyMaterialPrice 供核對用（見 types/estimate.ts 的價格模型說明）。
    legacyMaterialPrice: r.materialPrice,
    ...meta,
    note: `${r.note}（狀態：${r.status}）`,
    sourceUrl: r.sourceUrl,
    isProvisional: r.status === '暫估',
  }
})
