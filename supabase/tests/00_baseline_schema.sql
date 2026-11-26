-- Local replica of the production schema as read on 2026-11-26 (pg_get_functiondef). TEST ONLY.
-- The test PIN 4321 is fake and only exists in this local database.
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
end $$;
create table public.app_config (key text primary key, value text not null);
create table public.trips (trip_key text primary key, week_id text not null, trip_date date not null,
  direction text not null check (direction = any (array['anada','tornada'])), driver text,
  passengers jsonb not null default '[]'::jsonb, price_cents integer not null default 600,
  updated_at timestamptz not null default now());
create table public.weeks (week_id text primary key, settled boolean not null default false, settled_at timestamptz);
alter table public.app_config enable row level security;
alter table public.trips enable row level security;
alter table public.weeks enable row level security;
insert into public.app_config values ('group_pin','4321'),('default_price_cents','600');

create or replace function public._check_pin(p_pin text) returns void language plpgsql security definer set search_path to 'public' as $function$
declare v_pin text;
begin
  select value into v_pin from public.app_config where key = 'group_pin';
  if p_pin is distinct from v_pin then raise exception 'PIN_INVALID' using errcode = 'P0001'; end if;
end; $function$;
create or replace function public.get_carpool_state(p_pin text) returns jsonb language plpgsql security definer set search_path to 'public' as $function$
begin
  perform public._check_pin(p_pin);
  return jsonb_build_object(
    'trips', coalesce((select jsonb_agg(to_jsonb(t)) from public.trips t), '[]'::jsonb),
    'weeks', coalesce((select jsonb_agg(to_jsonb(w)) from public.weeks w), '[]'::jsonb),
    'default_price_cents', coalesce((select value::int from public.app_config where key = 'default_price_cents'), 600));
end; $function$;
create or replace function public.upsert_trip(p_pin text, p_trip_key text, p_week_id text, p_trip_date date, p_direction text, p_driver text, p_passengers jsonb, p_price_cents integer) returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare v_row public.trips;
begin
  perform public._check_pin(p_pin);
  insert into public.trips (trip_key, week_id, trip_date, direction, driver, passengers, price_cents, updated_at)
  values (p_trip_key, p_week_id, p_trip_date, p_direction, p_driver, p_passengers, p_price_cents, now())
  on conflict (trip_key) do update set driver = excluded.driver, passengers = excluded.passengers,
    price_cents = excluded.price_cents, updated_at = now()
  returning * into v_row;
  return to_jsonb(v_row);
end; $function$;
create or replace function public.set_week_settled(p_pin text, p_week_id text, p_settled boolean) returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare v_row public.weeks;
begin
  perform public._check_pin(p_pin);
  insert into public.weeks (week_id, settled, settled_at) values (p_week_id, p_settled, case when p_settled then now() else null end)
  on conflict (week_id) do update set settled = excluded.settled, settled_at = case when excluded.settled then now() else null end
  returning * into v_row;
  return to_jsonb(v_row);
end; $function$;
create or replace function public.set_default_price(p_pin text, p_price_cents integer) returns integer language plpgsql security definer set search_path to 'public' as $function$
begin
  perform public._check_pin(p_pin);
  if p_price_cents < 0 or p_price_cents > 100000 then raise exception 'PRICE_INVALID'; end if;
  insert into public.app_config (key, value) values ('default_price_cents', p_price_cents::text)
  on conflict (key) do update set value = excluded.value;
  return p_price_cents;
end; $function$;
