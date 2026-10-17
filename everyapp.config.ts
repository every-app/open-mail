// The Every App manifest: what the gateway, the CLI and everyAppWorker()
// know about this app. The Worker never imports this file.
export default {
  id: "agentic-inbox",
  name: "Agentic Inbox",
  description:
    "A team inbox with an AI agent: receive, read, draft and send email on your own domain.",
  resources: {
    // SQLite Durable Objects, exported by workers/app.ts. MAILBOX holds one
    // mailbox's folders and emails, EMAIL_AGENT its chat agent. EMAIL_MCP is
    // the app's own MCP server, kept until the defineTools() catalog
    // replaces it (lane L6 deletes it with `mcp: "app"`).
    durableObjects: [
      { name: "MAILBOX", className: "MailboxDO" },
      { name: "EMAIL_AGENT", className: "EmailAgent" },
      { name: "EMAIL_MCP", className: "EmailMCP" },
    ],
  },
  // Model calls go through the gateway's AI proxy: Workers AI by default,
  // OpenRouter with AI_PROVIDER=openrouter (workers/everyapp/gateway.ts).
  providers: ["workers-ai", "openrouter"],
  // `ai.models` (the model ids the app may request) arrives with lane L1.
  // `capabilities.email` arrives with lane L2, once the gateway's email
  // capability is in the linked platform checkout: the CLI validates the
  // manifest strictly and refuses an unknown capability id until then.
  mcp: "app",
  // Every member of the organization may open the inbox; owners and admins
  // manage mailboxes in the app.
  access: "everyone",
  public: [],
} as const;
