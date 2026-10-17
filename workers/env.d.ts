// Types `cf workers types` can't infer yet (.cloudflare/types/index.d.ts
// declares `Cloudflare.Env` from cloudflare.config.ts; this merges into it).
//
// The Durable Object namespaces: the SDK's everyAppWorker() names a class's
// Worker by string, so cf infers `DurableObjectNamespace<undefined>` and
// every RPC call on a stub (`getFolders`, `createEmail`, …) is a type error.
// Remove these three once the SDK emits typed namespaces (platform PR 2).
//
// The rest are set only on a deployed Worker (`everyapp deploy` writes them)
// or only in `.dev.vars`, so the dev-mode generated Env doesn't carry them.
declare namespace Cloudflare {
	interface Env {
		MAILBOX: DurableObjectNamespace<import("./durableObject").MailboxDO>;
		EMAIL_AGENT: DurableObjectNamespace<import("./agent").EmailAgent>;
		EMAIL_MCP: DurableObjectNamespace<import("./mcp").EmailMCP>;
		EMAIL_ADDRESSES: string[];
		/** The organization this copy of the app belongs to (org-owned deploys). */
		EVERY_APP_ORG_ID?: string;
		/** The gateway's origin (deployed Workers). */
		GATEWAY_URL?: string;
		/** "1" on a shared app's Worker. */
		EVERYAPP_SHARED?: string;
		/** The private service binding to the gateway (deployed Workers). */
		EVERY_APP_GATEWAY?: Fetcher;
		/** Local development only, from `.dev.vars`: direct provider keys. */
		WORKERS_AI_API_TOKEN?: string;
		CLOUDFLARE_ACCOUNT_ID?: string;
		OPENROUTER_API_KEY?: string;
		EMAIL_REST_API_TOKEN?: string;
		EMAIL_FROM?: string;
	}
}
