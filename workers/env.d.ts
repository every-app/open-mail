// Types `cf workers types` can't infer (.cloudflare/types/index.d.ts
// declares `Cloudflare.Env` from cloudflare.config.ts; this merges into it).
// The Durable Object namespaces need nothing here: cloudflare.config.ts
// hands everyAppWorker() the entry as a `cf-worker` module, so cf types
// MAILBOX and EMAIL_AGENT with their classes.
//
// The rest are set only on a deployed Worker (`everyapp deploy` writes them)
// or only in `.dev.vars`, so the dev-mode generated Env doesn't carry them.
declare namespace Cloudflare {
	interface Env {
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
