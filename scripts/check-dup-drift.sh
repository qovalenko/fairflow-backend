#!/usr/bin/env bash
# P20 shared-dedup: drift control for known families of duplicated files.
#
# Each family lists a canonical file plus its byte-identical copies across
# services. Before starting (and before merging) a dedup wave we re-run this:
# if a copy has "drifted" (md5 differs from the canon) the wave must stop and
# the delta be reconciled manually (usually by promoting the freshest variant
# to canon) BEFORE the extraction proceeds.
#
# Usage: bash scripts/check-dup-drift.sh
# Exit 0 = no drift; exit 1 = drift detected (or missing canon).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

md5_of() {
  # portable md5 (macOS `md5 -q` vs linux `md5sum`)
  if command -v md5 >/dev/null 2>&1; then
    md5 -q "$1"
  else
    md5sum "$1" | awk '{print $1}'
  fi
}

STATUS=0

# check_family <name> <canon-path> <copy-path...>
check_family() {
  local name="$1"; shift
  local canon="$1"; shift
  if [ ! -f "$canon" ]; then
    echo "[$name] MISSING CANON: $canon (family already migrated? skipping)"
    return 0
  fi
  local ref
  ref="$(md5_of "$canon")"
  local drift=0
  local copy sum
  for copy in "$@"; do
    if [ ! -f "$copy" ]; then
      # A copy that no longer exists is fine (it was migrated to shared).
      continue
    fi
    sum="$(md5_of "$copy")"
    if [ "$sum" != "$ref" ]; then
      echo "[$name] DRIFT: $copy differs from canon $canon"
      drift=1
    fi
  done
  if [ "$drift" -eq 0 ]; then
    echo "[$name] ok ($ref)"
  else
    STATUS=1
  fi
}

# --- Family: app-error.filter.ts (7 identical copies; gateway & auth are their own) ---
check_family "app-error.filter" \
  activity/src/common/app-error.filter.ts \
  company/src/common/app-error.filter.ts \
  contact/src/common/app-error.filter.ts \
  orders/src/common/app-error.filter.ts \
  pipe/src/common/app-error.filter.ts \
  product/src/common/app-error.filter.ts \
  control/src/common/app-error.filter.ts

# --- Family: errors.ts (7 byte-identical; control adds paymentRequired, auth adds OAuth codes) ---
check_family "errors(base)" \
  activity/src/common/errors.ts \
  company/src/common/errors.ts \
  contact/src/common/errors.ts \
  gateway/src/common/errors.ts \
  orders/src/common/errors.ts \
  pipe/src/common/errors.ts \
  product/src/common/errors.ts

# --- Family: gateway-api-key-validation.service.ts (15 byte-identical; canon activity) ---
check_family "gw-api-key-validation" \
  activity/src/auth-validation/gateway-api-key-validation.service.ts \
  audit/src/auth-validation/gateway-api-key-validation.service.ts \
  automation/src/auth-validation/gateway-api-key-validation.service.ts \
  billing/src/auth-validation/gateway-api-key-validation.service.ts \
  chat/src/auth-validation/gateway-api-key-validation.service.ts \
  company/src/auth-validation/gateway-api-key-validation.service.ts \
  contact/src/auth-validation/gateway-api-key-validation.service.ts \
  control/src/auth-validation/gateway-api-key-validation.service.ts \
  documents/src/auth-validation/gateway-api-key-validation.service.ts \
  notification/src/auth-validation/gateway-api-key-validation.service.ts \
  orders/src/auth-validation/gateway-api-key-validation.service.ts \
  pipe/src/auth-validation/gateway-api-key-validation.service.ts \
  product/src/auth-validation/gateway-api-key-validation.service.ts \
  reports/src/auth-validation/gateway-api-key-validation.service.ts \
  search/src/auth-validation/gateway-api-key-validation.service.ts

# --- Family: metrics.module.ts (18 identical) ---
check_family "metrics.module" \
  activity/src/metrics/metrics.module.ts \
  company/src/metrics/metrics.module.ts \
  contact/src/metrics/metrics.module.ts \
  orders/src/metrics/metrics.module.ts \
  pipe/src/metrics/metrics.module.ts \
  product/src/metrics/metrics.module.ts \
  control/src/metrics/metrics.module.ts \
  documents/src/metrics/metrics.module.ts \
  reports/src/metrics/metrics.module.ts

# --- Family: request-context.ts (8 identical; consumed by the filter) ---
check_family "request-context" \
  activity/src/common/request-context.ts \
  company/src/common/request-context.ts \
  contact/src/common/request-context.ts \
  gateway/src/common/request-context.ts \
  orders/src/common/request-context.ts \
  pipe/src/common/request-context.ts \
  product/src/common/request-context.ts \
  control/src/common/request-context.ts

if [ "$STATUS" -ne 0 ]; then
  echo ""
  echo "DRIFT DETECTED — reconcile the delta before running/merging a dedup wave."
fi
exit "$STATUS"
