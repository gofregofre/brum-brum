-- Migration: multi-group schema for the Cotxe Uni PILOT (a NEW, separate Supabase project).
-- NEVER run this on the production project gbtbsavxndpbnkqngmbz: it is a different schema.
-- Author: Claude (thread 4), requested by the project owner on 2026-11-26. Idempotent, deletes no data.
-- Needs pgcrypto in schema "extensions" (Supabase default).
--
-- Access model: group code (10 random chars, ~1e15 combinations) + 6-digit PIN stored as bcrypt.
-- Lockouts (all commit, because the gate RETURNS instead of RAISING, same trick as the prod migration):
--   (group, IP)   : 5 wrong PINs / 15 min  -> that IP locked out of THAT group for 15 min
--   group ceiling : 30 wrong PINs / 60 min -> that group locked 30 min (rotating-IP attack)
--   unknown code  : 10 unknown codes / 60 min from one IP -> that IP locked out of unknown-code probing 60 min
-- A wrong PIN and an unknown code give the same answer (PIN_INVALID), and both run one bcrypt, so
-- a caller cannot tell whether a group exists.

begin;

create table if not exists public.groups (
  id                  uuid primary key default gen_random_uuid(),
  code                text not null unique check (code ~ '^[a-z0-9]{10}$'),
  pin_hash            text not null,
  members             text[] not null,
  default_price_cents integer not null default 600 check (default_price_cents between 0 and 100000),
  created_at          timestamptz not null default now()
);
create table if not exists public.trips (
  group_id    uuid not null references public.groups(id) on delete cascade,
  trip_key    text not null,
  week_id     text not null,
  trip_date   date not null,
  direction   text not null check (direction in ('anada','tornada')),
  driver      text,
  passengers  jsonb not null default '[]'::jsonb,
  price_cents integer not null default 600 check (price_cents between 0 and 100000),
  updated_at  timestamptz not null default now(),
  primary key (group_id, trip_key)
);
create table if not exists public.weeks (
  group_id   uuid not null references public.groups(id) on delete cascade,
  week_id    text not null,
  settled    boolean not null default false,
  settled_at timestamptz,
  primary key (group_id, week_id)
);
create table if not exists public.trip_history (
  id         bigserial primary key,
  group_id   uuid not null references public.groups(id) on delete cascade,
  trip_key   text not null,
  changed_at timestamptz not null default now(),
  old_row    jsonb,
  new_row    jsonb not null
);
create index if not exists trip_history_group_idx on public.trip_history (group_id, trip_key);
create table if not exists public.pin_attempts (
  scope        text not null check (length(scope) <= 64),
  client_key   text not null check (length(client_key) <= 64),
  fail_count   integer not null default 0,
  window_start timestamptz not null default now(),
  locked_until timestamptz,
  primary key (scope, client_key)
);
alter table public.groups       enable row level security;
alter table public.trips        enable row level security;
alter table public.weeks        enable row level security;
alter table public.trip_history enable row level security;
alter table public.pin_attempts enable row level security;
revoke all on public.groups, public.trips, public.weeks, public.trip_history, public.pin_attempts
  from public, anon, authenticated;

-- History trigger: every insert/update of a trip is kept (what and when; there are no accounts, so not who).
create or replace function public._trip_history() returns trigger
language plpgsql security definer set search_path to 'public' as $function$
begin
  insert into public.trip_history (group_id, trip_key, old_row, new_row)
  values (new.group_id, new.trip_key,
          case when tg_op = 'UPDATE' then to_jsonb(old) - 'group_id' end,
          to_jsonb(new) - 'group_id');
  return new;
end; $function$;
drop trigger if exists trips_history on public.trips;
create trigger trips_history after insert or update on public.trips
  for each row execute function public._trip_history();

create or replace function public._client_key() returns text
language plpgsql stable security definer set search_path to 'public' as $function$
declare h jsonb; k text;
begin
  begin h := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then h := null; end;
  k := coalesce(h->>'cf-connecting-ip', h->>'x-real-ip', split_part(h->>'x-forwarded-for', ',', 1));
  k := nullif(btrim(coalesce(k, '')), '');
  return left(coalesce(k, 'unknown'), 64);
end; $function$;

