// ============================================================
// 永豐 AI 建築面積計算平台 — MVP v1.2
// floorsById map 結構，確保每層資料完全獨立
// ============================================================

const { useState, useMemo, useRef, useEffect } = React;

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────

const MOCK_PROJECT = {
  id: 'PRJ-2024-001',
  name: 'XX集合住宅新建工程',
  savedAt: '14:35',
  user: '王小明',
};

// ─────────────────────────────────────────────
// PROJECT INFO — 所有頁面、預覽、PDF/Excel 共用此來源
// ─────────────────────────────────────────────

const INITIAL_PROJECT_INFO = {
  projectName:               'XX集合住宅新建工程',
  buildingLocation:          '台中市南屯區大墩段 852、853、853-1 地號等 3 筆土地',
  zoning:                    '第四種住宅區',
  buildingCoverageRateLimit:  60,    // %
  floorAreaRatioLimit:        500,   // %
  buildingType:              '新建',
  buildingUsage:             '店舖、集合住宅、停車空間、機電設備空間',
  siteArea:                   2591.00,
  legalBuildingCoverageRate:  60,
  legalFloorAreaRatio:        500,
  householdInfo: {
    shopUnits:         4,
    residentialUnits:  364,
    totalUnits:        368,
  },
  floorCount: {
    aboveGround: 29,
    underground:  7,
    roof:         3,
  },
  structureType:  '鋼筋混凝土造',
  buildingHeight: '依各層高度加總',
  designOffice:   'XX建築師事務所',
  bonusVolume:    10364.00,  // 獎勵容積（都更/宜居/綠建築等），第一版手動輸入
  preparedBy:     '王小明',
  preparedDate:   '114.05.01',
  version:        '送審版 A',
  page:           '1 / 1',
  landLots: [
    { lotNumber: '852',   area: 581.00  },
    { lotNumber: '853',   area: 1140.00 },
    { lotNumber: '853-1', area: 870.00  },
  ],
};

const MENU_ITEMS = [
  { id: 'input',       label: '資料輸入區',      type: 'header' },
  { id: '1',           label: '基地基本資料',     type: 'item', step: 1 },
  { id: '2',           label: '樓層設定',         type: 'item', step: 2 },
  { id: '3',           label: '各層面積明細',     type: 'item', step: 3 },
  { id: '4',           label: '樓層面積彙整',     type: 'item', step: 4 },
  { id: '5',           label: '停車空間檢討',     type: 'item', step: 5 },
  { id: '6',           label: '建蔽率檢討',       type: 'item', step: 6 },
  { id: '7',           label: '容積率檢討',       type: 'item', step: 7 },
  { id: '8',           label: '法定空地檢討',     type: 'item', step: 8 },
  { id: '9',           label: '防空避難室檢討',   type: 'item', step: 9 },
  { id: '10',          label: '大總表預覽',       type: 'item', step: 10 },
  { id: 'mgmt',        label: '資料管理',         type: 'header' },
  { id: 'projects',    label: '專案列表',         type: 'item' },
  { id: 'templates',   label: '法規模板庫',       type: 'item' },
  { id: 'importexport',label: '匯入／匯出記錄',  type: 'item' },
  { id: 'versions',    label: '版本記錄',         type: 'item' },
];

// 樓層順序定義（不含實際面積資料，只有 meta）
const FLOOR_DEFINITIONS = [
  { id: 'B3F', name: '地下三層', usage: '停車空間', height: 3.00 },
  { id: 'B2F', name: '地下二層', usage: '停車空間', height: 3.00 },
  { id: 'B1F', name: '地下一層', usage: '停車空間', height: 3.00 },
  { id: '1F',  name: '一層',     usage: '店舖',     height: 4.20 },
  { id: '2F',  name: '二層',     usage: '集合住宅', height: 3.20 },
  { id: '3F',  name: '三層',     usage: '集合住宅', height: 3.20 },
  { id: '4F',  name: '四層',     usage: '集合住宅', height: 3.20 },
  { id: '5F',  name: '五層',     usage: '集合住宅', height: 3.20 },
  { id: '6F',  name: '六層',     usage: '集合住宅', height: 3.20 },
  { id: '7F',  name: '七層',     usage: '集合住宅', height: 3.20 },
  { id: '8F',  name: '八層',     usage: '集合住宅', height: 3.20 },
  { id: '9F',  name: '九層',     usage: '集合住宅', height: 3.20 },
  { id: '10F', name: '十層',     usage: '集合住宅', height: 3.20 },
  { id: '11F', name: '十一層',   usage: '集合住宅', height: 3.20 },
  { id: '12F', name: '十二層',   usage: '集合住宅', height: 3.20 },
  { id: 'RF1', name: '屋突一層', usage: '機械房',   height: 2.60 },
  { id: 'RF2', name: '屋突二層', usage: '水箱間',   height: 2.40 },
];

// ─────────────────────────────────────────────
// MOCK DATA GENERATORS
// ─────────────────────────────────────────────

const BASE_UNITS = [
  { unit: 'A1', use: '住宅', indoor: 68.71 },
  { unit: 'A2', use: '住宅', indoor: 72.31 },
  { unit: 'A3', use: '住宅', indoor: 53.41 },
  { unit: 'A5', use: '住宅', indoor: 50.62 },
  { unit: 'A6', use: '住宅', indoor: 53.52 },
  { unit: 'A7', use: '住宅', indoor: 50.39 },
  { unit: 'B1', use: '住宅', indoor: 50.62 },
  { unit: 'B2', use: '住宅', indoor: 53.51 },
  { unit: 'B3', use: '住宅', indoor: 53.51 },
  { unit: 'B5', use: '住宅', indoor: 70.23 },
  { unit: 'B6', use: '住宅', indoor: 70.95 },
  { unit: 'B7', use: '住宅', indoor: 51.97 },
  { unit: 'B8', use: '住宅', indoor: 50.76 },
  { unit: 'B9', use: '住宅', indoor: 52.32 },
];

// 每層陽台 <2M 面積（A1、A2、B5、B6 隨樓高遞減；其餘固定）
const FLOOR_BALCONY = {
  '5F':  [11.17, 7.52, 3.90, 3.90, 3.90, 3.90, 3.90, 3.90, 3.90,  8.90, 9.38, 3.90, 3.90, 5.15],
  '6F':  [11.05, 7.42, 3.90, 3.90, 3.90, 3.90, 3.90, 3.90, 3.90,  8.75, 9.25, 3.90, 3.90, 5.15],
  '7F':  [10.95, 7.35, 3.90, 3.90, 3.90, 3.90, 3.90, 3.90, 3.90,  8.60, 9.12, 3.90, 3.90, 5.15],
  '8F':  [10.82, 7.22, 3.90, 3.90, 3.90, 3.90, 3.90, 3.90, 3.90,  8.43, 8.95, 3.90, 3.90, 5.15],
  '9F':  [10.68, 7.12, 3.90, 3.90, 3.90, 3.90, 3.90, 3.90, 3.90,  8.27, 8.80, 3.90, 3.90, 5.15],
  '10F': [10.55, 7.02, 3.90, 3.90, 3.90, 3.90, 3.90, 3.90, 3.90,  8.12, 8.65, 3.90, 3.90, 5.15],
  '11F': [10.43, 6.90, 3.90, 3.90, 3.90, 3.90, 3.90, 3.90, 3.90,  7.98, 8.52, 3.90, 3.90, 5.15],
  '12F': [10.30, 6.78, 3.90, 3.90, 3.90, 3.90, 3.90, 3.90, 3.90,  7.85, 8.38, 3.90, 3.90, 5.15],
};
const FLOOR_BALCONY_OVER = {
  '5F':  [0.22, 0.18, 0, 0, 0, 0, 0, 0, 0, 0.39, 0.18, 0, 0, 0],
  '6F':  [0.20, 0.16, 0, 0, 0, 0, 0, 0, 0, 0.35, 0.15, 0, 0, 0],
  '7F':  [0.18, 0.14, 0, 0, 0, 0, 0, 0, 0, 0.31, 0.12, 0, 0, 0],
  '8F':  [0.16, 0.12, 0, 0, 0, 0, 0, 0, 0, 0.27, 0.10, 0, 0, 0],
  '9F':  [0.14, 0.10, 0, 0, 0, 0, 0, 0, 0, 0.23, 0.08, 0, 0, 0],
  '10F': [0.12, 0.08, 0, 0, 0, 0, 0, 0, 0, 0.19, 0.06, 0, 0, 0],
  '11F': [0.10, 0.06, 0, 0, 0, 0, 0, 0, 0, 0.15, 0.04, 0, 0, 0],
  '12F': [0.08, 0.04, 0, 0, 0, 0, 0, 0, 0, 0.11, 0.02, 0, 0, 0],
};

function mkPrivate(floorId) {
  const bal  = FLOOR_BALCONY[floorId]      || FLOOR_BALCONY['5F'];
  const over = FLOOR_BALCONY_OVER[floorId] || FLOOR_BALCONY_OVER['5F'];
  return BASE_UNITS.map((u, i) => ({
    id:          `${floorId}_${u.unit}`,
    unit:        u.unit,
    use:         u.use,
    indoor:      u.indoor,
    balcony:     bal[i],
    balconyOver: over[i],
    subtotal:    +(u.indoor + over[i]).toFixed(2),
    note:        over[i] > 0 ? '宜居陽台' : '-',
  }));
}

function mkShared(floorId, hallArea, b2Extra) {
  const art162 = [
    { name: '一般昇降機',     area: 13.89 },
    { name: '特別安全梯(A1)', area: 17.59 },
    { name: '特別安全梯(A2)', area: 19.62 },
    { name: '特別安全梯(B1)', area: 17.59 },
    { name: '特別安全梯(B2)', area: +(16.71 + b2Extra).toFixed(2) },
    { name: '緊急昇降機',     area: 16.62 },
    { name: '機電設備空間',   area: 23.38 },
  ];
  return [
    { id: `${floorId}_hall`, name: '梯廳兼排煙室', area: hallArea, inFloor: '是', inFAR: '條件判斷', rule: '梯廳10%',  note: '-' },
    ...art162.map((item, i) => ({
      id: `${floorId}_s${i}`, name: item.name, area: item.area,
      inFloor: '是', inFAR: '免計判斷', rule: '第162條', note: '-',
    })),
  ];
}

// ─────────────────────────────────────────────
// BUILD floorsById  { [floorId]: floorData }
//
// floorData = {
//   privateItems: [],
//   sharedItems:  [],
//   sourceFloor:  string | null,   // 複製來源 id
//   isOverridden: boolean,         // 來自標準層後是否手動改過
// }
//
// FLOOR_DEFINITIONS 存 meta（名稱/用途/高度），
// floorsById 只存可編輯的面積資料。
// ─────────────────────────────────────────────

