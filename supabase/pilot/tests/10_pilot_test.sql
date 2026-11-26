-- Tests for 20261126_pilot_multigroup.sql (written BEFORE the migration, TDD).
-- Each psql statement = one transaction, like a PostgREST request.
\set ON_ERROR_STOP 1
create schema if not exists t;
create or replace function t.call(p_ip text, p_fn text, p_group text, p_pin text,
  p_key text default '2026-11-23_anada', p_driver text default 'A', p_pass jsonb default '["A","J"]',
  p_price int default 600, p_date date default '2026-11-23', p_week text default '2026-W48',
  p_dir text default 'anada') returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform set_config('request.headers', case when p_ip is null then '{}' else json_build_object('cf-connecting-ip', p_ip)::text end, true);
  perform set_config('response.status', '', true);
  begin
    if p_fn = 'state' then r := public.get_carpool_state(p_group, p_pin);
    elsif p_fn = 'upsert' then r := public.upsert_trip(p_group, p_pin, p_key, p_week, p_date, p_dir, p_driver, p_pass, p_price);
    elsif p_fn = 'settle' then r := public.set_week_settled(p_group, p_pin, p_week, true);
    elsif p_fn = 'price' then r := public.set_default_price(p_group, p_pin, p_price);
    elsif p_fn = 'delete' then r := public.delete_group(p_group, p_pin, p_key);
    end if;
  exception when others then
    return jsonb_build_object('status', 'raised', 'error', sqlerrm);
  end;
  return jsonb_build_object('status', nullif(current_setting('response.status', true), ''), 'body', r);
end $$;
create or replace function t.eq(a anyelement, b anyelement, msg text) returns void language plpgsql as $$
begin if a is distinct from b then raise exception 'FAIL %: got % expected %', msg, a, b; end if; raise notice 'ok - %', msg; end $$;
grant usage on schema t to anon;
grant execute on all functions in schema t to anon;
create table t.g (name text primary key, code text);
grant select on t.g to anon;

-- 0. Group creation is admin-only (no open sign-up in the pilot)
do $$ begin
  set local role anon;
  begin perform public.admin_create_group(array['A','B'], '123456', 600); raise exception 'FAIL anon can create group';
  exception when insufficient_privilege then raise notice 'ok - anon cannot create groups'; end;
end $$;
insert into t.g values ('g1', public.admin_create_group(array['A','J','M','Q','R'], '111111', 600));
insert into t.g values ('g2', public.admin_create_group(array['A','X','Y'], '222222', 500));
select t.eq((select code ~ '^[a-z0-9]{10}$' from t.g where name='g1'), true, 'group code is 10 random chars');
select t.eq((select count(distinct code) from t.g), 2::bigint, 'group codes are distinct');
select t.eq((select count(*) from public.groups where pin_hash like '$2%' and pin_hash <> '111111' and pin_hash <> '222222'), 2::bigint, 'pins stored as bcrypt hashes');
-- creation input validation
do $$ declare m text; begin
  begin perform public.admin_create_group(array['A','J'], '1234', 600); raise exception 'FAIL short pin accepted';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; raise notice 'ok - pin must be 6 digits'; end;
  begin perform public.admin_create_group(array['A'], '123456', 600); raise exception 'FAIL 1 member accepted';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; raise notice 'ok - at least 2 members'; end;
  begin perform public.admin_create_group(array['A','A'], '123456', 600); raise exception 'FAIL duplicate members accepted';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; raise notice 'ok - members unique'; end;
  begin perform public.admin_create_group(array['A','B','C','D','E','F','G','H','I'], '123456', 600); raise exception 'FAIL 9 members accepted';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; raise notice 'ok - at most 8 members'; end;
  begin perform public.admin_create_group(array['A','<b>'], '123456', 600); raise exception 'FAIL unsafe member label accepted';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; raise notice 'ok - member labels alphanumeric'; end;
end $$;

