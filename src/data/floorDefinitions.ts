import type { FloorDefinition } from '@/types'

/** FLOOR_DEFINITIONS — 樓層 meta（名稱/用途/高度），全域共用 */
export const FLOOR_DEFINITIONS: FloorDefinition[] = [
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
]
