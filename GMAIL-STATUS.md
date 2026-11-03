# Gmail POC: where it stands (2026-11-02, round 5)

Branch `t3/gmail-background`, draft PR #19. It holds:
- the Gmail-as-a-provider POC (`feat/gmail-provider`);
- a merge of current main (`everyapp`, #18);
- Ben's round 4 review (send by default, no full send, two-way labels);
- round 5: the move onto Every App's simplified OAuth model (private-every-app `docs/design/2026-11-oauth-simplify.md`), which isn't released yet.

The spec is [docs/GMAIL.md](docs/GMAIL.md); the decisions are in [TODO.md](TODO.md), "Decide", under "Gmail".

## The product, as built

- **Connect Gmail, once, in OpenMail.** One link on the home page: Google's consent for `gmail.modify` and `gmail.send`, then back to OpenMail, where "Add your Gmail inbox" creates an inbox that only you see. That's the only step.
  - Before you connect, the card links to **"Using a personal @gmail.com account?"**, Every App's page: https://everyapp.com/docs/google-personal-accounts.
- **Sync.** Inbox, sent, drafts, archive and labels.
  - Every 30 s while OpenMail is open, and every 2 minutes while it's closed (GmailSync's alarm, on your own connection: `for: { background: true, userId }`).
  - Read, star, archive, trash and labels made in OpenMail happen in Gmail.
  - The strip under the top bar shows "Synced 12 s ago", or a Reconnect banner.
- **Auto-drafts.** Each new inbox message gets a reply draft, as a real Gmail draft in the thread, also while OpenMail is closed. The row shows "Drafting… 0:42". Edits use `drafts.update` and discards `drafts.delete`.
- **Sending.**
  - Send in OpenMail sends through your Gmail (`messages.send`) while you're there. "Open in Gmail" is still beside each draft.
  - Nothing ever sends in the background. OpenMail enforces this; the Gateway can't, since `gmail.modify` alone allows sending.
  - AI clients (MCP) can't send from a Gmail inbox; they save drafts.
- **Labels: one system**, both ways, as in round 4.
- **Settings.** A Gmail inbox's settings page has a Gmail section: the account, and Reconnect.
- **Privacy.** Every new inbox, Gmail or native, is visible only to its creator. Others get "not found", admins included. Old mailboxes (no `ownerId`) stay shared.

## What round 5 changed

- **Manifest:** `"google-workspace": { scopes: ["gmail.modify", "gmail.send"], why }`. No `access`, `background`, `identity` or `gmail.read`.
- **Connect:** one `connectUrl({ env, provider, returnTo })`, for Connect Gmail and Reconnect alike. `reconnectUrl` and the background page are gone.
- **Deleted:**
  - `docs/gmail/gmail-modify.json` and `docs/gmail/gmail-send.json` (the overlays), `.everyapp/scope-sets/`, and the `provider scope-set add` steps;
  - the manifest's `background` block, and `connectUrl({ background: true })`;
  - the status route's `background` and `scopeSets`, and the "Background drafting: On/Off, Turn on" row in the inbox's settings;
  - GmailSync's 10-minute retry window (`BACKGROUND_RETRY_MS`), which existed for members who hadn't allowed background use;
  - `account: "user"` on `integrationFetch`;
  - the `integration_scope_not_granted` message in `app/services/api.ts`;
  - `test/gmail-overlays.test.ts`, and the dev test's overlay-file and background-send-refused cases;
  - OpenMail's own `/help/personal-gmail` page (Every App's page replaces it);
  - the unused `sendDraft` client call.

## Verified

See PR #19's body: what typechecks and which tests pass against the vendored (old) SDK.

## Not verified

- **No real Google, no Gateway with the new model.** Everything runs against a fake Gmail.
- **The UI hasn't been looked at in a browser.**
- **That `ownerId` matches the id the Gateway expects in `for: { userId }`.**

## Needs a release

- `vendor/` holds the old SDK (private-every-app `birds/feature` at 38c3ebcf). Re-vendor from a checkout with the OAuth simplification and `pack-for-app --vendor`, or pin the first release that has it. See vendor/README.md.
- Existing Google connections are dropped by the Gateway change: each person reconnects once in OpenMail.