-- Records one failure for (scope, key); locks when the count reaches p_max within p_win.
create or replace function public._fail(p_scope text, p_key text, p_max int, p_win interval, p_lock interval) returns void
language plpgsql volatile security definer set search_path to 'public' as $function$
declare r public.pin_attempts;
begin
  insert into public.pin_attempts as a (scope, client_key, fail_count, window_start) values (p_scope, p_key, 1, now())
  on conflict (scope, client_key) do update set
    fail_count   = case when a.window_start < now() - p_win or a.locked_until is not null then 1 else a.fail_count + 1 end,
    window_start = case when a.window_start < now() - p_win or a.locked_until is not null then now() else a.window_start end,
    locked_until = null
  returning * into r;
  if r.fail_count >= p_max then
    update public.pin_attempts set locked_until = now() + p_lock where scope = p_scope and client_key = p_key;
  end if;
end; $function$;

-- o_status: 'OK' | 'PIN_INVALID' | 'PIN_LOCKED:<seconds>'. Never raises for bad credentials.
create or replace function public._group_gate(p_group text, p_pin text, out o_status text, out o_group uuid)
language plpgsql volatile security definer set search_path to 'public' as $function$
declare
  v_key text := public._client_key();
  v_g public.groups; v_until timestamptz; v_ok boolean;
  v_pin text := case when length(p_pin) between 1 and 64 then p_pin else '' end;
begin
  delete from public.pin_attempts where window_start < now() - interval '1 day'
     and (locked_until is null or locked_until < now());

  if p_group is not null and length(p_group) = 10 then
    select * into v_g from public.groups where code = p_group;
  end if;

  if v_g.id is null then
    select locked_until into v_until from public.pin_attempts
     where scope = 'nogroup' and client_key = v_key and locked_until > now();
    if v_until is not null then
      o_status := 'PIN_LOCKED:' || greatest(1, ceil(extract(epoch from v_until - now()))::int); return;
    end if;
    perform extensions.crypt(v_pin, extensions.gen_salt('bf', 8));   -- same cost as a real check
    perform public._fail('nogroup', v_key, 10, interval '60 minutes', interval '60 minutes');
    o_status := 'PIN_INVALID'; return;
  end if;

  select max(locked_until) into v_until from public.pin_attempts
   where scope = v_g.id::text and client_key in (v_key, '*group*') and locked_until > now();
  if v_until is not null then
    o_status := 'PIN_LOCKED:' || greatest(1, ceil(extract(epoch from v_until - now()))::int); return;
  end if;

  v_ok := v_pin <> '' and extensions.crypt(v_pin, v_g.pin_hash) = v_g.pin_hash;
  if v_ok then
    delete from public.pin_attempts where scope = v_g.id::text and client_key = v_key;
    o_status := 'OK'; o_group := v_g.id; return;
  end if;
  perform public._fail(v_g.id::text, v_key, 5, interval '15 minutes', interval '15 minutes');
  perform public._fail(v_g.id::text, '*group*', 30, interval '60 minutes', interval '30 minutes');
  o_status := 'PIN_INVALID';
end; $function$;

create or replace function public._pin_error(p_gate text) returns jsonb
language plpgsql volatile security definer set search_path to 'public' as $function$
begin
  if p_gate like 'PIN_LOCKED:%' then
    perform set_config('response.status', '429', true);
    return jsonb_build_object('code','P0001','message','PIN_LOCKED','details',null,'hint',null,
                              'retry_after_s', split_part(p_gate, ':', 2)::int);
  end if;
  perform set_config('response.status', '400', true);
  return jsonb_build_object('code','P0001','message','PIN_INVALID','details',null,'hint',null);
end; $function$;

-- Admin only (SQL editor). Returns the new group code; give it + the PIN to the group in person.
create or replace function public.admin_create_group(p_members text[], p_pin text, p_price_cents integer default 600) returns text
language plpgsql volatile security definer set search_path to 'public' as $function$
declare
  c_alpha constant text := 'abcdefghijkmnpqrstuvwxyz23456789';   -- 32 symbols, no 0/o/1/l
  v_code text; b bytea; i int;
