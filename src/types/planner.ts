export interface SiteConfig {
  width: number   // meters
  depth: number   // meters
}

export interface Regulations {
  bcrLimit: number       // % 建蔽率上限
  farLimit: number       // % 容積率上限
  setbackFront: number   // m 前院
  setbackRear: number    // m 後院
  setbackSide: number    // m 側院
  floors: number         // 地上層數
  floorHeight: number    // m 標準層高
}

export interface Rect2D {
  x: number   // meters from site top-left
  y: number
  w: number
  h: number
}

export interface Divider {
  id: string
  x: number   // meters from site left edge
}

export interface PlannerScheme {
  id: string
  label: string
  site: SiteConfig
  building: Rect2D
  core: Rect2D
  dividers: Divider[]
  bcr: number
  far: number
  units: number
}
