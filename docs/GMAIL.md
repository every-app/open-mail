# Gmail in OpenMail: product spec and plan

Status: POC, on `t3/gmail-background` (draft PR #19: the `feat/gmail-provider` POC, brought onto main and onto Every App's simplified OAuth model, private-every-app `docs/design/2026-11-oauth-simplify.md`; GMAIL-STATUS.md). Nothing here goes to `everyapp` (main) until Ben has tried it.

## Turning it on

Gmail is experimental and **off by default**: an installation shows nothing of it until the manifest's optional `gmail` feature is set up, the Gateway's Google client plus the app's `EXPERIMENTAL_GMAIL` setting at `true` (`pnpm everyapp configure openmail`; in `everyapp dev`, `EXPERIMENTAL_GMAIL=true` in `.dev.vars`). The Worker reads it per request (`workers/everyapp/gmail/flag.ts`) and `/api/v1/me` hands it to the UI as `gmail`, where every Gmail element mounts inside `<GmailOnly>` (`app/components/gmail/GmailOnly.tsx`). Off, the Gmail routes answer 404, `sync_mailbox` refuses (it stays in the deployed catalog, which is snapshotted at deploy) and GmailSync's alarm stops. A Gmail mailbox made while it was on stays listed as a plain mailbox and doesn't sync until it is on again.

## The product

You connect your Gmail and work your normal email from OpenMail. The agent drafts replies as mail arrives, also while OpenMail is closed. You review each draft and send it, from OpenMail or from Gmail. Over time, the agent learns how you reply.

| | What you get |
| --- | --- |
| **Connect** | Connect once, in OpenMail: click "Connect Gmail", approve Google's consent screen (`gmail.modify` and `gmail.send`), and you're back. That's the only step, and it covers background sync too. The Every App Gateway holds the token. OpenMail creates a Gmail inbox that belongs to you only. Personal @gmail.com accounts need a one-time change to the Gateway's Google app; the card links to [the steps](https://everyapp.com/docs/google-personal-accounts). |
| **Sync** | Your Gmail inbox, sent mail, drafts, archive and labels show up in OpenMail and stay in sync: every 30 s while OpenMail is open, and every 2 minutes while it isn't (see "Background sync"). Reading, starring, archiving, trashing and labelling in OpenMail happen in Gmail too. |
| **Labels** | One system: your Gmail labels are OpenMail's labels (the sidebar tree, the tags, `list_labels` and `label_conversation`). Creating, renaming, recolouring, deleting and applying a label on either side shows up on the other at the next sync. Gmail's own labels (Inbox, Starred, Important, the category tabs) stay folders and flags. |
| **Auto-drafts** | Off by default, like every mailbox's (Settings → Agent, "Draft replies automatically"). When on, each new message in your inbox gets a draft reply, written into Gmail as a real Gmail draft in the thread, also while OpenMail is closed. While a draft is being written, the thread shows "Drafting… 0:42", with an estimate based on how long recent drafts took. |
| **Sending** | Send in OpenMail sends through your Gmail (`messages.send`), as you, while you're there. Drafts can also be finished in Gmail ("Open in Gmail"). Nothing ever sends in the background, and AI clients (MCP) can't send from a Gmail inbox: they save drafts. |
| **Rules** | You and the agent write reply rules together ("when a customer asks for a refund, …"). The agent follows them on every draft. When you edit a draft before sending, the agent proposes a rule change from your edit, and you accept or reject it (phase 2). |
| **MCP** | Over the Every App MCP connector: list, read and search Gmail mail; create and update drafts; labels; archive; mark read; sync. `send_email` and `send_reply` refuse on a Gmail inbox (OpenMail's own inboxes send as before). |
| **Privacy** | Every inbox, native or Gmail, is visible only to the person who created it. Mailboxes created before this change stay shared with the organization (nothing recorded who created them). Opting an inbox into sharing with the team comes later. |

Out of scope for the POC: shared team inboxes, attachments in drafts the agent writes, Gmail filters, more than one Gmail account per person.

## How it works

```text
 browser (OpenMail UI)                 OpenMail Worker                          Every App Gateway        Google
 ─────────────────────                 ───────────────                          ─────────────────        ──────
 "Connect Gmail" ───────────────────────────────────────────────────────────▶  /connect/google-workspace
                                                                               ?app=openmail ───────────▶ consent
                  ◀── back to OpenMail ─────────────────────────────────────── holds the refresh token
 POST /gmail/mailboxes ──▶ create mailbox {provider: gmail, ownerId}
 every 30 s while open:
 POST …/gmail/sync ─────▶ GmailSync DO (one per Gmail mailbox)
 every 2 min, alarm ────▶   (the owner's own connection)
                            1. flush the outbox (drafts, label changes)  ──▶ held-token proxy ──▶ Gmail API
                            2. labels both ways (labels.list)            ──▶ (for: request, or
                            3. pull history since historyId
                            4. new mail → MailboxDO (upstream, as is)          { background, userId: owner })
                            5. new inbox mail → EmailAgent /onNewEmail
                               (the upstream auto-draft; its AI is the
                               organization's, background-attributed)
 the agent's draft ─────▶ wrapped env.MAILBOX.createEmail(draft) → MailboxDO + outbox
                            (flushed now if a person is behind the call, else by the alarm
                             within 5 s while the alarm is on, else at the next sync)
```

- **A Gmail mailbox is an OpenMail mailbox.** It has an R2 settings file with `provider: "gmail"` and `ownerId`, and a `MailboxDO` that mirrors the Gmail mail. All of upstream's UI, threading, search, paging, agent tools and MCP tools work on it unchanged.
- **The seam is `withGateway()`.** That function already builds the env for the routes, the agent and the MCP tools. It now also returns a wrapped `env.MAILBOX` (`workers/everyapp/gmail/namespace.ts`): for a Gmail mailbox, the mutating stub methods (`updateEmail`, `markThreadRead`, `moveEmail`, `deleteEmail`, `createEmail` into Drafts, and the label methods `createLabel`, `updateLabel`, `deleteLabel`, `labelThread`) are applied to the `MailboxDO` and recorded in the mailbox's outbox. Native mailboxes pass straight through. No upstream file changes.
- **`GmailSync` Durable Object** (new, `workers/everyapp/gmail/sync.ts`): the history cursor, the id map (local email id ↔ Gmail message id, thread id ↔ Gmail thread id, draft id ↔ Gmail draft id, OpenMail label id ↔ Gmail label id), the outbox, and draft-job timing. It has one entry point, `sync(target)`: flush, pull, poke the agent. Its alarm calls the same sync on the owner's behalf (see "Background sync").
- **Folders ↔ labels.** `INBOX`→inbox, `SENT`→sent, `DRAFT`→draft, `TRASH`→trash, `SPAM`→spam, anything else→archive. `STARRED`↔starred, and `UNREAD`↔unread. A move is a label change (archive removes `INBOX`, trash calls `messages.trash`). A person's own Gmail labels are OpenMail labels, linked one to one: each sync lists Gmail's labels and makes the two sides agree (a new, renamed, recoloured or deleted label on either side), and each message's Gmail labels become its email's OpenMail labels. OpenMail's 8 colours map to Gmail's label palette and back by nearest colour.
- **Sending.** `env.EMAIL` is wrapped as well. A send from a Gmail mailbox goes through Gmail's `messages.send` for the person behind the request (the Send button); with nobody behind it (background work) it is refused (`gmail_send_needs_person`). The MCP send tools refuse a Gmail mailbox before they send. The gateway's own email capability stays for native mailboxes only.
- **Drafting status.** When the sync pokes the agent for an email, `GmailSync` records `queuedAt`. A draft appearing in that thread finishes the job. The estimate is the median of the last 20 jobs, and a job older than 5 minutes counts as failed. This needs no change to the agent.

### API (port-owned routes, `workers/everyapp/gmail/routes.ts`)

| Route | Who | Answer |
| --- | --- | --- |
| `GET /api/v1/gmail/status` | any member | `{ configured, connection: { label, ready, reconnect } \| null, connectUrl }`. `connectUrl` is both Connect Gmail and Reconnect |
| `POST /api/v1/gmail/mailboxes` | any member | Creates the caller's Gmail mailbox (the address comes from the Gmail profile), then runs the first sync. `201 { id, email, settings }`, or `409` if it exists |
| `POST /api/v1/mailboxes/:id/gmail/sync` | the owner | `{ pulled, pushed, historyId, drafting: DraftJob[], background: { state: "on" \| "off" \| "pending" \| "idle", lastRunAt?, nextAt?, code?, message? }, error? }`, always 200; `error` is `{ code, message, reconnect }` |
| `GET /api/v1/mailboxes/:id/gmail/drafting` | the owner | `DraftJob[]`: `{ emailId, threadId, state: "queued" \| "done" \| "failed", queuedAt, finishedAt?, estimateMs }` |
| `GET /api/v1/mailboxes/:id/emails/:emailId/gmail-link` | the owner | `{ url }`: the draft or thread in Gmail |

A Gmail refusal answers `409 { error, message, reconnect: true, connectUrl }` when the person has to connect (or connect again), 403 for a call the Gateway or Google refuses, 503 when Gmail can't be reached at all (no gateway; under `everyapp dev`, no token), 502 otherwise. A per-mailbox route on a mailbox that isn't the caller's answers 404, on a native mailbox 400 `not_gmail`. Labels use OpenMail's own label routes (`workers/everyapp/labels.ts`), on Gmail mailboxes too.

Mailbox settings (`workers/everyapp/mailbox-settings.ts`): `ownerId`, `provider` and `replyRules`, all read and written with the existing mailbox routes.

`GET /api/v1/mailboxes` items (and MCP `list_mailboxes`) carry `settings` (at least `provider` and `ownerId`), so the home page tags Gmail inboxes and knows whether the caller has one without a detail request per mailbox. Until they do, the UI reads each mailbox's detail route instead. A sync refusal that only reconnecting fixes answers `409` with `reconnect: true` in its body.

### MCP (`workers/everyapp/tools.ts`)

- New tools: `archive_email` (write), `sync_mailbox` (write). Main's `list_labels`, `create_label` and `label_conversation` cover Gmail mailboxes too: their changes reach Gmail through the wrapped `env.MAILBOX`.
- `send_email` and `send_reply` keep `risk: "write"`. On a Gmail mailbox they throw `ToolError` ("AI clients can't send from a Gmail mailbox. Save a draft instead"), and their descriptions say so. On OpenMail's own mailboxes they send as on main.
- `list_mailboxes` lists only the caller's mailboxes, plus the shared ones.

## Google's rules

- **Scopes.** The manifest names Google's own scopes: `gmail.modify` and `gmail.send` (short for `https://www.googleapis.com/auth/<name>`). The Gateway adds the sign-in scopes for the account's name itself.
  - `gmail.modify` covers reading, drafts, labels and trash; Google classes it as **restricted**. `gmail.send` covers sending (sensitive).
  - Google's consent screen shows exactly these, and the connection is that person's, for OpenMail only. The Gateway refuses a token that holds more than the manifest lists, and puts the token only on calls to Google's hosts. It has no per-URL or per-method rules: `drafts.update` (PUT), `labels.patch` (PATCH) and `drafts.delete`/`labels.delete` (DELETE) are plain calls.
  - `gmail.modify` also lets an app send, so the Gateway can't stop OpenMail from sending. OpenMail's own code does: only a person's Send sends (`gmail_send_needs_person` otherwise), and the MCP send tools refuse a Gmail mailbox.
- **Clients.** An **Internal** OAuth client (one Workspace) needs no Google verification and admits only that Workspace's accounts. **Personal @gmail.com accounts** need it made **External**, best kept in **Testing** (up to 100 test users; Google ends a connection after 7 days, so they reconnect weekly and background sync pauses until they do). Every App's page has the steps: https://everyapp.com/docs/google-personal-accounts. The home page's Gmail card links to it.
- **Connect.** Connect Gmail and Reconnect are the same link, `connectUrl({ env, provider: "google-workspace", returnTo })`: Google's consent for the manifest's scopes, then back to OpenMail. A missing, expired or under-scoped connection answers 409 `integration_not_connected` (`reconnect: true`), and the UI shows Reconnect.

## Background sync

Connecting is all the permission OpenMail needs: the app may use a member's connection while they're away, with no second grant. Background work names whose connection it means with `for: { background: true, userId }`.

- **The alarm.** A person's successful sync arms `GmailSync`'s alarm (within 5 s the first time). The alarm reads the mailbox's settings from R2 for its `ownerId`, then runs the same `sync()` with `for: { background: true, organizationId: EVERY_APP_ORG_ID, userId: ownerId }`, and re-arms itself every 2 minutes.
- **Refusals.** A refusal only the owner can fix (any `integration_*` code, or Google's 401) turns background sync `off`, with the code, and stops the alarm. The owner's next successful sync (they reconnected) arms it again. Other failures (Gmail or the Gateway down) back off, doubling up to 30 minutes. A mailbox that is deleted, no longer Gmail or without an owner stops it.
- **Drafts.** The agent writes its draft into `MailboxDO` through the wrapped `env.MAILBOX`, which queues it in the outbox. With nobody behind the call it isn't flushed there; while background sync is `on`, the enqueue brings the alarm forward to 5 s, so the draft reaches Gmail within seconds.
- **Status.** `POST …/gmail/sync` answers `background: { state, lastRunAt, nextAt, code, message }`, the alarm's state.
- **While open** the UI still polls every 30 s and on focus, and MCP calls and chat turns sync first, as before.

Not covered: Gmail push (Pub/Sub `users.watch`) instead of the 2-minute poll. Sends in the background never happen, by design.

## Plan

| Lane | Owns | Delivers |
| --- | --- | --- |
| 0 (orchestrator) | `docs/GMAIL.md`, `workers/everyapp/gmail/client.ts`, `workers/everyapp/mailbox-settings.ts` | This spec, the Gmail REST client, the settings types |
| A: Gmail core | `workers/everyapp/gmail/*` (not `client.ts`), `workers/everyapp/gateway.ts` (`withGateway`), `everyapp.config.ts`, `cloudflare.config.ts`, the GmailSync export and route mount in `workers/app.ts` | The GmailSync DO, mime building, the sync (pull and outbox), the `MAILBOX` and `EMAIL` wrappers, the Gmail routes, the manifest's capability and DO, tests with a fake Gmail |
| B: access, MCP | `workers/everyapp/identity.ts`, `workers/everyapp/tools.ts`, `workers/everyapp/settings-routes.ts`, the mailbox list filter in `workers/index.ts`, the owner checks in `workers/app.ts` | Per-person mailboxes (routes, agent socket, MCP), the Gmail send refusal for MCP, the archive and sync MCP tools, tests |
| C: UI | `app/**` | Connect Gmail, the Gmail inbox, the sync poll, drafting status, Open in Gmail, the inbox's Gmail settings |
| D: rules (phase 2) | the agent's prompt assembly, the rule tools, the edit-to-rule loop | After A to C land |

Each lane works in its own worktree, on a branch stacked on `feat/gmail-provider`. The orchestrator merges the lanes into `feat/gmail-provider`. Nothing goes to `everyapp`.

## Local runs

Under `everyapp dev` Gmail goes straight to Google with the developer's own token: put an access token with the `gmail.modify` and `gmail.send` scopes in `.dev.vars` as `GOOGLE_WORKSPACE_ACCESS_TOKEN`. The SDK's dev twin puts it on calls to Google's hosts, in session and in the background (`for: { background: true, userId }`). No consent is simulated. `test/gmail-dev.test.ts` runs that path against the fake Gmail (no call leaves the machine): reads, drafts, `drafts.update`, `drafts.delete`, and labels for a person and in the background.

## Risks to check

- **The new OAuth model needs Every App 0.3.0-rc.11 or later** (`docs/design/2026-11-oauth-simplify.md` in private-every-app), on the Gateway and in `package.json`.
- **Existing connections are dropped** when the Gateway moves to the new model, so each person reconnects once in OpenMail.
- **Quota.** Gmail allows 250 quota units per user per second. The first pull runs a page of 50 messages per sync (6 at a time), until 200 threads or the end of the last 30 days.
- **One folder per email.** Upstream gives each email one folder; Gmail's system labels map to it, and the person's own labels are OpenMail labels.
- **Labels and the outbox.** A label change made in OpenMail while nobody is behind the call waits in the outbox for the next sync; each sync flushes before it reconciles labels, so a local change isn't undone by Gmail's older state.