set role anon;
-- 1. correct access, members and own price returned
select t.eq((t.call('10.0.0.1','state',(select code from t.g where name='g1'),'111111')->>'status'), null::text, 'g1 correct pin ok');
select t.eq((t.call('10.0.0.1','state',(select code from t.g where name='g1'),'111111')->'body'->'members'), '["A","J","M","Q","R"]'::jsonb, 'g1 members returned');
select t.eq((t.call('10.0.0.1','state',(select code from t.g where name='g2'),'222222')->'body'->>'default_price_cents'), '500', 'g2 own default price');
-- 2. one group's pin does not open another group; unknown code gives the SAME answer
select t.eq((t.call('10.0.0.2','state',(select code from t.g where name='g1'),'222222')->'body'->>'message'), 'PIN_INVALID', 'g2 pin does not open g1');
select t.eq((t.call('10.0.0.2','state','zzzzzzzzzz','111111')->'body'->>'message'), 'PIN_INVALID', 'unknown code -> same PIN_INVALID (no group enumeration)');
select t.eq((t.call('10.0.0.2','state','zzzzzzzzzz','111111')->>'status'), '400', 'unknown code -> 400');
select t.eq((t.call('10.0.0.2','state','zzzzzzzzzz','111111')->'body' ? 'trips'), false, 'unknown code leaks nothing');
-- 3. isolation: same trip_key in both groups
select t.eq((t.call('10.0.0.3','upsert',(select code from t.g where name='g1'),'111111')->'body'->>'driver'), 'A', 'g1 upsert ok');
select t.eq((t.call('10.0.0.3','upsert',(select code from t.g where name='g2'),'222222', p_driver=>'X', p_pass=>'["X","Y"]')->'body'->>'driver'), 'X', 'g2 upsert same key ok');
select t.eq(jsonb_array_length(t.call('10.0.0.3','state',(select code from t.g where name='g1'),'111111')->'body'->'trips'), 1, 'g1 sees only its trip');
select t.eq((t.call('10.0.0.3','state',(select code from t.g where name='g1'),'111111')->'body'->'trips'->0->>'driver'), 'A', 'g1 trip untouched by g2');
select t.eq((t.call('10.0.0.3','state',(select code from t.g where name='g1'),'111111')->'body'->'trips'->0 ? 'group_id'), false, 'internal group_id not exposed');
select t.eq((t.call('10.0.0.3','settle',(select code from t.g where name='g1'),'111111')->'body'->>'settled'), 'true', 'g1 settle ok');
select t.eq(jsonb_array_length(t.call('10.0.0.3','state',(select code from t.g where name='g2'),'222222')->'body'->'weeks'), 0, 'g1 settle invisible to g2');
select t.eq((t.call('10.0.0.3','price',(select code from t.g where name='g1'),'111111', p_price=>840)->'body'->>'default_price_cents'), '840', 'g1 price ok');
select t.eq((t.call('10.0.0.3','state',(select code from t.g where name='g2'),'222222')->'body'->>'default_price_cents'), '500', 'g1 price does not touch g2');
-- 4. trip validation (server never trusts the client)
select t.eq((t.call('10.0.0.4','upsert',(select code from t.g where name='g1'),'111111', p_pass=>'["A","X"]')->>'status'), 'raised', 'passenger outside group rejected');
select t.eq((t.call('10.0.0.4','upsert',(select code from t.g where name='g1'),'111111', p_driver=>'M')->>'status'), 'raised', 'driver not among passengers rejected');
select t.eq((t.call('10.0.0.4','upsert',(select code from t.g where name='g1'),'111111', p_pass=>'["A","A"]')->>'status'), 'raised', 'duplicate passenger rejected');
select t.eq((t.call('10.0.0.4','upsert',(select code from t.g where name='g1'),'111111', p_pass=>'"A"')->>'status'), 'raised', 'passengers not an array rejected');
select t.eq((t.call('10.0.0.4','upsert',(select code from t.g where name='g1'),'111111', p_key=>'hack')->>'status'), 'raised', 'malformed trip_key rejected');
select t.eq((t.call('10.0.0.4','upsert',(select code from t.g where name='g1'),'111111', p_key=>'2026-11-24_anada')->>'status'), 'raised', 'trip_key date mismatch rejected');
select t.eq((t.call('10.0.0.4','upsert',(select code from t.g where name='g1'),'111111', p_key=>'2026-11-23_tornada')->>'status'), 'raised', 'trip_key direction mismatch rejected');
select t.eq((t.call('10.0.0.4','upsert',(select code from t.g where name='g1'),'111111', p_week=>'2026-W47')->>'status'), 'raised', 'week mismatch rejected');
select t.eq((t.call('10.0.0.4','upsert',(select code from t.g where name='g1'),'111111', p_price=>-1)->>'status'), 'raised', 'negative price rejected');
select t.eq((t.call('10.0.0.4','upsert',(select code from t.g where name='g1'),'111111', p_price=>100001)->>'status'), 'raised', 'huge price rejected');
select t.eq((t.call('10.0.0.4','upsert',(select code from t.g where name='g1'),'111111', p_key=>'2026-11-23_anada_5')->>'status'), null::text, 'car 5 ok in 5-member group');
select t.eq((t.call('10.0.0.4','upsert',(select code from t.g where name='g2'),'222222', p_key=>'2026-11-23_anada_4', p_driver=>'X', p_pass=>'["X"]')->>'status'), 'raised', 'car 4 rejected in 3-member group');
select t.eq((t.call('10.0.0.4','upsert',(select code from t.g where name='g1'),'111111', p_driver=>null, p_pass=>'[]')->>'status'), null::text, 'empty trip (car removed) ok');
select t.eq((t.call('10.0.0.4','price',(select code from t.g where name='g1'),'111111', p_price=>-5)->>'status'), 'raised', 'negative default price rejected');
-- 5. wrong pin never writes
select t.eq((t.call('10.0.0.5','upsert',(select code from t.g where name='g2'),'000000', p_driver=>'Y', p_pass=>'["X","Y"]')->'body'->>'message'), 'PIN_INVALID', 'upsert wrong pin');
select t.eq((t.call('10.0.0.5','state',(select code from t.g where name='g2'),'222222')->'body'->'trips'->0->>'driver'), 'X', 'wrong pin wrote nothing');
-- 6. lockout is per (group, IP): campus NAT no longer locks other groups
select t.call('10.9.9.9','state',(select code from t.g where name='g1'),'000000') from generate_series(1,5);
select t.eq((t.call('10.9.9.9','state',(select code from t.g where name='g1'),'111111')->>'status'), '429', '5 fails lock g1 for that ip, even with correct pin');
select t.eq(((t.call('10.9.9.9','state',(select code from t.g where name='g1'),'111111')->'body'->>'retry_after_s')::int between 1 and 900), true, 'retry_after_s in (0,900]');
select t.eq((t.call('10.9.9.9','state',(select code from t.g where name='g2'),'222222')->>'status'), null::text, 'same ip still opens g2 (NAT-safe)');
select t.eq((t.call('10.9.9.8','state',(select code from t.g where name='g1'),'111111')->>'status'), null::text, 'other ip still opens g1');
-- 7. success clears the (group, ip) counter
select t.call('10.0.0.6','state',(select code from t.g where name='g1'),'000001');
select t.call('10.0.0.6','state',(select code from t.g where name='g1'),'111111');
reset role;
select t.eq((select count(*) from public.pin_attempts where client_key='10.0.0.6'), 0::bigint, 'success clears counter');
-- 8. lock expiry and stale window
update public.pin_attempts set locked_until = now() - interval '1 second' where client_key='10.9.9.9';
set role anon;
select t.eq((t.call('10.9.9.9','state',(select code from t.g where name='g1'),'111111')->>'status'), null::text, 'lock expires');
-- 9. group ceiling: rotating IPs lock ONLY the attacked group
reset role; delete from public.pin_attempts; set role anon;
select count(*) from generate_series(1,30) g, lateral (select t.call('172.16.0.'||g,'state',(select code from t.g where name='g1'),'000000')) x;
select t.eq((t.call('172.16.9.9','state',(select code from t.g where name='g1'),'111111')->>'status'), '429', 'group ceiling locks g1');
select t.eq((t.call('172.16.9.9','state',(select code from t.g where name='g2'),'222222')->>'status'), null::text, 'g2 unaffected by attack on g1');
-- 10. code enumeration: 10 unknown codes lock that IP for unknown codes only
reset role; delete from public.pin_attempts; set role anon;
select t.call('10.7.7.7','state','unknown'||g,'111111') from generate_series(1,10) g;
select t.eq((t.call('10.7.7.7','state','zzzzzzzzzz','111111')->>'status'), '429', 'enumeration locks unknown-code probing');
select t.eq((t.call('10.7.7.7','state',(select code from t.g where name='g1'),'111111')->>'status'), null::text, 'enumeration lock does not block a real group');
-- 11. odd inputs
select t.eq((t.call('10.1.0.1','state',null,'111111')->'body'->>'message'), 'PIN_INVALID', 'null code');
select t.eq((t.call('10.1.0.1','state',(select code from t.g where name='g2'),null)->'body'->>'message'), 'PIN_INVALID', 'null pin');
select t.eq((t.call('10.1.0.2','state',repeat('z',100000),'111111')->'body'->>'message'), 'PIN_INVALID', 'huge code');
select t.eq((t.call('10.1.0.3','state',(select code from t.g where name='g2'),repeat('9',100000))->'body'->>'message'), 'PIN_INVALID', 'huge pin');
select t.eq((t.call(null,'state',(select code from t.g where name='g2'),'222222')->>'status'), null::text, 'no headers still works');
-- 11b. timing: an unknown code costs the same bcrypt as a wrong PIN (no existence oracle by latency)
reset role; delete from public.pin_attempts; set role anon;
do $$ declare t0 timestamptz; a float; b float; begin
  t0 := clock_timestamp();
  for i in 1..8 loop perform t.call('10.8.0.'||i,'state','unknwn'||lpad(i::text,4,'0'),'123456'); end loop;
  a := extract(epoch from clock_timestamp() - t0);
  t0 := clock_timestamp();
  for i in 1..8 loop perform t.call('10.8.1.'||i,'state',(select code from t.g where name='g2'),'123456'); end loop;
  b := extract(epoch from clock_timestamp() - t0);
  perform t.eq(a / b between 0.5 and 2.0, true, format('unknown-code time ~ wrong-pin time (ratio %s)', round((a/b)::numeric,2)));
