// The Every App manifest: what the gateway, the CLI and everyAppWorker()
// know about this app. The Worker never imports this file.
export default {
  id: "agentic-inbox",
  name: "Agentic Inbox",
  description:
    "A team inbox with an AI agent: receive, read, draft and send email on your own domain.",
  icon: "/everyapp-icon.svg",
  resources: {
    // SQLite Durable Objects, exported by workers/app.ts. MAILBOX holds one
    // mailbox's folders and emails, EMAIL_AGENT its chat agent.
    durableObjects: [
      { name: "MAILBOX", className: "MailboxDO" },
      { name: "EMAIL_AGENT", className: "EmailAgent" },
    ],
  },
  // Model calls go through the gateway's AI proxy: Workers AI by default,
  // OpenRouter with AI_PROVIDER=openrouter (workers/everyapp/gateway.ts).
  providers: ["workers-ai", "openrouter"],
  // The model ids the gateway accepts from this app (it refuses any other
  // with model_not_allowed). Workers AI: the agent's default and the draft
  // verifier, the prompt-injection scanner, and kimi-k2.6 for AGENT_MODEL
  // (paid-only, 20 requests a minute per account, shared by every
  // organization on the gateway; the deprecated kimi-k2.5 id is sent as
  // k2.6). OpenRouter (AI_PROVIDER=openrouter): the same three models.
  ai: {
    models: [
      "@cf/meta/llama-4-scout-17b-16e-instruct",
      "@cf/meta/llama-3.1-8b-instruct-fast",
      "@cf/moonshotai/kimi-k2.6",
      "meta-llama/llama-4-scout",
      "meta-llama/llama-3.1-8b-instruct",
      "moonshotai/kimi-k2.6",
    ],
  },
  // Configure this installation's addresses with `everyapp email set
  // --sender <pattern> --inbound <address>` after its first deploy.
  capabilities: {
    email: {
      access: "write",
      why: "Sends mail from the organization's mailboxes on its own domain.",
    },
  },
  // Declares the Worker's email() handler; addresses belong to the installation.
  email: {
    inbound: true,
  },
  // No `mcp` setting: the gateway serves `/mcp` from the app's defineTools()
  // catalog (workers/everyapp/tools.ts).
  // Every member of the organization may open the inbox; owners and admins
  // manage mailboxes in the app.
  access: "everyone",
  public: [],
} as const;