function buildFloorsById() {
  const map = {};

  // 停車層
  ['B3F','B2F','B1F'].forEach((id, i) => {
    const areas = [2110.12, 2102.52, 1522.21];
    map[id] = {
      privateItems: [],
      sharedItems: [{ id: `${id}_s0`, name: '停車設備空間', area: areas[i], inFloor: '是', inFAR: '免計判斷', rule: '第162條', note: '-' }],
      sourceFloor: null, isOverridden: false,
    };
  });

  // 一層 (店舖)
  map['1F'] = {
    privateItems: [
      { id: '1F_S1', unit: 'S1', use: '店舖', indoor: 420.50, balcony: 38.20, balconyOver: 0, subtotal: 420.50, note: '騎樓' },
      { id: '1F_S2', unit: 'S2', use: '店舖', indoor: 385.30, balcony: 32.10, balconyOver: 0, subtotal: 385.30, note: '-' },
      { id: '1F_S3', unit: 'S3', use: '店舖', indoor: 310.20, balcony: 28.90, balconyOver: 0, subtotal: 310.20, note: '-' },
    ],
    sharedItems: [
      { id: '1F_h0', name: '梯廳兼排煙室', area: 102.50, inFloor: '是', inFAR: '條件判斷', rule: '梯廳10%', note: '-' },
      { id: '1F_s0', name: '一般昇降機',   area: 13.89,  inFloor: '是', inFAR: '免計判斷', rule: '第162條', note: '-' },
      { id: '1F_s1', name: '特別安全梯(A)',area: 21.30,  inFloor: '是', inFAR: '免計判斷', rule: '第162條', note: '-' },
      { id: '1F_s2', name: '特別安全梯(B)',area: 19.80,  inFloor: '是', inFAR: '免計判斷', rule: '第162條', note: '-' },
    ],
    sourceFloor: null, isOverridden: false,
  };

  // 二～四層（不同格局）
  const lowerVariants = {
    '2F': { balScale: 0.88, b2Extra: 0,    hallArea: 101.30 },
    '3F': { balScale: 0.92, b2Extra: 0,    hallArea: 100.80 },
    '4F': { balScale: 0.96, b2Extra: 0,    hallArea: 98.72  },
  };
  Object.entries(lowerVariants).forEach(([fid, v]) => {
    const privBase = mkPrivate('5F');
    map[fid] = {
      privateItems: privBase.map((p, i) => ({
        ...p,
        id:      `${fid}_${BASE_UNITS[i].unit}`,
        balcony: +(p.balcony * v.balScale).toFixed(2),
      })),
      sharedItems: mkShared(fid, v.hallArea, v.b2Extra),
      sourceFloor: null, isOverridden: false,
    };
  });

  // 五～十二層（每層各自生成，陽台資料來自 FLOOR_BALCONY）
  const stdExtras = { '5F':0, '6F':0.49, '7F':0.79, '8F':1.09, '9F':1.12, '10F':1.48, '11F':1.69, '12F':1.89 };
  Object.entries(stdExtras).forEach(([fid, extra]) => {
    map[fid] = {
      privateItems: mkPrivate(fid),          // 各層獨立產生，無 reference 共用
      sharedItems:  mkShared(fid, 98.72, extra),
      sourceFloor:  fid === '5F' ? null : '5F',   // 6F-12F 預設來自 5F 標準層
      isOverridden: false,
    };
  });

  // 屋突
  map['RF1'] = {
    privateItems: [],
    sharedItems: [
      { id: 'RF1_s0', name: '機電設備間', area: 85.20, inFloor: '是', inFAR: '免計判斷', rule: '第162條', note: '-' },
      { id: 'RF1_s1', name: '電梯機房',   area: 22.50, inFloor: '是', inFAR: '免計判斷', rule: '第162條', note: '-' },
    ],
    sourceFloor: null, isOverridden: false,
  };
  map['RF2'] = {
    privateItems: [],
    sharedItems: [
      { id: 'RF2_s0', name: '水箱間', area: 42.30, inFloor: '是', inFAR: '免計判斷', rule: '第162條', note: '-' },
    ],
    sourceFloor: null, isOverridden: false,
  };

  return map;
}

// ─────────────────────────────────────────────
// DERIVED CALCULATIONS
// ─────────────────────────────────────────────

function computeFloorStats(floorData) {
  const priv   = floorData.privateItems || [];
  const shared = floorData.sharedItems  || [];

  const privateIndoor      = priv.reduce((s, r) => s + Number(r.indoor      || 0), 0);
  const privateBalcony     = priv.reduce((s, r) => s + Number(r.balcony     || 0), 0);
  const privateBalconyOver = priv.reduce((s, r) => s + Number(r.balconyOver || 0), 0);
  const privateSubtotal    = priv.reduce((s, r) => s + Number(r.subtotal    || 0), 0);

  const sharedTotal = shared.reduce((s, r) => s + Number(r.area || 0), 0);
  const hallArea    = shared.find(r => r.rule === '梯廳10%')?.area || 0;
  const art162Total = shared.filter(r => r.rule === '第162條').reduce((s, r) => s + Number(r.area || 0), 0);

  const floorArea  = privateSubtotal + sharedTotal;
  const limit10    = floorArea * 0.10;
  const limit15    = floorArea * 0.15;
  const combinedSum = privateBalcony + Number(hallArea);
  const over15     = Math.max(0, combinedSum - limit15);
  const farArea    = floorArea - Number(hallArea) - art162Total + over15;

  return { privateIndoor, privateBalcony, privateBalconyOver, privateSubtotal,
           sharedTotal, hallArea, art162Total,
           floorArea, limit10, limit15, combinedSum, over15, farArea };
}

// ─────────────────────────────────────────────
// SUMMARY FUNCTIONS
// 所有大總表資料都由此產生，不使用任何固定假資料
// ─────────────────────────────────────────────

/**
 * getFloorSummary(floorDef, floorData)
 * 從單層的定義 + 資料計算出大總表一列所需的所有欄位。
 * @param {{ id, name, usage, height }} floorDef  — 來自 FLOOR_DEFINITIONS
 * @param {{ privateItems, sharedItems, sourceFloor, isOverridden }} floorData — 來自 floorsById[id]
 * @returns {{
 *   floorId, floorName, usage, height,
 *   floorArea,       // 樓地板面積 = privateSubtotal + sharedTotal（inFloor=是）
 *   privateIndoor,   // 專有部份室內面積合計
 *   balconyArea,     // 陽台面積 <2M 合計
 *   balconyOver2m,   // 陽台超過2M部分合計（宜居建築垂直綠化設施）
 *   article162Area,  // 第162條第二項設置空間合計
 *   hallArea,        // 梯廳面積
 *   floorVolume,     // 當層容積 = floorArea - hallArea - article162Area + over15
 *   over15,          // 陽台＋梯廳超過15%計入容積部分
 *   isOverridden,
 *   sourceFloor,
 * }}
 */
function getFloorSummary(floorDef, floorData) {
  const priv   = floorData.privateItems || [];
  const shared = floorData.sharedItems  || [];

  // 專有部份
  const privateIndoor   = priv.reduce((s, r) => s + Number(r.indoor      || 0), 0);
  const balconyArea     = priv.reduce((s, r) => s + Number(r.balcony     || 0), 0);
  const balconyOver2m   = priv.reduce((s, r) => s + Number(r.balconyOver || 0), 0);
  // subtotal = indoor + balconyOver2m（陽台超過2M計入）
  const privateSubtotal = priv.reduce((s, r) => s + Number(r.subtotal    || 0), 0);

  // 共用部份（只計 inFloor=是）
  const sharedInFloor  = shared.filter(r => r.inFloor === '是');
  const sharedTotal    = sharedInFloor.reduce((s, r) => s + Number(r.area || 0), 0);
  const hallArea       = shared.find(r => r.rule === '梯廳10%')?.area || 0;
  const article162Area = shared
    .filter(r => r.rule === '第162條')
    .reduce((s, r) => s + Number(r.area || 0), 0);

  // 樓地板面積
  const floorArea = privateSubtotal + sharedTotal;

  // 容積檢討
  const limit15    = floorArea * 0.15;
  const combinedSum = balconyArea + Number(hallArea);
  const over15     = Math.max(0, combinedSum - limit15);
  const floorVolume = floorArea - Number(hallArea) - article162Area + over15;

  return {
    floorId:       floorDef.id,
    floorName:     floorDef.name,
    usage:         floorDef.usage,
    height:        floorDef.height,
    floorArea,
    privateIndoor,
    balconyArea,
    balconyOver2m,
    article162Area,
    hallArea,
    floorVolume,
    over15,
    isOverridden:  floorData.isOverridden,
    sourceFloor:   floorData.sourceFloor,
  };
}

/**
 * getAllFloorSummaries(floorsById)
 * 依 FLOOR_DEFINITIONS 順序，對所有樓層呼叫 getFloorSummary，
 * 回傳可直接 render 大總表的列陣列。
 * dependency 為 floorsById 整個 map，任何一層變動都會觸發重算。
 */
function getAllFloorSummaries(floorsById) {
  return FLOOR_DEFINITIONS.map(def => getFloorSummary(def, floorsById[def.id]));
}

// ─────────────────────────────────────────────
// PROJECT-WIDE SUMMARY CALCULATION
// 全案即時總量計算 — dependency: floorsById + projectInfo
// ─────────────────────────────────────────────

/**
 * calculateProjectSummary(floorsById, projectInfo)
 * 加總所有樓層資料，計算全案容積總量與法規檢核狀態。
 * 任何一層 privateItems / sharedItems 異動都會觸發重算。
 */
function calculateProjectSummary(floorsById, projectInfo) {
  const rows = getAllFloorSummaries(floorsById);

  const totalFloorArea      = rows.reduce((s, r) => s + r.floorArea,       0);
  const totalBalconyArea    = rows.reduce((s, r) => s + r.balconyArea,     0);
  const totalGreenArea      = rows.reduce((s, r) => s + r.balconyOver2m,   0);
  const totalArticle162Area = rows.reduce((s, r) => s + r.article162Area,  0);
  const totalFloorVolume    = rows.reduce((s, r) => s + r.floorVolume,     0);

  // 容積基準
  const legalBaseVolume  = projectInfo.siteArea * projectInfo.legalFloorAreaRatio / 100;
  const bonusVolume      = projectInfo.bonusVolume || 0;
  const maxAllowedVolume = legalBaseVolume + bonusVolume;

  // 剩餘 / 超量
  const remainingVolume  = maxAllowedVolume - totalFloorVolume;
  const exceededVolume   = Math.max(0, totalFloorVolume - maxAllowedVolume);

  // 使用率 (%)
  const usageRate = maxAllowedVolume > 0
    ? Math.min(999, (totalFloorVolume / maxAllowedVolume) * 100)
    : 0;

  // 實設容積率
  const actualFAR = projectInfo.siteArea > 0
    ? (totalFloorVolume / projectInfo.siteArea) * 100
    : 0;

  // 狀態判斷
  let status;
  if      (remainingVolume < 0)    status = '超量';
  else if (remainingVolume <= 100) status = '接近上限';
  else                             status = '符合';

  return {
    totalFloorArea, totalBalconyArea, totalGreenArea, totalArticle162Area,
    totalFloorVolume, legalBaseVolume, bonusVolume, maxAllowedVolume,
    remainingVolume, exceededVolume, usageRate, actualFAR, status,
  };
}

