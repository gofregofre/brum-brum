-- Migration: PIN attempt limit for Cotxe Uni (project gbtbsavxndpbnkqngmbz)
-- Author: Claude (thread 1), requested by the project owner on 2026-11-26. Idempotent, no data deleted.
--
-- Why not just add a counter to _check_pin?  _check_pin RAISEs on a wrong PIN, and PostgREST rolls
-- back the whole transaction on RAISE, so any "failed attempt" row written before the RAISE would
-- vanish. Instead the RPCs now RETURN an error body and set response.status (400 / 429) so the
-- transaction COMMITS and the failure is recorded.
--
-- Policy (owner decision: 3 attempts):
--   per client IP : 3 wrong PINs within 15 min  -> locked 15 min (even the correct PIN is refused)
--   global        : 30 wrong PINs within 60 min -> everyone locked 30 min (stops IP-rotation attacks;
--                   trade-off: an attacker can lock the group out temporarily)
--   a correct PIN clears that IP's counter.
-- group_pin is NOT read by anything new except the comparison, and is NOT modified.

begin;

create table if not exists public.pin_attempts (
  client_key   text primary key check (length(client_key) <= 64),
  fail_count   integer not null default 0,
  window_start timestamptz not null default now(),
  locked_until timestamptz
);
alter table public.pin_attempts enable row level security;
revoke all on public.pin_attempts from public, anon, authenticated;

-- Client identity: Cloudflare's cf-connecting-ip (set by Supabase's edge), else x-real-ip, else
-- first x-forwarded-for hop. Bounded to 64 chars. Garbage/missing headers -> 'unknown'.
create or replace function public._client_key() returns text
language plpgsql stable security definer set search_path to 'public' as $function$
declare h jsonb; k text;
begin
  begin
    h := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then h := null;
  end;
  k := coalesce(h->>'cf-connecting-ip', h->>'x-real-ip', split_part(h->>'x-forwarded-for', ',', 1));
  k := nullif(btrim(coalesce(k, '')), '');
  return left(coalesce(k, 'unknown'), 64);
end; $function$;

-- Returns 'OK' | 'PIN_INVALID' | 'PIN_LOCKED:<seconds>'. Never raises for a wrong PIN.
create or replace function public._pin_gate(p_pin text) returns text
language plpgsql volatile security definer set search_path to 'public' as $function$
declare
  c_ip_max   constant int := 3;   c_ip_win   constant interval := '15 minutes'; c_ip_lock  constant interval := '15 minutes';
  c_glob_max constant int := 30;  c_glob_win constant interval := '60 minutes'; c_glob_lock constant interval := '30 minutes';
  v_key text := public._client_key();
  v_pin text; v_ip public.pin_attempts; v_gl public.pin_attempts; v_until timestamptz;
begin
  -- opportunistic cleanup of stale rows (bounded table size)
  delete from public.pin_attempts
   where client_key <> '*global*' and window_start < now() - interval '1 day'
     and (locked_until is null or locked_until < now());

  select * into v_ip from public.pin_attempts where client_key = v_key for update;
  select * into v_gl from public.pin_attempts where client_key = '*global*' for update;
  v_until := greatest(case when v_ip.locked_until > now() then v_ip.locked_until end,
                      case when v_gl.locked_until > now() then v_gl.locked_until end);
  if v_until is not null then
    return 'PIN_LOCKED:' || greatest(1, ceil(extract(epoch from v_until - now()))::int);
  end if;

  select value into v_pin from public.app_config where key = 'group_pin';
  if p_pin is not distinct from v_pin and v_pin is not null then
    delete from public.pin_attempts where client_key = v_key;
    return 'OK';
  end if;

  insert into public.pin_attempts as a (client_key, fail_count, window_start) values (v_key, 1, now())
  on conflict (client_key) do update set
    fail_count   = case when a.window_start < now() - c_ip_win then 1 else a.fail_count + 1 end,
    window_start = case when a.window_start < now() - c_ip_win then now() else a.window_start end,
    locked_until = null
  returning * into v_ip;
  if v_ip.fail_count >= c_ip_max then
    update public.pin_attempts set locked_until = now() + c_ip_lock where client_key = v_key;
  end if;

  insert into public.pin_attempts as a (client_key, fail_count, window_start) values ('*global*', 1, now())
  on conflict (client_key) do update set
    fail_count   = case when a.window_start < now() - c_glob_win then 1 else a.fail_count + 1 end,
    window_start = case when a.window_start < now() - c_glob_win then now() else a.window_start end
  returning * into v_gl;
  if v_gl.fail_count >= c_glob_max then
    update public.pin_attempts set locked_until = now() + c_glob_lock, fail_count = 0, window_start = now()
     where client_key = '*global*';
  end if;
  return 'PIN_INVALID';
