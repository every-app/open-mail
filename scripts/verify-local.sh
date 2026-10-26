#!/usr/bin/env bash
# The local end-to-end check of the port (the dev-loop half of the plan's
# §5.3; docs/EVERY_APP.md "Verified locally" holds a transcript), against a
# running `pnpm everyapp dev --port <gateway port>`:
#
#   bash scripts/verify-local.sh <gateway port> <the app's internal Vite port, printed by everyapp dev> [dev server log]
#
# It runs scripts/dev-probe.sh (SSR and the perimeter's headers, config, a
# new mailbox and its folders, the agent sockets, the direct hit), then:
# who am I; a member refused mailbox management; a send through the email
# adapter and its Sent copy; a refused sender (502, no Sent copy); inbound
# mail through the email() handler and the agent's auto-draft; the agent's
# socket and one chat turn; the MCP catalog through the gateway-lite's /mcp.
# With the dev server's log (`pnpm everyapp dev … > dev.log 2>&1`), it also
# finds the SDK's printed send and the agent's auto-draft line in it.
#
# Without AI keys in .dev.vars, the chat turn answers "AI isn't set up …"
# and the auto-draft is skipped with the same reason; both count as passing
# (the port's documented behaviour). With keys, Drafts gets the agent's
# reply (billed to the key's owner).
set -u
GW_PORT="${1:?usage: bash scripts/verify-local.sh <gateway port> <app Vite port> [dev server log]}"
APP_PORT="${2:?usage: bash scripts/verify-local.sh <gateway port> <app Vite port> [dev server log]}"
DEV_LOG="${3:-}"
HOST="openmail.localhost:${GW_PORT}"
U="http://${HOST}"
D="http://127.0.0.1:${APP_PORT}"
R=(--resolve "${HOST}:127.0.0.1" --max-time 60 -s)
O=(-H "Origin: ${U}")
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
STAMP="$(date +%s)"
MAILBOX="dev@example.com"
FAILS=0
pass() { echo "ok   $*"; }
fail() { echo "FAIL $*"; FAILS=$((FAILS + 1)); }
# json <file> <js expression over `j`>: prints the expression's value.
json() { node -e 'const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const v = (0, eval)(`(j) => (${process.argv[2]})`)(j); process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));' "$1" "$2" 2>/dev/null; }

echo "######## scripts/dev-probe.sh"
if bash "$HERE/dev-probe.sh" "$GW_PORT" "$APP_PORT"; then pass "dev-probe.sh"; else fail "dev-probe.sh (above)"; fi

echo "######## who am I, and the app's mail settings"
code=$(curl "${R[@]}" -o "$TMP/me.json" -w '%{http_code}' "$U/api/v1/me")
me=$(cat "$TMP/me.json")
[ "$code" = 200 ] && [ "$(json "$TMP/me.json" '[j.id, j.email, j.orgId, j.role].join(" ") + " " + /^https?:\/\//.test(j.gatewayUrl)')" = "dev-user dev@everyapp.localhost dev-org owner true" ] \
	&& pass "GET /api/v1/me -> $me" || fail "GET /api/v1/me -> $code $me"
code=$(curl "${R[@]}" -o "$TMP/config.json" -w '%{http_code}' "$U/api/v1/config")
[ "$code" = 200 ] && [ "$(json "$TMP/config.json" 'JSON.stringify(j.domains) + JSON.stringify(j.emailAddresses) + typeof j.ready')" = '["example.com"][]boolean' ] \
	&& pass "GET /api/v1/config -> $(cat "$TMP/config.json")" || fail "GET /api/v1/config -> $code $(cat "$TMP/config.json")"

