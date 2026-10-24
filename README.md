<div align="center">
  <h1>Agentic Inbox</h1>
  <p><em>A self-hosted email client with an AI agent, running entirely on Cloudflare Workers</em></p>
</div>

Agentic Inbox lets you send, receive, and manage emails through a modern web interface -- all powered by your own Cloudflare account. Incoming emails arrive via [Cloudflare Email Routing](https://developers.cloudflare.com/email-routing/), each mailbox is isolated in its own [Durable Object](https://developers.cloudflare.com/durable-objects/) with a SQLite database, and attachments are stored in [R2](https://developers.cloudflare.com/r2/).

An **AI-powered Email Agent** can read your inbox, search conversations, and draft replies -- built with the [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/) and [Workers AI](https://developers.cloudflare.com/workers-ai/).

![Agentic Inbox screenshot](./demo_app.png)


Read the blog post to learn more about Cloudflare Email Service and how to use it with the Agents SDK, MCP, and from the Wrangler CLI: [Email for Agents](https://blog.cloudflare.com/email-for-agents/).

## Deploy on Every App

This fork runs as a private app behind an [Every App](https://github.com/every-app/private-every-app) gateway, not with the Deploy to Cloudflare button. The gateway signs people in (the organization is the boundary: owners and admins manage mailboxes, members use them). It brokers the model calls (OpenRouter by default, or Workers AI) and outgoing mail, and serves the MCP tools. The app's Worker holds no secrets. **[docs/EVERY_APP.md](docs/EVERY_APP.md)** is the full runbook: what changes from upstream, how it works, running it locally, the deploy steps in order, and what isn't done yet.

In short, with a gateway installed (`pnpm everyapp setup` in the Every App checkout) on Workers Paid:

1. **OpenRouter**: `pnpm everyapp secret set OPENROUTER_API_KEY` (a key from https://openrouter.ai/settings/keys). The manifest requires it: the gateway doesn't open the app until it is set. Deploy with `AI_PROVIDER=openrouter` to use it; the build still defaults to Workers AI (`pnpm everyapp secret set WORKERS_AI_API_TOKEN`, optional in the manifest) until its own PR flips the default.
2. **Your mail domain**: onboard it to Email Sending (its zone on Cloudflare DNS in the gateway's account).
3. **Declare your mail domain** in `everyapp.config.ts`: the senders (`capabilities.email.senders: ["*@example.com"]`) and the inbound addresses (`email.inbound: ["*@example.com"]`).
4. **Deploy**: `pnpm install && pnpm everyapp deploy`, from this directory. It uploads the Worker `every-<orgKey>-agentic-inbox`, turns on Email Routing for the domain if you agree, and creates the catch-all rule that hands inbound mail to the Worker.
5. **Create a mailbox** at `https://agentic-inbox.<gateway domain>/` for an address on your domain.

Nothing has been deployed to a real account yet; the runbook's "Verified locally" section shows the local end-to-end run, and `TODO.md` lists what the first live deploy has to check.

## Features

- **Full email client** — Send and receive emails via Cloudflare Email Routing with a rich text composer, reply/forward threading, folder organization, search, and attachments
- **Per-mailbox isolation** — Each mailbox runs in its own Durable Object with SQLite storage and R2 for attachments
- **Built-in AI agent** — Side panel with 9 email tools for reading, searching, drafting, and sending
- **Auto-draft on new email** — Agent automatically reads inbound emails and generates draft replies, always requiring explicit confirmation before sending
- **Configurable and persistent** — Custom system prompts per mailbox, persistent chat history, streaming markdown responses, and tool call visibility

## Stack

- **Frontend:** React 19, React Router v7, Tailwind CSS, Zustand, TipTap, `@cloudflare/kumo`
- **Backend:** Hono, Cloudflare Workers, Durable Objects (SQLite), R2, Email Routing
- **AI Agent:** Cloudflare Agents SDK (`AIChatAgent`), AI SDK v6, OpenRouter or Workers AI through the Every App gateway (`anthropic/claude-haiku-5.5` on OpenRouter), `react-markdown` + `remark-gfm`
- **Auth:** the Every App gateway's signed identity, checked by `everyApp()` on every request

## Getting Started

You need Node 22+, pnpm 10, and the Every App repository checked out beside this one as `../private-every-app`. The Every App SDK and CLI are linked from it.

```bash
(cd ../private-every-app && pnpm install && pnpm -C packages/sdk build)
pnpm install
pnpm everyapp dev        # http://agentic-inbox.localhost:8787, signed in as a seeded owner
```

`pnpm test`, `pnpm types:check`, `pnpm build` and `pnpm check:deploy` (the deploy's own checks, offline) are described in [docs/EVERY_APP.md](docs/EVERY_APP.md#tests-and-checks).

## Prerequisites

- An [Every App](https://github.com/every-app/private-every-app) gateway on a Cloudflare account with Workers Paid
- A domain on Cloudflare DNS in the gateway's account, onboarded to [Email Sending](https://developers.cloudflare.com/email-service/) and with [Email Routing](https://developers.cloudflare.com/email-routing/) enabled
- An OpenRouter key on the gateway, deploying with `AI_PROVIDER=openrouter` (or a Workers AI API token for the default Workers AI build)

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
