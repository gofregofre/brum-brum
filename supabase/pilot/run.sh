#!/usr/bin/env bash
# Runs the pilot SQL suite on a throwaway local Postgres DB (needs a local superuser 'postgres').
set -euo pipefail
cd "$(dirname "$0")"
P="su postgres -c"
$P "dropdb --if-exists cotxe_pilot_test" >/dev/null 2>&1; $P "createdb cotxe_pilot_test"
$P "psql -q -v ON_ERROR_STOP=1 -d cotxe_pilot_test -f tests/00_setup.sql"
$P "psql -q -v ON_ERROR_STOP=1 -d cotxe_pilot_test -f migrations/20261126_pilot_multigroup.sql"
$P "psql -q -v ON_ERROR_STOP=1 -d cotxe_pilot_test -f migrations/20261126_pilot_multigroup.sql"   # idempotency
$P "psql -q -v ON_ERROR_STOP=1 -d cotxe_pilot_test -f tests/10_pilot_test.sql" 2>&1 | grep -E "ok -|FAIL|ERROR|DONE" | sed 's/^psql:[^ ]* //'
