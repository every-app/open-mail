# Agentic Inbox on Every App

This fork runs [cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox) as a private app behind an [Every App](https://github.com/every-app/private-every-app) gateway. It deploys as one Worker, `every-<orgKey>-agentic-inbox`, which the gateway reaches over a service binding. The Worker has no workers.dev URL, no routes and no app secrets. The gateway signs people in, brokers the model calls (the Gateway's default model provider, which its operator picks, or a pinned OpenRouter or Workers AI), sends the mail, and serves the MCP tools.

> **Status (2026-10-24).** Deployed: the app is live at `https://agentic-inbox.everyapp.team/` with mail on `hi.openseo.so`, its senders set with `pnpm everyapp email set --sender`.

## What changes from upstream

| Concern | Upstream (Deploy to Cloudflare) | On Every App |
| --- | --- | --- |
| Sign-in, who may open it | Cloudflare Access in front of the Worker (`POLICY_AUD`, `TEAM_DOMAIN`, `jose`) | The gateway's users, organizations and per-app access. `everyApp()` checks the gateway's signed identity on every request before any app code runs |
| Who may do what | Everyone Access lets in can do everything | The organization is the boundary. Owners and admins create and delete mailboxes and edit settings, including the agent's system prompt. Members read, search, draft, reply, forward, send, move and star. There are no per-mailbox permissions |
| Workers AI | `ai` binding with `workers-ai-provider`, model `@cf/moonshotai/kimi-k2.5` | The gateway's AI proxy. By default the Gateway's default model (`ai: { chat }` in the manifest, the route `/api/ai/default/v1`): the operator's choice (`pnpm everyapp ai default <provider>`), else the first provider whose key the gateway holds (OpenRouter, Workers AI, OpenAI, Anthropic, Groq, Mistral, Gemini), with the operator's model. `AI_PROVIDER=openrouter` or `workers-ai` at build time pins that provider instead (both optional in the manifest, "Settings" under "Deploy it"). `AGENT_MODEL` picks the agent's model (default: the operator's model on the default route, `@cf/meta/llama-4-scout-17b-16e-instruct` pinned to Workers AI, `anthropic/claude-haiku-5.5` pinned to OpenRouter) |
| Sending mail | `send_email` binding, any address on `DOMAINS`, answered `202` before the send | The gateway `email` capability, from the mailbox's own address on a domain the manifest declares (`capabilities.email.senders`). The send is awaited: a refusal answers `502` with the gateway's code, and nothing is copied to Sent |
| Receiving mail | Email Routing catch-all rule "Send to a Worker", made by hand | The same `email()` handler. `everyapp deploy` creates the Email Routing catch-all (or a rule per address) naming `every-<orgKey>-agentic-inbox` from the manifest's `email.inbound`, and deletes the ones the manifest drops |
| Storage | R2 bucket `agentic-inbox`, two SQLite Durable Objects | The R2 bucket is named after the Worker and created by the deploy. The Durable Objects (`MailboxDO`, `EmailAgent`) and every R2 key are unchanged |
| MCP | The app's own `/mcp` (`EmailMCP`) behind Access | The gateway's MCP connector serves the app's `defineTools()` catalog: 13 tools, with `delete_email` hidden from AI clients. The app serves no `/mcp` of its own |
| Settings | `wrangler.jsonc` vars `DOMAINS`, `EMAIL_ADDRESSES` | `everyapp.config.ts` (the manifest: senders, inbound addresses, models) and `cloudflare.config.ts`. `DOMAINS` comes from the manifest's senders. The `EMAIL_ADDRESSES` restriction is off (`[]`) |
| Secrets on the Worker | `POLICY_AUD`, `TEAM_DOMAIN` | None |
| Toolchain | npm, wrangler, Cloudflare Vite plugin 1.x | pnpm with the Every App SDK and CLI linked from the platform checkout, `cf` 1.0.0-beta.14, Cloudflare Vite plugin 2.x, React Router 7.13.1 with a build shim |

## Two shapes

|  | An organization's own copy (supported) | Shared first party (not supported) |
| --- | --- | --- |
| Who deploys it | An owner of the gateway's Cloudflare account, with `everyapp deploy` | Every App, on a hosted gateway |
| Organizations it serves | One | Every organization on the gateway |
| `EVERY_APP_ORG_ID` | Set by the deploy. A token for any other organization gets `401` | Unset |
| Mailboxes | Durable Objects named by address and R2 keys `mailboxes/<address>.json`: the whole bucket belongs to the one organization | Would need organization-scoped names and keys, and a domain-to-organization index for inbound mail |
| Sending domains | The manifest's `senders`, one set per deploy | Per-organization domains (follow-up) |

**There is no shared deploy.** The CLI's `--shared` flag is gone, and mailboxes aren't scoped by organization: in a shared Worker, every organization's members would see every mailbox. Nothing in the port rules the shared shape out; it needs the scoping above first (see `TODO.md`).

## How it works

