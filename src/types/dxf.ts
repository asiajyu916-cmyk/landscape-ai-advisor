// ── DXF 解析相關型別 ──────────────────────────────────────────────────────────

// ── 植栽索引表 ────────────────────────────────────────────────────────────────

export interface PlantScheduleEntry {
  rowIndex: number
  code: string            // 植栽代號 / 項次（998、T1、S2 等）
  plantName: string       // 植物名稱
  scientificName?: string // 學名
  plantType?: string      // 喬木 / 灌木 / 草皮 / 地被（若可判斷）
  spec?: string           // 規格
  quantity?: number       // 數量（小計 / 株數欄）
  unit?: string           // 單位
  note?: string           // 備註欄
  quantityNote?: string   // 例如「數量待確認」
  unitNote?: string       // 例如「單位需確認（㎡ 或 株）」
  rawRow: string[]        // 原始欄位值
  dbMatched: boolean      // 是否在植栽資料庫中找到
  confidence: 'high' | 'medium' | 'low'
}

export interface PlantSchedule {
  entries: PlantScheduleEntry[]
  headerRow?: string[]
  detected: boolean
  textCount: number
}

export interface DxfAttrib {
  tag: string    // ATTRIB group code 2（屬性名稱，如 "植物名稱"、"CODE"）
  value: string  // ATTRIB group code 1（屬性值，如 "蔓花生"）
}

export interface DxfInsert {
  type: 'INSERT'
  layer: string
  blockName: string
  x: number
  y: number
  scaleX: number    // default 1
  scaleY: number    // default 1
  rotation: number  // degrees, default 0
  attributes: DxfAttrib[]   // 緊接在 INSERT 後的 ATTRIB 實體，已連結
  handle?: string   // DXF entity handle（code 5，巢狀展開時為祖先 handle 組合鍵），供去重用
}

export interface DxfText {
  type: 'TEXT' | 'MTEXT'
  layer: string
  content: string
  x: number
  y: number
}

export type DxfEntity = DxfInsert | DxfText

export interface BlockGroup {
  blockName: string
  layer: string
  count: number
  positions: Array<{ x: number; y: number }>  // 全部位置（不限筆數）
  attributes: DxfAttrib[]  // 聚合自每個 INSERT 實例的 ATTRIB（以 tag 去重）
}

// ── 幾何區域 ─────────────────────────────────────────────────────────────────

export type ZoneType =
  | 'shrub'            // 灌木區
  | 'lawn'             // 草皮區
  | 'groundcover'      // 地被區
  | 'high_irrigation'  // 高澆灌區
  | 'low_irrigation'   // 低澆灌區
  | 'tree'             // 喬木種植區
  | 'unknown'          // 無法分類

export interface DxfPolygon {
  layer: string
  vertices: Array<{ x: number; y: number }>
  closed: boolean
  zoneType: ZoneType
  source: 'LWPOLYLINE' | 'POLYLINE' | 'HATCH'
  hatchPattern?: string   // code 2：pattern name，圖例對照主鍵
  hatchScale?: number     // code 41：pattern scale
  hatchAngle?: number     // code 52：pattern angle（degrees）
  hatchColor?: number     // code 62：color number（ACI）
  handle?: string   // DXF entity handle（code 5，巢狀展開時為祖先 handle 組合鍵）。
                     // 同一 HATCH 實體的多個 loop（外邊界＋孔洞／多個不連續面域）共用同一 handle。
  parentBlockName?: string   // 若此幾何巢狀在某個 BLOCK 定義內（由 INSERT 展開而來），此為該
                              // BLOCK 的名稱（例如 "TREE_茄苳"）；頂層（非巢狀）entity 為 undefined。
}

// block 定義的本地 bbox（以 block origin 為原點的本地座標系）
export interface BlockExtent {
  baseX: number
  baseY: number
  // local bbox center（可能偏離 block origin，例如圓形不在原點的 block）
  localCx: number
  localCy: number
  localMinX: number; localMaxX: number
  localMinY: number; localMaxY: number
}

export interface DxfParseResult {
  inserts: DxfInsert[]
  texts: DxfText[]
  blockGroups: BlockGroup[]
  polygons: DxfPolygon[]   // 可識別範圍多邊形
  allLayers: string[]
  // block 定義的幾何 bbox，key = blockName
  blockExtents: Record<string, BlockExtent>
  // LAYER 表顏色（ACI），key = layerName，供 ByLayer/ByBlock HATCH 解析 effectiveColor
  layerColors: Record<string, number>
  // HEADER $INSUNITS 原始代碼（4=mm, 5=cm, 6=m，其餘/undefined=無法辨識，需由 UI 詢問使用者）
  insUnits?: number
  stats: {
    totalInserts: number
    totalTexts: number
    uniqueBlocks: number
    uniqueLayers: number
    totalPolygons: number
    classifiedPolygons: number
  }
}

export type MatchStatus = 'matched' | 'partial' | 'unmatched'