// ─────────────────────────────────────────────
// UTILITY
// ─────────────────────────────────────────────

const fmt = (n, d = 2) => (n == null || isNaN(Number(n))) ? '-' : Number(n).toFixed(d);

// 真正的深層複製 — 完全切斷 reference
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ─────────────────────────────────────────────
// TOP BAR
// ─────────────────────────────────────────────

function TopBar({ project, onExportPDF, onExportExcel, onValidate }) {
  return (
    <div style={{ height: 52 }} className="flex items-center px-4 bg-white border-b border-gray-200 gap-4 shrink-0 shadow-sm z-10">
      <div className="flex items-center gap-2 shrink-0">
        <div className="w-7 h-7 bg-blue-700 rounded flex items-center justify-center">
          <span className="text-white text-xs font-bold">YF</span>
        </div>
        <span className="font-semibold text-gray-800 text-sm whitespace-nowrap">永豐 AI 建築面積計算平台</span>
      </div>
      <div className="w-px h-5 bg-gray-200 shrink-0" />
      <div className="flex items-center gap-1 shrink-0">
        <span className="text-xs text-gray-500">專案：</span>
        <select className="text-sm border border-gray-300 rounded px-2 py-0.5 bg-white text-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-400">
          <option>{project.name}</option>
        </select>
      </div>
      <div className="flex items-center gap-1 text-xs text-gray-400 shrink-0">
        <svg className="w-3.5 h-3.5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
        <span>已儲存 {project.savedAt}</span>
      </div>
      <div className="flex-1" />
      <button onClick={onValidate} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-gray-300 rounded text-gray-600 hover:bg-gray-50 transition-colors">
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>
        檢核全部
      </button>
      <button onClick={onExportPDF} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-red-50 border border-red-200 rounded text-red-700 hover:bg-red-100 transition-colors">
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
        匯出 PDF
      </button>
      <button onClick={onExportExcel} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-green-50 border border-green-200 rounded text-green-700 hover:bg-green-100 transition-colors">
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
        匯出 Excel
      </button>
      <div className="w-px h-5 bg-gray-200 shrink-0" />
      <div className="flex items-center gap-1.5 shrink-0">
        <div className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center">
          <span className="text-white text-xs font-semibold">王</span>
        </div>
        <span className="text-xs text-gray-600">{project.user}</span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// SIDEBAR
// ─────────────────────────────────────────────

function Sidebar({ activeId, onSelect }) {
  return (
    <div style={{ width: 196 }} className="bg-white border-r border-gray-200 flex flex-col shrink-0 overflow-y-auto">
      <div className="py-2">
        {MENU_ITEMS.map((item) => {
          if (item.type === 'header') return (
            <div key={item.id} className="px-4 pt-4 pb-1">
              <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{item.label}</span>
            </div>
          );
          const isActive = activeId === item.id;
          return (
            <button key={item.id} onClick={() => onSelect(item.id)}
              className={`w-full text-left flex items-center gap-2 px-4 py-2 text-sm transition-colors ${
                isActive ? 'bg-blue-50 text-blue-700 font-medium border-r-2 border-blue-600' : 'text-gray-600 hover:bg-gray-50'
              }`}
            >
              {item.step
                ? <span className={`w-5 h-5 rounded-full text-xs flex items-center justify-center shrink-0 font-medium ${isActive ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-500'}`}>{item.step}</span>
                : <span className="w-5 h-5 shrink-0" />
              }
              <span className="leading-tight">{item.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// FLOOR TABS
// ─────────────────────────────────────────────

function FloorTabs({ floorsById, activeFloorId, onSelect }) {
  const scrollRef = useRef(null);

  useEffect(() => {
    const el = scrollRef.current?.querySelector('[data-active="true"]');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, [activeFloorId]);

  return (
    <div className="bg-white border-b border-gray-200">
      <div ref={scrollRef} className="flex overflow-x-auto" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
        {FLOOR_DEFINITIONS.map((def) => {
          const floorData = floorsById[def.id];
          const isActive = def.id === activeFloorId;
          const isOverridden = floorData?.isOverridden;
          const hasSource = floorData?.sourceFloor;
          return (
            <button
              key={def.id}
              data-active={isActive}
              onClick={() => onSelect(def.id)}
              className={`flex items-center gap-1 px-3 py-2.5 text-xs whitespace-nowrap border-b-2 transition-colors shrink-0 ${
                isActive
                  ? 'border-blue-600 text-blue-700 bg-blue-50 font-semibold'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'
              }`}
            >
              {def.name}
              {isOverridden && (
                <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-amber-100 text-amber-600 text-xs font-bold leading-none" title="已覆寫">✎</span>
              )}
              {!isOverridden && hasSource && (
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-300" title="來自標準層" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// FLOOR SUMMARY BAR（含資料來源診斷資訊）
// ─────────────────────────────────────────────

function FloorSummaryBar({ def, floorData, stats, floorIndex, onPrev, onNext }) {
  const sourceDef = floorData.sourceFloor
    ? FLOOR_DEFINITIONS.find(d => d.id === floorData.sourceFloor)
    : null;

  const dataSourceLabel = floorData.sourceFloor
    ? `複製自${sourceDef?.name ?? floorData.sourceFloor}`
    : `${def.name}獨立資料`;

  return (
    <div className="bg-gray-50 border-b border-gray-200 px-4 py-2 flex flex-wrap items-start gap-y-1.5">
      {/* 上下層導航 + 標題 */}
      <div className="flex items-center gap-2 mr-4 shrink-0">
        <button onClick={onPrev} disabled={floorIndex === 0}
          className="w-6 h-6 flex items-center justify-center rounded border border-gray-300 text-gray-500 hover:bg-white disabled:opacity-30 disabled:cursor-not-allowed text-xs">‹</button>
        <div>
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-bold text-gray-800">{def.name}</span>
            {floorData.isOverridden && (
              <span className="text-xs bg-amber-100 border border-amber-300 text-amber-700 rounded px-1.5 py-0.5 font-semibold">已覆寫</span>
            )}
            {!floorData.isOverridden && floorData.sourceFloor && (
              <span className="text-xs bg-blue-50 border border-blue-200 text-blue-500 rounded px-1.5 py-0.5">來自標準層</span>
            )}
          </div>
        </div>
        <button onClick={onNext} disabled={floorIndex === FLOOR_DEFINITIONS.length - 1}
          className="w-6 h-6 flex items-center justify-center rounded border border-gray-300 text-gray-500 hover:bg-white disabled:opacity-30 disabled:cursor-not-allowed text-xs">›</button>
      </div>

      {/* 面積摘要 */}
      <div className="flex items-center divide-x divide-gray-300 flex-wrap gap-y-1 mr-4">
        {[
          ['用途',      def.usage],
          ['高度',      `${fmt(def.height, 2)} m`],
          ['樓地板',    `${fmt(stats.floorArea)} ㎡`],
          ['陽台',      `${fmt(stats.privateBalcony)} ㎡`],
          ['162條',     `${fmt(stats.art162Total)} ㎡`],
          ['當層容積',  `${fmt(stats.farArea)} ㎡`],
        ].map(([label, val]) => (
          <div key={label} className="px-2.5 first:pl-0 flex flex-col leading-tight">
            <span className="text-xs text-gray-400">{label}</span>
            <span className="text-xs font-semibold text-gray-700">{val}</span>
          </div>
        ))}
      </div>

      {/* 診斷資訊 */}
      <div className="ml-auto flex flex-col items-end justify-center gap-0.5 shrink-0">
        <div className="flex items-center gap-1 text-xs text-gray-400">
          <span className="font-medium text-gray-500">目前編輯：</span>
          <span className="text-gray-700">{def.name}</span>
        </div>
        <div className="flex items-center gap-1 text-xs text-gray-400">
          <span className="font-medium text-gray-500">資料來源：</span>
          <span className="text-gray-600">{dataSourceLabel}</span>
        </div>
        <div className="flex items-center gap-1 text-xs text-gray-400">
          <span className="font-medium text-gray-500">是否覆寫：</span>
          {floorData.isOverridden
            ? <span className="text-amber-600 font-semibold">是</span>
            : <span className="text-gray-500">否</span>
          }
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// EDITABLE CELL
// ─────────────────────────────────────────────

function EditableCell({ value, onChange, align = 'right' }) {
  return (
    <td className="editable-cell border border-gray-200 px-1 py-0.5">
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} style={{ textAlign: align }} />
    </td>
  );
}

// ─────────────────────────────────────────────
// TABLE: 專有部份
// ─────────────────────────────────────────────

function PrivateAreaTable({ rows, onChange }) {
  const totals = useMemo(() => ({
    indoor:      rows.reduce((s, r) => s + Number(r.indoor      || 0), 0),
    balcony:     rows.reduce((s, r) => s + Number(r.balcony     || 0), 0),
    balconyOver: rows.reduce((s, r) => s + Number(r.balconyOver || 0), 0),
    subtotal:    rows.reduce((s, r) => s + Number(r.subtotal    || 0), 0),
  }), [rows]);

  // 只更新這一列，其餘 row 維持 reference
  const updateRow = (id, field, val) =>
    onChange(rows.map(r => r.id === id ? { ...r, [field]: val } : r));
  const deleteRow = (id) => onChange(rows.filter(r => r.id !== id));

  const th = "border border-gray-300 bg-gray-50 px-2 py-1.5 text-xs font-semibold text-gray-600 whitespace-nowrap";
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr>
            <th className={th} style={{ width: 50  }}>編號</th>
            <th className={th} style={{ width: 60  }}>用途</th>
            <th className={th} style={{ width: 90  }}>室內面積(㎡)</th>
            <th className={th} style={{ width: 100 }}>陽台面積(&lt;2M)</th>
            <th className={th} style={{ width: 110 }}>陽台超過2M部分</th>
            <th className={th} style={{ width: 90  }}>小計(㎡)</th>
            <th className={th} style={{ width: 100 }}>備註</th>
            <th className={th} style={{ width: 40  }}>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0
            ? <tr><td colSpan={8} className="border border-gray-200 py-6 text-center text-xs text-gray-400">尚無專有部份資料 — 點「＋ 新增戶別」加入</td></tr>
            : rows.map(row => (
                <tr key={row.id} className="hover:bg-blue-50/30 transition-colors">
                  <EditableCell value={row.unit}        onChange={v => updateRow(row.id, 'unit',        v)} align="left" />
                  <EditableCell value={row.use}         onChange={v => updateRow(row.id, 'use',         v)} align="left" />
                  <EditableCell value={row.indoor}      onChange={v => updateRow(row.id, 'indoor',      v)} />
                  <EditableCell value={row.balcony}     onChange={v => updateRow(row.id, 'balcony',     v)} />
                  <EditableCell value={row.balconyOver} onChange={v => updateRow(row.id, 'balconyOver', v)} />
                  <td className="border border-gray-200 px-2 py-0.5 text-right font-medium text-blue-800 bg-blue-50/40">
                    {fmt(Number(row.indoor || 0) + Number(row.balconyOver || 0))}
                  </td>
                  <EditableCell value={row.note} onChange={v => updateRow(row.id, 'note', v)} align="left" />
                  <td className="border border-gray-200 px-1 py-0.5 text-center">
                    <button onClick={() => deleteRow(row.id)} className="text-red-400 hover:text-red-600 text-xs px-1">✕</button>
                  </td>
                </tr>
              ))
          }
        </tbody>
        <tfoot>
          <tr className="bg-gray-100 font-semibold">
            <td className="border border-gray-300 px-2 py-1.5 text-xs" colSpan={2}>小計</td>
            <td className="border border-gray-300 px-2 py-1.5 text-xs text-right">{fmt(totals.indoor)}</td>
            <td className="border border-gray-300 px-2 py-1.5 text-xs text-right">{fmt(totals.balcony)}</td>
            <td className="border border-gray-300 px-2 py-1.5 text-xs text-right">{fmt(totals.balconyOver)}</td>
            <td className="border border-gray-300 px-2 py-1.5 text-xs text-right text-blue-700">{fmt(totals.subtotal)}</td>
            <td className="border border-gray-300" colSpan={2} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ─────────────────────────────────────────────
// TABLE: 共用部份
// ─────────────────────────────────────────────

function CommonAreaTable({ rows, onChange }) {
  const total = useMemo(() => rows.reduce((s, r) => s + Number(r.area || 0), 0), [rows]);
  const updateRow = (id, field, val) =>
    onChange(rows.map(r => r.id === id ? { ...r, [field]: val } : r));
  const deleteRow = (id) => onChange(rows.filter(r => r.id !== id));

  const th = "border border-gray-300 bg-gray-50 px-2 py-1.5 text-xs font-semibold text-gray-600 whitespace-nowrap";
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr>
            <th className={th} style={{ width: 160 }}>項目名稱</th>
            <th className={th} style={{ width: 90  }}>面積(㎡)</th>
            <th className={th} style={{ width: 80  }}>計入樓地板</th>
            <th className={th} style={{ width: 90  }}>計入容積</th>
            <th className={th} style={{ width: 90  }}>法規依據</th>
            <th className={th} style={{ width: 80  }}>備註</th>
            <th className={th} style={{ width: 40  }}>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0
            ? <tr><td colSpan={7} className="border border-gray-200 py-6 text-center text-xs text-gray-400">尚無共用部份資料 — 點「＋ 新增共用項目」加入</td></tr>
            : rows.map(row => (
                <tr key={row.id} className="hover:bg-blue-50/30 transition-colors">
                  <EditableCell value={row.name}  onChange={v => updateRow(row.id, 'name',  v)} align="left" />
                  <EditableCell value={row.area}  onChange={v => updateRow(row.id, 'area',  v)} />
                  <td className="border border-gray-200 px-2 py-0.5 text-center">
                    <select value={row.inFloor} onChange={e => updateRow(row.id, 'inFloor', e.target.value)}
                      className="text-xs border-0 bg-transparent focus:outline-none">
                      <option>是</option><option>否</option>
                    </select>
                  </td>
                  <td className={`border border-gray-200 px-2 py-0.5 text-center text-xs font-medium ${row.inFAR === '條件判斷' ? 'text-amber-600' : 'text-green-600'}`}>
                    {row.inFAR}
                  </td>
                  <EditableCell value={row.rule}  onChange={v => updateRow(row.id, 'rule',  v)} align="left" />
                  <EditableCell value={row.note}  onChange={v => updateRow(row.id, 'note',  v)} align="left" />
                  <td className="border border-gray-200 px-1 py-0.5 text-center">
                    <button onClick={() => deleteRow(row.id)} className="text-red-400 hover:text-red-600 text-xs px-1">✕</button>
                  </td>
                </tr>
              ))
          }
        </tbody>
        <tfoot>
          <tr className="bg-gray-100 font-semibold">
            <td className="border border-gray-300 px-2 py-1.5 text-xs">小計</td>
            <td className="border border-gray-300 px-2 py-1.5 text-xs text-right">{fmt(total)}</td>
            <td className="border border-gray-300" colSpan={5} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ─────────────────────────────────────────────
// AUTO CHECK CARD
// ─────────────────────────────────────────────

function AutoCheckCard({ stats }) {
  const { floorArea, privateBalcony, hallArea, art162Total, limit10, limit15, combinedSum, over15, farArea } = stats;

  const PassIcon = () => (
    <span className="inline-flex items-center gap-1 text-green-600 font-medium">
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>符合
    </span>
  );
  const WarnIcon = ({ msg }) => (
    <span className="inline-flex items-center gap-1 text-amber-600 font-medium">
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>{msg}
    </span>
  );

  return (
    <div className="bg-white border border-gray-200 rounded-lg">
      <div className="px-4 py-3 border-b border-gray-100 bg-gray-50 rounded-t-lg">
        <h3 className="text-sm font-semibold text-gray-700">
          <span className="inline-block w-5 h-5 rounded bg-indigo-600 text-white text-xs text-center leading-5 mr-1.5 font-bold">C</span>
          當層自動檢討
        </h3>
      </div>
      <div className="p-4 space-y-4">
        <div className="grid grid-cols-2 gap-x-6 gap-y-2">
          {[
            ['A. 當層樓地板面積', fmt(floorArea),   '㎡'],
            ['B. 陽台面積',       fmt(privateBalcony),'㎡'],
            ['C. 梯廳面積',       fmt(hallArea),     '㎡'],
            ['E. 第162條第二項設置空間', fmt(art162Total), '㎡'],
          ].map(([label, val, unit]) => (
            <div key={label} className="flex items-baseline justify-between gap-2 py-1 border-b border-gray-100">
              <span className="text-xs text-gray-500">{label}</span>
              <span className="text-xs font-semibold text-gray-800 whitespace-nowrap">{val} {unit}</span>
            </div>
          ))}
          <div className="flex items-baseline justify-between gap-2 py-1 border-b border-blue-100 col-span-2 bg-blue-50/40 px-2 rounded">
            <span className="text-xs font-medium text-blue-700">F. 當層容積</span>
            <span className="text-sm font-bold text-blue-700">{fmt(farArea)} ㎡</span>
          </div>
        </div>
        <div className="space-y-2 pt-1">
          {[
            { label: `陽台 10%：${fmt(privateBalcony)}㎡ < ${fmt(limit10)}㎡`, pass: privateBalcony < limit10 },
            { label: `梯廳 10%：${fmt(hallArea)}㎡ < ${fmt(limit10)}㎡`,       pass: hallArea < limit10 },
            {
              label: `陽台＋梯廳 15%：${fmt(combinedSum)}㎡ ${combinedSum <= limit15 ? '≤' : '>'} ${fmt(limit15)}㎡`,
              pass: combinedSum <= limit15,
              warnMsg: `超過 ${fmt(over15)}㎡ 計入容積`,
            },
          ].map((c, i) => (
            <div key={i} className={`flex items-center justify-between py-1.5 px-3 rounded border ${c.pass ? 'bg-gray-50 border-gray-100' : 'bg-amber-50 border-amber-200'}`}>
              <span className="text-xs text-gray-600">{c.label}</span>
              {c.pass ? <PassIcon /> : <WarnIcon msg={c.warnMsg || '超過'} />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// COPY TO FLOORS MODAL
// ─────────────────────────────────────────────

function CopyToFloorsModal({ sourceDef, floorsById, onCopy, onClose }) {
  const [selected, setSelected] = useState({});

  const toggle = (id) => setSelected(prev => ({ ...prev, [id]: !prev[id] }));
  const toggleAll = (val) => {
    const next = {};
    FLOOR_DEFINITIONS.forEach(d => { if (d.id !== sourceDef.id) next[d.id] = val; });
    setSelected(next);
  };

  const targets = FLOOR_DEFINITIONS.filter(d => d.id !== sourceDef.id);
  const selectedCount = Object.values(selected).filter(Boolean).length;

  const handleConfirm = () => {
    const targetIds = Object.keys(selected).filter(id => selected[id]);
    if (!targetIds.length) { alert('請勾選至少一個目標樓層'); return; }
    onCopy(sourceDef.id, targetIds);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-[480px] max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-gray-200">
          <h2 className="text-base font-bold text-gray-800">複製本層到其他樓層</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            以「<span className="font-semibold text-blue-700">{sourceDef.name}</span>」為來源。
            複製後各目標層產生<span className="font-semibold text-red-600">獨立副本</span>，不共用 reference，可分別修改。
          </p>
        </div>
        <div className="px-5 py-2 border-b border-gray-100 flex items-center gap-3">
          <span className="text-xs text-gray-400">已選 {selectedCount} 層</span>
          <button onClick={() => toggleAll(true)}  className="text-xs text-blue-600 hover:underline">全選</button>
          <button onClick={() => toggleAll(false)} className="text-xs text-gray-400 hover:underline">清除</button>
        </div>
        <div className="overflow-y-auto flex-1 px-5 py-3">
          <div className="grid grid-cols-4 gap-2">
            {targets.map(def => {
              const fd = floorsById[def.id];
              const isChecked = !!selected[def.id];
              return (
                <button key={def.id}
                  onClick={() => toggle(def.id)}
                  className={`flex flex-col items-center px-2 py-2 rounded-lg border text-xs transition-colors ${
                    isChecked ? 'bg-blue-50 border-blue-400 text-blue-700 font-semibold' : 'bg-white border-gray-200 text-gray-600 hover:border-gray-300'
                  }`}
                >
                  <span>{def.name}</span>
                  <span className="text-gray-400 font-normal mt-0.5 truncate w-full text-center">{def.usage}</span>
                  {fd?.isOverridden && <span className="text-amber-500 text-xs mt-0.5">已覆寫</span>}
                  {!fd?.isOverridden && fd?.sourceFloor && <span className="text-blue-400 text-xs mt-0.5">標準層</span>}
                </button>
              );
            })}
          </div>
        </div>
        <div className="px-5 py-4 border-t border-gray-200 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-gray-300 rounded text-gray-600 hover:bg-gray-50">取消</button>
          <button onClick={handleConfirm}
            className="px-4 py-2 text-sm rounded font-medium text-white bg-blue-600 hover:bg-blue-700">
            複製到 {selectedCount} 個樓層
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// STEP 3 PANEL — 使用 floorsById[activeFloorId] 讀寫
// ─────────────────────────────────────────────

function Step3Panel({ floorsById, setFloorsById, activeFloorId, setActiveFloorId }) {
  const [showCopyModal, setShowCopyModal] = useState(false);
  const contentRef = useRef(null);

  const floorIndex = FLOOR_DEFINITIONS.findIndex(d => d.id === activeFloorId);
  const def        = FLOOR_DEFINITIONS[floorIndex];
  const floorData  = floorsById[activeFloorId];     // 只取這一層
  const stats      = useMemo(() => computeFloorStats(floorData), [floorData]);

  // 更新 activeFloorId 對應的那一層 — 其他層完全不觸碰
  const patchCurrentFloor = (patch) => {
    setFloorsById(prev => {
      const current = prev[activeFloorId];
      // 有 sourceFloor 且第一次修改 → 標記 isOverridden
      const shouldMarkOverride = current.sourceFloor && !current.isOverridden;
      return {
        ...prev,
        [activeFloorId]: {
          ...current,
          ...patch,
          isOverridden: shouldMarkOverride ? true : current.isOverridden,
        },
      };
    });
  };

  const handlePrivateChange = (items) => patchCurrentFloor({ privateItems: items });
  const handleSharedChange  = (items) => patchCurrentFloor({ sharedItems:  items });

  // 複製：deepClone source，逐一寫入 target key
  const handleCopy = (sourceId, targetIds) => {
    setFloorsById(prev => {
      const sourceData = prev[sourceId];
      const next = { ...prev };
      targetIds.forEach(tid => {
        // deepClone 確保切斷 reference
        const clonedPrivate = deepClone(sourceData.privateItems).map((p, i) => ({ ...p, id: `${tid}_p${i}` }));
        const clonedShared  = deepClone(sourceData.sharedItems ).map((s, i) => ({ ...s, id: `${tid}_cs${i}` }));
        next[tid] = {
          ...deepClone(prev[tid]),   // 保留目標層的 meta（sourceFloor 等）
          privateItems: clonedPrivate,
          sharedItems:  clonedShared,
          sourceFloor:  sourceId,
          isOverridden: false,       // 剛複製，還沒手動修改
        };
      });
      return next;
    });
  };

  const addPrivateRow = () => {
    const newId = `${activeFloorId}_new_${Date.now()}`;
    handlePrivateChange([...(floorData.privateItems || []), {
      id: newId, unit: '', use: '住宅', indoor: 0, balcony: 0, balconyOver: 0, subtotal: 0, note: '-',
    }]);
  };
  const addSharedRow = () => {
    const newId = `${activeFloorId}_new_${Date.now()}`;
    handleSharedChange([...(floorData.sharedItems || []), {
      id: newId, name: '', area: 0, inFloor: '是', inFAR: '免計判斷', rule: '第162條', note: '-',
    }]);
  };

  const navTo = (idx) => {
    if (idx >= 0 && idx < FLOOR_DEFINITIONS.length) {
      setActiveFloorId(FLOOR_DEFINITIONS[idx].id);
      contentRef.current?.scrollTo(0, 0);
    }
  };

  const cardClass = "bg-white border border-gray-200 rounded-lg mb-4";
  const cardHead  = "flex items-center justify-between px-4 py-2.5 border-b border-gray-100 bg-gray-50 rounded-t-lg";

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <FloorTabs floorsById={floorsById} activeFloorId={activeFloorId} onSelect={id => { setActiveFloorId(id); contentRef.current?.scrollTo(0, 0); }} />
      <FloorSummaryBar
        def={def} floorData={floorData} stats={stats}
        floorIndex={floorIndex}
        onPrev={() => navTo(floorIndex - 1)}
        onNext={() => navTo(floorIndex + 1)}
      />

      <div ref={contentRef} className="flex-1 overflow-y-auto p-4">
        {/* 頁面標題列 */}
        <div className="mb-4">
          <div className="flex items-baseline gap-3 mb-3">
            <h2 className="text-base font-bold text-gray-800">
              {def.name}
              {floorData.isOverridden && (
                <span className="ml-2 text-sm bg-amber-100 border border-amber-300 text-amber-700 rounded px-2 py-0.5 font-medium">已覆寫</span>
              )}
            </h2>
            <span className="text-sm text-gray-500">各層面積明細</span>
            <span className="ml-auto flex items-center gap-1 text-xs text-blue-600 bg-blue-50 border border-blue-200 rounded px-2 py-0.5">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-500 inline-block" />
              步驟 3／10
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setShowCopyModal(true)}
              className="px-3 py-1.5 text-xs border border-gray-300 rounded text-gray-600 hover:bg-gray-50 transition-colors">
              複製本層到其他樓層
            </button>
            <button onClick={() => alert('【匯入 Excel】功能開發中')}
              className="px-3 py-1.5 text-xs border border-gray-300 rounded text-gray-600 hover:bg-gray-50 transition-colors">
              匯入 Excel
            </button>
            <button onClick={addPrivateRow}
              className="px-3 py-1.5 text-xs border border-blue-300 rounded text-blue-600 bg-blue-50 hover:bg-blue-100 transition-colors">
              ＋ 新增戶別
            </button>
            <button onClick={addSharedRow}
              className="px-3 py-1.5 text-xs border border-blue-300 rounded text-blue-600 bg-blue-50 hover:bg-blue-100 transition-colors">
              ＋ 新增共用項目
            </button>
          </div>
        </div>

        {/* A 專有部份 */}
        <div className={cardClass}>
          <div className={cardHead}>
            <h3 className="text-sm font-semibold text-gray-700">
              <span className="inline-block w-5 h-5 rounded bg-blue-600 text-white text-xs text-center leading-5 mr-1.5 font-bold">A</span>
              專有部份
            </h3>
            <span className="text-xs text-gray-400">{floorData.privateItems.length} 筆</span>
          </div>
          <div className="p-3">
            <PrivateAreaTable rows={floorData.privateItems} onChange={handlePrivateChange} />
          </div>
        </div>

        {/* B 共用部份 */}
        <div className={cardClass}>
          <div className={cardHead}>
            <h3 className="text-sm font-semibold text-gray-700">
              <span className="inline-block w-5 h-5 rounded bg-teal-600 text-white text-xs text-center leading-5 mr-1.5 font-bold">B</span>
              共用部份
            </h3>
            <span className="text-xs text-gray-400">{floorData.sharedItems.length} 筆</span>
          </div>
          <div className="p-3">
            <CommonAreaTable rows={floorData.sharedItems} onChange={handleSharedChange} />
          </div>
        </div>

        {/* C 自動檢討 */}
        <AutoCheckCard stats={stats} />
      </div>

      {showCopyModal && (
        <CopyToFloorsModal
          sourceDef={def}
          floorsById={floorsById}
          onCopy={handleCopy}
          onClose={() => setShowCopyModal(false)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// RIGHT PANEL: 大總表摘要（逐層讀取 floorsById）
// ─────────────────────────────────────────────

function SummaryTable({ floorsById, activeFloorId }) {
  // getAllFloorSummaries 依 floorsById 即時計算，任何樓層資料變動都會觸發重算
  // dependency 明確包含 floorsById，確保每次修改都重新 render
  const summaryRows = useMemo(
    () => getAllFloorSummaries(floorsById),
    [floorsById]
  );

  const th = "border border-gray-300 bg-gray-100 px-1.5 py-1 text-xs font-semibold text-gray-600 whitespace-nowrap text-center";
  const td = "border border-gray-200 px-1.5 py-0.5 text-xs text-right";

  const cell = (val) =>
    val > 0
      ? <span>{fmt(val)}</span>
      : <span className="text-gray-300">-</span>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr>
            <th className={th}>樓層</th>
            <th className={th}>用途</th>
            <th className={th}>樓地板(㎡)</th>
            <th className={th}>陽台(㎡)</th>
            <th className={th}>宜居(&gt;2M)</th>
            <th className={th}>162條(㎡)</th>
            <th className={th}>容積(㎡)</th>
            <th className={th}>高度(M)</th>
          </tr>
        </thead>
        <tbody>
          {summaryRows.map(row => {
            const isAct = row.floorId === activeFloorId;
            return (
              <tr key={row.floorId} className={isAct ? 'bg-blue-100' : ''}>
                <td className={`${td} text-center font-medium ${isAct ? 'text-blue-700' : ''}`}>
                  {row.floorName}
                  {row.isOverridden && (
                    <span className="ml-0.5 text-amber-500" title="已覆寫">✎</span>
                  )}
                </td>
                <td className={`${td} text-left`}>{row.usage}</td>
                <td className={td}>{cell(row.floorArea)}</td>
                <td className={td}>{cell(row.balconyArea)}</td>
                <td className={td}>{cell(row.balconyOver2m)}</td>
                <td className={td}>{cell(row.article162Area)}</td>
                <td className={`${td} ${isAct ? 'text-blue-700 font-semibold' : ''}`}>
                  {cell(row.floorVolume)}
                </td>
                <td className={td}>{fmt(row.height, 2)}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="bg-gray-100 font-semibold">
            <td className={`${td} text-left`} colSpan={2}>合計</td>
            <td className={td}>{fmt(summaryRows.reduce((s, r) => s + r.floorArea,      0))}</td>
            <td className={td}>{fmt(summaryRows.reduce((s, r) => s + r.balconyArea,    0))}</td>
            <td className={td}>{fmt(summaryRows.reduce((s, r) => s + r.balconyOver2m,  0))}</td>
            <td className={td}>{fmt(summaryRows.reduce((s, r) => s + r.article162Area, 0))}</td>
            <td className={td}>{fmt(summaryRows.reduce((s, r) => s + r.floorVolume,    0))}</td>
            <td className={td} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ─── A. 目前樓層檢核卡片 ───
function CurrentFloorCheck({ floorsById, activeFloorId }) {
  const def  = FLOOR_DEFINITIONS.find(d => d.id === activeFloorId);
  const fd   = floorsById[activeFloorId];
  const s    = useMemo(() => computeFloorStats(fd), [fd]);

  const PassTag = () => (
    <span className="flex items-center gap-0.5 text-green-600 font-semibold text-xs">
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7"/></svg>符合
    </span>
  );
  const WarnTag = ({ msg }) => (
    <span className="flex items-center gap-0.5 text-amber-600 font-semibold text-xs">
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>{msg}
    </span>
  );

  const rows = [
    ['當層樓地板面積', fmt(s.floorArea),       '㎡', null],
    ['陽台面積',       fmt(s.privateBalcony),   '㎡', null],
    ['梯廳面積',       fmt(s.hallArea),         '㎡', null],
    ['162條設置空間', fmt(s.art162Total),       '㎡', null],
    ['當層容積',       fmt(s.farArea),          '㎡', 'blue'],
  ];

  const checks = [
    { label: `陽台 10%：${fmt(s.privateBalcony)} < ${fmt(s.limit10)} ㎡`, pass: s.privateBalcony < s.limit10 },
    { label: `梯廳 10%：${fmt(s.hallArea)} < ${fmt(s.limit10)} ㎡`,       pass: s.hallArea < s.limit10 },
    {
      label: `陽台＋梯廳 15%：${fmt(s.combinedSum)} ${s.combinedSum <= s.limit15 ? '≤' : '>'} ${fmt(s.limit15)} ㎡`,
      pass:  s.combinedSum <= s.limit15,
      warn:  `超過 ${fmt(s.over15)}㎡ 計入`,
    },
  ];

  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold text-gray-500 flex items-center gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-blue-500 inline-block"/>
        A. 目前樓層：{def?.name}
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
        {rows.map(([label, val, unit, color]) => (
          <div key={label} className={`flex items-baseline justify-between py-0.5 border-b border-gray-100 col-span-${color === 'blue' ? '2' : '1'}`}>
            <span className="text-xs text-gray-500 truncate">{label}</span>
            <span className={`text-xs font-semibold ml-1 whitespace-nowrap ${color === 'blue' ? 'text-blue-700' : 'text-gray-700'}`}>{val} {unit}</span>
          </div>
        ))}
      </div>
      <div className="space-y-1 pt-0.5">
        {checks.map((c, i) => (
          <div key={i} className={`flex items-center justify-between py-1 px-2 rounded text-xs border ${c.pass ? 'bg-gray-50 border-gray-100' : 'bg-amber-50 border-amber-200'}`}>
            <span className="text-gray-600 truncate mr-1">{c.label}</span>
            {c.pass ? <PassTag /> : <WarnTag msg={c.warn || '超過'} />}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── B. 全案即時總檢核卡片 ───
function ProjectVolumeCheck({ projectSummary, prevVolume }) {
  const ps = projectSummary;

  // 顏色系統
  const statusColor = {
    '符合':   { bar: 'bg-green-500', badge: 'bg-green-100 text-green-700 border-green-300', text: 'text-green-700' },
    '接近上限':{ bar: 'bg-amber-400', badge: 'bg-amber-100 text-amber-700 border-amber-300', text: 'text-amber-700' },
    '超量':   { bar: 'bg-red-500',   badge: 'bg-red-100   text-red-700   border-red-300',   text: 'text-red-700'   },
  }[ps.status];

  const barPct = Math.min(100, ps.usageRate);
  const delta  = prevVolume != null ? ps.totalFloorVolume - prevVolume : null;
  const deltaRemaining = prevVolume != null ? (ps.maxAllowedVolume - prevVolume) - ps.remainingVolume : null;

  return (
    <div className="space-y-3">
      <div className="text-xs font-semibold text-gray-500 flex items-center gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 inline-block"/>
        B. 全案總量檢核
      </div>

      {/* 容積使用率進度條 */}
      <div>
        <div className="flex justify-between text-xs mb-1">
          <span className="text-gray-500">容積使用率</span>
          <span className={`font-bold ${statusColor.text}`}>{fmt(ps.usageRate, 1)}%</span>
        </div>
        <div className="w-full h-3 rounded-full bg-gray-100 overflow-hidden border border-gray-200">
          <div
            className={`h-full rounded-full transition-all duration-300 ${statusColor.bar}`}
            style={{ width: `${barPct}%` }}
          />
        </div>
        <div className="flex justify-between text-xs text-gray-400 mt-0.5">
          <span>0</span>
          <span>{fmt(ps.maxAllowedVolume)} ㎡</span>
        </div>
      </div>

      {/* 狀態 badge */}
      <div className={`flex items-center justify-between px-3 py-2 rounded border font-semibold ${statusColor.badge}`}>
        <span className="text-xs">全案容積狀態</span>
        <span className="flex items-center gap-1 text-sm">
          {ps.status === '符合'    && <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7"/></svg>}
          {ps.status === '接近上限' && <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>}
          {ps.status === '超量'    && <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>}
          {ps.status}
        </span>
      </div>

      {/* 數值明細 */}
      <div className="space-y-0.5">
        {[
          ['目前實設容積',  fmt(ps.totalFloorVolume), '㎡', false],
          ['法定基準容積',  fmt(ps.legalBaseVolume),  '㎡', false],
          ['獎勵容積',      fmt(ps.bonusVolume),      '㎡', false],
          ['容積上限',      fmt(ps.maxAllowedVolume), '㎡', false],
          ['剩餘可用容積',  ps.remainingVolume >= 0 ? fmt(ps.remainingVolume) : '—', '㎡', ps.remainingVolume < 0],
          ['超出容積',      ps.exceededVolume > 0 ? fmt(ps.exceededVolume) : '—', '㎡', ps.exceededVolume > 0],
          ['實設容積率',    fmt(ps.actualFAR, 2),     '%',  false],
        ].map(([label, val, unit, warn]) => (
          <div key={label} className="flex items-baseline justify-between py-0.5 border-b border-gray-100">
            <span className="text-xs text-gray-500">{label}</span>
            <span className={`text-xs font-semibold ${warn ? 'text-red-600' : 'text-gray-800'}`}>
              {val} <span className="text-gray-400 font-normal">{unit}</span>
            </span>
          </div>
        ))}
      </div>

      {/* 本次調整影響 */}
      {delta !== null && Math.abs(delta) > 0.005 && (
        <div className="bg-indigo-50 border border-indigo-200 rounded px-3 py-2 space-y-0.5">
          <div className="text-xs font-semibold text-indigo-600 mb-1">本次調整影響</div>
          <div className="flex justify-between text-xs">
            <span className="text-gray-500">全案容積變化</span>
            <span className={`font-semibold ${delta > 0 ? 'text-red-600' : 'text-green-600'}`}>
              {delta > 0 ? '+' : ''}{fmt(delta)} ㎡
            </span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-gray-500">剩餘容積變化</span>
            <span className={`font-semibold ${delta > 0 ? 'text-red-600' : 'text-green-600'}`}>
              {deltaRemaining > 0 ? '' : '+'}{fmt(-delta)} ㎡
            </span>
          </div>
        </div>
      )}

      {/* 全案其他分項 */}
      <div className="pt-1 border-t border-gray-200 space-y-0.5">
        <div className="text-xs font-semibold text-gray-400 mb-1">全案面積分項</div>
        {[
          ['總樓地板面積',   fmt(ps.totalFloorArea)],
          ['總陽台面積',     fmt(ps.totalBalconyArea)],
          ['宜居垂直綠化',  fmt(ps.totalGreenArea)],
          ['162條設置空間', fmt(ps.totalArticle162Area)],
        ].map(([label, val]) => (
          <div key={label} className="flex justify-between text-xs text-gray-500 py-0.5 border-b border-gray-50">
            <span>{label}</span>
            <span className="font-medium text-gray-700">{val} ㎡</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── 其他法規檢討（靜態，待後續連動） ───
function OtherComplianceCheck() {
  const checks = [
    { label: '建蔽率檢討',     status: 'pass' },
    { label: '停車空間檢討',   status: 'warn' },
    { label: '法定空地檢討',   status: 'pass' },
    { label: '防空避難室檢討', status: 'pass' },
  ];
  const PassIcon = () => <svg className="w-3.5 h-3.5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7"/></svg>;
  const WarnIcon = () => <svg className="w-3.5 h-3.5 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>;
  return (
    <div className="space-y-1">
      {checks.map(c => (
        <div key={c.label} className={`flex items-center justify-between px-2 py-1 rounded border text-xs ${c.status === 'pass' ? 'bg-green-50/50 border-green-100' : 'bg-amber-50 border-amber-200'}`}>
          <span className="text-gray-600">{c.label}</span>
          <span className={`flex items-center gap-0.5 font-semibold ${c.status === 'pass' ? 'text-green-600' : 'text-amber-600'}`}>
            {c.status === 'pass' ? <PassIcon /> : <WarnIcon />}
            {c.status === 'pass' ? '符合' : '需確認'}
          </span>
        </div>
      ))}
    </div>
  );
}

function TraceBlock({ floorsById, activeFloorId }) {
  const [open, setOpen] = useState(true);
  const def       = FLOOR_DEFINITIONS.find(d => d.id === activeFloorId);
  const floorData = floorsById[activeFloorId];
  const s         = useMemo(() => computeFloorStats(floorData), [floorData]);

  return (
    <div className="border border-blue-200 rounded-lg bg-blue-50/30">
      <button className="w-full flex items-center justify-between px-3 py-2 text-left" onClick={() => setOpen(!open)}>
        <div>
          <div className="text-xs font-semibold text-blue-700">{def?.name} 當層容積</div>
          <div className="text-base font-bold text-blue-800">{fmt(s.farArea)} ㎡</div>
        </div>
        <svg className={`w-4 h-4 text-blue-400 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="px-3 pb-3 border-t border-blue-100">
          <div className="text-xs text-gray-500 mt-2 mb-1">來源公式：</div>
          <pre className="font-mono text-xs bg-white border border-blue-100 rounded p-2 whitespace-pre-wrap text-gray-700">
            <span className="text-gray-400">A - C - E + d1{'\n'}</span>
            <span>= {fmt(s.floorArea)} - {fmt(s.hallArea)} - {fmt(s.art162Total)} + {fmt(s.over15)}{'\n'}</span>
            <span className="font-bold text-blue-700">= {fmt(s.farArea)} ㎡</span>
          </pre>
          <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1 text-xs">
            {[['A','樓地板面積',fmt(s.floorArea)],['C','梯廳面積',fmt(s.hallArea)],['E','162條空間',fmt(s.art162Total)],['d1','超15%計入',fmt(s.over15)]].map(([sym, name, val]) => (
              <div key={sym} className="flex items-center gap-1 text-gray-500">
                <span className="font-semibold text-blue-600 w-5">{sym}</span>
                <span>{name}</span>
                <span className="ml-auto font-medium text-gray-700">{val}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function RightPanel({ floorsById, activeFloorId, projectInfo }) {
  // ── 全案即時總檢核（依 floorsById + projectInfo 重算）──
  const projectSummary = useMemo(
    () => calculateProjectSummary(floorsById, projectInfo),
    [floorsById, projectInfo]
  );

  // 追蹤上一次總容積，用於顯示「本次調整影響」
  const prevVolumeRef = useRef(null);
  const [prevVolume,  setPrevVolume]  = useState(null);
  useEffect(() => {
    // 每次 floorsById 變動時，記錄變動前的值
    setPrevVolume(prevVolumeRef.current);
    prevVolumeRef.current = projectSummary.totalFloorVolume;
  }, [floorsById]);   // 只追蹤 floorsById，忽略 projectInfo 異動

  const cardClass = "bg-white border border-gray-200 rounded-lg mb-3";
  const cardHead  = "px-3 py-2 border-b border-gray-100 bg-gray-50 rounded-t-lg flex items-center justify-between";

  // 全案容積狀態對應的外框顏色
  const volumeBorderColor = {
    '符合':    'border-green-200',
    '接近上限': 'border-amber-300',
    '超量':    'border-red-400',
  }[projectSummary.status] || 'border-gray-200';

  return (
    <div style={{ width: 310 }} className="flex flex-col shrink-0 overflow-y-auto bg-gray-50 border-l border-gray-200 p-3">

      {/* ── 全案即時總檢核（置頂，最重要） ── */}
      <div className={`bg-white rounded-lg mb-3 border-2 ${volumeBorderColor}`}>
        <div className={`${cardHead} rounded-t-lg`}>
          <h3 className="text-xs font-semibold text-gray-700 flex items-center gap-1">
            <svg className="w-3.5 h-3.5 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg>
            全案即時總檢核
          </h3>
          <span className="text-xs text-gray-400">即時連動</span>
        </div>
        <div className="p-3">
          <ProjectVolumeCheck projectSummary={projectSummary} prevVolume={prevVolume} />
        </div>
      </div>

      {/* ── 目前樓層檢核 ── */}
      <div className={cardClass}>
        <div className={cardHead}>
          <h3 className="text-xs font-semibold text-gray-600 flex items-center gap-1">
            <svg className="w-3.5 h-3.5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"/></svg>
            即時檢核摘要
          </h3>
        </div>
        <div className="p-3 space-y-3">
          <CurrentFloorCheck floorsById={floorsById} activeFloorId={activeFloorId} />
          <div className="border-t border-gray-100 pt-2">
            <div className="text-xs font-semibold text-gray-400 mb-1.5">其他法規檢討（待連動）</div>
            <OtherComplianceCheck />
          </div>
        </div>
      </div>

      {/* ── 大總表摘要預覽 ── */}
      <div className={cardClass}>
        <div className={cardHead}>
          <h3 className="text-xs font-semibold text-gray-600">大總表摘要預覽</h3>
          <span className="text-xs text-yellow-600 bg-yellow-50 border border-yellow-200 rounded px-1.5 py-0.5">非正式格式</span>
        </div>
        <div className="p-2">
          <SummaryTable floorsById={floorsById} activeFloorId={activeFloorId} />
        </div>
      </div>

      {/* ── 數值追溯 ── */}
      <div className={cardClass}>
        <div className={cardHead}>
          <h3 className="text-xs font-semibold text-gray-600">數值追溯</h3>
          <span className="text-xs text-gray-400">即時連動</span>
        </div>
        <div className="p-3"><TraceBlock floorsById={floorsById} activeFloorId={activeFloorId} /></div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// FORMAL TABLE HEADER
// 送審格式大總表表頭，模擬 A3 橫式正式報表格式。
// 所有資料來自 projectInfo，不寫死任何文字。
// ─────────────────────────────────────────────

function FormalTableHeader({ projectInfo }) {
  const pi = projectInfo;
  const lotTotal = pi.landLots.reduce((s, l) => s + l.area, 0);

  // 通用儲存格樣式
  const border = '1px solid #111';
  const labelStyle = {
    background: '#e8e8e8',
    fontWeight: 'bold',
    fontSize: 11,
    padding: '3px 6px',
    whiteSpace: 'nowrap',
    letterSpacing: '0.05em',
    borderRight: border,
  };
  const valueStyle = {
    fontSize: 11,
    padding: '3px 8px',
    borderRight: border,
  };
  const labelStyleNB = { ...labelStyle, borderRight: border };
  const valueStyleNB = { ...valueStyle };

  return (
    <div style={{ fontFamily: '"Microsoft JhengHei", "Noto Sans TC", sans-serif', color: '#111' }}>
      {/* ── 主標題 ── */}
      <table style={{ width: '100%', borderCollapse: 'collapse', border }}>
        <tbody>
          <tr>
            <td colSpan={6} style={{
              textAlign: 'center', fontWeight: 'bold', fontSize: 18,
              letterSpacing: '0.3em', padding: '8px 0',
              borderBottom: border, background: '#fff',
            }}>
              面　積　計　算　表
            </td>
          </tr>

          {/* ── 第一橫行：工程名稱 | 戶數 ── */}
          <tr>
            <td style={{ ...labelStyle, width: '9%', borderTop: border }}>工程名稱</td>
            <td style={{ ...valueStyle, width: '32%', borderTop: border }} colSpan={2}>{pi.projectName}</td>
            <td style={{ ...labelStyle, width: '9%', borderTop: border }}>戶　　數</td>
            <td style={{ ...valueStyle, width: '50%', borderTop: border }} colSpan={2}>
              店舖 {pi.householdInfo.shopUnits} 戶、集合住宅 {pi.householdInfo.residentialUnits} 戶，共 {pi.householdInfo.totalUnits} 戶
            </td>
          </tr>

          {/* ── 第二橫行：基地座落 | 樓層數 ── */}
          <tr>
            <td style={{ ...labelStyle, borderTop: border }}>基地座落</td>
            <td style={{ ...valueStyle, borderTop: border }} colSpan={2}>{pi.buildingLocation}</td>
            <td style={{ ...labelStyle, borderTop: border }}>樓　層　數</td>
            <td style={{ ...valueStyle, borderTop: border }} colSpan={2}>
              地上 {pi.floorCount.aboveGround} 層、地下 {pi.floorCount.underground} 層、屋突 {pi.floorCount.roof} 層
            </td>
          </tr>

          {/* ── 第三橫行：使用分區 | 構造種類 ── */}
          <tr>
            <td style={{ ...labelStyle, borderTop: border }}>使用分區</td>
            <td style={{ ...valueStyle, borderTop: border }} colSpan={2}>
              {pi.zoning}（建蔽率 {pi.legalBuildingCoverageRate}%、容積率 {pi.legalFloorAreaRatio}%）
            </td>
            <td style={{ ...labelStyle, borderTop: border }}>構　　　造</td>
            <td style={{ ...valueStyle, borderTop: border }} colSpan={2}>{pi.structureType}</td>
          </tr>

          {/* ── 第四橫行：建築類別 | 設計單位 ── */}
          <tr>
            <td style={{ ...labelStyle, borderTop: border }}>建築類別</td>
            <td style={{ ...valueStyle, borderTop: border }} colSpan={2}>{pi.buildingType}</td>
            <td style={{ ...labelStyle, borderTop: border }}>設計單位</td>
            <td style={{ ...valueStyle, borderTop: border }} colSpan={2}>{pi.designOffice}</td>
          </tr>

          {/* ── 第五橫行：建築用途 | 製表人 ── */}
          <tr>
            <td style={{ ...labelStyle, borderTop: border }}>建築用途</td>
            <td style={{ ...valueStyle, borderTop: border }} colSpan={2}>{pi.buildingUsage}</td>
            <td style={{ ...labelStyle, borderTop: border }}>製　表　人</td>
            <td style={{ ...valueStyle, borderTop: border }}>{pi.preparedBy}</td>
            <td style={{ ...valueStyle, borderTop: border, borderRight: 'none' }}>
              <span style={{ color: '#555', fontSize: 10 }}>版本：</span>{pi.version}
            </td>
          </tr>

          {/* ── 第六橫行：基地面積 | 製表日期 ── */}
          <tr>
            <td style={{ ...labelStyle, borderTop: border }}>基地面積</td>
            <td style={{ ...valueStyle, borderTop: border }} colSpan={2}>
              {Number(pi.siteArea).toFixed(2)} ㎡
            </td>
            <td style={{ ...labelStyle, borderTop: border }}>製表日期</td>
            <td style={{ ...valueStyle, borderTop: border }}>{pi.preparedDate}</td>
            <td style={{ ...valueStyle, borderTop: border, borderRight: 'none' }}>
              <span style={{ color: '#555', fontSize: 10 }}>頁次：</span>{pi.page}
            </td>
          </tr>

          {/* ── 第七橫行：法定比率 | 地號明細 ── */}
          <tr>
            <td style={{ ...labelStyle, borderTop: border }}>法定建蔽率</td>
            <td style={{ ...valueStyle, borderTop: border }}>{pi.legalBuildingCoverageRate}%</td>
            <td style={{ ...valueStyle, borderTop: border }}>
              <span style={{ ...labelStyle, display: 'inline', background: 'transparent', fontWeight: 'bold', padding: 0, letterSpacing: 0 }}>法定容積率</span>
              ：{pi.legalFloorAreaRatio}%
            </td>
            <td style={{ ...labelStyle, borderTop: border, verticalAlign: 'top' }} rowSpan={2}>地號明細</td>
            <td style={{ borderTop: border, padding: '3px 8px', fontSize: 11 }} colSpan={2} rowSpan={2}>
              {pi.landLots.map((l, i) => (
                <div key={l.lotNumber} style={{ lineHeight: '1.7' }}>
                  ({i + 1}) {l.lotNumber} 地號 = {Number(l.area).toFixed(2)} ㎡
                </div>
              ))}
              <div style={{ borderTop: '1px solid #aaa', marginTop: 3, paddingTop: 3, fontWeight: 'bold' }}>
                合計 = {Number(lotTotal).toFixed(2)} ㎡
              </div>
            </td>
          </tr>
          <tr>
            <td style={{ ...labelStyle, borderTop: border }}>法定容積率</td>
            <td style={{ ...valueStyle, borderTop: border }} colSpan={2}>{pi.legalFloorAreaRatio}%</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ─────────────────────────────────────────────
// FORMAL SUMMARY TABLE（大總表主體，接在 Header 下方）
// ─────────────────────────────────────────────

function FormalSummaryTableBody({ summaryRows }) {
  const border = '1px solid #111';
  const thStyle = {
    border,
    background: '#e8e8e8',
    fontWeight: 'bold',
    fontSize: 10,
    padding: '3px 4px',
    textAlign: 'center',
    whiteSpace: 'nowrap',
  };
  const tdBase = {
    border,
    fontSize: 10,
    padding: '2px 4px',
    textAlign: 'right',
    whiteSpace: 'nowrap',
  };

  const cell = (val) => val > 0 ? Number(val).toFixed(2) : '-';

  const totals = summaryRows.reduce((acc, r) => ({
    floorArea:      acc.floorArea      + r.floorArea,
    privateIndoor:  acc.privateIndoor  + r.privateIndoor,
    balconyArea:    acc.balconyArea    + r.balconyArea,
    balconyOver2m:  acc.balconyOver2m  + r.balconyOver2m,
    article162Area: acc.article162Area + r.article162Area,
    floorVolume:    acc.floorVolume    + r.floorVolume,
  }), { floorArea: 0, privateIndoor: 0, balconyArea: 0, balconyOver2m: 0, article162Area: 0, floorVolume: 0 });

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 2, fontFamily: '"Microsoft JhengHei", sans-serif' }}>
      <thead>
        <tr>
          <th style={{ ...thStyle, width: '6%'  }}>樓層</th>
          <th style={{ ...thStyle, width: '7%'  }}>當層用途</th>
          <th style={{ ...thStyle, width: '9%'  }}>樓地板面積(㎡)</th>
          <th style={{ ...thStyle, width: '8%'  }}>室內面積(㎡)</th>
          <th style={{ ...thStyle, width: '9%'  }}>陽台面積<br/>(&lt;2M)(㎡)</th>
          <th style={{ ...thStyle, width: '9%'  }}>宜居建築<br/>垂直綠化(㎡)</th>
          <th style={{ ...thStyle, width: '11%' }}>依第162條第二項<br/>設置空間(㎡)</th>
          <th style={{ ...thStyle, width: '9%'  }}>當層容積(㎡)</th>
          <th style={{ ...thStyle, width: '6%'  }}>高度(M)</th>
          <th style={{ ...thStyle, width: '10%' }}>備註</th>
        </tr>
      </thead>
      <tbody>
        {summaryRows.map((row, idx) => {
          const isEven = idx % 2 === 0;
          const rowBg = isEven ? '#fff' : '#f9f9f9';
          return (
            <tr key={row.floorId} style={{ background: rowBg }}>
              <td style={{ ...tdBase, textAlign: 'center', fontWeight: 'bold' }}>
                {row.floorName}{row.isOverridden ? ' *' : ''}
              </td>
              <td style={{ ...tdBase, textAlign: 'center' }}>{row.usage}</td>
              <td style={{ ...tdBase }}>{cell(row.floorArea)}</td>
              <td style={{ ...tdBase }}>{cell(row.privateIndoor)}</td>
              <td style={{ ...tdBase }}>{cell(row.balconyArea)}</td>
              <td style={{ ...tdBase }}>{cell(row.balconyOver2m)}</td>
              <td style={{ ...tdBase }}>{cell(row.article162Area)}</td>
              <td style={{ ...tdBase, fontWeight: row.floorVolume > 0 ? 'bold' : 'normal' }}>{cell(row.floorVolume)}</td>
              <td style={{ ...tdBase, textAlign: 'center' }}>{Number(row.height).toFixed(2)}</td>
              <td style={{ ...tdBase, textAlign: 'left', fontSize: 9 }}>
                {row.isOverridden ? '已覆寫' : row.sourceFloor ? '來自標準層' : ''}
              </td>
            </tr>
          );
        })}
      </tbody>
      <tfoot>
        <tr style={{ background: '#e8e8e8', fontWeight: 'bold' }}>
          <td style={{ ...tdBase, textAlign: 'center', fontWeight: 'bold' }} colSpan={2}>合　　計</td>
          <td style={{ ...tdBase, fontWeight: 'bold' }}>{totals.floorArea.toFixed(2)}</td>
          <td style={{ ...tdBase, fontWeight: 'bold' }}>{totals.privateIndoor.toFixed(2)}</td>
          <td style={{ ...tdBase, fontWeight: 'bold' }}>{totals.balconyArea.toFixed(2)}</td>
          <td style={{ ...tdBase, fontWeight: 'bold' }}>{totals.balconyOver2m.toFixed(2)}</td>
          <td style={{ ...tdBase, fontWeight: 'bold' }}>{totals.article162Area.toFixed(2)}</td>
          <td style={{ ...tdBase, fontWeight: 'bold' }}>{totals.floorVolume.toFixed(2)}</td>
          <td style={{ ...tdBase }} colSpan={2}></td>
        </tr>
      </tfoot>
    </table>
  );
}

// ─────────────────────────────────────────────
// EXPORT MODAL（整合 FormalTableHeader + FormalSummaryTableBody）
// ─────────────────────────────────────────────

function ExportModal({ type, floorsById, projectInfo, onClose }) {
  // 與大總表摘要相同的資料來源
  const summaryRows = useMemo(() => getAllFloorSummaries(floorsById), [floorsById]);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl flex flex-col"
        style={{ width: '92vw', maxWidth: 1100, maxHeight: '92vh' }}
        onClick={e => e.stopPropagation()}
      >
        {/* ── Modal 頂部工具列 ── */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 shrink-0">
          <div className="flex items-center gap-3">
            <div>
              <h2 className="text-sm font-bold text-gray-800">
                正式送審格式大總表 — 匯出 {type}
              </h2>
              <p className="text-xs text-gray-400 mt-0.5">
                A3 橫式｜黑白線框｜共 {summaryRows.length} 層逐層獨立資料
                ｜<span className="text-amber-600">* 標示表示已覆寫標準層</span>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400 bg-yellow-50 border border-yellow-200 rounded px-2 py-0.5 text-yellow-600">
              畫面預覽（非正式列印比例）
            </span>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none ml-2">✕</button>
          </div>
        </div>

        {/* ── 預覽主體（可捲動） ── */}
        <div className="flex-1 overflow-y-auto p-5 bg-gray-100">
          {/* 模擬 A3 紙張區域 */}
          <div style={{
            background: '#fff',
            boxShadow: '0 2px 12px rgba(0,0,0,0.18)',
            padding: '18px 22px',
            minWidth: 860,
          }}>
            {/* 表頭：建築物基本資訊 */}
            <FormalTableHeader projectInfo={projectInfo} />

            {/* 間隔 */}
            <div style={{ height: 6 }} />

            {/* 大總表主體 */}
            <FormalSummaryTableBody summaryRows={summaryRows} />

            {/* 頁尾簽核區 */}
            <table style={{
              width: '100%', borderCollapse: 'collapse',
              border: '1px solid #111', marginTop: 4,
              fontFamily: '"Microsoft JhengHei", sans-serif',
            }}>
              <tbody>
                <tr>
                  {['製　表　人', '審　核　人', '建　築　師', '核　　　章'].map(label => (
                    <td key={label} style={{
                      border: '1px solid #111',
                      width: '25%', height: 40,
                      textAlign: 'center',
                      fontSize: 11, fontWeight: 'bold',
                      background: '#e8e8e8',
                      verticalAlign: 'middle',
                    }}>
                      {label}
                    </td>
                  ))}
                </tr>
                <tr>
                  {[projectInfo.preparedBy, '', '', ''].map((val, i) => (
                    <td key={i} style={{
                      border: '1px solid #111', height: 36,
                      textAlign: 'center', fontSize: 11,
                      verticalAlign: 'middle',
                    }}>
                      {val}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>

            {/* 備註 */}
            <div style={{ marginTop: 4, fontSize: 9, color: '#555' }}>
              備註：本表依建築技術規則建築設計施工編計算。* 表示該層已覆寫標準層資料。
              製表日期：{projectInfo.preparedDate}　版本：{projectInfo.version}　頁次：{projectInfo.page}
            </div>
          </div>
        </div>

        {/* ── Modal 底部按鈕 ── */}
        <div className="px-5 py-3 border-t border-gray-200 flex items-center justify-between shrink-0">
          <span className="text-xs text-gray-400">
            PDF / Excel 產生器接入後，以上預覽即為正式輸出格式
          </span>
          <div className="flex gap-2">
            <button onClick={onClose}
              className="px-4 py-2 text-sm border border-gray-300 rounded text-gray-600 hover:bg-gray-50">
              取消
            </button>
            <button
              onClick={() => {
                alert(
                  `【匯出${type}】功能開發中。\n` +
                  `工程：${projectInfo.projectName}\n` +
                  `共 ${summaryRows.length} 層，每層獨立資料，資料結構已就緒。`
                );
                onClose();
              }}
              className={`px-4 py-2 text-sm rounded font-medium text-white ${
                type === 'PDF' ? 'bg-red-600 hover:bg-red-700' : 'bg-green-600 hover:bg-green-700'
              }`}
            >
              確認匯出 {type}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// PLACEHOLDER
// ─────────────────────────────────────────────

function PlaceholderPanel({ stepId }) {
  const item = MENU_ITEMS.find(m => m.id === stepId);
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="text-center">
        <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-4">
          {item?.step ? <span className="text-2xl font-bold text-gray-400">{item.step}</span>
            : <svg className="w-7 h-7 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
          }
        </div>
        <h3 className="text-sm font-semibold text-gray-600 mb-1">{item?.label ?? '功能頁面'}</h3>
        <p className="text-xs text-gray-400">此頁面於 MVP v2 開放</p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// ROOT APP
// ─────────────────────────────────────────────

function App() {
  const [activeMenu,    setActiveMenu]    = useState('3');
  const [floorsById,    setFloorsById]    = useState(() => buildFloorsById());
  const [activeFloorId, setActiveFloorId] = useState('5F');
  const [exportModal,   setExportModal]   = useState(null);
  // projectInfo：基地基本資料、送審格式大總表、PDF/Excel 共用此來源
  const [projectInfo,   setProjectInfo]   = useState(INITIAL_PROJECT_INFO);

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <TopBar
        project={MOCK_PROJECT}
        onExportPDF={()    => setExportModal('PDF')}
        onExportExcel={()  => setExportModal('Excel')}
        onValidate={()     => alert('檢核完成：\n✅ 建蔽率 符合\n✅ 容積率 符合\n⚠️ 停車空間 需確認\n✅ 法定空地 符合\n✅ 防空避難室 符合')}
      />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar activeId={activeMenu} onSelect={setActiveMenu} />
        {activeMenu === '3'
          ? <Step3Panel
              floorsById={floorsById}
              setFloorsById={setFloorsById}
              activeFloorId={activeFloorId}
              setActiveFloorId={setActiveFloorId}
            />
          : <PlaceholderPanel stepId={activeMenu} />
        }
        <RightPanel floorsById={floorsById} activeFloorId={activeFloorId} projectInfo={projectInfo} />
      </div>
      {exportModal && (
        <ExportModal type={exportModal} floorsById={floorsById} projectInfo={projectInfo} onClose={() => setExportModal(null)} />
      )}
    </div>
  );
}

// 若 app-v2.js 已設定 __YF_V2__ flag，讓 v2 負責渲染；否則直接渲染工作台
if (!window.__YF_V2__) {
  const root = ReactDOM.createRoot(document.getElementById('root'));
  root.render(<App />);
}