- **Identity** (`workers/app.ts`, `workers/everyapp/identity.ts`). The gateway signs a 120-second RS256 token onto every request it forwards (`x-everyapp-identity`; audience `EVERYAPP_AUDIENCE`, the Worker's own name). `everyApp()` from `@every-app/sdk/server` checks it before Hono runs. Without a valid token the answer is `401`; without the gateway's key set, it is `500`. `requireOrganization` refuses a token from another organization when `EVERY_APP_ORG_ID` is set. Roles come from the token's `org_role` on every request, and nothing about members is stored. `GET /api/v1/me` returns `{ id, email, orgId, role, gatewayUrl }`. "Sign out" opens the gateway, which owns sign-out. The app sets no cookies, and the gateway strips inbound `Cookie` and `Authorization` headers.
- **Agent sockets** (`/agents/*`). partyserver makes every Durable Object binding addressable by URL. The guard (`agentGuard`) lets only the chat agent of a mailbox that exists through, compared by binding name (`EMAIL_AGENT`): `/agents/mailbox/*` answers `404`, a name that is no binding `400`, and the agent's internal `/onNewEmail` `404`. Each agent socket closes 15 minutes after it connects. The client reconnects through the gateway, which signs a fresh identity or refuses someone it no longer lets in.
- **AI** (`workers/everyapp/gateway.ts`). `withGateway(env, request)` hands upstream's code an env with `AI` and `EMAIL` in it, both brokered by the gateway. `env.AI.run()` is a shim over the gateway's OpenAI-compatible chat completions: the Gateway's default model (`/api/ai/default/v1/chat/completions`) unless the Worker was built with a pin (`/api/ai/openrouter/api/v1/...` with `AI_PROVIDER=openrouter`, `/api/ai/workers-ai/v1/...` with `AI_PROVIDER=workers-ai`). The shim sends `messages`, `max_tokens` and `temperature` only, never `stream_options`. It is used by the prompt-injection scanner and the draft verifier. Upstream names Workers AI models for them (`@cf/meta/llama-3.1-8b-instruct-fast` and `@cf/meta/llama-4-scout-17b-16e-instruct`); `mapModel()` sends `default` for any `@cf/` id on the default route (the Gateway fills in the operator's model; any other id goes as it is), and OpenRouter's ids for them when pinned to OpenRouter. When no model is set up on the gateway (`503 ai_default_not_configured` on the default route, `503 ai_provider_not_configured` on a pin), the shim and the agent's stream both turn the refusal into one sentence a person can act on. On the default route it is "AI isn't set up on this gateway yet. An admin sets one model provider's key (OpenRouter first): `pnpm everyapp secret set OPENROUTER_API_KEY`, or picks one with `pnpm everyapp ai default <provider>`."; on a pin it names that provider's key ("… An admin sets WORKERS_AI_API_TOKEN with `pnpm everyapp secret set WORKERS_AI_API_TOKEN`."). It is shown as the reason an auto-draft was skipped ("No draft for this email: …") and, in the chat, after what the agent can't do ("AI isn't set up on this gateway yet, so I can't help with this inbox. …"). Pinning or unpinning is a redeploy with `AI_PROVIDER` (see "Redeploying"), the operator's business, not the sentence's. The agent streams through `@ai-sdk/openai-compatible` over the same gateway fetch. Calls made while serving a request carry that person's identity; the agent's own Durable Object calls are the organization's. The manifest's `ai.models` lists the models a pinned Worker may ask for; the default route doesn't read it (the operator chose the model). `AI_PROVIDER` and `AGENT_MODEL` are plain text vars, read when the Worker is built.
- **Sending mail** (the `gatewayEmail` adapter in `workers/everyapp/email.ts`, `workers/index.ts`, `workers/routes/reply-forward.ts`). `sendEmail(env.EMAIL, …)` in upstream's `workers/email-sender.ts` reaches the SDK's `sendEmail()` and the gateway's `email` capability (#325): `POST /api/integrations/email/send` over the service binding, attributed to the person who sent it. The gateway sends only `from` addresses that match the manifest's `senders`, and counts each send against its mail budget. Inline images go as inline attachments with their content id. The send routes await it. A refusal answers `502 { error: <code>, message }` and writes no Sent copy. Upstream's per-mailbox limits (20 an hour, 100 a day) and its sender check still run first. `GET /api/v1/config` returns `{ domains, emailAddresses, ready }`: `domains` are the domains of `senders`, and `ready` is the gateway's email status (ready, and accepting at least one of the app's senders). The home page shows "No mail domain yet" while `domains` is empty, and "Sending is off until an owner or admin finishes email setup" while `ready` is false (owners and admins read "Sending is off until the gateway's email sender is set", with the command to run); the composer repeats it above the To field.
- **Receiving mail** (the `email()` export in `workers/app.ts`, `receiveEmail()` in `workers/index.ts`, byte-identical to upstream). An Email Routing rule hands the message to the Worker. The Worker parses it, drops it if no mailbox exists for the recipient (no `mailboxes/<address>.json`), stores attachments under `attachments/<emailId>/<attachmentId>/<file>`, threads it by `In-Reply-To`/`References` (or by subject), writes it to the mailbox's Durable Object, and pokes that mailbox's agent to draft a reply. The `email()` wrapper names the agent on that poke (`withNamedAgents()` in `workers/everyapp/inbound.ts`), because partyserver refuses a request to an agent that was never addressed by name; without it, a mailbox whose chat panel was never opened got no auto-draft. The deploy refuses the `email` trigger as a Worker setting; instead `everyapp deploy` creates Email Routing rules that name the Worker, from the manifest's `email.inbound` (`*@<domain>` is the zone's catch-all, which exists only on a zone's apex; any other address gets a rule of its own), records them, and deletes the ones the manifest drops.
- **Storage.** `MailboxDO` (one per address: folders, emails, threads, send counters, in SQLite) and `EmailAgent` (one per address: the chat agent and its history). R2 holds mailbox settings (`mailboxes/<address>.json`) and attachments, in the bucket named after the Worker.
- **MCP** (`workers/everyapp/tools.ts`). The 13 tools of upstream's MCP server, each with a risk, as a `defineTools()` catalog. The gateway snapshots the catalog at deploy and serves it from its `/mcp` to personal access tokens and OAuth clients. Reads are `read`, drafts and sends are `write`, and `delete_email` is `destructive` (hidden from AI clients until the gateway has approvals). Tool calls run with the caller's identity, so their model calls and sends are attributed to them.
- **Inline images.** The message view renders mail in a sandboxed `srcdoc` iframe whose requests carry no gateway session. The parent fetches inline attachments itself and swaps `cid:` references for `data:` URLs (2 MiB each at most).
- **Build** (`vite.config.ts`, `cloudflare.config.ts`, `everyapp.config.ts`). `cf build` with the Cloudflare Vite plugin 2.x builds React Router's client and the Worker. `reactRouterBuildOutputShim` copies React Router's client manifest to where its SSR build looks for it, because the plugin writes the client build into the Build Output; drop it once React Router reads the client environment's output directory. `everyAppWorker()` turns the manifest into the Worker definition (Durable Objects, the gateway binding, the identity settings), and `cloudflare.config.ts` adds the bucket and the text vars. It hands `everyAppWorker()` the entry as a `cf-worker` module import, so `cf workers types` types `env.MAILBOX` and `env.EMAIL_AGENT` with their classes. There is no `wrangler.jsonc`.
- **Upstream merges.** Most of upstream's code is untouched, so `git merge upstream/main` stays cheap. Files the port keeps byte-identical: `workers/lib/{tools,email-helpers,attachments,mailbox,schemas}.ts`, `workers/durableObject/*`, `workers/db/*`, `shared/*`, `react-router.config.ts`, `workers/email-sender.ts`, `receiveEmail` in `workers/index.ts`, and everything under `app/` except fourteen files: `app/lib/utils.ts`, `app/services/api.ts`, `app/root.tsx`, `app/routes/{home,mailbox,email-list,settings,not-found}.tsx`, `app/hooks/useComposeForm.ts`, `app/components/{MCPPanel,AgentPanel,ComposePanel}.tsx` and `app/components/email-panel/{SingleMessageView,ThreadMessage}.tsx` (`app/components/SendingOffBanner.tsx` is the port's own). `workers/lib/ai.ts` differs by one deleted `@ts-expect-error` line. Upstream files the port edits: `workers/app.ts` (the entry), `workers/types.ts`, `workers/agent/index.ts` (the model and the socket lifetime), `workers/index.ts` (the config and send routes), `workers/routes/reply-forward.ts` (awaited sends); `workers/mcp/index.ts` is deleted. The Every App code lives in `workers/everyapp/` (`gateway.ts`, `agent-ai.ts`, `email.ts`, `inbound.ts`, `identity.ts`, `tools.ts`). Check with `git diff --stat upstream/main -- workers app shared`; "Verified locally" shows a synthetic upstream change to `lib/tools.ts` and `receiveEmail` merging cleanly.

