<div align="center">
  <h1>Agentic Inbox</h1>
  <p><em>A self-hosted email client with an AI agent, running entirely on Cloudflare Workers</em></p>
</div>

Agentic Inbox lets you send, receive, and manage emails through a modern web interface -- all powered by your own Cloudflare account. Incoming emails arrive via [Cloudflare Email Routing](https://developers.cloudflare.com/email-routing/), each mailbox is isolated in its own [Durable Object](https://developers.cloudflare.com/durable-objects/) with a SQLite database, and attachments are stored in [R2](https://developers.cloudflare.com/r2/).

An **AI-powered Email Agent** can read your inbox, search conversations, and draft replies -- built with the [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/) and [Workers AI](https://developers.cloudflare.com/workers-ai/).

![Agentic Inbox screenshot](./demo_app.png)


Read the blog post to learn more about Cloudflare Email Service and how to use it with the Agents SDK, MCP, and from the Wrangler CLI: [Email for Agents](https://blog.cloudflare.com/email-for-agents/).

## Deploy on Every App

This fork runs as a private app behind an [Every App](https://github.com/every-app/private-every-app) gateway, not with the Deploy to Cloudflare button. The gateway signs people in (the organization is the boundary: owners and admins manage mailboxes, members use them). It brokers the model calls (the Gateway's default model provider, or a pinned OpenRouter or Workers AI) and outgoing mail, and serves the MCP tools. The app's Worker holds no secrets. **[docs/EVERY_APP.md](docs/EVERY_APP.md)** is the full runbook: what changes from upstream, how it works, running it locally, the deploy steps in order, and what isn't done yet.

In short, with a gateway installed (`pnpm everyapp setup` in the Every App checkout) on Workers Paid:

1. **A model**: `pnpm everyapp secret set OPENROUTER_API_KEY` (a key from https://openrouter.ai/settings/keys), or any other model provider's key. The app takes the Gateway's default model (`ai.chat` in the manifest): the gateway doesn't open it until one provider is set up, and `pnpm everyapp ai default <provider>` picks which. To pin one provider instead, deploy with `AI_PROVIDER=openrouter` or `AI_PROVIDER=workers-ai`.
2. **Your mail domain**: onboard it to Email Sending (its zone on Cloudflare DNS in the gateway's account).
3. **Deploy**: from your Every App checkout, `pnpm everyapp install https://github.com/every-app/agentic-inbox` (the latest release, which the Release workflow publishes on every push; the same command updates it later), or to deploy your own changes, that checkout's CLI from this directory: `node ../every-app/packages/cli/bin/everyapp.js deploy`. Either uploads the Worker `every-<orgKey>-agentic-inbox`.
4. **Set your mail domain** on the installation, not in the manifest: `pnpm everyapp email set --sender '*@example.com' --inbound '*@example.com'`. The gateway then sends as those addresses, turns on Email Routing for the domain if you agree, and routes its mail to the Worker. `pnpm everyapp email show` prints them.
5. **Create a mailbox** at `https://agentic-inbox.<gateway domain>/` for an address on your domain.

Deployed: the app is live at `https://agentic-inbox.everyapp.team/` with mail on `hi.openseo.so`, its senders set with `pnpm everyapp email set --sender`.

## Features

- **Full email client** — Send and receive emails via Cloudflare Email Routing with a rich text composer, reply/forward threading, folder organization, search, and attachments
- **Per-mailbox isolation** — Each mailbox runs in its own Durable Object with SQLite storage and R2 for attachments
- **Built-in AI agent** — Side panel with 9 email tools for reading, searching, drafting, and sending
- **Auto-draft on new email** — Agent automatically reads inbound emails and generates draft replies, always requiring explicit confirmation before sending
- **Configurable and persistent** — Custom system prompts per mailbox, persistent chat history, streaming markdown responses, and tool call visibility

## Stack

- **Frontend:** React 19, React Router v7, Tailwind CSS, Zustand, TipTap, `@cloudflare/kumo`
- **Backend:** Hono, Cloudflare Workers, Durable Objects (SQLite), R2, Email Routing
- **AI Agent:** Cloudflare Agents SDK (`AIChatAgent`), AI SDK v6, the Every App gateway's default model (the operator's provider and model), or a pinned OpenRouter or Workers AI, `react-markdown` + `remark-gfm`
- **Auth:** the Every App gateway's signed identity, checked by `everyApp()` on every request

## Getting Started

You need Node 22+ and pnpm 10. The Every App SDK and CLI it builds with are the published packages `@every-app/sdk` and `everyapp`, pinned to one exact version in `package.json`, so a clone of this repository installs and builds on its own: no checkout of the Every App repository beside it.

```bash
pnpm install
cp .dev.vars.example .dev.vars              # optional: AI keys, a real mail transport
pnpm everyapp dev                           # http://agentic-inbox.localhost:8787, signed in as a seeded owner
```

`pnpm test`, `pnpm types:check`, `pnpm build`, `pnpm check:deploy` (what `everyapp deploy` checks before it uploads, run offline on a production build) and `pnpm check:runbook` (every name the runbook says to `secret set` is a Gateway setting) are described in [docs/EVERY_APP.md](docs/EVERY_APP.md#tests-and-checks).

## Prerequisites

- An [Every App](https://github.com/every-app/private-every-app) gateway on a Cloudflare account with Workers Paid
- A domain on Cloudflare DNS in the gateway's account, onboarded to [Email Sending](https://developers.cloudflare.com/email-service/) and with [Email Routing](https://developers.cloudflare.com/email-routing/) enabled
- A model provider's key on the gateway (OpenRouter's first; any provider the Gateway's default resolves to will do)

Anyone in the organization that owns the app can use every mailbox, including through the gateway's MCP connector, where AI tools (Claude Code, Cursor, etc.) act on a mailbox by its address. There is no per-mailbox authorization: the gateway's organization is the trust boundary.

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
                     │                  │────>│  Workers AI     │
                     └──────────────────┘     └─────────────────┘
```

## License

Apache 2.0 -- see [LICENSE](LICENSE).
