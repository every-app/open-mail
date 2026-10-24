# Notes for coding agents

This is [cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox) ported to run behind an Every App gateway. Read [docs/EVERY_APP.md](docs/EVERY_APP.md) first: what changed from upstream, how the gateway seams work, local runs and the deploy runbook.

## Setup

- `@every-app/sdk` and the `everyapp` CLI are vendored tarballs (`vendor/README.md`, `file:` dependencies in `package.json`): `pnpm install` here is all a clone or a worktree needs, no Every App checkout beside it. To work against a live checkout, point the two specifiers at `link:` paths locally and don't commit that.
- pnpm only (`packageManager` pins it). Install with `pnpm install --ignore-scripts`: upstream code is third party, and nothing here needs an install script (`pnpm-workspace.yaml` lists the skipped ones).

## Commands

- `pnpm types:check`, `pnpm test`, `pnpm build`: run all three before you hand work back.
- `pnpm check:deploy`: what `everyapp deploy` checks before it uploads, offline, through the vendored CLI's `everyapp release` (logins hidden; you set nothing): the manifest against the CLI's strict schema, a production `cf build`, the CLI's Build Output policy for the build's placeholder Worker, and the built Worker's bindings (no `ai`, no `send_email`, no triggers, `AI_PROVIDER` at its build default). `pnpm check:runbook`: every name `docs/EVERY_APP.md` says to `everyapp secret set` is a Gateway setting the CLI accepts, by the SDK's own list, offline.
- `bash scripts/verify-local.sh <gateway port> <vite port> [dev log]` against a running `everyapp dev`: the port's whole local end-to-end check (sends, refusals, inbound mail, the agent, MCP). Run it after an upstream merge.
- `pnpm everyapp dev --port <port>`: the app behind a local gateway-lite at `http://agentic-inbox.localhost:<port>`, as the seeded owner `dev@everyapp.localhost`. Pick a free port; many dev servers may be running. Stop yours when done.
- Never run `everyapp deploy`, `setup`, `update`, `install`, `secret set`, `secret unset`, `email set`, `email unset`, `access on|off` or `delete`, `cf deploy`, or anything else that talks to a live Cloudflare account, unless the person you work for asked for exactly that. The read-only `pnpm everyapp secret list` (which Gateway settings the app needs, required or optional, and whether each is set), `pnpm everyapp email show` and `pnpm everyapp status` are fine: they print names, never values. The `cf` login on a maintainer's machine is a real account. If you must read cf's validation, hide the login: `XDG_CONFIG_HOME=$(mktemp -d) CI=1`.

## Every App

- Run it with `pnpm dev` (`everyapp dev`). Deploys run from an Every App checkout: `pnpm everyapp install https://github.com/every-app/agentic-inbox` there installs the latest release, or that checkout's CLI from this directory (`node ../every-app/packages/cli/bin/everyapp.js deploy`) deploys the working tree; `pnpm run deploy` here runs the vendored CLI, which can't update the Gateway. The live copy is `agentic-inbox.everyapp.team`.
- `everyapp.config.ts` is the manifest: the resources (two Durable Objects), the AI providers and models, the `email` capability and `email.inbound`. An app's own secrets would be declared there too; this one has none. The Gateway settings it needs (`OPENROUTER_API_KEY`, required; `WORKERS_AI_API_TOKEN`, optional; `EMAIL_FROM`, required by the `email` capability) are set by the person with `pnpm everyapp secret set <NAME>`, from any directory.
- Senders and inbound addresses belong to the installation, not the manifest: `pnpm everyapp email set --sender '*@<domain>' --inbound '*@<domain>'` after the first deploy; `pnpm everyapp email show` prints them.
- The `everyapp` skill (every command and flag, the manifest, secrets, email, deploy) is in the vendored CLI at `node_modules/everyapp/skills/everyapp/SKILL.md`. Read it before running any `everyapp` command.

## Where changes go

- Every App code lives in `workers/everyapp/` (`gateway.ts`: `withGateway()` and AI through the gateway; `agent-ai.ts`: the agent's AI errors and notices; `email.ts`: mail through the gateway; `inbound.ts`: naming the agent for inbound mail; `identity.ts`: organization, roles, the agent guard, socket lifetime; `tools.ts`: the MCP catalog) and in the entry, `workers/app.ts`. Settings live in `everyapp.config.ts` (the manifest) and `cloudflare.config.ts`; there is no `wrangler.jsonc`.
- Keep upstream's files byte-identical so `git merge upstream/main` stays cheap. Those are `workers/lib/{tools,email-helpers,attachments,mailbox,schemas}.ts`, `workers/durableObject/*`, `workers/db/*`, `shared/*`, `react-router.config.ts`, `workers/email-sender.ts`, `receiveEmail` in `workers/index.ts`, and `app/**` apart from the files `docs/EVERY_APP.md` names. Work through the seams instead: `withGateway()` supplies `env.AI` and `env.EMAIL` to upstream's code. Check with `git diff --stat upstream/main -- workers app shared`.
- The deploy refuses `ai` and `send_email` bindings and `email` triggers on the app's Worker. Don't add them.

## Tests

`vitest.config.ts` has two projects:

- **node**: `test/**/*.test.ts`, unit tests with fake bindings.
- **workers**: `test/**/*.workers.test.ts` and `test/receive-email.test.ts`, inside workerd through `@cloudflare/vitest-pool-workers`. The production entry is the Worker, against the real Durable Objects and a local R2 bucket.

The workers project shares storage across tests (isolated storage can't undo open SQLite Durable Objects), so give each test its own mailbox address. Its compatibility date trails production because the pool's workerd is older; raise it with the pool.

## Decisions

Record every decision taken by default in `TODO.md` under `## Decide`, as `- [ ] **Title.** What was decided, the default taken, the alternative.`