## Run it locally

You need Node 22+ and pnpm 10. The Every App SDK and CLI it builds with are the published packages `@every-app/sdk` and `everyapp`, pinned to one exact version in `package.json`, so a clone of this repository installs and builds on its own: no checkout of the Every App repository beside it.

```bash
pnpm install
cp .dev.vars.example .dev.vars    # optional: AI keys, a real mail transport
pnpm everyapp dev                 # or: pnpm everyapp dev --port 8801
```

`everyapp dev` runs the app under `cf dev` on an internal port and puts a gateway-lite in front of it on `http://agentic-inbox.localhost:8787` (or the port you pass). The gateway-lite applies the real perimeter: the header strip and inject, the same-origin check on state-changing requests, the security headers, and an RS256 identity signed with the SDK's dev key. You are its seeded owner, `dev@everyapp.localhost` in `dev-org`. Its `/mcp` serves the app's MCP tools; send any `Authorization: Bearer` value. If `*.localhost` resolves to `::1` on your machine, use `curl --resolve agentic-inbox.localhost:8787:127.0.0.1`, as `scripts/dev-probe.sh` does.

- **AI.** There is no gateway locally, so the SDK calls a provider directly with your key from `.dev.vars`, billed to you. On the default route it resolves the default on `.dev.vars` in the Gateway's order: set `OPENROUTER_API_KEY` (a key from https://openrouter.ai/settings/keys), or `WORKERS_AI_API_TOKEN` (an API token from the "Workers AI" template: Workers AI Read and Edit) with `CLOUDFLARE_ACCOUNT_ID`, or another provider's key. That needs `everyapp` and `@every-app/sdk` 0.3.0-rc.2 or later: 0.3.0-rc.1 refuses the manifest's `ai.chat` (`ai: Unrecognized key: "chat"`) and its local fallback doesn't serve `/api/ai/default`; on rc.1 the way to call a model in development is a pin, `AI_PROVIDER=openrouter pnpm everyapp dev` (or `AI_PROVIDER=workers-ai`) with that provider's key in `.dev.vars`. A pin works the same on rc.2. Without keys, the chat and the auto-draft show "AI isn't set up" instead of failing the request.
- **Sending.** The SDK checks each send as the gateway would (the mailbox's address must match the manifest's `senders`), then prints it (`[everyapp dev] email to 1 recipient subject "…"`) unless `EMAIL_REST_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `EMAIL_FROM` are set in `.dev.vars` (the Email Sending REST API, on your account). `GET /api/v1/config` says `ready: false`, and the home page shows "Sending is off until the gateway's email sender is set" (the dev login is an owner), until `EMAIL_FROM` is set.
- **Receiving.** `bash scripts/dev-inbound.sh <vite port> [gateway port] [to address]` posts `test/fixtures/inbound.eml` to the app's internal Vite port at `/cdn-cgi/local/email?from=…&to=…` (`everyapp dev` prints that port, and an `Email:` line with the same endpoint, since the manifest declares `email.inbound`). With the gateway port it creates the mailbox (default `dev@example.com`) first and checks its Inbox afterwards; mail to an address with no mailbox is dropped, as in production.
- **Probes.** `bash scripts/verify-local.sh <gateway port> <vite port> [dev server log]` is the whole local end-to-end check (the transcript is under "Verified locally"). Its parts: `bash scripts/dev-probe.sh <gateway port> <vite port>` checks the SSR page and the perimeter's headers, `/api/v1/config`, creating a mailbox, the agent socket, the refused sockets, and that a direct hit on the Vite port (no identity) answers `401`; `node scripts/ws-probe.mjs <ws url> [host] [origin]` opens one agent socket; `node scripts/chat-probe.mjs <ws url> <host> <origin> "<message>"` sends one chat turn; `node scripts/mint-dev-identity.mjs <owner|admin|member> [org]` mints a dev identity for requests straight to the Vite port as someone other than the seeded owner.
- **Direct `cf dev`** (`pnpm dev:vite`) runs the Worker without the gateway-lite. Every request then gets `401`, because nothing signs an identity.

### Tests and checks

| Command | What it runs |
| --- | --- |
| `pnpm test` | Vitest, two projects (`vitest.config.ts`). `node`: unit tests with fake bindings (the gateway shims, identity, the tool catalog, frontend helpers). `workers`: tests inside workerd through `@cloudflare/vitest-pool-workers`. The production entry is the Worker there, against the real Durable Objects and a local R2 bucket (inbound mail through `receiveEmail()`, the entry's identity check). A file runs in `workers` when it is named `*.workers.test.ts` (or `test/receive-email.test.ts`). The workers project shares storage between tests, so use a fresh mailbox address in each |
| `pnpm types:check` | `cf workers types` (the Worker's `Env` from `cloudflare.config.ts`), `react-router typegen`, `tsc --noEmit` |
| `pnpm build` | A development build of the client and the Worker, then `tsc` |
| `pnpm check:deploy` | What `everyapp deploy` checks before it uploads, offline, through the installed CLI's `everyapp release --json` (logins hidden; you set nothing): the manifest against the CLI's strict schema (and that it declares `email.inbound`), a production `cf build` for the build's placeholder Worker (`every-hosted--sentinel`, which a deploy replaces), the CLI's Build Output policy, and the built Worker's bindings (no `ai`, no `send_email`, no triggers, the bucket and audience named after the Worker, `AI_PROVIDER` at its build default, empty), and that the manifest asks for `ai.chat` |
| `pnpm check:runbook` | Every setting this runbook tells you to set with `everyapp secret set` is a Gateway setting the command accepts, by the SDK's own list, and none would be taken for an app secret (offline) |

**CI.** The venue has no CI. Its `link:` dependencies need the platform checkout beside it, so a hosted runner can't install it as is. When the SDK and CLI are published again, switch the links to versions and run the commands above in CI.

## Verified locally

The plan's §5.3 checklist, run end to end on 2026-10-17 by the integration lane (L7) on macOS with Node 24.20 and pnpm 10.34, the venue at the commit that added this section and the platform checkout at `fc2d59d2` (`main`, with #322 to #328). No Cloudflare account was involved: every command ran with `XDG_CONFIG_HOME=<empty directory> CI=1`, so `cf` had no login, and there was no `.dev.vars`, so no AI or mail provider was called.

**1. Types and tests.** `pnpm types:check` (`cf workers types && react-router typegen && tsc --noEmit`): 0 errors. `pnpm test`: 13 files, 144 tests, all passing:

```
 ✓ |node| test/manifest-mail.test.ts (2 tests)
 ✓ |node| test/api-client.test.ts (8 tests)
 ✓ |node| test/inline-images.test.ts (10 tests)
 ✓ |node| test/model-ids.test.ts (9 tests)
 ✓ |node| test/with-gateway.test.ts (7 tests)
 ✓ |node| test/gateway-email.test.ts (23 tests)
 ✓ |node| test/gateway-ai.test.ts (20 tests)
 ✓ |node| test/identity.test.ts (18 tests)
 ✓ |node| test/tools.test.ts (14 tests)
 ✓ |workers| test/tools.workers.test.ts (11 tests)
 ✓ |workers| test/send-routes.workers.test.ts (14 tests)
 ✓ |workers| test/entry.workers.test.ts (2 tests)
 ✓ |workers| test/receive-email.test.ts (6 tests)
 Test Files  13 passed (13)
      Tests  144 passed (144)
