#!/usr/bin/env bash
# Smoke / negative checks (services must be running). Exit 0 if expectations hold.
set -euo pipefail
AUTH_HTTP="${AUTH_HTTP:-http://127.0.0.1:3001}"
GW="${GATEWAY_HTTP:-http://127.0.0.1:3000}"

code() {
  curl -s -o /dev/null -w "%{http_code}" "$@" || echo "000"
}

echo "== Health on auth (expect 200) =="
c=$(code "$AUTH_HTTP/healthz")
echo "GET $AUTH_HTTP/healthz -> $c"
test "$c" = "200"

echo "== Legacy business REST on auth port (expect 404) =="
c=$(code -X POST "$AUTH_HTTP/api/v1/auth/login" -H 'Content-Type: application/json' -d '{}')
echo "POST $AUTH_HTTP/api/v1/auth/login -> $c"
test "$c" = "404"

echo "== Gateway GraphQL (expect 200) =="
c=$(code "$GW/graphql" -X POST -H 'Content-Type: application/json' -d '{"query":"{ __typename }"}')
echo "POST $GW/graphql -> $c"
test "$c" = "200"

echo "OK"
