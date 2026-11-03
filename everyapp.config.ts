// The Every App manifest: what the gateway, the CLI and everyAppWorker()
// know about this app. The Worker never imports this file.
export default {
  id: "openmail",
  name: "OpenMail",
  description:
    "A team inbox with an AI agent: receive, read, draft and send email on your own domain.",
  icon: "/everyapp-icon.svg",
  resources: {
    // SQLite Durable Objects, exported by workers/app.ts. MAILBOX holds one
    // mailbox's folders and emails, EMAIL_AGENT its chat agent, GMAIL_SYNC a
    // Gmail mailbox's sync state (cursor, id maps, outbox, draft jobs).
    durableObjects: [
      { name: "MAILBOX", className: "MailboxDO" },
      { name: "EMAIL_AGENT", className: "EmailAgent" },
      { name: "GMAIL_SYNC", className: "GmailSync" },
    ],
  },
  // Model calls go through the gateway's AI proxy (workers/everyapp/gateway.ts).
  // By default the app takes the Gateway's default model (`ai.chat`): the
  // operator's choice, else the first provider whose key is set (OpenRouter,
  // Workers AI, OpenAI, Anthropic, Groq, Mistral, Gemini). The gateway
  // doesn't open the app until one is set up.
  ai: {
    chat: {
      why: "The inbox agent's model, with the prompt-injection scanner and the draft verifier.",
    },
    // The model ids the gateway accepts from a pinned Worker (it refuses any
    // other with model_not_allowed); the default route doesn't read this
    // list, the operator chose the model. Workers AI (AI_PROVIDER=workers-ai):
    // the agent's default and the draft verifier, the prompt-injection
    // scanner, and kimi-k2.6 for AGENT_MODEL (paid-only, 20 requests a minute
    // per account; the deprecated kimi-k2.5 id is sent as k2.6). OpenRouter
    // (AI_PROVIDER=openrouter): the same three, plus claude-haiku-5.5, its
    // agent model (Scout wrote draft_reply calls out as text).
    models: [
      "@cf/meta/llama-4-scout-17b-16e-instruct",
      "@cf/meta/llama-3.1-8b-instruct-fast",
      "@cf/moonshotai/kimi-k2.6",
      "meta-llama/llama-4-scout",
      "meta-llama/llama-3.1-8b-instruct",
      "anthropic/claude-haiku-5.5",
      "moonshotai/kimi-k2.6",
    ],
  },
  // The pins, both optional: a Worker built with AI_PROVIDER=openrouter or
  // workers-ai calls that provider's own route, which the gateway serves
  // only to an app that lists it. Nobody needs to set either for the
  // default.
  providers: [
    {
      id: "openrouter",
      optional: true,
      why: "Only for a Worker built with AI_PROVIDER=openrouter (a pin); the default model needs no provider of its own.",
    },
    {
      id: "workers-ai",
      optional: true,
      why: "Only for a Worker built with AI_PROVIDER=workers-ai (a pin); the default model needs no provider of its own.",
    },
  ],
  // Configure this installation's addresses with `everyapp email set
  // --sender <pattern> --inbound <address>` after its first deploy.
  capabilities: {
    email: {
      access: "write",
      why: "Sends mail from the organization's mailboxes on its own domain.",
    },
    // Each person's own Gmail, through the Gateway's held-token proxy
    // (docs/GMAIL.md). A person connects once, in OpenMail, and Google's
    // screen shows exactly these two scopes. gmail.modify covers reading,
    // drafts, labels and trash; gmail.send is for Send in OpenMail. The
    // Gateway adds the sign-in scopes for the account's name itself, and
    // refuses a token that holds more than these.
    //
    // GmailSync's alarm uses the same connection while OpenMail is closed
    // (for: { background: true, userId }): it syncs and writes the agent's
    // reply drafts. It never sends: only a person's own Send does.
    "google-workspace": {
      scopes: ["gmail.modify", "gmail.send"],
      why: "Mirrors your Gmail, writes reply drafts as mail arrives, and sends when you press Send.",
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