```

**2. The dev loop.** `pnpm everyapp dev --port 8808 > dev.log 2>&1` (it printed the app's internal Vite port, 56602, and an `Email:` line for `email.inbound`), then `bash scripts/verify-local.sh 8808 56602 dev.log`:

```
######## scripts/dev-probe.sh
== GET / (SSR through the gateway-lite)
ok   GET / -> 200 <title>Agentic Inbox</title>
ok   perimeter header content-security-policy: frame-ancestors 'none'; base-uri 'self'; object-src 'none'
ok   perimeter header x-frame-options: DENY
ok   perimeter header x-content-type-options: nosniff
ok   perimeter header referrer-policy: strict-origin-when-cross-origin
ok   perimeter header strict-transport-security: max-age=63072000; includeSubDomains; preload
== GET /favicon.svg (static asset)
ok   GET /favicon.svg -> 200 image/svg+xml
== GET /api/v1/config
ok   config -> {"domains":["example.com"],"emailAddresses":[],"ready":false}
== Set-Cookie: the app sets none
ok   GET / sets no cookie
== POST /api/v1/mailboxes (probe-1792248156@example.com, with Origin)
ok   create mailbox -> 201 {"id":"probe-1792248156@example.com","email":"probe-1792248156@example.com","name":"Probe","settings":{"fromName":"Probe
ok   six folders: archive,draft,inbox,sent,spam,trash
ok   GET /api/v1/mailboxes lists it
== POST without Origin (cookieless, no same-origin signal) is anonymous
ok   POST without Origin -> 401
== WebSocket /agents/email-agent/probe-1792248156@example.com
ok   email-agent socket: upgrade 101, "type":"cf_agent_identity"
== WebSocket /agents/mailbox/probe-1792248156@example.com (must be refused)
ok   mailbox socket refused: refused (no upgrade)
== HTTP /agents/mailbox/probe-1792248156@example.com and /agents/email-mcp/x (must be refused)
ok   GET /agents/mailbox/... -> 404
ok   GET /agents/email-mcp/x -> 400 (no such binding)
== direct hit on the app's Vite port 56602 (bypassing the gateway)
ok   direct hit -> 401 {"error":"unauthenticated","message":"request reached the app without an identity token (not proxied through the gateway?)"}

dev-probe OK
ok   dev-probe.sh
######## who am I, and the app's mail settings
ok   GET /api/v1/me -> {"id":"dev-user","email":"dev@everyapp.localhost","orgId":"dev-org","role":"owner","gatewayUrl":"https://gateway.dev.localhost"}
ok   GET /api/v1/config -> {"domains":["example.com"],"emailAddresses":[],"ready":false}
######## mailboxes: the owner creates dev@example.com, a member may not
ok   owner POST /api/v1/mailboxes dev@example.com -> 409
ok   GET /api/v1/mailboxes lists dev@example.com
ok   member (minted dev identity, app port) POST /api/v1/mailboxes -> {"error":"forbidden","code":"admin_required","message":"Only owners and admins of the organization can manage mailboxes."} 403
ok   member GET .../dev@example.com/folders -> 200
     (another organization's owner, unpinned dev copy: GET /api/v1/mailboxes -> 200; a deployed copy is pinned to EVERY_APP_ORG_ID and answers 401)
######## sending: through the gateway email adapter (the SDK prints it under everyapp dev)
ok   POST .../dev@example.com/emails -> 200 {"id":"24ebeeb3-62fb-4114-b4f4-50792dddcc0f","status":"sent"}
ok   Sent lists "verify-local send 1792248153"
ok   dev log: [everyapp dev] email to 1 recipient subject "verify-local send 1792248153" (not sent: set EMAIL_REST_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and EMAIL_FROM in .dev.vars to send)
ok   a sender outside capabilities.email.senders -> 502 {"error":"email_sender_not_allowed","message":"This app may not send as refused-1792248153@other.example: list it, or *@other.example, in capabilities.email.senders in everyapp.config.ts."}
ok   no Sent copy of the refused mail
######## receiving: test/fixtures/inbound.eml through email() on the Vite port
ok   mailbox dev@example.com exists
ok   delivered inbound-1792248164-18076@example.org from alice@example.org to dev@example.com -> 200 Worker successfully processed email
ok   the Inbox of dev@example.com lists it (email 40e48364-e021-4869-a99c-7180b144f3ed)
ok   inbound mail filed in the Inbox
ok   auto-draft for 40e48364-e021-4869-a99c-7180b144f3ed: Skipping auto-draft for 40e48364-e021-4869-a99c-7180b144f3ed: AI isn't set up on this gateway (WORKERS_AI_API_TOKEN) or in .dev.vars (WORKERS_AI_API_TOKEN and CLOUDFLARE_ACCOUNT_ID).
     Drafts of dev@example.com: (none)
######## the agent: socket, one chat turn, the refused objects
ok   ws /agents/email-agent/dev@example.com -> upgrade 101 + cf_agent_identity
ok   ws /agents/mailbox/dev@example.com refused
ok   GET /agents/mailbox/dev@example.com -> 404
     chat: {   "reply": "⚠️ AI isn't set up on this gateway (WORKERS_AI_API_TOKEN) or in .dev.vars (WORKERS_AI_API_TOKEN and CLOUDFLARE_ACCOUNT_ID).",   "tools": [],   "error": null } 
ok   a chat turn finished without a stream error
######## MCP: the gateway-lite's /mcp serves the app's defineTools() catalog
ok   initialize -> every-app-agentic-inbox, protocol 2025-06-18
ok   tools/list -> 12 tools, no delete_email: create_draft,draft_reply,get_email,get_thread,list_emails,list_mailboxes,mark_email_read,move_email,search_emails,send_email,send_reply,update_draft
ok   tools/call list_mailboxes -> includes dev@example.com
ok   tools/call delete_email -> refused: Unknown tool: delete_email
######## the perimeter
ok   direct hit on the Vite port GET /api/v1/me -> 401 {"error":"unauthenticated","message":"request reached the app without an identity token (not proxied through the gateway

verify-local OK
```

The same server in headless Chromium (a Playwright probe outside the repository), with no mocked routes: the home page shows the owner "New mailbox", a "‹ Every App" row above the title linking to `https://gateway.dev.localhost`, the "Email sending isn't set up on this gateway" banner (`ready: false`) and a delete control per mailbox; an inbound `multipart/related` mail with a `cid:` image renders in the sandboxed message iframe as a `data:image/png;base64,…` URL that the page (never the iframe) fetched; the agent panel connects over `ws://` and a chat turn answers "⚠️ AI isn't set up on this gateway (WORKERS_AI_API_TOKEN) …"; the MCP panel shows `https://gateway.dev.localhost/mcp` and `http://agentic-inbox.localhost:8808/mcp` and lists the catalog's tools without `delete_email`; no page errors once Vite had optimised its dependencies.

**The agent with a model.** No provider key existed on the porting machine, so the model calls went to a local mock playing the gateway's AI proxy (an OpenAI-compatible responder), wired in by a temporary change to `withGateway()` that gave the dev env an `EVERY_APP_GATEWAY` forwarding to it; the change was reverted and never committed. With `AI_PROVIDER=openrouter pnpm everyapp dev --port 8808`, everything else real (the Worker, the `EmailAgent` and `MailboxDO` Durable Objects, the SDK's binding path, `streamText`/`generateText`, upstream's tools):

```
== inbound to a mailbox nobody has opened (ai-1792247210@example.com): the auto-draft
ok   delivered inbound-1792247210-7312@example.org from alice@example.org to ai-1792247210@example.com -> 200 Worker successfully processed email
ok   the Inbox of ai-1792247210@example.com lists it (email c2db9211-89f1-4571-b20b-a0dd93aacaa5)
Drafts after the auto-draft: 1 draft(s): Re: Lunch on Friday? [in_reply_to c2db9211-…] to alice@example.org
== chat turn over the agent socket (scripts/chat-probe.mjs)
"reply": "I drafted a reply to Alice accepting Friday at 12:30; it is in Drafts."
"tools": draft_reply { originalEmailId: c2db9211-…, to: alice@example.org } -> { status: "draft_saved", draftId: 54d814f7-… }
Drafts after the chat turn: 2 draft(s)
the mock's log, one line per model call:
  /api/ai/openrouter/api/v1/chat/completions meta-llama/llama-3.1-8b-instruct stream=false (the injection scanner)
  /api/ai/openrouter/api/v1/chat/completions anthropic/claude-haiku-5.5 stream=false (auto-draft: tool call, answer)
  /api/ai/openrouter/api/v1/chat/completions meta-llama/llama-4-scout stream=false (draft_reply's verifier, in both turns)
  /api/ai/openrouter/api/v1/chat/completions anthropic/claude-haiku-5.5 stream=true  (chat: tool call, answer)
  no call carried an authorization header
```

Workers AI's own streaming with tool calls is proven only by the live captures replayed through the gateway's real AI proxy (port lane L1); it is on the first-live-deploy list.

**3. The offline deploy check.** `pnpm check:deploy` (recorded before the app took the Gateway's default model; the check now asserts that `AI_PROVIDER` defaults to empty and that the manifest asks for `ai.chat`, which needs the 0.3.0-rc.2 CLI):

```
$ everyapp release
  app.install: ok
  app.build: Built the app and checked its Build Output.
  app.release: Packed agentic-inbox 0.1.0 (a29e694602fa) into …/everyapp-release.tar.gz.
ok   cf build completes and the deploy policy accepts the Build Output (app.build ok)
ok   no D1 migrations, or they match the schema (app.schema ok)
ok   the release is packed (done with version and sha256)
ok   no warnings from the release
ok   Build Output is a production build
ok   manifest validates strictly (id agentic-inbox)
ok   email.inbound declares the Worker's email handler
ok   worker name is the build placeholder every-hosted--sentinel
ok   exports are the manifest's Durable Objects (MailboxDO, EmailAgent)
ok   every export is a SQLite Durable Object
ok   BUCKET is the R2 bucket named after the Worker
ok   EVERYAPP_AUDIENCE is the Worker's name
ok   no triggers
ok   no AI or send-email binding
ok   compatibilityFlags has nodejs_compat
ok   EMAIL_ADDRESSES is []
ok   AI_PROVIDER defaults to workers-ai
ok   the only secrets are the platform's (GATEWAY_URL, EVERY_APP_ORG_ID)
check:deploy OK: the production Build Output passes the deploy policy offline.
```

**4. Bundle and startup.** The production `cf build`: 5.13 MiB of JavaScript (the Worker entry 2.26 MiB, React Router's server build 2.17 MiB; 491 KB gzipped for the entry) plus 10.36 MiB of source maps, far under the 64 MiB limit. `wrangler check startup` on that bundle (a throwaway `wrangler.jsonc` outside the repository, wrangler 4.151.0, login hidden): `Bundle: 5898.04 KiB / gzip: 1185.68 KiB`, `Active: 40.5 ms (including 3.0 ms garbage collection)` against the 1 s limit. Nothing is created at module scope but Hono routers, React Router's request handler (its build is imported lazily) and two `WeakMap`s.

**5. Upstream merges.** `git diff --stat upstream/main -- workers app shared` lists only the files under "How it works → Upstream merges" (21 files: 7 under `app/`, `workers/lib/ai.ts | 1 -`, the Every App files and the five edited upstream files, `workers/mcp/index.ts` deleted); the byte-identical set is empty in `git diff --stat upstream/main -- workers/lib/{tools,email-helpers,attachments,mailbox,schemas}.ts workers/durableObject workers/db shared react-router.config.ts workers/email-sender.ts`, and `receiveEmail` is identical to upstream's. A synthetic upstream commit changing `workers/lib/tools.ts` (a header comment, a doc comment and a line in `toolListMailboxes`) and `receiveEmail`'s size limit in `workers/index.ts`, merged into the port with `git merge --no-commit --no-ff`: "Automatic merge went well", 0 conflicts. `git grep -i "set-cookie\|document.cookie" workers app` finds nothing.

## Deploy it

### Settings

What the manifest (`everyapp.config.ts`) declares the app needs, all held by the Gateway Worker; the app's own Worker has no secrets. The gateway doesn't open the app until the **required** ones are set: the launcher card says "Needs setup" (its dialog shows these commands), and `pnpm everyapp status` lists each setting under SETTINGS. `pnpm everyapp secret set <name>` sets one from the platform checkout or from this directory (the CLI routes Gateway settings by name; a hidden prompt asks for the value).

| Setting | Declared as | Need | Why | Command |
| --- | --- | --- | --- | --- |
| A model provider's key (`OPENROUTER_API_KEY` first) | `ai.chat`, the Gateway's default model | **required** | The inbox agent's model, with the prompt-injection scanner and the draft verifier. Any one provider's key opens the app; the setup asks for OpenRouter's first | `pnpm everyapp secret set OPENROUTER_API_KEY` (a key from https://openrouter.ai/settings/keys), or another provider's key; `pnpm everyapp ai default <provider>` picks one |
| `EMAIL_FROM` (`EMAIL_FROM_NAME` optional) | capability `email` | **required** | Sends mail from the organization's mailboxes on its own domain; the gateway sends nothing without its own sender (step 7) | `pnpm everyapp secret set EMAIL_FROM EMAIL_FROM_NAME` |
| `OPENROUTER_API_KEY` | provider `openrouter` | optional | Only for a Worker built with `AI_PROVIDER=openrouter` (a pin). The same key also serves the default | `pnpm everyapp secret set OPENROUTER_API_KEY` |
| `WORKERS_AI_API_TOKEN` | provider `workers-ai` | optional | Only for a Worker built with `AI_PROVIDER=workers-ai` (a pin); it is also the default's second choice when no OpenRouter key is set. A pinned Worker without it opens, but the chat and the auto-draft say "AI isn't set up on this gateway yet. An admin sets WORKERS_AI_API_TOKEN with `pnpm everyapp secret set WORKERS_AI_API_TOKEN`." | `pnpm everyapp secret set WORKERS_AI_API_TOKEN` |

The Worker picks between the default and a pin when it is built (`AI_PROVIDER`); the default itself is the gateway's to resolve on every call, so changing the default provider or model (`pnpm everyapp ai default <provider>[/<model>]`, `pnpm everyapp ai show`) needs no redeploy.

### Steps

These steps assume a gateway installed with `pnpm everyapp setup` from the platform checkout (`~/workspaces/private-every-app`, or wherever yours is). Run `pnpm everyapp …` gateway commands from that checkout, and app commands and `pnpm exec cf …` from this directory (it has `cf`; the platform checkout's root doesn't). The account must be on **Workers Paid**: Every App needs it (`everyapp setup` checks), and so do Email Sending to arbitrary recipients and Email Routing to Workers. The steps are in order. The codes in capitals are the CLI's: `--json` prints them in its events, and a terminal shows the sentence that goes with them.

| # | Where | What | Command / step | Needs |
| --- | --- | --- | --- | --- |
| 0 | the platform checkout | Upgrade the live gateway to the checkout's release. Every platform change the port needs (#322 to #330) is on `main`: #322, #325 and #329 change the gateway, #327 and #330 the CLI, which runs from the checkout. While the gateway runs an older release, `pnpm everyapp status` says so under "To do" and names the command. This app's first deploy would upgrade it too (step 10), but do it first: the settings below are for the new release. The upgrade keeps the gateway's database (migrations run first, with a restore point), its users, apps and secrets | `git pull --ff-only`, `pnpm install` (it builds the SDK), then `pnpm everyapp update`. It prints `Upgrading the Gateway to …` and `The Gateway (…) is live at https://<gateway domain>` | #322, #325, #329 |
| 1 | Cloudflare account | Workers Paid | Dashboard → Workers & Pages → Plans | |
| 2 | OpenRouter | An API key for the gateway: the first provider the Gateway's default resolves to (any provider in the order will do) | https://openrouter.ai/settings/keys | |
| 3 | gateway | A chat model, **required** by the manifest's `ai.chat`: until one model provider's key is set the gateway doesn't open the app (the launcher card says "Needs setup" with this command, and `pnpm everyapp status` lists it under SETTINGS as `! not set`). `pnpm everyapp ai show` says what the default resolves to | `pnpm everyapp secret set OPENROUTER_API_KEY` (a hidden prompt asks for the value); optionally `pnpm everyapp ai default <provider>[/<model>]` | |
| 4 | Cloudflare account (optional) | For Workers AI, the default's second choice or a pin: an API token with **Workers AI Read and Edit** for the gateway's account. `CLOUDFLARE_ACCOUNT_ID`, the account it bills, needs nothing: `everyapp setup` set it when it installed the gateway | Dashboard → My Profile → API Tokens → Create Token → "Workers AI" template | |
| 5 | gateway (optional) | `WORKERS_AI_API_TOKEN`, optional in the manifest: the default model when no OpenRouter key is set, or for a Worker built with `AI_PROVIDER=workers-ai` (step 10). A pinned Worker without the token opens, but the gateway refuses its model calls with `503 ai_provider_not_configured`: the chat answers "AI isn't set up on this gateway yet, so I can't help with this inbox. An admin sets WORKERS_AI_API_TOKEN with `pnpm everyapp secret set WORKERS_AI_API_TOKEN`.", and inbound mail gets no draft (the agent's chat says "No draft for this email: AI isn't set up on this gateway yet. An admin sets …", and the Worker logs it) | `pnpm everyapp secret set WORKERS_AI_API_TOKEN` | #322 |
| 6 | Cloudflare zone (on Cloudflare DNS, in the gateway's account) | Onboard each mail domain to the gateway's **email provider**. With Cloudflare Email Sending (the default) this adds the `cf-bounce` MX, SPF, DKIM and DMARC records; new accounts start with a low daily quota. With Resend (step 12) verify the domain in Resend instead | `pnpm exec cf email-sending subdomains create -z example.com --name example.com`, or Dashboard → Compute & AI → Email Service → Email Sending → Onboard Domain. Details: `docs/runbooks/email-sending-setup.md` in the platform checkout ("Choosing a provider", "Resend") | #325, #329 |
| 7 | gateway | The gateway's sender, needed whichever provider sends: `EMAIL_FROM` (an address on a domain from step 6, `noreply@example.com`), **required** by the manifest's `email` capability, and `EMAIL_FROM_NAME` (`Every App`), optional. Mailboxes still send as themselves, but without a sender the gateway sends nothing, so it doesn't open the app until `EMAIL_FROM` is set ("Needs setup" on the launcher). Skip it if `pnpm everyapp secret list` shows it set | `pnpm everyapp secret set EMAIL_FROM EMAIL_FROM_NAME` | #325 |
| 8 | Cloudflare zone | Choose a mail domain on Cloudflare DNS in the gateway's account. Email Routing adds and locks its MX and SPF records | `everyapp email set --inbound` offers to enable routing; add `--enable-email-routing` when running unattended | #327 |
| 9 | this directory | Check the manifest and production build offline. The manifest declares `capabilities.email` and `email: { inbound: true }`; addresses belong to the installation | `pnpm check:deploy` | #325, #327 |
| 10 | this directory | Deploy, then configure the installation's senders and inbound addresses. Mailbox domains are read from the gateway's configured senders | `pnpm everyapp deploy`, then `pnpm everyapp email set --sender '*@example.com' --inbound '*@example.com'` (replace with your domain; a catch-all requires a zone apex). Use `pnpm everyapp email show` to inspect them | #327 |
| 11 | Cloudflare zone | Check the inbound routes. A rule you made by hand that already sends to the Worker is adopted and renamed `everyapp:every-<orgKey>-agentic-inbox` | `pnpm everyapp status` prints `Email:    agentic-inbox: *@<domain>`. If a rule is gone, off or sends elsewhere, its "To do" says `Mail for agentic-inbox doesn't reach it: *@<domain> (…). Run: pnpm everyapp deploy (in agentic-inbox's directory)` (code `EMAIL_ROUTE_MISSING` with `--json`) | #327 |
| 12 | gateway (optional) | Resend instead of Cloudflare Email Sending: a deployed gateway with `RESEND_API_KEY` sends all its mail through Resend, its own included; `EMAIL_PROVIDER` (`resend` or `cloudflare`, asked at the hidden prompt) pins the choice. Or the Email Sending REST API instead of the gateway's `EMAIL` binding (Docker gateways) | `pnpm everyapp secret set RESEND_API_KEY`, `pnpm everyapp secret set EMAIL_PROVIDER`, or `pnpm everyapp secret set EMAIL_REST_API_TOKEN` | #325, #329 |
| 13 | this directory | App secrets | **None** | |

Then open `https://agentic-inbox.<gateway domain>/` as an owner or admin and create a mailbox on one of the domains. Send a mail to it from outside and watch the inbox, then Drafts, where the agent's reply appears.

**Models.** On the default route the scanner, the verifier and the agent send `default`: the operator's model (each provider's own default, OpenRouter's `anthropic/claude-haiku-5.5`, unless `pnpm everyapp ai default <provider>/<model>` names one). `AGENT_MODEL=<id> pnpm everyapp deploy` sends that id for the agent as it is (the default provider must serve it; a Workers AI `@cf/` id becomes `default`). Pinned to OpenRouter the agent uses `anthropic/claude-haiku-5.5`: Llama 4 Scout often wrote its `draft_reply` call out as text, and that text became the draft. The scanner and verifier use `meta-llama/llama-3.1-8b-instruct` and `meta-llama/llama-4-scout`; `AGENT_MODEL=moonshotai/kimi-k2.6` switches the agent's model. Pinned to Workers AI, the scanner, verifier and agent use the Workers AI models (`@cf/meta/llama-3.1-8b-instruct-fast`, `@cf/meta/llama-4-scout-17b-16e-instruct`; `AGENT_MODEL=@cf/moonshotai/kimi-k2.6` for Kimi). Kimi K2.6 on Workers AI (what upstream's deprecated `kimi-k2.5` now aliases to) is paid-only and allows 20 requests a minute per account, shared by every organization on the gateway.

**Redeploying.** Run `pnpm everyapp deploy` again; a redeploy of an app the gateway already serves never touches the gateway. Changing `senders`, `email.inbound`, `AI_PROVIDER` or `AGENT_MODEL` needs a redeploy. `AI_PROVIDER` and `AGENT_MODEL` are read when the Worker is built, so repeat them on every redeploy: one without them goes back to the Gateway's default model. A redeploy deletes the routes of addresses dropped from `email.inbound`, and `pnpm everyapp delete --purge` removes them all, with the Worker; it leaves the R2 bucket `every-<orgKey>-agentic-inbox` (mailbox settings and attachments) in the account. A copy deployed from a build that still had upstream's MCP server has an `EmailMCP` Durable Object class that the catalog removed. Redeploy that copy once with `pnpm everyapp deploy --allow-delete-durable-object-data`; it deletes only the old MCP server's session state.

**What you don't do:** set any app secret; declare email triggers; bind Workers AI or `send_email` on the app (the deploy refuses both); set up CORS or Cloudflare Access.

### First live deploy: what only a real account can prove

The checklist is in `TODO.md` under "Check on the first live deploy", each item with what proves it: the R2 bucket created by the first deploy; the client assets through the gateway without an `assets` key; startup (error 10021 past 1 s) and memory on the edge; the inbound routes `everyapp deploy` creates delivering to a Worker with no workers.dev URL and no routes, and surviving redeploys; the auto-draft for a never-opened mailbox; Workers AI streaming with tools on llama-4-scout and kimi-k2.6 (and kimi's 20-requests-a-minute cap); a send through the gateway, reply and forward with threading headers and attachments from a second domain, Email Sending's refusal codes in the compose dialog, the gateway's `app` budget counting, and a `cid:` inline image arriving rendered; the agent socket through the gateway closing after 15 minutes; MCP through the gateway; a verified MCP send inside 30 s.

## What is not done

- **The shared first-party shape.** It needs mailboxes scoped by organization, a domain-to-organization index for inbound mail, and per-organization sending domains. See "Two shapes".
- **Per-mailbox permissions.** Anyone in the organization can use every mailbox. That is upstream's model, with the gateway's organization in place of the Access policy.
- **Deleting a mailbox** removes its settings only. Its Durable Object data and R2 attachments stay (an upstream TODO).
- **The `EMAIL_ADDRESSES` allowlist** is off (`[]`); organization roles replace it.
- **CI**: see "Tests and checks".

**Known limitations**

- The mailbox's `from` must be its own address, on a domain in `senders`. Each domain in `senders` must be onboarded to the gateway's email provider (Email Sending in the gateway's account, or verified in Resend).
- Sends count against the gateway's `app` mail budget: by the gateway's defaults (#325), 100 per recipient address per day and 5,000 per gateway per day, on top of the mailbox's own 20 an hour and 100 a day.
- Inbound mail to an address with no mailbox is dropped. A `*@<domain>` catch-all exists only on a zone's apex; mail for a subdomain needs literal addresses in `email.inbound`.
- Someone removed from the organization keeps an already-open agent chat for at most 15 minutes (the socket's lifetime); HTTP requests stop within 120 s, when the gateway's identity token expires.
- The hosted gateway's third-party deploys (Workers for Platforms) haven't been tried with this app's Durable Objects and `email()` handler.
