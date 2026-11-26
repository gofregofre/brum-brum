# Ledger — Thread 1: motor + capa Supabase

Data: 2026-11-26 (Europe/Madrid). Fitxer lliurat: `carpool-engine.js` (global `window.CarpoolEngine` o CommonJS).

## 1. Pas 0 — Verificació Supabase (`gbtbsavxndpbnkqngmbz`)
Fet amb el MCP de Supabase de l'ordinador de l'usuari (només consultes de lectura) + proves HTTP des del núvol.

| Comprovació | Resultat |
|---|---|
| Taules `trips`, `weeks`, `app_config` | Existeixen. RLS activat a les tres (`relrowsecurity=true`), `force RLS` desactivat, **cap política** |
| Accés directe REST a les taules amb clau pública | `401 / 42501 permission denied` (privilegis revocats + RLS) |
| RPC `get_carpool_state(p_pin text) → jsonb` | Existeix, SECURITY DEFINER, `search_path=public` |
| RPC `upsert_trip(p_pin, p_trip_key, p_week_id, p_trip_date date, p_direction, p_driver, p_passengers jsonb, p_price_cents int) → jsonb` | Existeix, SECURITY DEFINER |
| RPC `set_week_settled(p_pin, p_week_id, p_settled bool) → jsonb` | Existeix, SECURITY DEFINER |
| RPC `set_default_price(p_pin, p_price_cents int) → int` | Existeix, SECURITY DEFINER |
| Validació PIN | Helper `_check_pin` (no executable per `anon`), llegeix `app_config.group_pin`, `raise 'PIN_INVALID' (P0001)`. Sense PIN literal al codi |
| `group_pin` / dades | **No llegit, no modificat, res esborrat** |

Clau pública: `sb_publishable_…` (nova) i JWT legacy `anon` (payload decodificat: `role:"anon"`, `ref` correcte). **Cap clau secreta/service_role obtinguda.** `classifyKey()` rebutja `sb_secret_*` i JWT amb `role≠anon`.
Capçaleres: publishable → només `apikey` + `Content-Type`; JWT → afegeix `Authorization: Bearer`.

Proves en viu amb PIN fals (les dues claus): `0000`, `9999`, `' OR 1=1 --`, `""` → `PIN_INVALID (400)` a `get_carpool_state`, `upsert_trip`, `set_week_settled`, `set_default_price`. Cap escriptura ha tingut efecte.
Observació: la clau publishable **amb** `Bearer` també ha estat acceptada (400 PIN_INVALID, no 401). El CONTEXT diu el contrari; igualment seguim la regla del CONTEXT (no enviar Bearer), que és la recomanada per Supabase.

## 2. Decisions de disseny (i per què)
1. **Aritmètica exacta en unitats de 1/60 cèntim** (60 = mcm(1..5)): `price/N` és enter per a N∈{1..5}. S'arrodoneix **un sol cop** al final (residu més gran, desempat alfabètic) → suma de saldos exactament 0 i sense deriva acumulada (3 trajectes de 100 c / 3 → 100 c exactes, no 99 ni 102).
2. **Bizums mínims exactes**, no greedy pur: el greedy (deutor màxim → creditor màxim) no sempre és òptim. Òptim = (#no-zero) − (màx. grups disjunts de suma zero); amb 5 membres és un DP sobre 32 subconjunts, i greedy dins de cada grup. Validat contra força bruta (3000 casos).
3. **Normalització defensiva**: només `A,J,M,Q,R`, sense duplicats, ordre alfabètic; el conductor sempre és ocupant; conductor desconegut → `null`; preu no enter/negatiu → 0 (mai NaN).
4. **Setmana sense fila a `weeks` = pendent.** Total acumulat = suma exacta de totes les setmanes no liquidades i arrodonida un cop (pot diferir ±1 c de la suma de saldos setmanals arrodonits).
5. **Cua per `trip_key`**: màxim 1 petició en vol per tram; els tocs intermedis es fusionen (upsert és substitució completa, només importa l'últim estat). Trams diferents van en paral·lel.
6. **Refresc segur**: `refresh()` reaplica les edicions locals pendents sobre l'estat del servidor i ignora respostes obsoletes (número de seqüència). Si el servidor torna `PIN_INVALID` (PIN canviat), es fa logout.
7. Errors d'escriptura: es manté la intenció local i `retry()` la reenvia. `setWeekSettled`/`setDefaultPrice` fan rollback si fallen.
8. `localStorage` embolcallat amb try/catch (mode privat / quota) i cache corrupta tolerada.

## 3. Tests (TDD)
Inicialment fora del repo (el prompt demanava esborrar-los); **2026-11-26 16:09 l'usuari accepta mantenir-los per auditoria** → ara a `tests/`. Executar: `node --test tests/engine.test.js tests/sync.test.js`. Prova en viu: `SB_PUBLISHABLE_KEY=... SB_ANON_JWT=... NODE_USE_ENV_PROXY=1 node tests/live.js` (només PINs falsos).

- Resultat: **46/46 passen** (30 motor + 16 sincronització).
- Casos obligatoris: a) conductor sol 0,00 €; b) anada 4 (J) + tornada 2 (A) → `A+1,50 J+4,50 M−1,50 Q−1,50 R−3,00`; c) 700/3 suma 0; d) cercle A→J→M→A → 0 Bizums; e) setmanes `settled` excloses.
- Adversaris: anys ISO 53 setmanes i canvi d'any, dates invàlides (30 feb), duplicats/noms llargs/membres desconeguts, preus NaN/negatius/2^60, fuzz 2000 setmanes aleatòries, ordre de claus, claus secretes/service_role, cache corrupta, storage que llança, respostes fora d'ordre, refresc durant escriptura, PIN rotat, `onChange` que llança.
- **Mutation testing**: 8 mutants (sense serialització, sense override en refresc, Bearer sempre, arrodoniment per trajecte, greedy pur, ignorar settled, acceptar service_role, sense control de seqüència) → **tots detectats** pels tests.
- Nota d'honestedat TDD: la suite del motor es va escriure i executar en vermell abans del codi; la suite de sincronització es va escriure després del codi i per això s'ha validat amb els mutants.

