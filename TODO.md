# TODO

## Decide

Decisions taken by default while porting agentic-inbox to Every App; each says what was decided, the default taken and the alternative.

- [ ] **pnpm with `link:` dependencies on the platform checkout.** `@every-app/sdk` and `everyapp` are `link:../private-every-app/packages/{sdk,cli}` (publishing is paused), so the venue installs only with the platform checkout beside it, and CI can't install it. Alternative: published packages once publishing resumes.
- [ ] **Platform default compatibility date (2026-06-01); React Router 7.13.1 with a build shim.** `vite.config.ts`'s `reactRouterBuildOutputShim` mirrors React Router's client manifest because the Cloudflare Vite plugin 2.x writes the client build into the Build Output (React Router 8.4.0 fails identically). Alternative: drop the shim once React Router reads the client environment's `outDir` (upstream issue to file with remix-run/react-router and cloudflare/workers-sdk).
- [ ] **`env.AI` and `env.EMAIL` are shims inside `withGateway()`** (`workers/everyapp/gateway.ts`), so upstream's `lib/*`, Durable Objects and `email()` stay byte-identical. The AI client is created on the first model call, so a request never fails for want of an AI key. Alternative: rewrite each call site against the SDK.
- [ ] **Until the gateway email capability is wired, `env.EMAIL` is a stand-in that logs in dev and refuses when deployed** (`code: "email_not_configured"`), so a deployed Worker never reports a send that didn't happen. Alternative: log-and-succeed everywhere (what the plan sketched).
- [ ] **Only the chat agent is reachable under `/agents/*`.** The guard compares partyserver's `lobby.className`, which in partyserver 0.3.3 is the env binding's name (`EMAIL_AGENT`), not the class name. Alternative: none; `MAILBOX` and `EMAIL_MCP` must stay internal.
- [ ] **`@modelcontextprotocol/sdk` is a direct dependency while `EmailMCP` exists, and `workers-ai-provider` stays until the agent moves to the gateway model.** pnpm doesn't hoist `agents`' copy of the MCP SDK for the app's own import. Alternative: none; both go with their last importer.
- [ ] **One `tsconfig.json` for the Worker, the React app and the config files.** `cf workers types` writes `.cloudflare/types/index.d.ts`, which imports `cloudflare.config.ts`, so the config files are in the Worker's program anyway; `tsc --noEmit` checks it all. Alternative: upstream's three project-reference configs with `tsc -b`.
- [ ] **`react-router typegen --mode development`.** Typegen loads `vite.config.ts`, whose Cloudflare plugin builds the Worker definition; production mode needs `.everyapp/deploy.json`, which only `everyapp deploy` writes. Alternative: none needed.
