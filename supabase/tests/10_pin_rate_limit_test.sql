-- Tests for 20261126_pin_rate_limit.sql. Each psql statement = one transaction (like PostgREST).
\set ON_ERROR_STOP 1
create schema if not exists t;
create or replace function t.call(p_ip text, p_fn text, p_pin text) returns jsonb language plpgsql as $$
declare r jsonb; h text;
begin
  h := case when p_ip is null then '{}' else json_build_object('cf-connecting-ip', p_ip)::text end;
  perform set_config('request.headers', h, true);
  perform set_config('response.status', '', true);
  if p_fn = 'state' then r := public.get_carpool_state(p_pin);
  elsif p_fn = 'upsert' then r := public.upsert_trip(p_pin, '2026-11-23_anada', '2026-W48', '2026-11-23', 'anada', 'J', '["A","J"]'::jsonb, 600);
  elsif p_fn = 'settle' then r := public.set_week_settled(p_pin, '2026-W48', true);
  elsif p_fn = 'price' then r := to_jsonb(public.set_default_price(p_pin, 650));
  end if;
  return jsonb_build_object('status', nullif(current_setting('response.status', true), ''), 'body', r);
end $$;
grant usage on schema t to anon; grant execute on function t.call(text,text,text) to anon;
create or replace function t.eq(a anyelement, b anyelement, msg text) returns void language plpgsql as $$
begin if a is distinct from b then raise exception 'FAIL %: got % expected %', msg, a, b; end if; raise notice 'ok - %', msg; end $$;
grant execute on function t.eq(anyelement, anyelement, text) to anon;

set role anon;
-- 1. correct PIN works, no status override
select t.eq((t.call('10.0.0.1','state','4321')->>'status'), null::text, 'correct pin -> no error status');
select t.eq((t.call('10.0.0.1','state','4321')->'body'->>'default_price_cents'), '600', 'correct pin -> state returned');
-- 2. wrong PIN -> 400 PIN_INVALID body, no data leaked
select t.eq((t.call('10.0.0.2','state','0000')->>'status'), '400', 'wrong pin -> 400');
select t.eq((t.call('10.0.0.2','state','0000')->'body'->>'message'), 'PIN_INVALID', 'wrong pin -> PIN_INVALID');
select t.eq((t.call('10.0.0.2','state','0000')->'body' ? 'trips'), false, 'wrong pin -> no trips leaked');
-- 3. failures persist across transactions (the core bug a RAISE would cause)
reset role;
select t.eq((select fail_count from public.pin_attempts where client_key='10.0.0.2'), 3, 'failures committed across transactions');
set role anon;
-- 4. 3rd failure (user decision: 3 attempts) locks this IP; correct PIN refused with 429, not even checked
select t.eq((t.call('10.0.0.2','state','4321')->>'status'), '429', 'locked ip -> 429 even with correct pin');
select t.eq((t.call('10.0.0.2','state','4321')->'body'->>'message'), 'PIN_LOCKED', 'locked ip -> PIN_LOCKED');
select t.eq(((t.call('10.0.0.2','state','4321')->'body'->>'retry_after_s')::int between 1 and 900), true, 'retry_after_s in (0,900]');
-- 5. other IP unaffected
select t.eq((t.call('10.0.0.3','state','4321')->>'status'), null::text, 'other ip unaffected');
-- 6. writes also gated and wrong PIN never writes
select t.eq((t.call('10.0.0.4','upsert','0000')->'body'->>'message'), 'PIN_INVALID', 'upsert wrong pin');
select t.eq((t.call('10.0.0.4','settle','0000')->'body'->>'message'), 'PIN_INVALID', 'settle wrong pin');
select t.eq((t.call('10.0.0.4','price','0000')->'body'->>'message'), 'PIN_INVALID', 'price wrong pin');
reset role;
select t.eq((select count(*) from public.trips), 0::bigint, 'no trip written with wrong pin');
select t.eq((select count(*) from public.weeks), 0::bigint, 'no week written with wrong pin');
select t.eq((select value from public.app_config where key='default_price_cents'), '600', 'price unchanged with wrong pin');
set role anon;
-- 7. correct writes still work and keep their return shapes
select t.eq((t.call('10.0.0.5','upsert','4321')->'body'->>'driver'), 'J', 'upsert ok');
select t.eq((t.call('10.0.0.5','settle','4321')->'body'->>'settled'), 'true', 'settle ok');
select t.eq((t.call('10.0.0.5','price','4321')->'body'->>'default_price_cents'), '650', 'price ok (jsonb now)');
-- 8. success resets the IP counter (typo then correct)
select t.call('10.0.0.6','state','0001'); select t.call('10.0.0.6','state','4321');
reset role;
select t.eq((select count(*) from public.pin_attempts where client_key='10.0.0.6'), 0::bigint, 'success clears ip counter');
-- 9. lock expires: move time back
update public.pin_attempts set locked_until = now() - interval '1 second' where client_key='10.0.0.2';
set role anon;
select t.eq((t.call('10.0.0.2','state','4321')->>'status'), null::text, 'lock expires');
-- 10. window expiry: old failures do not count
reset role;
insert into public.pin_attempts(client_key, fail_count, window_start) values ('10.0.0.7', 2, now() - interval '16 minutes');
set role anon;
select t.call('10.0.0.7','state','0000');
select t.eq((t.call('10.0.0.7','state','4321')->>'status'), null::text, 'stale window resets count (not locked)');
-- 11. missing / garbage / spoof-ish headers
select t.eq((t.call(null,'state','0000')->'body'->>'message'), 'PIN_INVALID', 'no headers -> grouped as unknown, still works');
reset role;
select set_config('request.headers', 'not json', false);
set role anon;
select t.eq((public.get_carpool_state('4321') ? 'trips'), true, 'garbage headers do not crash');
reset role; select set_config('request.headers', '', false);
-- 12. global ceiling: many IPs rotating -> global lock, everyone gets 429
delete from public.pin_attempts;
set role anon;
select count(*) from generate_series(1,30) g, lateral (select t.call('172.16.0.'||g, 'state', '0000')) x;
select t.eq((t.call('172.16.9.9','state','4321')->>'status'), '429', 'global ceiling locks everybody');
-- 13. anon cannot touch the attempts table or the gate directly
reset role;
do $$ begin
  set local role anon;
  begin perform 1 from public.pin_attempts; raise exception 'FAIL anon read pin_attempts';
  exception when insufficient_privilege then raise notice 'ok - anon cannot read pin_attempts'; end;
  begin perform public._pin_gate('4321'); raise exception 'FAIL anon executes _pin_gate';
  exception when insufficient_privilege then raise notice 'ok - anon cannot execute _pin_gate'; end;
end $$;
-- 14. null pin / huge pin
delete from public.pin_attempts;
set role anon;
select t.eq((t.call('10.1.0.1','state',null)->'body'->>'message'), 'PIN_INVALID', 'null pin invalid');
select t.eq((t.call('10.1.0.1','state',repeat('9',100000))->'body'->>'message'), 'PIN_INVALID', 'huge pin invalid');
reset role;
select t.eq((select length(client_key) <= 64 from public.pin_attempts limit 1), true, 'client_key bounded');
-- 15. idempotent: migration can be re-run
\echo ALL TESTS DONE