end $$;
-- 12. edit history (who changed what is unknown without accounts, but WHAT and WHEN is kept)
select t.call('10.2.0.1','upsert',(select code from t.g where name='g2'),'222222', p_key=>'2026-11-24_tornada', p_date=>'2026-11-24', p_dir=>'tornada', p_driver=>'X', p_pass=>'["X","Y"]');
select t.call('10.2.0.1','upsert',(select code from t.g where name='g2'),'222222', p_key=>'2026-11-24_tornada', p_date=>'2026-11-24', p_dir=>'tornada', p_driver=>'Y', p_pass=>'["X","Y","A"]');
reset role;
select t.eq((select count(*) from public.trip_history h join public.groups gr on gr.id=h.group_id join t.g on t.g.code=gr.code where t.g.name='g2' and h.trip_key='2026-11-24_tornada'), 2::bigint, 'history has insert + update');
select t.eq((select old_row->>'driver' from public.trip_history where trip_key='2026-11-24_tornada' and old_row is not null), 'X', 'history keeps previous value');
-- 13. anon has no direct table access
do $$ begin
  set local role anon;
  begin perform 1 from public.groups; raise exception 'FAIL anon reads groups';
  exception when insufficient_privilege then raise notice 'ok - anon cannot read groups'; end;
  begin perform 1 from public.trips; raise exception 'FAIL anon reads trips';
  exception when insufficient_privilege then raise notice 'ok - anon cannot read trips'; end;
  begin perform 1 from public.trip_history; raise exception 'FAIL anon reads history';
  exception when insufficient_privilege then raise notice 'ok - anon cannot read history'; end;
  begin perform public._group_gate('x','y'); raise exception 'FAIL anon runs gate';
  exception when insufficient_privilege then raise notice 'ok - anon cannot run gate'; end;
