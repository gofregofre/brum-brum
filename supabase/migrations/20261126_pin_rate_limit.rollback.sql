-- ROLLBACK of 20261126_pin_rate_limit.sql: restores the original RPC bodies (read 2026-11-26). Keeps pin_attempts table (harmless).
begin;
drop function if exists public.set_default_price(text, integer);
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
revoke all on function public._pin_gate(text), public._pin_error(text), public._client_key() from public, anon, authenticated;
grant execute on function public.get_carpool_state(text) to anon, authenticated;
grant execute on function public.upsert_trip(text, text, text, date, text, text, jsonb, integer) to anon, authenticated;
grant execute on function public.set_week_settled(text, text, boolean) to anon, authenticated;
grant execute on function public.set_default_price(text, integer) to anon, authenticated;
commit;
