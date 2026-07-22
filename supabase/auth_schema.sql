-- ── landscape-ai-advisor：登入與角色權限 schema ──────────────────────────────
-- 用途：新增 profiles 表（角色/狀態），並收緊既有 plants 表的 RLS。
--
-- 使用方式：全部貼到 Supabase Dashboard → SQL Editor → New query，
-- 按 Run 執行一次即可（可重複執行，已用 IF NOT EXISTS / OR REPLACE 保護）。

-- ── profiles 表 ────────────────────────────────────────────────────────────
-- id 對應 auth.users.id；role/status 決定該帳號能用哪些功能，見 src/lib/permissions.ts。

create table if not exists public.profiles (
  id             uuid primary key references auth.users(id) on delete cascade,
  email          text not null,
  display_name   text,
  company        text,
  role           text not null default 'viewer' check (role in ('admin','reviewer','viewer','disabled')),
  status         text not null default 'disabled' check (status in ('active','disabled')),
  created_at     timestamptz not null default now(),
  last_login_at  timestamptz
);

alter table public.profiles enable row level security;

-- ── is_admin()：目前登入者是否為啟用中的 admin，供下面政策共用 ──────────────
create or replace function public.is_admin() returns boolean
language sql security definer stable as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and status = 'active'
  );
$$;

-- ── profiles RLS：本人或 admin 可讀／寫自己的列 ─────────────────────────────
drop policy if exists "profiles_select_own_or_admin" on public.profiles;
create policy "profiles_select_own_or_admin" on public.profiles
  for select using (auth.uid() = id or public.is_admin());

drop policy if exists "profiles_update_own_or_admin" on public.profiles;
create policy "profiles_update_own_or_admin" on public.profiles
  for update using (auth.uid() = id or public.is_admin());

-- 一般使用者能更新自己的列（如 last_login_at、display_name），但不能自己把
-- role/status 改掉——RLS 的 USING/WITH CHECK 沒辦法直接比較新舊欄位值，
-- 用 trigger 擋：非 admin 卻想改 role 或 status 就直接擋掉整個更新。
create or replace function public.protect_profile_role_status() returns trigger
language plpgsql security definer as $$
begin
  -- auth.uid() 為 null 代表這次呼叫不是透過一般使用者的已登入 session
  -- （Supabase SQL Editor、postgres 角色直接下指令、service_role key 都屬於
  -- 這種情況——這些都需要資料庫直接存取權限或後端密鑰才碰得到，屬於信任層級，
  -- 直接放行；一般使用者透過 app 端 supabase-js 的請求一定會帶 JWT，
  -- auth.uid() 一定有值，這條路徑的保護完全不受影響）。
  if auth.uid() is not null and not public.is_admin() then
    if new.role is distinct from old.role or new.status is distinct from old.status then
      raise exception '無權限修改角色或帳號狀態';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_protect_profile_role_status on public.profiles;
create trigger trg_protect_profile_role_status
  before update on public.profiles
  for each row execute function public.protect_profile_role_status();

-- ── 新使用者自動建立 profiles 列 ─────────────────────────────────────────
-- 預設 role='viewer'、status='disabled'：新帳號建立後預設不能用，
-- 要 admin 手動到 profiles 表把 status 改成 active、指定正確的 role。
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer as $$
begin
  insert into public.profiles (id, email, display_name, role, status)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', new.email),
    'viewer',
    'disabled'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_handle_new_user on auth.users;
create trigger trg_handle_new_user
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── 收緊既有 plants 表的 RLS ─────────────────────────────────────────────
-- 原本 schema.sql 開放 anon 完全讀寫；現在整個 APP 都要求登入，
-- 讀取需要登入、新增/修改僅限 admin（對應 canManagePlants 權限）。
--
-- 用 to_regclass 判斷 plants 表是否存在才動作：若尚未執行過 schema.sql
-- （plants 表不存在），直接引用 public.plants 會整個腳本連 profiles 表、
-- trigger 都一起失敗（Supabase SQL Editor 是單一 transaction，一個陳述式
-- 出錯全部 rollback）——這正是「profiles 表沒建出來」的實際成因之一。
do $$
begin
  if to_regclass('public.plants') is not null then
    execute 'drop policy if exists "plants_select_anon" on public.plants';
    execute 'drop policy if exists "plants_select_authenticated" on public.plants';
    execute 'create policy "plants_select_authenticated" on public.plants for select using (auth.uid() is not null)';

    execute 'drop policy if exists "plants_insert_anon" on public.plants';
    execute 'drop policy if exists "plants_insert_admin" on public.plants';
    execute 'create policy "plants_insert_admin" on public.plants for insert with check (public.is_admin())';

    execute 'drop policy if exists "plants_update_anon" on public.plants';
    execute 'drop policy if exists "plants_update_admin" on public.plants';
    execute 'create policy "plants_update_admin" on public.plants for update using (public.is_admin())';
  end if;
end $$;

-- ── Backfill：補建已存在、但因上述問題沒建到 profiles 的 auth user ──────────
-- 涵蓋「帳號已經在 auth.users、但 profiles 沒有對應列」的情形，等效於
-- handle_new_user() trigger 補跑一次；新舊帳號都能重複執行、不會出錯。
insert into public.profiles (id, email, display_name, role, status)
select u.id, u.email, u.email, 'viewer', 'disabled'
from auth.users u
left join public.profiles p on p.id = u.id
where p.id is null
on conflict (id) do nothing;