echo "######## mailboxes: the owner creates $MAILBOX, a member may not"
code=$(curl "${R[@]}" "${O[@]}" -X POST -H 'content-type: application/json' -d "{\"name\":\"Dev\",\"email\":\"$MAILBOX\"}" -o "$TMP/create.json" -w '%{http_code}' "$U/api/v1/mailboxes")
case "$code" in 201|409) pass "owner POST /api/v1/mailboxes $MAILBOX -> $code" ;; *) fail "owner POST /api/v1/mailboxes -> $code $(cat "$TMP/create.json")" ;; esac
curl "${R[@]}" "$U/api/v1/mailboxes" > "$TMP/list.json"
[ "$(json "$TMP/list.json" 'j.some((m) => m.email === "'"$MAILBOX"'")')" = true ] && pass "GET /api/v1/mailboxes lists $MAILBOX" || fail "GET /api/v1/mailboxes: $(head -c 300 "$TMP/list.json")"
MEMBER="$(node "$HERE/mint-dev-identity.mjs" member)"
body=$(curl -s --max-time 30 -H "x-everyapp-identity: $MEMBER" -X POST -H 'content-type: application/json' -d "{\"name\":\"M\",\"email\":\"member-$STAMP@example.com\"}" -w ' %{http_code}' "$D/api/v1/mailboxes")
case "$body" in *'"code":"admin_required"'*' 403') pass "member (minted dev identity, app port) POST /api/v1/mailboxes -> $body" ;; *) fail "member POST /api/v1/mailboxes -> $body" ;; esac
code=$(curl -s --max-time 30 -H "x-everyapp-identity: $MEMBER" -o /dev/null -w '%{http_code}' "$D/api/v1/mailboxes/$MAILBOX/folders")
[ "$code" = 200 ] && pass "member GET .../$MAILBOX/folders -> 200" || fail "member GET folders -> $code"
OTHER_ORG="$(node "$HERE/mint-dev-identity.mjs" owner other-org)"
code=$(curl -s --max-time 30 -H "x-everyapp-identity: $OTHER_ORG" -o /dev/null -w '%{http_code}' "$D/api/v1/mailboxes")
echo "     (another organization's owner, unpinned dev copy: GET /api/v1/mailboxes -> $code; a deployed copy is pinned to EVERY_APP_ORG_ID and answers 401)"

echo "######## sending: through the gateway email adapter (the SDK prints it under everyapp dev)"
SUBJECT="verify-local send $STAMP"
code=$(curl "${R[@]}" "${O[@]}" -X POST -H 'content-type: application/json' \
	-d "{\"to\":\"alice@example.org\",\"from\":\"$MAILBOX\",\"subject\":\"$SUBJECT\",\"html\":\"<p>Hello from verify-local</p>\",\"text\":\"Hello from verify-local\"}" \
	-o "$TMP/send.json" -w '%{http_code}' "$U/api/v1/mailboxes/$MAILBOX/emails")
[ "$code" = 200 ] && [ "$(json "$TMP/send.json" 'j.status')" = sent ] && pass "POST .../$MAILBOX/emails -> 200 $(cat "$TMP/send.json")" || fail "send -> $code $(cat "$TMP/send.json")"
curl "${R[@]}" "$U/api/v1/mailboxes/$MAILBOX/emails?folder=sent&limit=100" > "$TMP/sent.json"
[ "$(json "$TMP/sent.json" '(Array.isArray(j) ? j : j.emails).some((e) => e.subject === "'"$SUBJECT"'")')" = true ] && pass "Sent lists \"$SUBJECT\"" || fail "Sent doesn't list \"$SUBJECT\": $(head -c 300 "$TMP/sent.json")"
if [ -n "$DEV_LOG" ]; then
	line=$(grep -a "\[everyapp dev\] email to .*subject \"$SUBJECT\"" "$DEV_LOG" | tail -1)
	[ -n "$line" ] && pass "dev log: $line" || fail "no [everyapp dev] email line for \"$SUBJECT\" in $DEV_LOG"
fi
REFUSED="refused-$STAMP@other.example"
curl "${R[@]}" "${O[@]}" -X POST -H 'content-type: application/json' -d "{\"name\":\"Refused\",\"email\":\"$REFUSED\"}" -o /dev/null "$U/api/v1/mailboxes"
code=$(curl "${R[@]}" "${O[@]}" -X POST -H 'content-type: application/json' \
	-d "{\"to\":\"alice@example.org\",\"from\":\"$REFUSED\",\"subject\":\"refused $STAMP\",\"text\":\"x\"}" \
	-o "$TMP/refused.json" -w '%{http_code}' "$U/api/v1/mailboxes/$REFUSED/emails")