end; $function$;

-- Builds the error body (PostgREST-like shape) and sets the HTTP status without rolling back.
create or replace function public._pin_error(p_gate text) returns jsonb
language plpgsql volatile security definer set search_path to 'public' as $function$
begin
  if p_gate like 'PIN_LOCKED:%' then
    perform set_config('response.status', '429', true);
    return jsonb_build_object('code', 'P0001', 'message', 'PIN_LOCKED', 'details', null, 'hint', null,
                              'retry_after_s', split_part(p_gate, ':', 2)::int);
  end if;
  perform set_config('response.status', '400', true);
  return jsonb_build_object('code', 'P0001', 'message', 'PIN_INVALID', 'details', null, 'hint', null);
end; $function$;

revoke all on function public._client_key() from public, anon, authenticated;
revoke all on function public._pin_gate(text) from public, anon, authenticated;
revoke all on function public._pin_error(text) from public, anon, authenticated;

create or replace function public.get_carpool_state(p_pin text) returns jsonb
language plpgsql security definer set search_path to 'public' as $function$
declare g text := public._pin_gate(p_pin);
begin
  if g <> 'OK' then return public._pin_error(g); end if;
  return jsonb_build_object(
    'trips', coalesce((select jsonb_agg(to_jsonb(t)) from public.trips t), '[]'::jsonb),
    'weeks', coalesce((select jsonb_agg(to_jsonb(w)) from public.weeks w), '[]'::jsonb),
    'default_price_cents', coalesce((select value::int from public.app_config where key = 'default_price_cents'), 600));
end; $function$;

create or replace function public.upsert_trip(p_pin text, p_trip_key text, p_week_id text, p_trip_date date, p_direction text, p_driver text, p_passengers jsonb, p_price_cents integer) returns jsonb
language plpgsql security definer set search_path to 'public' as $function$
declare v_row public.trips; g text := public._pin_gate(p_pin);
begin
  if g <> 'OK' then return public._pin_error(g); end if;
  insert into public.trips (trip_key, week_id, trip_date, direction, driver, passengers, price_cents, updated_at)
  values (p_trip_key, p_week_id, p_trip_date, p_direction, p_driver, p_passengers, p_price_cents, now())
  on conflict (trip_key) do update set driver = excluded.driver, passengers = excluded.passengers,
    price_cents = excluded.price_cents, updated_at = now()
  returning * into v_row;
  return to_jsonb(v_row);
end; $function$;

create or replace function public.set_week_settled(p_pin text, p_week_id text, p_settled boolean) returns jsonb
language plpgsql security definer set search_path to 'public' as $function$
declare v_row public.weeks; g text := public._pin_gate(p_pin);
begin
  if g <> 'OK' then return public._pin_error(g); end if;
  insert into public.weeks (week_id, settled, settled_at) values (p_week_id, p_settled, case when p_settled then now() else null end)
  on conflict (week_id) do update set settled = excluded.settled, settled_at = case when excluded.settled then now() else null end
  returning * into v_row;
  return to_jsonb(v_row);
end; $function$;

-- Return type changes integer -> jsonb (needed to return the error body), so DROP + CREATE.
drop function if exists public.set_default_price(text, integer);
create function public.set_default_price(p_pin text, p_price_cents integer) returns jsonb
language plpgsql security definer set search_path to 'public' as $function$
declare g text := public._pin_gate(p_pin);
begin
  if g <> 'OK' then return public._pin_error(g); end if;
  if p_price_cents is null or p_price_cents < 0 or p_price_cents > 100000 then raise exception 'PRICE_INVALID'; end if;
  insert into public.app_config (key, value) values ('default_price_cents', p_price_cents::text)
  on conflict (key) do update set value = excluded.value;
  return jsonb_build_object('default_price_cents', p_price_cents);
end; $function$;

grant execute on function public.get_carpool_state(text) to anon, authenticated;
grant execute on function public.upsert_trip(text, text, text, date, text, text, jsonb, integer) to anon, authenticated;
grant execute on function public.set_week_settled(text, text, boolean) to anon, authenticated;
grant execute on function public.set_default_price(text, integer) to anon, authenticated;

commit;
