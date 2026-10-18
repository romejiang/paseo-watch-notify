#!/usr/bin/env bash
#
# Live behaviour diff for the two gateways.
#
# Sends the same request sequence to whichever gateway base URL you pass and prints one
# `label|status|body` line per request, so two runs can be diffed:
#
#   ./live-check.sh https://notify.romejiang.top                 > /tmp/worker.txt
#   ssh root@yang 'bash -s -- http://127.0.0.1:8787' < live-check.sh > /tmp/node.txt
#   diff /tmp/node.txt /tmp/worker.txt
#
# Uses throwaway channel secrets that never own real devices, so nothing is pushed to Apple.
set -uo pipefail

BASE="${1:?usage: live-check.sh <base-url>}"

run_id="$(date +%s)-$RANDOM"
reg="parity-reg-${run_id}"
empty="parity-empty-${run_id}"
rl="parity-rl-${run_id}"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

req() {
  local label="$1" method="$2" path="$3" body="${4-}" auth="${5-}"
  local args=(-s -o "$tmp" -w '%{http_code}' -X "$method" --max-time 20 "$BASE$path")
  [ -n "$auth" ] && args+=(-H "Authorization: Bearer $auth")
  if [ -n "$body" ]; then
    args+=(-H 'content-type: application/json' --data-binary "$body")
  fi
  local code
  code="$(curl "${args[@]}" 2>/dev/null || echo ERR)"
  printf '%s|%s|%s\n' "$label" "$code" "$(tr -d '\n' < "$tmp")"
}

big_body="$(printf '{"preview":"%s"}' "$(printf 'x%.0s' $(seq 1 70000))")"

req healthz               GET    /healthz
req no-bearer             POST   /api/notify  '{}'
req register-no-token     POST   /api/devices '{}'                                            "$reg"
req register-prod         POST   /api/devices '{"token":"parity-1","environment":"production","topic":"com.custom.topic","platform":"watch"}' "$reg"
req register-sandbox      POST   /api/devices '{"token":"parity-2","environment":"sandbox"}'  "$reg"
req register-default-env  POST   /api/devices '{"token":"parity-3"}'                          "$reg"
req notify-empty-channel  POST   /api/notify  '{"reason":"finished"}'                          "$empty"
req delete-malformed      DELETE '/api/devices/%ZZ' ''                                        "$reg"
req invalid-json          POST   /api/notify  '{not json'                                     "$empty"
req unknown-route         GET    /api/nope    ''                                              "$reg"
req oversized-body        POST   /api/notify  "$big_body"                                     "$empty"

# Rate limiting: both gateways must reject a burst that exceeds the per-channel budget (60/window).
# Sent concurrently because a sequential loop (~1 req/s) never drains a token bucket. Kept under the
# per-IP budget (120) so the cleanup requests below are not themselves rate limited.
burst="$(seq 1 100 | xargs -P 30 -I{} curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST "$BASE/api/notify" -H "Authorization: Bearer $rl" \
  -H 'content-type: application/json' --data '{}' --max-time 20)"
ok="$(printf '%s\n' "$burst" | grep -c '^200$')"
blocked="$(printf '%s\n' "$burst" | grep -c '^429$')"
other="$(printf '%s\n' "$burst" | grep -vc -e '^200$' -e '^429$')"
printf 'burst-100|ok=%s|blocked=%s|other=%s\n' "$ok" "$blocked" "$other"

# Clean up the throwaway devices so repeat runs do not accumulate garbage.
for token in parity-1 parity-2 parity-3; do
  req "cleanup-${token}" DELETE "/api/devices/${token}" '' "$reg"
done