end $$;
-- 14. right to erasure (RGPD): needs pin AND typing the code again; cascades everything
set role anon;
select t.eq((t.call('10.3.0.1','delete',(select code from t.g where name='g2'),'222222', p_key=>'wrong')->>'status'), 'raised', 'delete needs confirmation = code');
select t.eq((t.call('10.3.0.1','delete',(select code from t.g where name='g2'),'000000', p_key=>(select code from t.g where name='g2'))->'body'->>'message'), 'PIN_INVALID', 'delete needs pin');
select t.eq((t.call('10.3.0.2','delete',(select code from t.g where name='g2'),'222222', p_key=>(select code from t.g where name='g2'))->'body'->>'deleted'), 'true', 'delete ok');
reset role;
select t.eq((select count(*) from public.trips t2 where not exists (select 1 from public.groups g where g.id=t2.group_id)), 0::bigint, 'no orphan trips');
select t.eq((select count(*) from public.trip_history h where not exists (select 1 from public.groups g where g.id=h.group_id)), 0::bigint, 'no orphan history');
select t.eq((select count(*) from public.groups), 1::bigint, 'only g1 left');
set role anon;
select t.eq((t.call('10.3.0.3','state',(select code from t.g where name='g2'),'222222')->'body'->>'message'), 'PIN_INVALID', 'deleted group no longer opens');
select t.eq((t.call('10.3.0.3','state',(select code from t.g where name='g1'),'111111')->>'status'), null::text, 'g1 survives g2 deletion');
\echo ALL TESTS DONE
