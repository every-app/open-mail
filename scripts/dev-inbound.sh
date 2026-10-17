#!/usr/bin/env bash
# Delivers test/fixtures/inbound.eml to the app's email() handler under
# `pnpm everyapp dev`, as Email Routing would deliver it to the deployed
# Worker.
#
#   bash scripts/dev-inbound.sh <the app's internal Vite port, printed by everyapp dev> [gateway port] [to address]
#
# The message goes to the app's Vite port, not the gateway-lite: miniflare
# (under the Cloudflare Vite plugin 2.x) takes inbound mail at
# POST /cdn-cgi/local/email?from=<MAIL FROM>&to=<RCPT TO> with the raw RFC
# 5322 message as the body (a Message-ID is required; 1 MiB at most). On the
# gateway-lite host the path would be an app route and the app would answer
# 401. receiveEmail() files the mail by its To header, so the script rewrites
# that header to <to address> (default dev@example.com), and gives every
# delivery a fresh Message-ID and a subject of its own.
#
# With the gateway port, the script also creates the mailbox if it is missing
# (as the dev owner) and checks that the message is in its Inbox afterwards.
# The agent's auto-draft runs in the background: with AI keys in .dev.vars
# Drafts gets a reply; without, the dev server's log shows the AI
# configuration message.
set -u
APP_PORT="${1:?usage: bash scripts/dev-inbound.sh <app Vite port> [gateway port] [to address]}"
GW_PORT="${2:-}"
TO="${3:-dev@example.com}"
FROM="alice@example.org"
HERE="$(cd "$(dirname "$0")" && pwd)"
FIXTURE="$HERE/../test/fixtures/inbound.eml"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
STAMP="$(date +%s)-$$"
SUBJECT="Question about my order ($STAMP)"

if [ -n "$GW_PORT" ]; then
	HOST="agentic-inbox.localhost:${GW_PORT}"
	U="http://${HOST}"
	R=(--resolve "${HOST}:127.0.0.1" --max-time 60 -s)
	code=$(curl "${R[@]}" -H "Origin: ${U}" -X POST -H 'content-type: application/json' \
		-d "{\"name\":\"Dev\",\"email\":\"$TO\"}" -o "$TMP/create.json" -w '%{http_code}' "$U/api/v1/mailboxes")
	case "$code" in
		201) echo "ok   created mailbox $TO" ;;
		409) echo "ok   mailbox $TO exists" ;;
		*) echo "FAIL create mailbox $TO -> $code $(cat "$TMP/create.json")"; exit 1 ;;
	esac
fi

# The fixture with To: <to address>, a fresh Message-ID and a subject this
# delivery can be found by (CRLF line ends kept).
node -e '
	const fs = require("fs");
	const [fixture, out, to, stamp, subject] = process.argv.slice(1);
	const eml = fs.readFileSync(fixture, "utf8")
		.replace(/^To: .*$/m, `To: Dev Inbox <${to}>`)
		.replace(/^Message-ID: .*$/m, `Message-ID: <inbound-${stamp}@example.org>`)
		.replace(/^Subject: .*$/m, `Subject: ${subject}`);
	fs.writeFileSync(out, eml);
' "$FIXTURE" "$TMP/message.eml" "$TO" "$STAMP" "$SUBJECT"

code=$(curl -s --max-time 60 -X POST --data-binary @"$TMP/message.eml" -o "$TMP/deliver.txt" -w '%{http_code}' \
	"http://127.0.0.1:${APP_PORT}/cdn-cgi/local/email?from=${FROM}&to=${TO}")
if [ "$code" = 200 ]; then
	echo "ok   delivered inbound-$STAMP@example.org from $FROM to $TO -> 200 $(head -c 120 "$TMP/deliver.txt")"
else
	echo "FAIL deliver -> $code $(head -c 400 "$TMP/deliver.txt")"
	exit 1
fi

if [ -n "$GW_PORT" ]; then
	curl "${R[@]}" "$U/api/v1/mailboxes/$TO/emails?folder=inbox&limit=100" > "$TMP/inbox.json"
	found=$(node -e '
		const list = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
		const emails = Array.isArray(list) ? list : list.emails;
		const hit = emails.find((e) => e.subject === process.argv[2] && e.sender === process.argv[3]);
		console.log(hit ? hit.id : "");
	' "$TMP/inbox.json" "$SUBJECT" "$FROM" 2>/dev/null)
	if [ -n "$found" ]; then
		echo "ok   the Inbox of $TO lists it (email $found)"
	else
		echo "FAIL the Inbox of $TO doesn't list \"$SUBJECT\" from $FROM: $(head -c 400 "$TMP/inbox.json")"
		exit 1
	fi
fi
