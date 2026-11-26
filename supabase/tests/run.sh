#!/usr/bin/env bash
# Runs the SQL suite on a throwaway local Postgres DB (needs a local superuser 'postgres').
set -euo pipefail
cd "$(dirname "$0")/.."
P="su postgres -c"
$P "dropdb --if-exists cotxe_test" >/dev/null 2>&1; $P "createdb cotxe_test"
$P "psql -q -v ON_ERROR_STOP=1 -d cotxe_test -f tests/00_baseline_schema.sql"
$P "psql -q -v ON_ERROR_STOP=1 -d cotxe_test -f migrations/20261126_pin_rate_limit.sql"
$P "psql -q -v ON_ERROR_STOP=1 -d cotxe_test -f migrations/20261126_pin_rate_limit.sql"   # idempotency
$P "psql -q -v ON_ERROR_STOP=1 -d cotxe_test -f tests/10_pin_rate_limit_test.sql" 2>&1 | grep -E "ok -|FAIL|ERROR|DONE" | sed 's/^psql:[^ ]* //'
