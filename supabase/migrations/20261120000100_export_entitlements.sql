begin;

create table if not exists public.goodtake_export_entitlements (
  user_id uuid primary key references auth.users(id) on delete cascade,
  access_until timestamptz not null
);

alter table public.goodtake_export_entitlements enable row level security;
revoke all on table public.goodtake_export_entitlements from public, anon, authenticated;
grant select on table public.goodtake_export_entitlements to authenticated;
grant select, insert, update, delete on table public.goodtake_export_entitlements to service_role;

drop policy if exists "Users read their own GoodTake export access" on public.goodtake_export_entitlements;
create policy "Users read their own GoodTake export access"
  on public.goodtake_export_entitlements for select to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.goodtake_has_export_access()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1
    from public.goodtake_export_entitlements
    where user_id = (select auth.uid())
      and access_until > now()
  );
$$;

revoke all on function public.goodtake_has_export_access() from public, anon, authenticated;
grant execute on function public.goodtake_has_export_access() to authenticated;

commit;
