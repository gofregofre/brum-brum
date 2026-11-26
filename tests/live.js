const E = require(require('path').join(__dirname,'..','carpool-engine.js'));
const URL = 'https://gbtbsavxndpbnkqngmbz.supabase.co';
const KEYS = { publishable: process.env.SB_PUBLISHABLE_KEY, jwt: process.env.SB_ANON_JWT };
(async () => {
  for (const [name, key] of Object.entries(KEYS)) {
    console.log(name, 'classify=', E.classifyKey(key), 'headers=', Object.keys(E.buildHeaders(key)).join(','));
    const c = E.SupabaseClient({ url: URL, key });
    for (const pin of ['0000', '9999', "' OR 1=1 --", '']) {
      try { await c.getState(pin); console.log('  get', JSON.stringify(pin), '-> UNEXPECTED SUCCESS (data hidden)'); }
      catch (e) { console.log('  get', JSON.stringify(pin), '->', e.code, e.status); }
    }
    for (const [fn, call] of [['upsert_trip', () => c.upsertTrip('0000', { trip_key: '2026-11-23_anada', week_id: '2026-W48', trip_date: '2026-11-23', direction: 'anada', driver: 'A', passengers: ['A'], price_cents: 600 })],
      ['set_week_settled', () => c.setWeekSettled('0000', '2026-W48', true)], ['set_default_price', () => c.setDefaultPrice('0000', 600)]]) {
      try { await call(); console.log('  ', fn, 'UNEXPECTED SUCCESS'); } catch (e) { console.log('  ', fn, 'fake PIN ->', e.code, e.status); }
    }
  }
  // direct table access must be blocked by RLS (no policies)
  for (const t of ['trips', 'weeks', 'app_config']) {
    const r = await fetch(`${URL}/rest/v1/${t}?select=*&limit=1`, { headers: E.buildHeaders(KEYS.publishable) });
    const body = await r.text();
    console.log('table', t, r.status, body.length <= 2 ? body : '(non-empty body, hidden) len=' + body.length);
  }
  // publishable key with Bearer header (what CONTEXT forbids) - observe behaviour
  const r = await fetch(`${URL}/rest/v1/rpc/get_carpool_state`, { method: 'POST', headers: { apikey: KEYS.publishable, Authorization: 'Bearer ' + KEYS.publishable, 'Content-Type': 'application/json' }, body: '{"p_pin":"0000"}' });
  console.log('publishable+Bearer ->', r.status, (await r.text()).slice(0, 120));
})();
