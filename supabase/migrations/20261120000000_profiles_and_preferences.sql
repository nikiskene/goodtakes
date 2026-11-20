begin;

create table if not exists public.goodtake_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 80)
);

alter table public.goodtake_profiles enable row level security;
revoke all on public.goodtake_profiles from public, anon, authenticated;
grant select, insert, update, delete on public.goodtake_profiles to authenticated;

drop policy if exists "Users manage their own GoodTake profile" on public.goodtake_profiles;
create policy "Users manage their own GoodTake profile"
  on public.goodtake_profiles for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create table if not exists public.goodtake_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  aspect_ratio text check (aspect_ratio in ('vertical', 'landscape')),
  caption_style text check (caption_style in ('editorial', 'emphasis'))
);

alter table public.goodtake_preferences enable row level security;
revoke all on public.goodtake_preferences from public, anon, authenticated;
grant select, insert, update, delete on public.goodtake_preferences to authenticated;

drop policy if exists "Users manage their own GoodTake preferences" on public.goodtake_preferences;
create policy "Users manage their own GoodTake preferences"
  on public.goodtake_preferences for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create table if not exists public.goodtake_account_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('owner'))
);

alter table public.goodtake_account_roles enable row level security;
revoke all on public.goodtake_account_roles from public, anon, authenticated;
grant select on public.goodtake_account_roles to authenticated;

drop policy if exists "Users read their own GoodTake role" on public.goodtake_account_roles;
create policy "Users read their own GoodTake role"
  on public.goodtake_account_roles for select to authenticated
  using ((select auth.uid()) = user_id);

commit;
