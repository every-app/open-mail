# Notes for coding agents

This is [cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox) ported to run behind an Every App gateway. Read [docs/EVERY_APP.md](docs/EVERY_APP.md) first: what changed from upstream, how the gateway seams work, local runs and the deploy runbook.

## Setup

- The Every App repository must sit beside this one as `../private-every-app`, on `main`. `@every-app/sdk` and the `everyapp` CLI are `link:` dependencies on it. Build the SDK there before installing: `pnpm -C ../private-every-app/packages/sdk build`.
- In a git worktree outside the parent directory, the relative `link:` paths point nowhere. Make `<worktree>/../private-every-app` a symlink to the checkout.
- pnpm only (`packageManager` pins it). Install with `pnpm install --ignore-scripts`: upstream code is third party, and nothing here needs an install script (`pnpm-workspace.yaml` lists the skipped ones).

## Commands

- `pnpm types:check`, `pnpm test`, `pnpm build`: run all three before you hand work back.
- `pnpm check:deploy`: the deploy's own checks on a production build, offline. `pnpm check:runbook`: the runbook's gateway secrets are ones the CLI accepts.
- `bash scripts/verify-local.sh <gateway port> <vite port> [dev log]` against a running `everyapp dev`: the port's whole local end-to-end check (sends, refusals, inbound mail, the agent, MCP). Run it after an upstream merge.
- `pnpm everyapp dev --port <port>`: the app behind a local gateway-lite at `http://agentic-inbox.localhost:<port>`, as the seeded owner `dev@everyapp.localhost`. Pick a free port; many dev servers may be running. Stop yours when done.
- Never run `everyapp deploy`, `setup`, `register`, `secret` or `delete`, `cf deploy`, or anything else that talks to a live Cloudflare account, unless the person you work for asked for exactly that. The `cf` login on a maintainer's machine is a real account. If you must read cf's validation, hide the login: `XDG_CONFIG_HOME=$(mktemp -d) CI=1`.

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