begin
  if p_pin is null or p_pin !~ '^[0-9]{6}$' then raise exception 'GROUP_INVALID: PIN must be 6 digits'; end if;
  if p_members is null or coalesce(array_length(p_members, 1), 0) not between 2 and 8 then
    raise exception 'GROUP_INVALID: 2 to 8 members'; end if;
  if exists (select 1 from unnest(p_members) m where m is null or m !~ '^[A-Za-z0-9]{1,12}$') then
    raise exception 'GROUP_INVALID: member labels must be 1-12 letters or digits'; end if;
  if (select count(distinct m) from unnest(p_members) m) <> array_length(p_members, 1) then
    raise exception 'GROUP_INVALID: duplicate member'; end if;
  if p_price_cents is null or p_price_cents not between 0 and 100000 then raise exception 'GROUP_INVALID: price'; end if;
  loop
    b := extensions.gen_random_bytes(10); v_code := '';
    for i in 0..9 loop v_code := v_code || substr(c_alpha, (get_byte(b, i) % 32) + 1, 1); end loop;
    exit when not exists (select 1 from public.groups where code = v_code);
  end loop;
  insert into public.groups (code, pin_hash, members, default_price_cents)
  values (v_code, extensions.crypt(p_pin, extensions.gen_salt('bf', 8)), p_members, p_price_cents);
  return v_code;
end; $function$;

create or replace function public.get_carpool_state(p_group text, p_pin text) returns jsonb
language plpgsql security definer set search_path to 'public' as $function$
declare g record;
begin
  select * into g from public._group_gate(p_group, p_pin);
  if g.o_status <> 'OK' then return public._pin_error(g.o_status); end if;
  return jsonb_build_object(
    'members', (select to_jsonb(members) from public.groups where id = g.o_group),
    'trips', coalesce((select jsonb_agg(to_jsonb(t) - 'group_id' order by t.trip_key) from public.trips t where t.group_id = g.o_group), '[]'::jsonb),
    'weeks', coalesce((select jsonb_agg(to_jsonb(w) - 'group_id' order by w.week_id) from public.weeks w where w.group_id = g.o_group), '[]'::jsonb),
    'default_price_cents', (select default_price_cents from public.groups where id = g.o_group));
end; $function$;

create or replace function public.upsert_trip(p_group text, p_pin text, p_trip_key text, p_week_id text, p_trip_date date,
  p_direction text, p_driver text, p_passengers jsonb, p_price_cents integer) returns jsonb
