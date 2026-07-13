-- ── landscape-ai-advisor：植物雲端資料庫 schema ──────────────────────────────
-- 用途：AI / 指定植物網站查詢成功、使用者人工確認後，永久寫入這張表。
-- 下次搜尋同一植物時，直接從這張表讀取，不再呼叫 Claude API / web_search。
--
-- 使用方式：complete 全部貼到 Supabase Dashboard → SQL Editor → New query，
-- 按 Run 執行一次即可（可重複執行，已用 IF NOT EXISTS 保護）。

create extension if not exists "pgcrypto";

create table if not exists public.plants (
  id                    uuid primary key default gen_random_uuid(),

  -- ── identity / 比對用欄位 ──────────────────────────────────────────────────
  name                  text not null,                 -- 中文名稱
  normalized_name       text not null,                 -- 正規化名稱（trim/全半形/台灣異體字/小寫後）
  scientific_name       text default '',
  normalized_scientific_name text default '',
  english_name          text default '',
  aliases               text[] not null default '{}',  -- 別名清單（正規化後儲存，供比對）
  family                text default '',                -- 科名
  genus                 text default '',                -- 屬名

  -- ── 分類 / 型態 ───────────────────────────────────────────────────────────
  plant_type            text default '',                -- 植物類型（喬木/灌木/地被…）
  normalized_category   text default '',                -- tree / shrub / groundcover
  height                text default '',
  crown_width           text default '',

  -- ── 環境需求 ──────────────────────────────────────────────────────────────
  sun_requirement       text default '',
  water_requirement     text default '',
  drought_tolerance     text default '',
  wet_tolerance         text default '',
  soil_requirement      text default '',
  maintenance_level     text default '',

  -- ── 用途 / 備註 ───────────────────────────────────────────────────────────
  landscape_use         text default '',                -- 景觀用途

  -- ── 資料來源 / 追溯 ───────────────────────────────────────────────────────
  data_source           text not null default 'ai_web_search',
  -- 'csv' | 'cloud_db' | 'taipei_botanical' | 'moa_agriculture' | 'ai_web_search'
  source_url            text default '',

  -- ── 完整欄位資料（保留原始查詢結果，供之後畫面顯示完整欄位）──────────────
  full_record           jsonb not null default '{}'::jsonb,

  -- ── 稽核欄位 ──────────────────────────────────────────────────────────────
  created_at            timestamptz not null default now(),
  is_ai_generated        boolean not null default true,
  is_verified            boolean not null default false  -- 是否已人工確認（目前流程：確認才會寫入，預設 true 情境另計）
);

-- 比對加速索引
create index if not exists plants_normalized_name_idx on public.plants (normalized_name);
create index if not exists plants_normalized_scientific_name_idx on public.plants (normalized_scientific_name);
create index if not exists plants_aliases_gin_idx on public.plants using gin (aliases);

-- 避免同一正規化名稱重複建立（人工確認新增前程式會先查一次，這裡再加一層資料庫保護）
create unique index if not exists plants_normalized_name_unique on public.plants (normalized_name);

-- ── Row Level Security ───────────────────────────────────────────────────────
-- 目前 APP 是公司內部使用、用 anon key 直接讀寫，先開放 anon 讀寫，
-- 之後若要收緊權限（例如只有登入使用者可寫），再另外調整 policy。
alter table public.plants enable row level security;

drop policy if exists "plants_select_anon" on public.plants;
create policy "plants_select_anon" on public.plants
  for select using (true);

drop policy if exists "plants_insert_anon" on public.plants;
create policy "plants_insert_anon" on public.plants
  for insert with check (true);

drop policy if exists "plants_update_anon" on public.plants;
create policy "plants_update_anon" on public.plants
  for update using (true);