[ "$code" = 502 ] && [ "$(json "$TMP/refused.json" 'j.error')" = email_sender_not_allowed ] && pass "a sender outside capabilities.email.senders -> 502 $(head -c 220 "$TMP/refused.json")" || fail "refused send -> $code $(cat "$TMP/refused.json")"
curl "${R[@]}" "$U/api/v1/mailboxes/$REFUSED/emails?folder=sent&limit=100" > "$TMP/refused-sent.json"
[ "$(json "$TMP/refused-sent.json" 'j.totalCount ?? (Array.isArray(j) ? j.length : j.emails.length)')" = 0 ] && pass "no Sent copy of the refused mail" || fail "refused mail has a Sent copy: $(head -c 300 "$TMP/refused-sent.json")"
curl "${R[@]}" "${O[@]}" -X DELETE -o /dev/null "$U/api/v1/mailboxes/$REFUSED"

echo "######## receiving: test/fixtures/inbound.eml through email() on the Vite port"
[ -n "$DEV_LOG" ] && LOG_START=$(wc -l < "$DEV_LOG")
bash "$HERE/dev-inbound.sh" "$APP_PORT" "$GW_PORT" "$MAILBOX" | tee "$TMP/inbound.out"
grep -q '^ok   the Inbox of' "$TMP/inbound.out" && pass "inbound mail filed in the Inbox" || fail "inbound mail (above)"
EMAIL_ID=$(sed -n 's/^ok   the Inbox of .* lists it (email \(.*\))$/\1/p' "$TMP/inbound.out")
if [ -n "$DEV_LOG" ] && [ -n "$EMAIL_ID" ]; then
	# The auto-draft runs in the background after delivery; give it up to 60 s.
	# Without AI keys the agent logs "Skipping auto-draft for <id>: …"; with
	# keys, Drafts gets a reply to <id> (listed below).
	line=""
	for _ in $(seq 1 60); do
		line=$(tail -n +"$((LOG_START + 1))" "$DEV_LOG" | grep -a -E "auto-draft.*$EMAIL_ID|$EMAIL_ID.*(draft|Draft)|onNewEmail handler failed" | tail -1)
		[ -n "$line" ] && break
		drafted=$(curl "${R[@]}" "$U/api/v1/mailboxes/$MAILBOX/emails?folder=draft&limit=100" | grep -c "$EMAIL_ID")
		[ "$drafted" -gt 0 ] && line="Drafts holds a reply to $EMAIL_ID" && break
		sleep 1
	done
	case "$line" in
		*"onNewEmail handler failed"*) fail "dev log (auto-draft): $(echo "$line" | head -c 260)" ;;
		"") fail "no auto-draft outcome for $EMAIL_ID in $DEV_LOG within 60 s" ;;
		*) pass "auto-draft for $EMAIL_ID: $(echo "$line" | head -c 260)" ;;
	esac
fi
curl "${R[@]}" "$U/api/v1/mailboxes/$MAILBOX/emails?folder=draft&limit=100" > "$TMP/drafts.json"
echo "     Drafts of $MAILBOX: $(json "$TMP/drafts.json" '(Array.isArray(j) ? j : j.emails).map((e) => e.subject).join(" | ") || "(none)"')"

