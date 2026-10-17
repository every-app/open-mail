# Agentic Inbox on Every App

This fork runs [cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox) as a private app behind an [Every App](https://github.com/every-app/private-every-app) gateway. It deploys as one Worker, `every-<orgKey>-agentic-inbox`, which the gateway reaches over a service binding. The Worker has no workers.dev URL, no routes and no app secrets. The gateway signs people in, brokers Workers AI, sends the mail, and serves the MCP tools.

> **Status (written 2026-10-17 by port lane L5; lane L7 updates it after the end-to-end run and adds "Verified locally").** Nothing here has run against a real Cloudflare account yet. Each deploy step names the platform pull request it needs. At the time of writing:
>
> | Platform PR | What the inbox needs it for | Status |
> | --- | --- | --- |
> | PR 1 `port/workers-ai-provider` | the gateway's `workers-ai` AI provider and `WORKERS_AI_API_TOKEN` | **merged** (#322, `254b774d`) |
> | PR 3 `port/email-capability` | the gateway `email` capability: `capabilities.email.senders` in the manifest, sends through the gateway | **merged** (#325, `10368fab`) |
> | PR 6 `port/inbound-email-routes` | `everyapp deploy` creates the Email Routing rule from `email.inbound` | **not merged** (no PR yet) |
>
> The deployed Worker sends through the gateway's `email` capability, from each mailbox's own address on a domain in the manifest's `senders` (step 8). Local development checks sends the same way and prints them, unless `.dev.vars` has the Email Sending settings.
>
> "How it works" describes the port once its lanes have merged. At the time of writing, only the bootstrap (L0) is on `everyapp`. AI through the gateway (L1), mail through the gateway (L2), roles and `/api/v1/me` (L3), the frontend fixes (L4) and the MCP catalog (L6) are in progress. Lane L7 checks this document against the code.

<!-- TODO(integration): lane inbox-L2b updated the PR 3 rows and sentences of this document (lane L5's file) when it wired the SDK's sendEmail(); L7 checks the rest against the code. -->

## What changes from upstream

| Concern | Upstream (Deploy to Cloudflare) | On Every App |
| --- | --- | --- |
| Sign-in, who may open it | Cloudflare Access in front of the Worker (`POLICY_AUD`, `TEAM_DOMAIN`, `jose`) | The gateway's users, organizations and per-app access. `everyApp()` checks the gateway's signed identity on every request before any app code runs |
| Who may do what | Everyone Access lets in can do everything | The organization is the boundary. Owners and admins create and delete mailboxes and edit settings, including the agent's system prompt. Members read, search, draft, reply, forward, send, move and star. There are no per-mailbox permissions |
| Workers AI | `ai` binding with `workers-ai-provider`, model `@cf/moonshotai/kimi-k2.5` | The gateway's AI proxy (`workers-ai` provider) with the gateway's `WORKERS_AI_API_TOKEN`. `AI_PROVIDER=openrouter` switches the same code to OpenRouter. `AGENT_MODEL` picks the agent's model (default `@cf/meta/llama-4-scout-17b-16e-instruct`) |
| Sending mail | `send_email` binding, any address on `DOMAINS`, answered `202` before the send | The gateway `email` capability, from the mailbox's own address on a domain the manifest declares (`capabilities.email.senders`). The send is awaited: a refusal answers `502` with the gateway's code, and nothing is copied to Sent |
| Receiving mail | Email Routing catch-all rule "Send to a Worker" | Unchanged: the same `email()` handler, fed by a catch-all rule that names `every-<orgKey>-agentic-inbox` (a manual step until PR 6) |
| Storage | R2 bucket `agentic-inbox`, two SQLite Durable Objects | The R2 bucket is named after the Worker and created by the deploy. The Durable Objects (`MailboxDO`, `EmailAgent`) and every R2 key are unchanged |
| MCP | The app's own `/mcp` (`EmailMCP`) behind Access | The gateway's MCP connector serves the app's `defineTools()` catalog: 13 tools, with `delete_email` hidden from AI clients (port lane L6; until it lands, the app's own `EmailMCP` behind the gateway) |
| Settings | `wrangler.jsonc` vars `DOMAINS`, `EMAIL_ADDRESSES` | `everyapp.config.ts` (the manifest) and `cloudflare.config.ts`. `DOMAINS` comes from the manifest's senders. The `EMAIL_ADDRESSES` restriction is off (`[]`) |
| Secrets on the Worker | `POLICY_AUD`, `TEAM_DOMAIN` | None |
| Toolchain | npm, wrangler, Cloudflare Vite plugin 1.x | pnpm with the Every App SDK and CLI linked from the platform checkout, `cf` 1.0.0-beta.14, Cloudflare Vite plugin 2.x, React Router 7.13.1 with a build shim |

## Two shapes

|  | An organization's own copy (supported) | Shared first party (`--shared`, not supported) |
| --- | --- | --- |
| Who deploys it | An owner of the gateway's Cloudflare account, with `everyapp deploy` | Every App, on a hosted gateway |
| Organizations it serves | One | Every organization on the gateway |
| `EVERY_APP_ORG_ID` | Set by the deploy. A token for any other organization gets `401` | Unset |
| Mailboxes | Durable Objects named by address and R2 keys `mailboxes/<address>.json`: the whole bucket belongs to the one organization | Would need organization-scoped names and keys, and a domain-to-organization index for inbound mail |
| Sending domains | The manifest's `senders`, one set per deploy | Per-organization domains (follow-up) |

**Do not deploy with `--shared`.** Mailboxes aren't scoped by organization. In a shared Worker, every organization's members would see every mailbox. Nothing in the port rules the shared shape out; it needs the scoping above first (see `TODO.md`).

## How it works

- **Identity** (`workers/app.ts`, `workers/everyapp/identity.ts`). The gateway signs a 120-second RS256 token onto every request it forwards (`x-everyapp-identity`; audience `EVERYAPP_AUDIENCE`, the Worker's own name). `everyApp()` from `@every-app/sdk/server` checks it before Hono runs. Without a valid token the answer is `401`; without the gateway's key set, it is `500`. `requireOrganization` refuses a token from another organization when `EVERY_APP_ORG_ID` is set. Roles come from the token's `org_role` on every request, and nothing about members is stored. `GET /api/v1/me` returns `{ id, email, orgId, role, gatewayUrl }`. "Sign out" opens the gateway, which owns sign-out. The app sets no cookies, and the gateway strips inbound `Cookie` and `Authorization` headers.
- **Agent sockets** (`/agents/*`). partyserver makes every Durable Object binding addressable by URL. The guard (`agentGuard`) lets only the chat agent through, compared by binding name (`EMAIL_AGENT`). Mailbox and MCP objects answer `404`. Each agent socket closes 15 minutes after it connects. The client reconnects through the gateway, which signs a fresh identity or refuses someone it no longer lets in.
- **AI** (`workers/everyapp/gateway.ts`). `withGateway(env, request)` hands upstream's code an env with `AI` and `EMAIL` in it, both brokered by the gateway. `env.AI.run()` is a shim over the gateway's OpenAI-compatible chat completions (`/api/ai/workers-ai/v1/...`, or `/api/ai/openrouter/api/v1/...` with `AI_PROVIDER=openrouter`). The shim sends `messages`, `max_tokens` and `temperature` only, never `stream_options`. It is used by the prompt-injection scanner (`@cf/meta/llama-3.1-8b-instruct-fast`) and the draft verifier (`@cf/meta/llama-4-scout-17b-16e-instruct`). The agent streams through `@ai-sdk/openai-compatible` over the same gateway fetch. Calls made while serving a request carry that person's identity; the agent's own Durable Object calls are the organization's. The manifest's `ai.models` lists the models the app may ask for. `AI_PROVIDER` and `AGENT_MODEL` are plain text vars, read when the Worker is built.
- **Sending mail** (the `gatewayEmail` adapter in `workers/everyapp/email.ts`, `workers/index.ts`, `workers/routes/reply-forward.ts`). `sendEmail(env.EMAIL, …)` in upstream's `workers/email-sender.ts` reaches the SDK's `sendEmail()` and the gateway's `email` capability (PR 3): `POST /api/integrations/email/send` over the service binding, attributed to the person who sent it. The gateway sends only `from` addresses that match the manifest's `senders`, and counts each send against its mail budget. Inline images go as inline attachments with their content id. The send routes await it. A refusal answers `502 { error: <code>, message }` and writes no Sent copy. Upstream's per-mailbox limits (20 an hour, 100 a day) and its sender check still run first. `GET /api/v1/config` returns `{ domains, emailAddresses, ready }`: `domains` are the domains of `senders`, and `ready` is the gateway's email status (ready, and accepting at least one of the app's senders). The home page shows "Email sending isn't set up on this gateway" while `ready` is false.
- **Receiving mail** (the `email()` export in `workers/app.ts`, `receiveEmail()` in `workers/index.ts`, byte-identical to upstream). An Email Routing rule hands the message to the Worker. The Worker parses it, drops it if no mailbox exists for the recipient (no `mailboxes/<address>.json`), stores attachments under `attachments/<emailId>/<attachmentId>/<file>`, threads it by `In-Reply-To`/`References` (or by subject), writes it to the mailbox's Durable Object, and pokes that mailbox's agent to draft a reply. The deploy refuses the `email` trigger as a Worker setting, so the rule is created by name, outside the deploy.
- **Storage.** `MailboxDO` (one per address: folders, emails, threads, send counters, in SQLite) and `EmailAgent` (one per address: the chat agent and its history). R2 holds mailbox settings (`mailboxes/<address>.json`) and attachments, in the bucket named after the Worker.
- **MCP** (`workers/everyapp/tools.ts`, port lane L6). The 13 tools of upstream's MCP server, each with a risk, as a `defineTools()` catalog. The gateway snapshots the catalog at deploy and serves it from its `/mcp` to personal access tokens and OAuth clients. Reads are `read`, drafts and sends are `write`, and `delete_email` is `destructive` (hidden from AI clients until the gateway has approvals). Tool calls run with the caller's identity, so their model calls and sends are attributed to them.
- **Inline images.** The message view renders mail in a sandboxed `srcdoc` iframe whose requests carry no gateway session. The parent fetches inline attachments itself and swaps `cid:` references for `data:` URLs (2 MiB each at most).
- **Build** (`vite.config.ts`, `cloudflare.config.ts`, `everyapp.config.ts`). `cf build` with the Cloudflare Vite plugin 2.x builds React Router's client and the Worker. `reactRouterBuildOutputShim` copies React Router's client manifest to where its SSR build looks for it, because the plugin writes the client build into the Build Output; drop it once React Router reads the client environment's output directory. `everyAppWorker()` turns the manifest into the Worker definition (Durable Objects, the gateway binding, the identity settings), and `cloudflare.config.ts` adds the bucket and the text vars. There is no `wrangler.jsonc`.
- **Upstream merges.** Most of upstream's code is untouched, so `git merge upstream/main` stays cheap. Files the port keeps byte-identical: `workers/lib/{tools,email-helpers,attachments,mailbox,schemas}.ts`, `workers/durableObject/*`, `workers/db/*`, `shared/*`, `react-router.config.ts`, `workers/email-sender.ts`, `receiveEmail` in `workers/index.ts`, and everything under `app/` except the frontend files the port names. `workers/lib/ai.ts` differs by one deleted `@ts-expect-error` line. The Every App code lives in `workers/everyapp/` and the entry in `workers/app.ts`. Check with `git diff --stat upstream/main -- workers app shared`.

## Run it locally

You need Node 22+, pnpm 10, and the Every App repository checked out beside this one as `../private-every-app` on `main`. The SDK and CLI are linked from it (`link:` dependencies) while publishing is paused. Build the SDK there first:

```bash
(cd ../private-every-app && pnpm install && pnpm -C packages/sdk build)
pnpm install
cp .dev.vars.example .dev.vars    # optional: AI keys, a real mail transport
pnpm everyapp dev                 # or: pnpm everyapp dev --port 8801
```

`everyapp dev` runs the app under `cf dev` on an internal port and puts a gateway-lite in front of it on `http://agentic-inbox.localhost:8787` (or the port you pass). The gateway-lite applies the real perimeter: the header strip and inject, the same-origin check on state-changing requests, the security headers, and an RS256 identity signed with the SDK's dev key. You are its seeded owner, `dev@everyapp.localhost` in `dev-org`. Its `/mcp` serves the app's MCP tools; send any `Authorization: Bearer` value. If `*.localhost` resolves to `::1` on your machine, use `curl --resolve agentic-inbox.localhost:8787:127.0.0.1`, as `scripts/dev-probe.sh` does.

- **AI.** There is no gateway locally, so the app calls the provider directly with your key from `.dev.vars`, billed to you. For Workers AI (the default), set `WORKERS_AI_API_TOKEN` (an API token with Workers AI Read) and `CLOUDFLARE_ACCOUNT_ID`. For OpenRouter, set `OPENROUTER_API_KEY` and start with `AI_PROVIDER=openrouter pnpm everyapp dev`. Without keys, the chat and the auto-draft show "AI isn't set up" instead of failing the request.
- **Sending.** The SDK checks each send as the gateway would (the mailbox's address must match the manifest's `senders`), then prints it (`[everyapp dev] email to 1 recipient subject "…"`) unless `EMAIL_REST_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `EMAIL_FROM` are set in `.dev.vars` (the Email Sending REST API, on your account). `GET /api/v1/config` says `ready: false`, and the home page shows the "isn't set up" banner, until `EMAIL_FROM` is set.
- **Receiving.** `bash scripts/dev-inbound.sh` posts `test/fixtures/inbound.eml` to the app's internal Vite port at `/cdn-cgi/local/email?from=…&to=…`; `everyapp dev` prints that port. Create the mailbox `dev@example.com` first; mail to an address with no mailbox is dropped, as in production.
- **Probes.** `bash scripts/dev-probe.sh <gateway port> <vite port>` checks the SSR page and the perimeter's headers, `/api/v1/config`, creating a mailbox, the agent socket, the refused sockets, and that a direct hit on the Vite port (no identity) answers `401`. `node scripts/ws-probe.mjs <ws url> [host] [origin]` opens one agent socket.
- **Direct `cf dev`** (`pnpm dev:vite`) runs the Worker without the gateway-lite. Every request then gets `401`, because nothing signs an identity.

### Tests and checks

| Command | What it runs |
| --- | --- |
| `pnpm test` | Vitest, two projects (`vitest.config.ts`). `node`: unit tests with fake bindings (the gateway shims, identity, the tool catalog, frontend helpers). `workers`: tests inside workerd through `@cloudflare/vitest-pool-workers`. The production entry is the Worker there, against the real Durable Objects and a local R2 bucket (inbound mail through `receiveEmail()`, the entry's identity check). A file runs in `workers` when it is named `*.workers.test.ts` (or `test/receive-email.test.ts`). The workers project shares storage between tests, so use a fresh mailbox address in each |
| `pnpm types:check` | `cf workers types` (the Worker's `Env` from `cloudflare.config.ts`), `react-router typegen`, `tsc --noEmit` |
| `pnpm build` | A development build of the client and the Worker, then `tsc` |
| `pnpm check:deploy` | What `everyapp deploy` checks before it uploads, offline: the manifest against the CLI's strict schema, a production `cf build` with fake deploy inputs, the CLI's Build Output policy, and the built Worker's bindings (no `ai`, no `send_email`, no triggers, the bucket and audience named after the Worker) |
| `pnpm check:runbook` | Every gateway secret this runbook tells you to set is one `everyapp secret set --for gateway` accepts (the CLI's own check, offline) |

**CI.** The venue has no CI. Its `link:` dependencies need the platform checkout beside it, so a hosted runner can't install it as is. When the SDK and CLI are published again, switch the links to versions and run the commands above in CI.

## Deploy it

These steps assume a gateway installed with `pnpm everyapp setup` from the platform checkout (`~/workspaces/private-every-app`, or wherever yours is). Run `pnpm everyapp …` gateway commands from that checkout, and app commands from this directory. The account must be on **Workers Paid**: Email Sending to arbitrary recipients and Email Routing to Workers need it. The steps are in order.

| # | Where | What | Command / step | Needs |
| --- | --- | --- | --- | --- |
| 1 | Cloudflare account | Workers Paid | Dashboard (Workers plans) | |
| 2 | Cloudflare account | An API token with **Workers AI Read** for the gateway's account | Dashboard → My Profile → API Tokens → Create Token → "Workers AI" template | |
| 3 | gateway | The Workers AI token. The gateway must run a release with PR 1: after `git pull` in the platform checkout, `pnpm everyapp setup` upgrades it (so does this app's first `everyapp deploy`) | `pnpm everyapp secret set WORKERS_AI_API_TOKEN --for gateway` | PR 1: **merged** |
| 4 | gateway | `CLOUDFLARE_ACCOUNT_ID`, the account Workers AI bills | Nothing to do: `everyapp setup` set it | |
| 5 | gateway (optional) | OpenRouter instead of Workers AI | `pnpm everyapp secret set OPENROUTER_API_KEY --for gateway`, then deploy with `AI_PROVIDER=openrouter` (step 9) | |
| 6 | Cloudflare zone (on Cloudflare DNS, in the gateway's account) | Onboard each mail domain to **Email Sending**. This adds the `cf-bounce` MX, SPF, DKIM and DMARC records. New accounts start with a low daily quota | `pnpm exec cf email-sending subdomains create -z example.com --name example.com`, or Dashboard → Compute & AI → Email Service → Email Sending → Onboard Domain. Details: `docs/runbooks/email-sending-setup.md` in the platform checkout | PR 3: **merged**; the gateway must run a release with it (`pnpm everyapp setup` upgrades it) |
| 7 | Cloudflare zone | Enable **Email Routing**. This adds and locks the zone's MX and SPF records | `pnpm exec cf email-routing enable -z example.com`, or Dashboard → Email → Email Routing → Enable | |
| 8 | this directory | Declare the sending domains once: one `"*@<domain>"` entry per domain onboarded in step 6. `DOMAINS`, the domains the app offers for new mailboxes, is derived from the same list | `everyapp.config.ts`: `capabilities: { email: { access: "write", why: "…", senders: ["*@example.com"] } }`. Replace the shipped placeholder `*@example.com` with your domains (at most 20) | PR 3: **merged** |
| 9 | this directory | Deploy. The first deploy registers the app and prints its Worker name, `every-<orgKey>-agentic-inbox` | `pnpm install`, then `pnpm everyapp deploy`. Optional build-time settings in the same command: `AI_PROVIDER=openrouter`, `AGENT_MODEL=<model id>` | |
| 10 | Cloudflare zone | **Catch-all rule → Send to a Worker → `every-<orgKey>-agentic-inbox`.** Catch-alls exist only on the apex zone; an address on a subdomain needs a literal rule | Dashboard → Email Routing → Routing rules → Catch-all address → Send to a Worker, or `pnpm exec cf email-routing rules catch-all update -z example.com --enabled --matchers '[{"type":"all"}]' --actions '[{"type":"worker","value":["every-<orgKey>-agentic-inbox"]}]'` (add `--dry-run` to check first). **After PR 6:** declare `email: { inbound: ["*@example.com"] }` in the manifest and `everyapp deploy` creates the rule | PR 6 (automation): **not merged** |
| 11 | gateway (optional) | Use the Email Sending REST API instead of the gateway's `EMAIL` binding (Docker gateways) | `pnpm everyapp secret set EMAIL_REST_API_TOKEN --for gateway` | PR 3: **merged** |
| 12 | this directory | App secrets | **None** | |

Then open `https://agentic-inbox.<gateway domain>/` as an owner or admin and create a mailbox on one of the domains. Send a mail to it from outside and watch the inbox, then Drafts, where the agent's reply appears. (See the known limitation about the first mail below.)

**Models.** The agent uses `@cf/meta/llama-4-scout-17b-16e-instruct` by default. `AGENT_MODEL=@cf/moonshotai/kimi-k2.6 pnpm everyapp deploy` switches it. Kimi K2.6 (what upstream's deprecated `kimi-k2.5` now aliases to) is paid-only and allows 20 requests a minute per account, shared by every organization on the gateway. With `AI_PROVIDER=openrouter`, the scanner, verifier and agent use the matching OpenRouter models (`meta-llama/llama-3.1-8b-instruct`, `meta-llama/llama-4-scout`).

**Redeploying.** Run `pnpm everyapp deploy` again; a redeploy of an app the gateway already serves never touches the gateway. Changing `senders`, `AI_PROVIDER` or `AGENT_MODEL` needs a redeploy. A copy deployed before the MCP catalog (port lane L6) has an `EmailMCP` Durable Object class that the catalog removes. Redeploy that copy once with `pnpm everyapp deploy --allow-delete-durable-object-data`; it deletes only the old MCP server's session state.

**What you don't do:** set any app secret; declare email triggers; bind Workers AI or `send_email` on the app (the deploy refuses both); set up CORS or Cloudflare Access.

### First live deploy: what only a real account can prove

Check these on the first deploy, with the command that proves each:

- [ ] The deploy creates the R2 bucket `every-<orgKey>-agentic-inbox` (`pnpm everyapp status`; you can create it beforehand).
- [ ] `cf deploy --prebuilt` uploads the client assets although the Build Output's `worker.config.json` has no `assets` key: `GET /` renders and `/assets/*` load through the gateway.
- [ ] An Email Routing rule with `actions: [{ type: "worker", value: ["every-<orgKey>-agentic-inbox"] }]` delivers to a Worker that has no workers.dev URL and no routes. Fallback: a gateway-owned `email` trigger that relays `message.raw` over the binding.
- [ ] A `*@<apex>` catch-all and a literal `x@<subdomain>` rule both route, and the rule survives a redeploy.
- [ ] The gateway's `env.EMAIL.send()` works from a second onboarded `from` domain, with `In-Reply-To`/`References` headers and attachments (reply and forward).
- [ ] An unverified sender's refusal arrives as `email_sender_not_verified` (`E_SENDER_NOT_VERIFIED` mapped), and a spent quota as `email_provider_limited`, each shown in the compose dialog.
- [ ] Sends count against the gateway's `app` mail budget (`rate_limit_counters` in the gateway's D1).
- [ ] Workers AI streaming with tool calls through the gateway for the default model, and for `kimi-k2.6` at its 20-requests-a-minute cap.
- [ ] A WebSocket to the agent through the gateway (`wss://agentic-inbox.<gateway domain>/agents/email-agent/<address>`) opens, and closes after 15 minutes with a clean reconnect.

## What is not done

- **The shared first-party shape** (`--shared`). It needs mailboxes scoped by organization, a domain-to-organization index for inbound mail, and per-organization sending domains. See "Two shapes".
- **Per-mailbox permissions.** Anyone in the organization can use every mailbox. That is upstream's model, with the gateway's organization in place of the Access policy.
- **Deleting a mailbox** removes its settings only. Its Durable Object data and R2 attachments stay (an upstream TODO).
- **The `EMAIL_ADDRESSES` allowlist** is off (`[]`); organization roles replace it.
- **CI**: see "Tests and checks".

**Known limitations**

- The mailbox's `from` must be its own address, on a domain in `senders`. Each domain in `senders` must be onboarded to Email Sending in the gateway's account.
- Sends count against the gateway's `app` mail budget: per PR 3's design, 100 per recipient address per day and 5,000 per gateway per day, on top of the mailbox's own 20 an hour and 100 a day.
- Inbound mail to an address with no mailbox is dropped.
- **The agent drafts a reply to inbound mail only once the mailbox's agent knows its name**, that is, after someone has opened that mailbox's agent panel once. `receiveEmail()` pokes the `EmailAgent` Durable Object with a bare `fetch`. partyserver 0.3.3 refuses that (`Missing namespace or room headers when connecting to EmailAgent`) until the object has been reached once through `/agents/email-agent/<address>`, which stores its name. The mail itself is always stored. This is upstream behaviour, reproduced under the workers test project. Fixing it means naming the agent before the poke, without editing `receiveEmail` (see `TODO.md`).
- The hosted gateway's third-party deploys (Workers for Platforms) haven't been tried with this app's Durable Objects and `email()` handler.
