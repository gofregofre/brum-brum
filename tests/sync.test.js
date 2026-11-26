'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require(require('path').join(__dirname,'..','carpool-engine.js'));
const URL = 'https://gbtbsavxndpbnkqngmbz.supabase.co';
const PUB = 'sb_publishable_TESTONLY';
const jwt = (payload) => 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.sig';

test('classifyKey refuses secret / service_role / unknown keys', () => {
  assert.equal(E.classifyKey(PUB), 'publishable');
  assert.equal(E.classifyKey(jwt({ role: 'anon' })), 'jwt');
  assert.throws(() => E.classifyKey('sb_secret_abc'), /KEY_IS_SECRET/);
  assert.throws(() => E.classifyKey(jwt({ role: 'service_role' })), /KEY_NOT_ANON/);
  assert.throws(() => E.classifyKey(jwt({ role: 'authenticated' })), /KEY_NOT_ANON/);
  assert.throws(() => E.classifyKey('eyJ.not-json.x'), /KEY_MALFORMED/);
  assert.throws(() => E.classifyKey(''), /KEY_MISSING/);
  assert.throws(() => E.classifyKey('random'), /KEY_UNKNOWN_TYPE/);
});
test('headers: publishable -> NO Authorization; anon JWT -> Bearer', () => {
  assert.deepEqual(E.buildHeaders(PUB), { apikey: PUB, 'Content-Type': 'application/json' });
  const j = jwt({ role: 'anon' });
  assert.equal(E.buildHeaders(j).Authorization, 'Bearer ' + j);
  assert.throws(() => E.SupabaseClient({ url: URL, key: 'sb_secret_x', fetch() {} }));
  assert.throws(() => E.SupabaseClient({ url: 'http://insecure', key: PUB, fetch() {} }));
});

function res(status, body) { return Promise.resolve({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(JSON.stringify(body)) }); }
function memStorage(init = {}) { const m = new Map(Object.entries(init)); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), _m: m }; }
const deferred = () => { let r, j; const p = new Promise((a, b) => { r = a; j = b; }); return { p, r, j }; };

test('rpc: request shape + PIN_INVALID mapping + network error', async () => {
  const calls = [];
  const c = E.SupabaseClient({ url: URL + '/', key: PUB, fetch: (u, o) => { calls.push([u, o]); return res(400, { code: 'P0001', message: 'PIN_INVALID' }); } });
  await assert.rejects(c.getState('0000'), e => e.code === 'PIN_INVALID');
  assert.equal(calls[0][0], URL + '/rest/v1/rpc/get_carpool_state');
  assert.equal(calls[0][1].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0][1].body), { p_pin: '0000' });
  assert.equal(calls[0][1].headers.Authorization, undefined);
  const c2 = E.SupabaseClient({ url: URL, key: PUB, fetch: () => Promise.reject(new TypeError('Failed to fetch')) });
  await assert.rejects(c2.getState('1'), e => e.code === 'NETWORK');
  const c3 = E.SupabaseClient({ url: URL, key: PUB, fetch: () => Promise.resolve({ ok: false, status: 502, text: () => Promise.resolve('<html>') }) });
  await assert.rejects(c3.getState('1'), e => e.code === 'HTTP_502');
});
test('upsertTrip sends exact contract', async () => {
  let body;
  const c = E.SupabaseClient({ url: URL, key: PUB, fetch: (u, o) => { body = JSON.parse(o.body); return res(200, {}); } });
  await c.upsertTrip('1234', { trip_key: '2026-11-23_anada', week_id: '2026-W48', trip_date: '2026-11-23', direction: 'anada', driver: 'J', passengers: ['A', 'J'], price_cents: 600 });
  assert.deepEqual(Object.keys(body).sort(), ['p_direction','p_driver','p_passengers','p_pin','p_price_cents','p_trip_date','p_trip_key','p_week_id']);
});

function fakeClient() {
  const log = [], queue = [];
  return {
    log, queue,
    getState: () => { const d = deferred(); queue.push({ kind: 'get', d }); return d.p; },
    upsertTrip: (pin, t) => { const d = deferred(); log.push(JSON.parse(JSON.stringify(t))); queue.push({ kind: 'up', t, d }); return d.p; },
    setWeekSettled: () => { const d = deferred(); queue.push({ kind: 'wk', d }); return d.p; },
    setDefaultPrice: () => { const d = deferred(); queue.push({ kind: 'pr', d }); return d.p; },
  };
}
const tick = () => new Promise(r => setImmediate(r));

