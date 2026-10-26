#!/usr/bin/env bash
# Probes a running `pnpm everyapp dev --port <gateway port>` through its
# gateway-lite, as a browser would reach it.
#
#   bash scripts/dev-probe.sh [gateway port, default 8787] [the app's internal Vite port, printed by everyapp dev]
#
# curl resolves openmail.localhost to 127.0.0.1 itself (--resolve): the
# system resolver answers ::1 for *.localhost while the gateway-lite listens
# on 127.0.0.1. Non-GET requests carry Origin: the perimeter treats a
# cookieless state-changing request without a same-origin signal as
# anonymous, as it would a cross-site one.
set -u
GW_PORT="${1:-8787}"
APP_PORT="${2:-}"
HOST="openmail.localhost:${GW_PORT}"
U="http://${HOST}"
R=(--resolve "${HOST}:127.0.0.1" --max-time 60 -s)
ORIGIN=(-H "Origin: ${U}")
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAILS=0
pass() { echo "ok   $*"; }
fail() { echo "FAIL $*"; FAILS=$((FAILS + 1)); }

echo "== GET / (SSR through the gateway-lite)"
code=$(curl "${R[@]}" -D "$TMP/root.h" -o "$TMP/root.html" -w '%{http_code}' "$U/")
title=$(grep -o '<title>[^<]*</title>' "$TMP/root.html" | head -1)
[ "$code" = 200 ] && [ "$title" = "<title>OpenMail</title>" ] && pass "GET / -> 200 $title" || fail "GET / -> $code $title"
for h in content-security-policy x-frame-options x-content-type-options referrer-policy strict-transport-security; do
	line=$(grep -i "^$h:" "$TMP/root.h" | tr -d '\r')
	[ -n "$line" ] && pass "perimeter header $line" || fail "missing perimeter header $h"
done

echo "== GET /favicon.svg (static asset)"
code=$(curl "${R[@]}" -o /dev/null -w '%{http_code} %{content_type}' "$U/favicon.svg")
[ "${code%% *}" = 200 ] && pass "GET /favicon.svg -> $code" || fail "GET /favicon.svg -> $code"

echo "== GET /api/v1/config"
# `ready` is the gateway's email status: under `everyapp dev`, true only with
# EMAIL_FROM in .dev.vars.
body=$(curl "${R[@]}" "$U/api/v1/config")
case "$body" in
	'{"domains":["example.com"],"emailAddresses":[],"ready":'*'}') pass "config -> $body" ;;
	*) fail "config -> $body" ;;
esac

echo "== Set-Cookie: the app sets none"
if grep -qi '^set-cookie:' "$TMP/root.h"; then fail "GET / set a cookie"; else pass "GET / sets no cookie"; fi

MAILBOX="probe-$(date +%s)@example.com"
echo "== POST /api/v1/mailboxes ($MAILBOX, with Origin)"
code=$(curl "${R[@]}" "${ORIGIN[@]}" -X POST -H 'content-type: application/json' \
	-d "{\"name\":\"Probe\",\"email\":\"$MAILBOX\"}" -o "$TMP/create.json" -w '%{http_code}' "$U/api/v1/mailboxes")
[ "$code" = 201 ] && pass "create mailbox -> 201 $(cat "$TMP/create.json" | head -c 120)" || fail "create mailbox -> $code $(cat "$TMP/create.json")"
folders=$(curl "${R[@]}" "$U/api/v1/mailboxes/$MAILBOX/folders" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).map(f=>f.id).sort().join(","))}catch{console.log(s.slice(0,200))}})')
[ "$folders" = "archive,draft,inbox,sent,spam,trash" ] && pass "six folders: $folders" || fail "folders: $folders"
listed=$(curl "${R[@]}" "$U/api/v1/mailboxes" | grep -c "$MAILBOX")
[ "$listed" -ge 1 ] && pass "GET /api/v1/mailboxes lists it" || fail "GET /api/v1/mailboxes doesn't list $MAILBOX"

echo "== POST without Origin (cookieless, no same-origin signal) is anonymous"
code=$(curl "${R[@]}" -X POST -H 'content-type: application/json' -d '{"name":"x","email":"x@example.com"}' -o /dev/null -w '%{http_code}' "$U/api/v1/mailboxes")
[ "$code" = 401 ] && pass "POST without Origin -> 401" || fail "POST without Origin -> $code"

echo "== WebSocket /agents/email-agent/$MAILBOX"
if node "$HERE/ws-probe.mjs" "ws://127.0.0.1:${GW_PORT}/agents/email-agent/$MAILBOX" "$HOST" "$U" > "$TMP/ws.log" 2>&1; then
	pass "email-agent socket: $(grep -o 'upgrade [0-9]*' "$TMP/ws.log" | head -1), $(grep -o '"type":"cf_agent_identity"' "$TMP/ws.log" | head -1)"
else
	fail "email-agent socket: $(tr '\n' ' ' < "$TMP/ws.log" | head -c 400)"
fi

echo "== WebSocket /agents/mailbox/$MAILBOX (must be refused)"
node "$HERE/ws-probe.mjs" "ws://127.0.0.1:${GW_PORT}/agents/mailbox/$MAILBOX" "$HOST" "$U" > "$TMP/ws2.log" 2>&1
rc=$?
[ "$rc" = 2 ] && pass "mailbox socket refused: $(grep -o 'refused.*' "$TMP/ws2.log" | head -1)" || fail "mailbox socket not refused (exit $rc): $(tr '\n' ' ' < "$TMP/ws2.log" | head -c 400)"

echo "== HTTP /agents/mailbox/$MAILBOX and /agents/email-mcp/x (must be refused)"
code=$(curl "${R[@]}" -o /dev/null -w '%{http_code}' "$U/agents/mailbox/$MAILBOX")
[ "$code" = 404 ] && pass "GET /agents/mailbox/... -> 404" || fail "GET /agents/mailbox/... -> $code"
# EmailMCP is gone (the MCP tools are a defineTools() catalog), so no
# EMAIL_MCP binding exists and partyserver answers 400 ("Invalid request")
# for this path before any guard runs.
code=$(curl "${R[@]}" -o /dev/null -w '%{http_code}' "$U/agents/email-mcp/x")
[ "$code" = 400 ] && pass "GET /agents/email-mcp/x -> 400 (no such binding)" || fail "GET /agents/email-mcp/x -> $code"

if [ -n "$APP_PORT" ]; then
	echo "== direct hit on the app's Vite port $APP_PORT (bypassing the gateway)"
	code=$(curl -s --max-time 20 -o "$TMP/direct.json" -w '%{http_code}' "http://127.0.0.1:${APP_PORT}/api/v1/config")
	[ "$code" = 401 ] && pass "direct hit -> 401 $(cat "$TMP/direct.json" | head -c 160)" || fail "direct hit -> $code $(cat "$TMP/direct.json")"
else
	echo "(skipped the direct-hit check: pass the app's Vite port as the second argument)"
fi

echo
if [ "$FAILS" = 0 ]; then echo "dev-probe OK"; else echo "dev-probe: $FAILS failure(s)"; exit 1; fi