echo "######## the agent: socket, one chat turn, the refused objects"
node "$HERE/ws-probe.mjs" "ws://127.0.0.1:${GW_PORT}/agents/email-agent/$MAILBOX" "$HOST" "$U" > "$TMP/ws.log" 2>&1
[ $? = 0 ] && pass "ws /agents/email-agent/$MAILBOX -> $(grep -o 'upgrade [0-9]*' "$TMP/ws.log" | head -1) + cf_agent_identity" || fail "agent socket: $(tr '\n' ' ' < "$TMP/ws.log" | head -c 300)"
node "$HERE/ws-probe.mjs" "ws://127.0.0.1:${GW_PORT}/agents/mailbox/$MAILBOX" "$HOST" "$U" > "$TMP/ws2.log" 2>&1
[ $? = 2 ] && pass "ws /agents/mailbox/$MAILBOX refused" || fail "mailbox socket not refused: $(tr '\n' ' ' < "$TMP/ws2.log" | head -c 300)"
code=$(curl "${R[@]}" -o /dev/null -w '%{http_code}' "$U/agents/mailbox/$MAILBOX")
[ "$code" = 404 ] && pass "GET /agents/mailbox/$MAILBOX -> 404" || fail "GET /agents/mailbox/$MAILBOX -> $code"
node "$HERE/chat-probe.mjs" "ws://127.0.0.1:${GW_PORT}/agents/email-agent/$MAILBOX" "$HOST" "$U" "Draft a reply to the newest email in my inbox." > "$TMP/chat.json" 2>&1
rc=$?
echo "     chat: $(tr '\n' ' ' < "$TMP/chat.json" | head -c 600)"
[ "$rc" = 0 ] && pass "a chat turn finished without a stream error" || fail "chat turn (exit $rc)"

echo "######## MCP: the gateway-lite's /mcp serves the app's defineTools() catalog"
H=(-H "Origin: ${U}" -H "Authorization: Bearer any-token-in-dev" -H "content-type: application/json" -H "accept: application/json, text/event-stream")
rpc() { curl "${R[@]}" "${H[@]}" -X POST -d "{\"jsonrpc\":\"2.0\",\"id\":$2,\"method\":\"$1\",\"params\":$3}" "$U/mcp" | sed -n 's/^data: //p;/^{/p' > "$TMP/rpc.json"; }
rpc initialize 1 '{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"verify-local","version":"1"}}'
server=$(json "$TMP/rpc.json" 'j.result.serverInfo.name')
[ -n "$server" ] && pass "initialize -> $server, protocol $(json "$TMP/rpc.json" 'j.result.protocolVersion')" || fail "initialize: $(head -c 300 "$TMP/rpc.json")"
curl "${R[@]}" "${H[@]}" -o /dev/null -X POST -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' "$U/mcp"
rpc tools/list 2 '{}'
names=$(json "$TMP/rpc.json" 'j.result.tools.map((t) => t.name).sort().join(",")')
count=$(json "$TMP/rpc.json" 'j.result.tools.length')
[ "$count" = 12 ] && [ "${names#*delete_email}" = "$names" ] && pass "tools/list -> 12 tools, no delete_email: $names" || fail "tools/list -> $count: $names"
rpc tools/call 3 '{"name":"list_mailboxes","arguments":{}}'
listed=$(json "$TMP/rpc.json" 'j.result.content.map((c) => c.text).join("")')
case "$listed" in *"$MAILBOX"*) pass "tools/call list_mailboxes -> includes $MAILBOX" ;; *) fail "tools/call list_mailboxes -> $(head -c 300 "$TMP/rpc.json")" ;; esac
rpc tools/call 4 "{\"name\":\"delete_email\",\"arguments\":{\"mailboxId\":\"$MAILBOX\",\"emailId\":\"x\"}}"
[ -n "$(json "$TMP/rpc.json" 'j.error && j.error.message')" ] && pass "tools/call delete_email -> refused: $(json "$TMP/rpc.json" 'j.error.message')" || fail "delete_email not refused: $(head -c 300 "$TMP/rpc.json")"

echo "######## the perimeter"
code=$(curl -s --max-time 20 -o "$TMP/direct.json" -w '%{http_code}' "$D/api/v1/me")
[ "$code" = 401 ] && pass "direct hit on the Vite port GET /api/v1/me -> 401 $(head -c 120 "$TMP/direct.json")" || fail "direct hit -> $code"

echo
if [ "$FAILS" = 0 ]; then echo "verify-local OK"; else echo "verify-local FAILED ($FAILS)"; exit 1; fi
