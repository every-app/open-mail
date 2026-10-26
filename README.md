# OpenMail

> **An inbox where an AI agent drafts your replies and you hit send.**
>
> Mail on your own domain arrives through Cloudflare Email Routing. The agent reads each new message and drafts a reply; nothing goes out until you confirm.

## Features

- Send and receive on your own domain: composer, threads, folders, search and attachments.
- An agent in the side panel that reads, searches, drafts and sends.
- Auto-drafts a reply to new mail; sending always needs your confirmation.
- A custom system prompt per mailbox, with chat history and every tool call shown.
- Each mailbox in its own Durable Object with SQLite; attachments in R2.
- MCP tools for your AI clients, acting on a mailbox by its address.

## Install on EveryApp

```bash
pnpm everyapp install https://github.com/every-app/open-mail
pnpm everyapp configure openmail
```

Needs a model key (OpenRouter first), a mail domain on Cloudflare with Email Sending, and R2 enabled. Details: [everyapp.com/docs/apps/openmail](https://everyapp.com/docs/apps/openmail)

Development: [docs/development.md](docs/development.md). Self-hosting: [docs/self-hosting.md](docs/self-hosting.md). Full runbook and every change from upstream: [docs/EVERY_APP.md](docs/EVERY_APP.md).

## Thanks

OpenMail is a fork of Cloudflare's [agentic-inbox](https://github.com/cloudflare/agentic-inbox) (Apache-2.0; see the [blog post](https://blog.cloudflare.com/email-for-agents/)), modified to run behind an Every App gateway. Thanks to the Cloudflare team for building it. It is not an official Cloudflare product. Upstream's license is kept in [LICENSE](LICENSE), and the changes are this fork's own, under the same license.
