# Self-hosting OpenMail

OpenMail lets you send, receive, and manage emails through a modern web interface -- all powered by your own Cloudflare account. Incoming emails arrive via [Cloudflare Email Routing](https://developers.cloudflare.com/email-routing/), each mailbox is isolated in its own [Durable Object](https://developers.cloudflare.com/durable-objects/) with a SQLite database, and attachments are stored in [R2](https://developers.cloudflare.com/r2/).

An **AI-powered Email Agent** can read your inbox, search conversations, and draft replies -- built with the [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/), on the model your Every App gateway's default model provider serves (or a pinned OpenRouter or Workers AI).

![OpenMail screenshot](../demo_app.png)

## Prerequisites

- An [Every App](https://github.com/every-app/every-app) gateway on a Cloudflare account with Workers Paid
- A domain on Cloudflare DNS in the gateway's account, onboarded to [Email Sending](https://developers.cloudflare.com/email-service/) and with [Email Routing](https://developers.cloudflare.com/email-routing/) enabled
- A model provider's key on the gateway (OpenRouter's first; any provider the Gateway's default resolves to will do)

Anyone in the organization that owns the app can use every mailbox, including through the gateway's MCP connector, where AI tools (Claude Code, Cursor, etc.) act on a mailbox by its address. There is no per-mailbox authorization: the gateway's organization is the trust boundary.

## Deploy it

This fork runs as a private app behind an [Every App](https://github.com/every-app/every-app) gateway, not with the Deploy to Cloudflare button. The gateway signs people in (the organization is the boundary: owners and admins manage mailboxes, members use them). It brokers the model calls (the Gateway's default model provider, or a pinned OpenRouter or Workers AI) and outgoing mail, and serves the MCP tools. The app's Worker holds no secrets. **[docs/EVERY_APP.md](EVERY_APP.md)** is the full runbook: what changes from upstream, how it works, running it locally, the deploy steps in order, and what isn't done yet.

In short, with a gateway installed (`pnpm everyapp setup` in the Every App checkout) on Workers Paid, and R2 enabled once on the account:

1. **A model**: `pnpm everyapp secret set OPENROUTER_API_KEY` (a key from https://openrouter.ai/settings/keys), or any other model provider's key. The app takes the Gateway's default model (`ai.chat` in the manifest): the gateway doesn't open it until one provider is set up, and `pnpm everyapp ai default <provider>` picks which. To pin one provider instead, deploy with `AI_PROVIDER=openrouter` or `AI_PROVIDER=workers-ai`.
2. **Your mail domain**: onboard it to Email Sending (its zone on Cloudflare DNS in the gateway's account).
3. **Install**: from your Every App checkout, `pnpm everyapp install https://github.com/every-app/open-mail` (the latest release, which the Release workflow publishes on every push; the same command updates it later), then `pnpm everyapp configure openmail`, which asks for any key from step 1 that is still missing. To deploy your own changes instead, run that checkout's CLI from this directory: `node ../every-app/packages/cli/bin/everyapp.js deploy`. Either uploads the Worker `every-<orgKey>-openmail`.
4. **Set your mail domain** on the installation, not in the manifest: `pnpm everyapp email set --sender '*@example.com' --inbound '*@example.com'`. The gateway then sends as those addresses, turns on Email Routing for the domain if you agree, and routes its mail to the Worker. `pnpm everyapp email show` prints them.
5. **Create a mailbox** at `https://openmail.<gateway domain>/` for an address on your domain.