test('store: cache loads instantly, login stores PIN, bad PIN not stored', async () => {
  const st = memStorage({ [E.CACHE_KEY]: JSON.stringify({ trips: [{ trip_key: '2026-11-23_anada', trip_date: '2026-11-23', week_id: '2026-W48', direction: 'anada', driver: 'J', passengers: ['A','J'], price_cents: 600 }], weeks: [], default_price_cents: 600 }) });
  const fc = fakeClient();
  const s = E.CarpoolStore({ client: fc, storage: st });
  assert.equal(s.fromCache, true);
  assert.equal(s.state.trips.length, 1);
  assert.equal(s.hasPin(), false);
  const p = s.login('9999'); fc.queue.shift().d.j(Object.assign(new Error('PIN_INVALID'), { code: 'PIN_INVALID' }));
  await assert.rejects(p); assert.equal(st.getItem(E.PIN_KEY), null);
  await assert.rejects(s.login('12a4'), e => e.code === 'PIN_FORMAT');
  const p2 = s.login('4321'); fc.queue.shift().d.r({ trips: [], weeks: [], default_price_cents: 700 });
  await p2; assert.equal(st.getItem(E.PIN_KEY), '4321'); assert.equal(s.state.default_price_cents, 700);
});
test('store: corrupt cache / throwing storage do not crash', () => {
  const s1 = E.CarpoolStore({ client: fakeClient(), storage: memStorage({ [E.CACHE_KEY]: '{not json' }) });
  assert.deepEqual(s1.state.trips, []);
  const evil = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('Quota'); }, removeItem() { throw new Error('x'); } };
  const s2 = E.CarpoolStore({ client: fakeClient(), storage: evil });
  s2.setDriver('2026-11-23', 'anada', 'J').catch(() => {});
  assert.equal(s2.getTrip('2026-11-23', 'anada').driver, 'J');
});
test('race: rapid taps on same trip are serialized and coalesced; last intent wins', async () => {
  const fc = fakeClient(); const st = memStorage({ [E.PIN_KEY]: '1111' });
  const s = E.CarpoolStore({ client: fc, storage: st });
  s.togglePassenger('2026-11-23', 'anada', 'A');           // request #1 in flight
  s.togglePassenger('2026-11-23', 'anada', 'M');           // queued
  s.setDriver('2026-11-23', 'anada', 'J');                 // coalesced with previous
  assert.equal(fc.queue.length, 1, 'only one in-flight request per trip_key');
  assert.deepEqual(s.getTrip('2026-11-23', 'anada').passengers, ['A','J','M'], 'optimistic UI immediately');
  assert.equal(s.status, 'syncing');
  fc.queue.shift().d.r({}); await tick();
  assert.equal(fc.queue.length, 1);
  assert.deepEqual(fc.log.map(t => [t.driver, t.passengers]), [[null, ['A']], ['J', ['A','J','M']]]);
  fc.queue.shift().d.r({}); await tick();
  assert.equal(s.status, 'saved');
});
test('race: different trip_keys run in parallel', () => {
  const fc = fakeClient(); const s = E.CarpoolStore({ client: fc, storage: memStorage({ [E.PIN_KEY]: '1111' }) });
  s.togglePassenger('2026-11-23', 'anada', 'A');
  s.togglePassenger('2026-11-23', 'tornada', 'A');
  assert.equal(fc.queue.length, 2);
});
test('race: refresh arriving during an in-flight write does not revert optimistic edit', async () => {
  const fc = fakeClient(); const s = E.CarpoolStore({ client: fc, storage: memStorage({ [E.PIN_KEY]: '1111' }) });
  s.setDriver('2026-11-23', 'anada', 'J').catch(() => {});
  const r = s.refresh();
  const get = fc.queue.find(q => q.kind === 'get');
  get.d.r({ trips: [{ trip_key: '2026-11-23_anada', trip_date: '2026-11-23', week_id: '2026-W48', direction: 'anada', driver: null, passengers: [], price_cents: 600 }], weeks: [], default_price_cents: 600 });
  await r;
  assert.equal(s.getTrip('2026-11-23', 'anada').driver, 'J');
});
test('race: stale refresh response is ignored', async () => {
  const fc = fakeClient(); const s = E.CarpoolStore({ client: fc, storage: memStorage({ [E.PIN_KEY]: '1111' }) });
  const r1 = s.refresh(); const r2 = s.refresh();
  const [g1, g2] = fc.queue.splice(0, 2);
  g2.d.r({ trips: [], weeks: [], default_price_cents: 800 }); await r2;
  g1.d.r({ trips: [], weeks: [], default_price_cents: 100 }); await r1;
  assert.equal(s.state.default_price_cents, 800);
});
test('network error -> status error, retry resends latest intent', async () => {
  const fc = fakeClient(); const s = E.CarpoolStore({ client: fc, storage: memStorage({ [E.PIN_KEY]: '1111' }) });
  const p = s.setDriver('2026-11-23', 'anada', 'R');
  fc.queue.shift().d.j(Object.assign(new Error('x'), { code: 'NETWORK' }));
  await assert.rejects(p);
  assert.equal(s.status, 'error');
  assert.equal(s.getTrip('2026-11-23', 'anada').driver, 'R', 'optimistic value kept for retry');
  const rp = s.retry(); assert.equal(fc.queue.length, 1);
  assert.equal(fc.queue[0].t.driver, 'R');
  fc.queue.shift().d.r({}); await rp; await tick();
  assert.equal(s.status, 'saved');
});
test('new trip uses default price; existing trip keeps its own price', async () => {
  const fc = fakeClient(); const s = E.CarpoolStore({ client: fc, storage: memStorage({ [E.PIN_KEY]: '1' }) });
  const p = s.login('1234'); fc.queue.shift().d.r({ trips: [{ trip_key: '2026-11-16_anada', trip_date: '2026-11-16', week_id: '2026-W47', direction: 'anada', driver: 'A', passengers: ['A','J'], price_cents: 600 }], weeks: [], default_price_cents: 750 }); await p;
  s.togglePassenger('2026-11-23', 'anada', 'A'); assert.equal(fc.log.at(-1).price_cents, 750);
  s.togglePassenger('2026-11-16', 'anada', 'M'); assert.equal(fc.log.at(-1).price_cents, 600);
});
test('settle week: optimistic, rolled back on failure', async () => {
  const fc = fakeClient(); const s = E.CarpoolStore({ client: fc, storage: memStorage({ [E.PIN_KEY]: '1' }) });
  const p = s.setWeekSettled('2026-W48', true);
  assert.equal(E.isWeekSettled(s.state.weeks, '2026-W48'), true);
  fc.queue.shift().d.j(new Error('net')); await assert.rejects(p);
  assert.equal(E.isWeekSettled(s.state.weeks, '2026-W48'), false);
  await assert.rejects(s.setDefaultPrice(-5), e => e.code === 'PRICE_INVALID');
});
test('PIN rotated server-side -> refresh logs out (PIN removed from storage)', async () => {
  const fc = fakeClient(); const st = memStorage({ [E.PIN_KEY]: '1111' }); const s = E.CarpoolStore({ client: fc, storage: st });
  const r = s.refresh(); fc.queue.shift().d.j(Object.assign(new Error('PIN_INVALID'), { code: 'PIN_INVALID' }));
  await assert.rejects(r); assert.equal(st.getItem(E.PIN_KEY), null); assert.equal(s.hasPin(), false);
});
test('visibilitychange triggers refresh only when visible; unsubscribe works', () => {
  const fc = fakeClient(); const s = E.CarpoolStore({ client: fc, storage: memStorage({ [E.PIN_KEY]: '1111' }) });
  const doc = new EventTarget(); doc.visibilityState = 'hidden';
  const off = s.attachVisibilitySync(doc);
  doc.dispatchEvent(new Event('visibilitychange')); assert.equal(fc.queue.length, 0);
  doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange')); assert.equal(fc.queue.length, 1);
  off(); doc.dispatchEvent(new Event('visibilitychange')); assert.equal(fc.queue.length, 1);
});
test('onChange throwing does not break sync', async () => {
  const fc = fakeClient(); const s = E.CarpoolStore({ client: fc, storage: memStorage({ [E.PIN_KEY]: '1' }), onChange() { throw new Error('ui bug'); } });
  const p = s.setDriver('2026-11-23', 'anada', 'A'); fc.queue.shift().d.r({}); await p;
  assert.equal(s.status, 'saved');
});