export interface MappedItem {
  blockName: string
  layer: string
  count: number
  positions: Array<{ x: number; y: number }>
  matchStatus: MatchStatus
  plantName?: string
  plantCategory?: string
  plantSubCategory?: string
  matchReason?: string
  manualOverride?: string
  confidenceScore?: number           // 0–100
  scheduleEntry?: PlantScheduleEntry  // 若來自索引表
  nearbyTexts?: string[]             // 附近文字片段
  detectedType?: string              // '喬木圖塊' / '灌木圖塊' 等（由 block/layer 名稱推斷）
  possiblePlantCode?: string         // 從 block name 提取的數字代號（如 '994'）
  evidence?: string[]                // 對應依據清單
  sourceType?: 'saved_rule' | 'block' | 'attribute' | 'legend' | 'text' | 'unidentified'
  attributes?: DxfAttrib[]           // 對應 BlockGroup.attributes（供 restoreExcluded 重新比對用）
}

// ── 分區空間識別 ──────────────────────────────────────────────────────────────

export interface DetectedZone {
  name: string                           // "A區", "B區", "一區" 等
  labelPosition: { x: number; y: number }
  boundary?: DxfPolygon                  // 包含該文字標籤的多邊形（若找到）
  confidence: 'high' | 'medium' | 'low'
  source: 'text-in-polygon' | 'text-only'
}

export interface ZoneTreeBlock {
  blockName: string
  layer: string
  plantName?: string
  detectedType?: string
  positionsInZone: number   // 在此區內的插入點數
  totalCount: number
}

export interface ZonePlantArea {
  layer: string
  zoneType: ZoneType
  source: 'HATCH' | 'LWPOLYLINE' | 'POLYLINE'
  vertexCount: number
  centerX: number
  centerY: number
  hatchPattern?: string
  hatchScale?: number
  hatchAngle?: number
  hatchColor?: number
  vertices?: Array<{ x: number; y: number }>
  overlapRatio?: number   // 交集面積 / HATCH 自身面積（供跨區判斷）
  crossZone?: boolean     // true = 面積比在 20~60% 之間，分區歸屬需人工確認
}

export interface ZonePlantList {
  zone: DetectedZone
  treeBlocks: ZoneTreeBlock[]
  shrubAreas: ZonePlantArea[]
  lawnAreas: ZonePlantArea[]
  groundcoverAreas: ZonePlantArea[]
  unknownAreas: ZonePlantArea[]
}

// ── 複層配置分析 ──────────────────────────────────────────────────────────────

export type MultiLayerJudgment = 'ok' | 'caution' | 'conflict' | 'unclear'

export interface ZoneHit {
  zoneType: ZoneType
  layerName: string
}

export interface MultiLayerResult {
  treeBlockName: string
  treePlantName?: string
  treeLayer: string
  position: { x: number; y: number }
  positionIndex: number   // which of N insertions
  totalCount: number      // total insertions of this block
  zones: ZoneHit[]
  judgment: MultiLayerJudgment
  underlayerDesc: string  // 所在範圍描述
  riskReasons: string[]
  suggestions: string[]
}

// ── 分區植栽面積與喬木數量統計 ──────────────────────────────────────────────────

export type DrawingUnit = 'mm' | 'cm' | 'm'

export type PlantStatCategory = 'tree' | 'shrub' | 'groundcover' | 'lawn' | 'unknown'

export interface ZoneHatchPlantStat {
  plantName: string        // 已比對到植栽時為植物名稱，否則為標準化後圖層名稱
  category: PlantStatCategory
  layerName: string
  hatchCount: number       // 去重後、屬於此分區的 HATCH 區塊數
  areaM2: number            // 與分區交集後的實際面積（m²，已去重、已扣除孔洞）
  entityHandles: string[]
}

export interface ZoneTreePlantStat {
  plantName: string        // 未能解析植物名稱時 fallback 為 blockName
  blockName: string
  layerName: string
  count: number
  entityHandles: string[]
}

export interface ZoneUnknownPlantStat {
  source: 'hatch' | 'block'
  layerName: string
  blockName?: string
  hatchCount?: number
  areaM2?: number
  count?: number
  entityHandles: string[]
  // 'generic_green_area'：圖層名稱僅為通用色塊/範圍代號（例如含「綠」字但無具體植物名稱），
  // 不得因此推定為草皮、地被或任何特定植物；未設定時預設為一般「待確認植栽」。
  category?: 'unknown' | 'generic_green_area'
}

export interface ZoneStatisticsResult {
  zoneId: string
  zoneAreaM2: number
  shrubAreaM2: number
  groundLawnAreaM2: number       // 草皮＋地被合計
  plantingAreaM2: number         // 灌木＋草皮＋地被合計（不含喬木）
  plantingCoveragePercent: number
  treeTotalCount: number
  hatchPlants: ZoneHatchPlantStat[]
  treePlants: ZoneTreePlantStat[]
  unknownPlants: ZoneUnknownPlantStat[]
}
