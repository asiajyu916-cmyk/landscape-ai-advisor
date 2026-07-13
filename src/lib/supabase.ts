// ── Supabase client ────────────────────────────────────────────────────────────
// 讀取 Vercel / .env.local 設定的 VITE_SUPABASE_URL、VITE_SUPABASE_ANON_KEY。
// 尚未設定時 supabase 為 null，呼叫端一律要檢查、優雅降級（不拋例外中斷流程），
// 因為 Supabase 是「植物雲端資料庫」這個附加功能的後端，不應該讓其他既有功能
// （本地 CSV 比對、AI 搜尋）在沒設定 Supabase 時也一起壞掉。

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY)

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(SUPABASE_URL as string, SUPABASE_ANON_KEY as string)
  : null

if (!isSupabaseConfigured && typeof window !== 'undefined') {
  console.warn(
    '[supabase] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY 尚未設定，' +
    '植物雲端資料庫功能將停用（AI/網站查詢結果不會永久儲存，本地 CSV 比對不受影響）。'
  )
}
