import { parsePlantCsv } from '@/utils/csvParser'
import { normalizeForCompare } from '@/utils/plantNameMatch'
import type { CsvPlantRecord, ImportResult, PlantImageData, ImageStore } from '@/types/csvPlant'

const STORAGE_KEY       = 'landscape_advisor_plants_v1'
const IMAGE_STORAGE_KEY = 'landscape_advisor_images_v1'

// ── Persistence ───────────────────────────────────────────────────────────────

export function savePlantsToStorage(plants: CsvPlantRecord[]): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(plants))
    return true
  } catch {
    // localStorage quota exceeded
    return false
  }
}

export function loadPlantsFromStorage(): CsvPlantRecord[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as CsvPlantRecord[]
  } catch {
    return null
  }
}

export function clearPlantsFromStorage(): void {
  localStorage.removeItem(STORAGE_KEY)
}

// ── Auto-load from public/plantdb.csv ────────────────────────────────────────

export async function fetchDefaultPlants(): Promise<ImportResult | null> {
  try {
    const res = await fetch('/plantdb.csv')
    if (!res.ok) return null
    const text = await res.text()
    return parsePlantCsv(text)
  } catch {
    return null
  }
}

// ── localStorage + 內建 CSV 合併載入 ────────────────────────────────────────────
// 舊行為：localStorage 有資料就直接用，永遠不再讀 public/plantdb.csv，導致
// CSV 新增/更新的植物即使部署上線，使用者瀏覽器裡也永遠看不到（除非手動清空
// storage 重新匯入）。改為：localStorage 仍是主要來源（保留使用者已匯入/編輯
// 的資料，不覆蓋、不刪除），但每次都同時讀取內建 CSV，只把「localStorage 裡
// 完全沒有的植物名稱（正規化後比對，含台/臺等寫法差異）」補進去——只增不減、
// 不覆蓋既有資料。
export interface PlantsLoadResult {
  plants: CsvPlantRecord[]
  source: 'csv-only' | 'localStorage-only' | 'localStorage+csv-merge'
  csvFileName: string
  csvTotal: number
  csvLastPlantName: string
  addedFromCsv: number
}

export async function loadPlantsWithCsvMerge(): Promise<PlantsLoadResult> {
  const stored = loadPlantsFromStorage() ?? []
  const csvResult = await fetchDefaultPlants()
  const csvPlants = csvResult?.plants ?? []
  const csvFileName = '/plantdb.csv'
  const csvLastPlantName = csvPlants.length > 0 ? csvPlants[csvPlants.length - 1].name : ''

  if (!csvResult) {
    return { plants: stored, source: 'localStorage-only', csvFileName, csvTotal: 0, csvLastPlantName, addedFromCsv: 0 }
  }
  if (stored.length === 0) {
    savePlantsToStorage(csvPlants)
    return { plants: csvPlants, source: 'csv-only', csvFileName, csvTotal: csvPlants.length, csvLastPlantName, addedFromCsv: csvPlants.length }
  }

  const existingKeys = new Set(stored.map(p => normalizeForCompare(p.name)))
  const newOnes = csvPlants.filter(p => !existingKeys.has(normalizeForCompare(p.name)))
  if (newOnes.length === 0) {
    return { plants: stored, source: 'localStorage+csv-merge', csvFileName, csvTotal: csvPlants.length, csvLastPlantName, addedFromCsv: 0 }
  }
  const merged = [...stored, ...newOnes]
  savePlantsToStorage(merged)
  return { plants: merged, source: 'localStorage+csv-merge', csvFileName, csvTotal: csvPlants.length, csvLastPlantName, addedFromCsv: newOnes.length }
}

// ── File import (user upload) ──────────────────────────────────────────────────

export function importFromFile(file: File): Promise<ImportResult> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = e => {
      const text = e.target?.result
      if (typeof text !== 'string') { reject(new Error('read error')); return }
      resolve(parsePlantCsv(text))
    }
    reader.onerror = () => reject(new Error('file error'))
    reader.readAsText(file, 'utf-8')
  })
}

// ── Image store (keyed by plant name — survives CSV re-import) ────────────────

export function loadImageStore(): ImageStore {
  try {
    const raw = localStorage.getItem(IMAGE_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as ImageStore) : {}
  } catch { return {} }
}

export function saveImageStore(store: ImageStore): void {
  try {
    localStorage.setItem(IMAGE_STORAGE_KEY, JSON.stringify(store))
  } catch { /* quota exceeded */ }
}

export function upsertPlantImage(
  store: ImageStore,
  plantName: string,
  data: Partial<PlantImageData>
): ImageStore {
  const existing = store[plantName] ?? { hasImage: false }
  const merged: PlantImageData = {
    ...existing,
    ...data,
    hasImage: !!(data.imageUrl ?? existing.imageUrl ?? data.uploadedDataUrl ?? existing.uploadedDataUrl),
  }
  return { ...store, [plantName]: merged }
}

export function removePlantImage(store: ImageStore, plantName: string): ImageStore {
  const next = { ...store }
  delete next[plantName]
  return next
}

/** Upload a File → base64 data URL, reject if > 2 MB */
export function readImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (file.size > 2 * 1024 * 1024) {
      reject(new Error('圖片大小超過 2 MB，請選擇較小的圖片或使用網址方式'))
      return
    }
    const reader = new FileReader()
    reader.onload = e => {
      const result = e.target?.result
      if (typeof result === 'string') resolve(result)
      else reject(new Error('讀取失敗'))
    }
    reader.onerror = () => reject(new Error('圖片讀取失敗'))
    reader.readAsDataURL(file)
  })
}

// ── Search & filter helpers ───────────────────────────────────────────────────

export interface PlantFilter {
  search: string
  category: '' | 'tree' | 'shrub' | 'groundcover'
  sun: string
  water: string
  wet: string
}

export function filterPlants(plants: CsvPlantRecord[], f: PlantFilter): CsvPlantRecord[] {
  return plants.filter(p => {
    if (f.search) {
      const q = f.search.toLowerCase()
      if (!p.name.includes(f.search) &&
          !(p.scientificName ?? '').toLowerCase().includes(q) &&
          !(p.subCategory ?? '').includes(f.search)) return false
    }
    if (f.category && p.normalizedCategory !== f.category) return false
    if (f.sun && p.sunRequirement !== f.sun) return false
    if (f.water && p.waterRequirement !== f.water) return false
    if (f.wet && p.wetTolerance !== f.wet) return false
    return true
  })
}
