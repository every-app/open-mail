# Developing OpenMail

## Getting Started

You need Node 22+ and pnpm 10. The Every App SDK and CLI it builds with are the published packages `@every-app/sdk` and `everyapp`, pinned to one exact version in `package.json`, so a clone of this repository installs and builds on its own: no checkout of the Every App repository beside it.

```bash
pnpm install
cp .dev.vars.example .dev.vars              # optional: AI keys, a real mail transport
pnpm everyapp dev                           # http://openmail.localhost:8787, signed in as a seeded owner
```

`pnpm test`, `pnpm types:check`, `pnpm build`, `pnpm check:deploy` (what `everyapp deploy` checks before it uploads, run offline on a production build) and `pnpm check:runbook` (every name the runbook says to `secret set` is a Gateway setting) are described in [docs/EVERY_APP.md](EVERY_APP.md#tests-and-checks).

## Stack

- **Frontend:** React 19, React Router v7, Tailwind CSS, Zustand, TipTap, `@cloudflare/kumo`
- **Backend:** Hono, Cloudflare Workers, Durable Objects (SQLite), R2, Email Routing
- **AI Agent:** Cloudflare Agents SDK (`AIChatAgent`), AI SDK v6, the Every App gateway's default model (the operator's provider and model), or a pinned OpenRouter or Workers AI, `react-markdown` + `remark-gfm`
- **Auth:** the Every App gateway's signed identity, checked by `everyApp()` on every request

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Browser    │────>│  Hono Worker     │────>│  MailboxDO      │
│  React SPA   │     │  (API + SSR)     │     │  (SQLite + R2)  │
│  Agent Panel │     │                  │     └─────────────────┘
└──────┬───────┘     │  /agents/* ──────┼────>┌─────────────────┐
       │             │                  │     │  EmailAgent DO  │
       │ WebSocket   │                  │     │  (AIChatAgent)  │
       └─────────────┤                  │     │  9 email tools  │
                     │                  │────>│  Gateway model  │
                     └──────────────────┘     └─────────────────┘
```
