/*!
 * carpool-engine.js — Cotxe Uni: pure logic + Supabase RPC layer.
 * Zero dependencies. Works as a browser <script> (window.CarpoolEngine) or a CommonJS module.
 *
 * Money model: every amount is an integer number of cents. Internally, trip shares are
 * computed in "units" of 1/UNIT cent, where UNIT = lcm(1..5) = 60, so price/N is exact
 * for any N in 1..5. Rounding to cents happens once, at the end, with a deterministic
 * largest-remainder method that keeps the sum of balances exactly 0.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CarpoolEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MEMBERS = Object.freeze(['A', 'J', 'M', 'Q', 'R']);
  var DIRECTIONS = Object.freeze(['anada', 'tornada']);
  var MEMBER_SET = new Set(MEMBERS);

  function gcd(a, b) { while (b) { var t = a % b; a = b; b = t; } return a; }
  var UNIT = 1;
  for (var i = 1; i <= MEMBERS.length; i++) UNIT = (UNIT * i) / gcd(UNIT, i); // 60

  function zeroMap() { var o = {}; MEMBERS.forEach(function (m) { o[m] = 0; }); return o; }

  /* ------------------------------------------------------------------ dates */
  var DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  var WEEK_RE = /^(\d{4})-W(\d{2})$/;
  var DAY_MS = 86400000;

  function parseDate(s) {
    var m = typeof s === 'string' && DATE_RE.exec(s);
    if (!m) throw new Error('INVALID_DATE: ' + s);
    var y = +m[1], mo = +m[2], d = +m[3];
    var t = Date.UTC(y, mo - 1, d);
    var dt = new Date(t);
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
      throw new Error('INVALID_DATE: ' + s);
    }
    return t;
  }
  function fmtDate(t) {
    var d = new Date(t);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(d.getUTCDate()).padStart(2, '0');
  }
  function isoDow(t) { return ((new Date(t).getUTCDay() + 6) % 7) + 1; } // Mon=1..Sun=7

  function isoWeekParts(t) {
    var thursday = t + (4 - isoDow(t)) * DAY_MS;
    var year = new Date(thursday).getUTCFullYear();
    var week = Math.floor((thursday - Date.UTC(year, 0, 1)) / DAY_MS / 7) + 1;
    return { year: year, week: week };
  }
  function weeksInYear(year) { return isoWeekParts(Date.UTC(year, 11, 28)).week; }

  function isoWeekId(dateStr) {
    var p = isoWeekParts(parseDate(dateStr));
    return p.year + '-W' + String(p.week).padStart(2, '0');
  }
  function weekMondayMs(weekId) {
    var m = typeof weekId === 'string' && WEEK_RE.exec(weekId);
    if (!m) throw new Error('INVALID_WEEK: ' + weekId);
    var year = +m[1], week = +m[2];
    if (week < 1 || week > weeksInYear(year)) throw new Error('INVALID_WEEK: ' + weekId);
    var jan4 = Date.UTC(year, 0, 4);
    return jan4 - (isoDow(jan4) - 1) * DAY_MS + (week - 1) * 7 * DAY_MS;
  }
  function weekDates(weekId) {
    var mon = weekMondayMs(weekId), out = [];
    for (var k = 0; k < 7; k++) out.push(fmtDate(mon + k * DAY_MS));
    return out;
  }
  function shiftWeek(weekId, delta) {
    return isoWeekId(fmtDate(weekMondayMs(weekId) + (delta | 0) * 7 * DAY_MS));
  }
  function todayLocal(now) {
    var d = now || new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }
  function currentWeekId(now) { return isoWeekId(todayLocal(now)); }

  var MONTHS_CA = ['gen', 'febr', 'març', 'abr', 'maig', 'juny', 'jul', 'ag', 'set', 'oct', 'nov', 'des'];
  var DAYS_CA = ['Dl', 'Dt', 'Dc', 'Dj', 'Dv', 'Ds', 'Dg'];

  function weekRangeLabel(weekId, opts) {
    var d = weekDates(weekId);
    var a = new Date(parseDate(d[0]));
    var b = new Date(parseDate(d[opts && opts.includeWeekend ? 6 : 4]));
    var ma = MONTHS_CA[a.getUTCMonth()], mb = MONTHS_CA[b.getUTCMonth()];
    return a.getUTCMonth() === b.getUTCMonth()
      ? a.getUTCDate() + ' – ' + b.getUTCDate() + ' ' + mb
      : a.getUTCDate() + ' ' + ma + ' – ' + b.getUTCDate() + ' ' + mb;
  }
  function dayLabel(dateStr) {
    var t = parseDate(dateStr);
    return DAYS_CA[isoDow(t) - 1] + ' ' + new Date(t).getUTCDate();
  }

  function tripKey(dateStr, direction) {
    parseDate(dateStr);
    if (DIRECTIONS.indexOf(direction) < 0) throw new Error('INVALID_DIRECTION: ' + direction);
    return dateStr + '_' + direction;
  }

  /* ------------------------------------------------------------ formatting */
  function formatCents(c) {
    if (!Number.isInteger(c)) throw new Error('NOT_INTEGER_CENTS: ' + c);
    var neg = c < 0, a = Math.abs(c);
    var euros = String(Math.floor(a / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return (neg ? '-' : '') + euros + ',' + String(a % 100).padStart(2, '0') + ' €';
  }

  /* ----------------------------------------------------------- trip rules */
  function cleanMembers(list) {
    var set = new Set();
    if (Array.isArray(list)) list.forEach(function (m) { if (MEMBER_SET.has(m)) set.add(m); });
    return MEMBERS.filter(function (m) { return set.has(m); }); // canonical alphabetical order
  }
  /** Canonical form: valid members only, alphabetical, driver (if valid) always an occupant. */
  function normalizeTrip(trip) {
    var t = trip || {};
    var driver = MEMBER_SET.has(t.driver) ? t.driver : null;
    var ps = cleanMembers(t.passengers);
    if (driver && ps.indexOf(driver) < 0) ps = cleanMembers(ps.concat([driver]));
    var out = {};
    for (var k in t) if (Object.prototype.hasOwnProperty.call(t, k)) out[k] = t[k];
    out.driver = driver; out.passengers = ps;
    return out;
  }
  function togglePassenger(trip, member) {
    if (!MEMBER_SET.has(member)) throw new Error('UNKNOWN_MEMBER: ' + member);
    var t = normalizeTrip(trip);
    if (t.passengers.indexOf(member) >= 0) {
      t.passengers = t.passengers.filter(function (m) { return m !== member; });
      if (t.driver === member) t.driver = null; // unticking the driver clears the driver
    } else {
      t.passengers = cleanMembers(t.passengers.concat([member]));
    }
    return t;
  }
  /** Tap on the driver selector: picks the driver (adds as occupant); tapping the same one again unsets it. */
  function setDriver(trip, member) {
    if (member !== null && !MEMBER_SET.has(member)) throw new Error('UNKNOWN_MEMBER: ' + member);
    var t = normalizeTrip(trip);
    if (member === null || t.driver === member) { t.driver = null; return t; }
    t.driver = member;
    t.passengers = cleanMembers(t.passengers.concat([member]));
    return t;
  }
  function validPrice(p) { return Number.isSafeInteger(p) && p > 0 ? p : 0; }

  /* --------------------------------------------------------------- money */
  /** Exact per-member balance of ONE trip in 1/UNIT-cent units (positive = is owed). */
  function tripUnits(trip, acc) {
    var t = normalizeTrip(trip);
    var price = validPrice(t.price_cents);
    var n = t.passengers.length;
    if (!t.driver || n <= 1 || price === 0) return acc;
    var share = (price * UNIT) / n; // exact integer because UNIT % n === 0
    t.passengers.forEach(function (m) {
      if (m === t.driver) return;
      acc[m] -= share;
      acc[t.driver] += share;
    });
    return acc;
  }
  /** Round a zero-sum map of units to integer cents, keeping the sum exactly 0 (deterministic). */
  function unitsToCents(units) {
    var out = {}, rem = [], total = 0;
    MEMBERS.forEach(function (m, idx) {
      var f = Math.floor(units[m] / UNIT);
      out[m] = f; total += f;
      rem.push({ m: m, r: units[m] - f * UNIT, idx: idx });
    });
    var missing = -total; // 0 <= missing < MEMBERS.length
    rem.sort(function (x, y) { return (y.r - x.r) || (x.idx - y.idx); });
    for (var k = 0; k < missing; k++) out[rem[k].m] += 1;
    MEMBERS.forEach(function (m) { if (out[m] === 0) out[m] = 0; }); // normalise -0
    return out;
  }
  function computeBalances(trips) {
    var acc = zeroMap();
    (Array.isArray(trips) ? trips : []).forEach(function (t) {
      if (t && typeof t === 'object') tripUnits(t, acc);
    });
    return unitsToCents(acc);
  }
  function settledSet(weeks) {
    var s = new Set();
    (Array.isArray(weeks) ? weeks : []).forEach(function (w) { if (w && w.settled === true) s.add(w.week_id); });
    return s;
  }
  function tripWeek(t) {
    if (t && typeof t.week_id === 'string') return t.week_id;
    try { return isoWeekId(t.trip_date); } catch (e) { return null; }
  }
  function tripsOfWeek(trips, weekId) {
    return (Array.isArray(trips) ? trips : []).filter(function (t) { return t && tripWeek(t) === weekId; });
  }
  function weekBalances(trips, weekId) { return computeBalances(tripsOfWeek(trips, weekId)); }
  /** Accumulated balance over every week NOT marked settled (missing weeks row = pending). */
  function pendingBalances(trips, weeks) {
    var s = settledSet(weeks);
    return computeBalances((Array.isArray(trips) ? trips : []).filter(function (t) {
      return t && !s.has(tripWeek(t));
    }));
  }
  function pendingWeekIds(trips, weeks) {
    var s = settledSet(weeks), ids = new Set();
    (Array.isArray(trips) ? trips : []).forEach(function (t) {
      var w = t && tripWeek(t);
      if (w && !s.has(w)) {
        var b = computeBalances([t]);
        if (MEMBERS.some(function (m) { return b[m] !== 0; })) ids.add(w);
      }
    });
    return Array.from(ids).sort();
  }
  function isWeekSettled(weeks, weekId) { return settledSet(weeks).has(weekId); }

  /* ------------------------------------------------------ minimal Bizums */
  function greedy(members, bal) {
    var b = {}; members.forEach(function (m) { b[m] = bal[m]; });
    var out = [];
    for (;;) {
      var debtor = null, creditor = null;
      members.forEach(function (m) {
        if (b[m] < 0 && (debtor === null || b[m] < b[debtor])) debtor = m;
        if (b[m] > 0 && (creditor === null || b[m] > b[creditor])) creditor = m;
      });
      if (debtor === null || creditor === null) break;
      var amt = Math.min(-b[debtor], b[creditor]);
      out.push({ from: debtor, to: creditor, cents: amt });
      b[debtor] += amt; b[creditor] -= amt;
    }
    return out;
  }
  /**
   * Minimum number of transfers. Plain greedy (largest debtor -> largest creditor) is NOT always
   * optimal; the true optimum is (#non-zero members) − (max number of disjoint zero-sum groups).
   * With 5 members an exact bitmask DP is trivial (≤ 32 subsets), then greedy inside each group
   * (which needs exactly |group|−1 transfers when the group has no zero-sum sub-group).
   */
  function minimalTransfers(balances) {
    var bal = {};
    MEMBERS.forEach(function (m) {
      var v = balances && balances[m] !== undefined ? balances[m] : 0;
      if (!Number.isSafeInteger(v)) throw new Error('NOT_INTEGER_CENTS: ' + m);
      bal[m] = v;
    });
    var nz = MEMBERS.filter(function (m) { return bal[m] !== 0; });
    var n = nz.length, full = (1 << n) - 1, sumAll = 0;
    nz.forEach(function (m) { sumAll += bal[m]; });
    if (sumAll !== 0) throw new Error('BALANCES_NOT_ZERO_SUM: ' + sumAll);
    if (n === 0) return [];
    var s = new Array(full + 1).fill(0);
    for (var mask = 1; mask <= full; mask++) {
      var low = mask & -mask; s[mask] = s[mask ^ low] + bal[nz[31 - Math.clz32(low)]];
    }
    // dp[mask] = max zero-sum groups partitioning mask; choice[mask] = group containing lowest bit
    var dp = new Array(full + 1).fill(-1), choice = new Array(full + 1).fill(0);
    dp[0] = 0;
    for (mask = 1; mask <= full; mask++) {
      if (s[mask] !== 0) continue;
      var lowBit = mask & -mask;
      for (var sub = mask; sub; sub = (sub - 1) & mask) {
        if (!(sub & lowBit) || s[sub] !== 0 || dp[mask ^ sub] < 0) continue;
        if (dp[mask ^ sub] + 1 > dp[mask]) { dp[mask] = dp[mask ^ sub] + 1; choice[mask] = sub; }
      }
    }
    var out = [], rest = full;
    while (rest) {
      var g = choice[rest];
      var groupMembers = nz.filter(function (_, k) { return g & (1 << k); });
      out = out.concat(greedy(groupMembers, bal));
      rest ^= g;
    }
    return out.sort(function (x, y) {
      return (MEMBERS.indexOf(x.from) - MEMBERS.indexOf(y.from)) || (MEMBERS.indexOf(x.to) - MEMBERS.indexOf(y.to));
    });
  }

  /* ---------------------------------------------------- WhatsApp summary */
  function whatsappSummary(trips, weekId, weeks, opts) {
    var wk = tripsOfWeek(trips, weekId).map(normalizeTrip);
    var settled = isWeekSettled(weeks, weekId);
    var lines = ['Cotxe · Setmana ' + weekRangeLabel(weekId, opts) + (settled ? ' (Liquidada)' : ''), ''];
    var byDate = {};
    wk.forEach(function (t) {
      if (!t.passengers.length) return;
      (byDate[t.trip_date] = byDate[t.trip_date] || {})[t.direction] = t;
    });
    var dates = Object.keys(byDate).sort();
    if (!dates.length) lines.push('Cap trajecte aquesta setmana.');
    dates.forEach(function (d) {
      var parts = [];
      DIRECTIONS.forEach(function (dir) {
        var t = byDate[d][dir];
        if (!t) return;
        var name = dir === 'anada' ? 'Anada' : 'Tornada';
        var others = t.passengers.filter(function (m) { return m !== t.driver; });
        var who = t.driver
          ? t.driver + (others.length ? ' (' + others.join(', ') + ')' : ' sol')
          : 'sense conductor (' + t.passengers.join(', ') + ')';
        parts.push(name + ': ' + who);
      });
      lines.push(dayLabel(d) + ' · ' + parts.join(' · '));
    });
    var bal = computeBalances(wk);
    var tr = minimalTransfers(bal);
    lines.push('');
    lines.push('Bizums:');
    if (!tr.length) lines.push('Cap deute.');
    tr.forEach(function (x) { lines.push(x.from + ' → ' + x.to + ' ' + formatCents(x.cents)); });
    return lines.join('\n');
  }

  /* ======================================================= Supabase layer */
  function b64urlDecode(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    if (typeof atob === 'function') return decodeURIComponent(escape(atob(s)));
    return Buffer.from(s, 'base64').toString('utf8'); // eslint-disable-line no-undef
  }
  /** Classifies a key and REFUSES anything that is not public. */
  function classifyKey(key) {
    if (typeof key !== 'string' || !key) throw new Error('KEY_MISSING');
    if (key.indexOf('sb_secret_') === 0) throw new Error('KEY_IS_SECRET');
    if (key.indexOf('sb_publishable_') === 0) return 'publishable';
    if (key.indexOf('eyJ') === 0) {
      var payload;
      try { payload = JSON.parse(b64urlDecode(key.split('.')[1] || '')); } catch (e) { throw new Error('KEY_MALFORMED'); }
      if (!payload || payload.role !== 'anon') throw new Error('KEY_NOT_ANON');
      return 'jwt';
    }
    throw new Error('KEY_UNKNOWN_TYPE');
  }
  function buildHeaders(key) {
    var type = classifyKey(key);
    var h = { 'apikey': key, 'Content-Type': 'application/json' };
    if (type === 'jwt') h['Authorization'] = 'Bearer ' + key; // never for sb_publishable_
    return h;
  }

  function RpcError(code, message, status) {
    var e = new Error(message || code);
    e.name = 'RpcError'; e.code = code; e.status = status || 0;
    return e;
  }

  function SupabaseClient(opts) {
    if (!(this instanceof SupabaseClient)) return new SupabaseClient(opts);
    if (!opts || typeof opts.url !== 'string' || !/^https:\/\//.test(opts.url)) throw new Error('URL_INVALID');
    this.url = opts.url.replace(/\/+$/, '');
    this.headers = buildHeaders(opts.key);
    this.keyType = classifyKey(opts.key);
    this.fetch = opts.fetch || (typeof fetch === 'function' ? fetch.bind(null) : null);
    this.timeoutMs = opts.timeoutMs || 15000;
    if (!this.fetch) throw new Error('FETCH_UNAVAILABLE');
  }
  SupabaseClient.prototype.rpc = function (name, body) {
    var self = this;
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, self.timeoutMs) : null;
    return Promise.resolve()
      .then(function () {
        return self.fetch(self.url + '/rest/v1/rpc/' + encodeURIComponent(name), {
          method: 'POST', headers: self.headers, body: JSON.stringify(body || {}),
          signal: ctrl ? ctrl.signal : undefined,
        });
      })
      .then(function (res) {
        return res.text().then(function (txt) {
          var data = null;
          try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
          var isObj = data && typeof data === 'object' && !Array.isArray(data);
          var pinErr = isObj && (data.message === 'PIN_INVALID' || data.message === 'PIN_LOCKED') ? data.message : null;
          // Error bodies are honoured even with HTTP 200 (defence in depth: the server sets the
          // status through the response.status GUC so that failed attempts are committed).
          if (res.ok && !pinErr) return data;
          var msg = isObj ? [data.message, data.details, data.hint].filter(Boolean).join(' ') : String(data);
          if (pinErr === 'PIN_LOCKED' || /PIN_LOCKED/.test(msg)) {
            var e = RpcError('PIN_LOCKED', 'PIN_LOCKED', res.status);
            e.retryAfterS = isObj && Number.isSafeInteger(data.retry_after_s) ? data.retry_after_s : null;
            throw e;
          }
          if (pinErr === 'PIN_INVALID' || /PIN_INVALID/.test(msg)) throw RpcError('PIN_INVALID', 'PIN_INVALID', res.status);
          throw RpcError('HTTP_' + res.status, msg, res.status);
        });
      }, function (err) {
        throw RpcError('NETWORK', (err && err.message) || 'NETWORK');
      })
      .finally(function () { if (timer) clearTimeout(timer); });
  };
  SupabaseClient.prototype.getState = function (pin) { return this.rpc('get_carpool_state', { p_pin: pin }); };
  SupabaseClient.prototype.upsertTrip = function (pin, t) {
    return this.rpc('upsert_trip', {
      p_pin: pin, p_trip_key: t.trip_key, p_week_id: t.week_id, p_trip_date: t.trip_date,
      p_direction: t.direction, p_driver: t.driver, p_passengers: t.passengers, p_price_cents: t.price_cents,
    });
  };
  SupabaseClient.prototype.setWeekSettled = function (pin, weekId, settled) {
    return this.rpc('set_week_settled', { p_pin: pin, p_week_id: weekId, p_settled: !!settled });
  };
  SupabaseClient.prototype.setDefaultPrice = function (pin, cents) {
    return this.rpc('set_default_price', { p_pin: pin, p_price_cents: cents });
  };

  /* ================================================== store (state + sync) */
  var PIN_KEY = 'uni_carpool_pin';
  var CACHE_KEY = 'uni_carpool_cache_v1';
  var DEFAULT_PRICE = 600;

  function safeStorage(s) {
    return {
      get: function (k) { try { return s ? s.getItem(k) : null; } catch (e) { return null; } },
      set: function (k, v) { try { if (s) s.setItem(k, v); } catch (e) { /* quota / private mode */ } },
      del: function (k) { try { if (s) s.removeItem(k); } catch (e) { /* ignore */ } },
    };
  }
  function sanitizeState(raw) {
    var r = raw && typeof raw === 'object' ? raw : {};
    return {
      trips: (Array.isArray(r.trips) ? r.trips : []).filter(function (t) { return t && typeof t.trip_key === 'string'; }).map(normalizeTrip),
      weeks: (Array.isArray(r.weeks) ? r.weeks : []).filter(function (w) { return w && typeof w.week_id === 'string'; }),
      default_price_cents: validPrice(r.default_price_cents) || DEFAULT_PRICE,
    };
  }

  /**
   * CarpoolStore: optimistic UI state + per-trip_key serialized writes.
   * - Each trip_key has its own queue. Only the LATEST desired state is sent (upsert is a full
   *   replacement, so intermediate taps can be coalesced) and never two requests in parallel
   *   for the same key -> no out-of-order writes.
   * - refresh() re-applies local pending edits over the server snapshot and ignores stale
   *   responses (sequence number), so a refresh never "un-does" a tap still in flight.
   */
  function CarpoolStore(opts) {
    if (!(this instanceof CarpoolStore)) return new CarpoolStore(opts);
    this.client = opts.client;
    this.store = safeStorage(opts.storage);
    this.onChange = opts.onChange || function () {};
    this.pin = this.store.get(PIN_KEY);
    var cached = null;
    try { cached = JSON.parse(this.store.get(CACHE_KEY) || 'null'); } catch (e) { cached = null; }
    this.state = sanitizeState(cached);
    this.fromCache = !!cached;
    this.status = 'idle'; // idle | syncing | saved | error
    this.lastError = null;
    this._q = {};       // trip_key -> { pending: trip|null, inflight: trip|null, running: bool, failed: bool }
    this._seq = 0;
    this._other = 0;    // in-flight non-trip writes
  }
  var SP = CarpoolStore.prototype;
  SP._emit = function () { try { this.onChange(this); } catch (e) { /* UI errors must not break sync */ } };
  SP._persist = function () { this.store.set(CACHE_KEY, JSON.stringify(this.state)); };
  SP._setStatus = function () {
    var self = this;
    var keys = Object.keys(this._q);
    var failed = keys.some(function (k) { return self._q[k].failed; });
    var busy = this._other > 0 || keys.some(function (k) { return self._q[k].running || self._q[k].pending; });
    this.status = failed || this.lastError ? 'error' : busy ? 'syncing' : 'saved';
  };
  SP.hasPin = function () { return !!this.pin; };
  SP.login = function (pin) {
    var self = this;
    if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) return Promise.reject(RpcError('PIN_FORMAT', 'PIN_FORMAT'));
    return this.client.getState(pin).then(function (raw) {
      self.pin = pin; self.store.set(PIN_KEY, pin);
      self._applyServer(raw); return self.state;
    });
  };
  SP.logout = function () {
    this.pin = null; this.store.del(PIN_KEY); this.store.del(CACHE_KEY);
    this.state = sanitizeState(null); this._q = {}; this.status = 'idle'; this._emit();
  };
  SP._localOverrides = function () {
    var self = this, o = {};
    Object.keys(this._q).forEach(function (k) {
      var q = self._q[k], t = q.pending || q.inflight;
      if (t) o[k] = t;
    });
    return o;
  };
  SP._applyServer = function (raw) {
    var s = sanitizeState(raw), over = this._localOverrides();
    var byKey = {};
    s.trips.forEach(function (t) { byKey[t.trip_key] = t; });
    Object.keys(over).forEach(function (k) { byKey[k] = over[k]; });
    s.trips = Object.keys(byKey).sort().map(function (k) { return byKey[k]; });
    this.state = s; this.fromCache = false; this.lastError = null;
    this._persist(); this._setStatus(); this._emit();
  };
  SP.refresh = function () {
    var self = this;
    if (!this.pin) return Promise.resolve(this.state);
    var seq = ++this._seq;
    return this.client.getState(this.pin).then(function (raw) {
      if (seq !== self._seq) return self.state; // stale response, a newer refresh started
      self._applyServer(raw); return self.state;
    }, function (err) {
      if (err && err.code === 'PIN_INVALID') { self.logout(); throw err; } // PIN changed server-side
      if (seq === self._seq) { self.lastError = err; self._setStatus(); self._emit(); }
      throw err;
    });
  };
  SP.getTrip = function (dateStr, direction) {
    var key = tripKey(dateStr, direction);
    for (var k = 0; k < this.state.trips.length; k++) if (this.state.trips[k].trip_key === key) return this.state.trips[k];
    return { trip_key: key, week_id: isoWeekId(dateStr), trip_date: dateStr, direction: direction,
      driver: null, passengers: [], price_cents: this.state.default_price_cents };
  };
  SP._putLocal = function (trip) {
    var t = normalizeTrip(trip), found = false;
    this.state.trips = this.state.trips.map(function (x) { if (x.trip_key === t.trip_key) { found = true; return t; } return x; });
    if (!found) this.state.trips.push(t);
    this._persist();
    return t;
  };
  SP.updateTrip = function (dateStr, direction, mutate) {
    var t = this._putLocal(mutate(this.getTrip(dateStr, direction)));
    var q = this._q[t.trip_key] || (this._q[t.trip_key] = { pending: null, inflight: null, running: false, failed: false });
    q.pending = t; q.failed = false;
    this._setStatus(); this._emit();
    return this._drain(t.trip_key);
  };
  SP.togglePassenger = function (d, dir, m) { return this.updateTrip(d, dir, function (t) { return togglePassenger(t, m); }); };
  SP.setDriver = function (d, dir, m) { return this.updateTrip(d, dir, function (t) { return setDriver(t, m); }); };
  SP._drain = function (key) {
    var self = this, q = this._q[key];
    if (q.running) return q.promise;
    q.running = true;
    q.promise = (function loop() {
      if (!q.pending) {
        q.running = false; q.inflight = null;
        if (!q.failed) delete self._q[key];
        self._setStatus(); self._emit();
        return Promise.resolve();
      }
      var t = q.pending; q.pending = null; q.inflight = t;
      return self.client.upsertTrip(self.pin, t).then(function () {
        q.inflight = null; return loop();
      }, function (err) {
        if (!q.pending) q.pending = t; // keep the latest intent for retry()
        q.inflight = null; q.running = false; q.failed = true;
        self.lastError = err;
        if (err && err.code === 'PIN_INVALID') { self.logout(); }
        self._setStatus(); self._emit();
        throw err;
      });
    })();
    return q.promise;
  };
  /** Re-send every failed trip write (button "Reintentar"). */
  SP.retry = function () {
    var self = this; this.lastError = null;
    var jobs = Object.keys(this._q).filter(function (k) { return self._q[k].failed; }).map(function (k) {
      self._q[k].failed = false; return self._drain(k).catch(function (e) { return e; });
    });
    this._setStatus(); this._emit();
    return Promise.all(jobs);
  };
  SP._otherWrite = function (apply, call) {
    var self = this, snapshot = JSON.stringify(this.state);
    apply(); this._persist(); this._other++; this._setStatus(); this._emit();
    return call().then(function () {
      self._other--; self._setStatus(); self._emit();
    }, function (err) {
      self._other--; self.state = JSON.parse(snapshot); self._persist(); // roll back
      self.lastError = err; self._setStatus(); self._emit(); throw err;
    });
  };
  SP.setWeekSettled = function (weekId, settled) {
    var self = this; weekMondayMs(weekId);
    return this._otherWrite(function () {
      var found = false;
      self.state.weeks = self.state.weeks.map(function (w) {
        if (w.week_id === weekId) { found = true; return { week_id: weekId, settled: !!settled }; } return w;
      });
      if (!found) self.state.weeks.push({ week_id: weekId, settled: !!settled });
    }, function () { return self.client.setWeekSettled(self.pin, weekId, settled); });
  };
  SP.setDefaultPrice = function (cents) {
    var self = this;
    if (!validPrice(cents)) return Promise.reject(RpcError('PRICE_INVALID', 'PRICE_INVALID'));
    return this._otherWrite(function () { self.state.default_price_cents = cents; },
      function () { return self.client.setDefaultPrice(self.pin, cents); });
  };
  /** Re-sync whenever the page/PWA comes back to the foreground. Returns an unsubscribe fn. */
  SP.attachVisibilitySync = function (doc) {
    var self = this;
    var h = function () { if (doc.visibilityState === 'visible') self.refresh().catch(function () {}); };
    doc.addEventListener('visibilitychange', h);
    return function () { doc.removeEventListener('visibilitychange', h); };
  };

  return Object.freeze({
    MEMBERS: MEMBERS, DIRECTIONS: DIRECTIONS, UNIT: UNIT, DEFAULT_PRICE: DEFAULT_PRICE,
    PIN_KEY: PIN_KEY, CACHE_KEY: CACHE_KEY,
    isoWeekId: isoWeekId, weekDates: weekDates, shiftWeek: shiftWeek, currentWeekId: currentWeekId,
    todayLocal: todayLocal, weekRangeLabel: weekRangeLabel, dayLabel: dayLabel, tripKey: tripKey,
    formatCents: formatCents, normalizeTrip: normalizeTrip, togglePassenger: togglePassenger, setDriver: setDriver,
    computeBalances: computeBalances, weekBalances: weekBalances, pendingBalances: pendingBalances,
    pendingWeekIds: pendingWeekIds, isWeekSettled: isWeekSettled, tripsOfWeek: tripsOfWeek,
    minimalTransfers: minimalTransfers, whatsappSummary: whatsappSummary,
    classifyKey: classifyKey, buildHeaders: buildHeaders,
    SupabaseClient: SupabaseClient, CarpoolStore: CarpoolStore,
  });
});