// ---- PIN attempt limit (migration 20261126_pin_rate_limit) ----
test('rpc: 429 PIN_LOCKED mapped with retryAfterS', async () => {
  const c = E.SupabaseClient({ url: URL, key: PUB, fetch: () => res(429, { code: 'P0001', message: 'PIN_LOCKED', retry_after_s: 812 }) });
  await assert.rejects(c.getState('4321'), e => e.code === 'PIN_LOCKED' && e.retryAfterS === 812 && e.status === 429);
});
test('rpc: error body with HTTP 200 is still an error (defence if status GUC is ignored)', async () => {
  for (const m of ['PIN_INVALID', 'PIN_LOCKED']) {
    const c = E.SupabaseClient({ url: URL, key: PUB, fetch: () => res(200, { code: 'P0001', message: m }) });
    await assert.rejects(c.getState('0000'), e => e.code === m);
  }
  const ok = E.SupabaseClient({ url: URL, key: PUB, fetch: () => res(200, { trips: [], weeks: [], default_price_cents: 600 }) });
  assert.equal((await ok.getState('1')).default_price_cents, 600);
});
test('store: PIN_LOCKED on refresh does NOT log out; on login does not store PIN', async () => {
  const fc = fakeClient(); const st = memStorage({ [E.PIN_KEY]: '1111' }); const s = E.CarpoolStore({ client: fc, storage: st });
  const r = s.refresh(); fc.queue.shift().d.j(Object.assign(new Error('PIN_LOCKED'), { code: 'PIN_LOCKED', retryAfterS: 60 }));
  await assert.rejects(r); assert.equal(st.getItem(E.PIN_KEY), '1111'); assert.equal(s.status, 'error');
  s.logout();
  const p = s.login('2222'); fc.queue.shift().d.j(Object.assign(new Error('PIN_LOCKED'), { code: 'PIN_LOCKED' }));
  await assert.rejects(p, e => e.code === 'PIN_LOCKED'); assert.equal(st.getItem(E.PIN_KEY), null);
});
