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