language plpgsql security definer set search_path to 'public' as $function$
declare g record; v_members text[]; m text[]; v_row public.trips;
begin
  select * into g from public._group_gate(p_group, p_pin);
  if g.o_status <> 'OK' then return public._pin_error(g.o_status); end if;
  select members into v_members from public.groups where id = g.o_group;

  m := regexp_match(coalesce(p_trip_key, ''), '^([0-9]{4}-[0-9]{2}-[0-9]{2})_(anada|tornada)(_([2-9]))?$');
  if m is null then raise exception 'TRIP_INVALID: trip_key format'; end if;
  if p_trip_date is null or m[1] <> to_char(p_trip_date, 'YYYY-MM-DD') then raise exception 'TRIP_INVALID: trip_key date'; end if;
  if p_direction is distinct from m[2] then raise exception 'TRIP_INVALID: trip_key direction'; end if;
  if m[4] is not null and m[4]::int > array_length(v_members, 1) then raise exception 'TRIP_INVALID: too many cars'; end if;
  if p_week_id is distinct from to_char(p_trip_date, 'IYYY-"W"IW') then raise exception 'TRIP_INVALID: week'; end if;
  if p_price_cents is null or p_price_cents not between 0 and 100000 then raise exception 'TRIP_INVALID: price'; end if;
  if p_passengers is null or jsonb_typeof(p_passengers) <> 'array' then raise exception 'TRIP_INVALID: passengers'; end if;
  if exists (select 1 from jsonb_array_elements(p_passengers) e
             where jsonb_typeof(e) <> 'string' or not ((e #>> '{}') = any (v_members))) then
    raise exception 'TRIP_INVALID: passenger not in group'; end if;
  if (select count(distinct e) from jsonb_array_elements(p_passengers) e) <> jsonb_array_length(p_passengers) then
    raise exception 'TRIP_INVALID: duplicate passenger'; end if;
  if p_driver is not null and not (p_passengers ? p_driver) then raise exception 'TRIP_INVALID: driver not in car'; end if;

  insert into public.trips (group_id, trip_key, week_id, trip_date, direction, driver, passengers, price_cents, updated_at)
  values (g.o_group, p_trip_key, p_week_id, p_trip_date, p_direction, p_driver, p_passengers, p_price_cents, now())
  on conflict (group_id, trip_key) do update set driver = excluded.driver, passengers = excluded.passengers,
    price_cents = excluded.price_cents, updated_at = now()
  returning * into v_row;
  return to_jsonb(v_row) - 'group_id';
end; $function$;

create or replace function public.set_week_settled(p_group text, p_pin text, p_week_id text, p_settled boolean) returns jsonb
language plpgsql security definer set search_path to 'public' as $function$
declare g record; v_row public.weeks;
begin
  select * into g from public._group_gate(p_group, p_pin);
  if g.o_status <> 'OK' then return public._pin_error(g.o_status); end if;
  if p_week_id is null or p_week_id !~ '^[0-9]{4}-W[0-9]{2}$' or p_settled is null then raise exception 'WEEK_INVALID'; end if;
  insert into public.weeks (group_id, week_id, settled, settled_at)
  values (g.o_group, p_week_id, p_settled, case when p_settled then now() end)
  on conflict (group_id, week_id) do update set settled = excluded.settled,
    settled_at = case when excluded.settled then now() end
  returning * into v_row;
  return to_jsonb(v_row) - 'group_id';
end; $function$;

create or replace function public.set_default_price(p_group text, p_pin text, p_price_cents integer) returns jsonb
language plpgsql security definer set search_path to 'public' as $function$
declare g record;
begin
  select * into g from public._group_gate(p_group, p_pin);
  if g.o_status <> 'OK' then return public._pin_error(g.o_status); end if;
  if p_price_cents is null or p_price_cents not between 0 and 100000 then raise exception 'PRICE_INVALID'; end if;
  update public.groups set default_price_cents = p_price_cents where id = g.o_group;
  return jsonb_build_object('default_price_cents', p_price_cents);
end; $function$;

-- Right to erasure: PIN + the group code typed again. Deletes the group and everything under it.
create or replace function public.delete_group(p_group text, p_pin text, p_confirm text) returns jsonb
language plpgsql security definer set search_path to 'public' as $function$
declare g record;
begin
  select * into g from public._group_gate(p_group, p_pin);
  if g.o_status <> 'OK' then return public._pin_error(g.o_status); end if;
  if p_confirm is distinct from p_group then raise exception 'CONFIRM_MISMATCH'; end if;
  delete from public.groups where id = g.o_group;
  delete from public.pin_attempts where scope = g.o_group::text;
  return jsonb_build_object('deleted', true);
end; $function$;

-- Postgres grants EXECUTE to PUBLIC by default: take it away from everything, then grant the 5 RPCs.
revoke all on function public._trip_history() from public, anon, authenticated;
revoke all on function public._client_key() from public, anon, authenticated;
revoke all on function public._fail(text, text, int, interval, interval) from public, anon, authenticated;
revoke all on function public._group_gate(text, text) from public, anon, authenticated;
revoke all on function public._pin_error(text) from public, anon, authenticated;
revoke all on function public.admin_create_group(text[], text, integer) from public, anon, authenticated;
revoke all on function public.get_carpool_state(text, text) from public;
revoke all on function public.upsert_trip(text, text, text, text, date, text, text, jsonb, integer) from public;
revoke all on function public.set_week_settled(text, text, text, boolean) from public;
revoke all on function public.set_default_price(text, text, integer) from public;
revoke all on function public.delete_group(text, text, text) from public;
grant execute on function public.get_carpool_state(text, text) to anon, authenticated;
grant execute on function public.upsert_trip(text, text, text, text, date, text, text, jsonb, integer) to anon, authenticated;
grant execute on function public.set_week_settled(text, text, text, boolean) to anon, authenticated;
grant execute on function public.set_default_price(text, text, integer) to anon, authenticated;
grant execute on function public.delete_group(text, text, text) to anon, authenticated;

commit;