## 4. Riscos coneguts / pendents
- El PIN de 4 dígits (10.000 combinacions) no té limitació d'intents a `_check_pin` (segons el cos inspeccionat): un atacant amb la clau pública el pot forçar. Recomanat: taula de rate-limit a `_check_pin`.
- Les RPC són `EXECUTE` per a `PUBLIC`; acceptable perquè totes validen PIN.
- `upsert_trip` confia en el client per a `week_id`/`price_cents`; la BD no valida coherència.

## 5. Límit d'intents de PIN (2026-11-26, **preparat, NO aplicat**)
Decisió de l'usuari: "Sí, prepara la migració" (targeta, 16:09) i "Amb tres intents ja n'hi ha prou" (16:11). Aplicar només amb la seva confirmació.

- Fitxers: `supabase/migrations/20261126_pin_rate_limit.sql`, `…rollback.sql`, tests a `supabase/tests/` (`./supabase/tests/run.sh`).
- Definicions de partida llegides en viu (només lectura, `pg_get_functiondef`), PostgreSQL 17.12. Rèplica local a `tests/00_baseline_schema.sql` amb PIN fals `4321`.
- **Trampa evitada:** `_check_pin` fa `RAISE`; PostgREST fa ROLLBACK en un RAISE, per tant un comptador escrit abans es perdria. Les RPC ara **retornen** el cos d'error i fixen `response.status` (400 / 429) perquè la transacció faci COMMIT. Nota: que PostgREST faci COMMIT amb un 4xx fixat per GUC és una **inferència** de la documentació ("If the transaction doesn't fail, it will always end in a COMMIT"), no una frase explícita → es verifica en viu després d'aplicar (3 PINs falsos → el 4t ha de donar 429).
- Política: per IP (`cf-connecting-ip` → `x-real-ip` → 1a de `x-forwarded-for`) 3 errors / 15 min → bloqueig 15 min; global 30 errors / 60 min → bloqueig 30 min per a tothom. Un PIN correcte esborra el comptador d'aquella IP.
- Trade-off: el límit global permet a un atacant bloquejar el grup 30 min (DoS) però impedeix rotar IPs. La solució de fons és un PIN més llarg (6+ dígits).
- Canvi de contracte: `set_default_price` retorna `jsonb` en lloc d'`integer` (cal per retornar l'error). El motor no en fa servir el valor.
- Motor: nou codi `PIN_LOCKED` (amb `retryAfterS`), i un cos `PIN_INVALID/PIN_LOCKED` es tracta com a error encara que arribi amb HTTP 200 (defensa en profunditat). Un `PIN_LOCKED` no fa logout.
- Tests: SQL **30/30** (inclou: persistència entre transaccions, IP bloquejada rebutja fins i tot el PIN correcte, cap escriptura amb PIN fals, caducitat, capçaleres absents/brossa, límit global, `anon` no pot llegir `pin_attempts` ni executar `_pin_gate`, PIN nul/100.000 caràcters, migració re-executable). 4 mutants SQL (RAISE en lloc de RETURN, sense comprovació de bloqueig, límit 5, sense REVOKE) → tots detectats. Rollback provat (torna l'`integer` i el RAISE original). Motor JS: **49/49**.

### 5.1 Aplicació (registre)
- 16:14 l'usuari aprova aplicar-la (targeta "Sí, aplica-la").
- Pre-check en viu OK: `pin_attempts` no existia, `_check_pin` sense canvis, `set_default_price` retornava `integer`.
- Incidència 1 (error meu): vaig enviar al dispositiu una versió amb comentaris condensats però amb el hash del fitxer del repo → no quadrava i **no s'aplicà** (correcte). Text exacte enviat reconstruït: `20261126_pin_rate_limit.applied-copy.sql`, sha256 `9a9a7b763748f93468abde90f2eea25a55b8b483c0bed8b2b81882762e569423`, idèntic en codi al revisat (només canvien comentaris); suite SQL re-executada sobre aquest text: 30/30.
- Incidència 2: el mode automàtic de Claude Code a l'ordinador de l'usuari bloqueja `apply_migration` en BD de producció. No s'ha intentat cap via alternativa. Pendent que l'usuari l'executi al SQL Editor.
