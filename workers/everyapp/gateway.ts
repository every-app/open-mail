/**
 * Everything the gateway brokers for this app, in one place.
 *
 * On Every App the app's Worker holds no provider keys and may bind neither
 * Workers AI nor `send_email` (the deploy refuses both). withGateway() gives
 * the upstream code the env it expects anyway: `env.AI.run()` goes to the
 * gateway's AI proxy and `env.EMAIL.send()` to the gateway's email
 * capability, so lib/ai.ts, lib/tools.ts, the Durable Objects and the
 * `email()` handler stay as upstream wrote them.
 *
 * Lane ownership: L1 owns PROVIDERS, mapModel, gatewayAi and gatewayModel;
 * L2 owns gatewayEmail; withGateway() itself stays as it is.
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
	createGatewayFetch,
	type GatewayCallFor,
} from "@every-app/sdk/server";
import type { Env } from "../types";

/**
 * Any origin does: the SDK sends the request's path over the
 * EVERY_APP_GATEWAY binding (or, in local dev with a key in `.dev.vars`,
 * straight to the provider).
 */
const GATEWAY = "http://every-app-gateway.internal";

/** The gateway's AI providers this app uses, and each one's model ids. */
export const PROVIDERS = {
	"workers-ai": {
		base: `${GATEWAY}/api/ai/workers-ai/v1`,
		scanner: "@cf/meta/llama-3.1-8b-instruct-fast",
		verifier: "@cf/meta/llama-4-scout-17b-16e-instruct",
		agent: "@cf/meta/llama-4-scout-17b-16e-instruct",
	},
	openrouter: {
		base: `${GATEWAY}/api/ai/openrouter/api/v1`,
		scanner: "meta-llama/llama-3.1-8b-instruct",
		verifier: "meta-llama/llama-4-scout",
		agent: "meta-llama/llama-4-scout",
	},
} as const;

type ProviderEnv = Pick<Cloudflare.Env, "AI_PROVIDER" | "AGENT_MODEL">;

/** The provider AI_PROVIDER selects; Workers AI unless it says "openrouter". */
export function providerOf(env: ProviderEnv) {
	return PROVIDERS[env.AI_PROVIDER === "openrouter" ? "openrouter" : "workers-ai"];
}

/** OpenRouter's ids for the Workers AI models upstream's code names. */
const OPENROUTER_MODELS: Record<string, string> = {
	[PROVIDERS["workers-ai"].scanner]: PROVIDERS.openrouter.scanner,
	[PROVIDERS["workers-ai"].verifier]: PROVIDERS.openrouter.verifier,
	"@cf/moonshotai/kimi-k2.5": "moonshotai/kimi-k2",
	"@cf/moonshotai/kimi-k2.6": "moonshotai/kimi-k2",
};

/** The id to send for `model`: lib/ai.ts names Workers AI models. */
export function mapModel(env: ProviderEnv, model: string): string {
	if (env.AI_PROVIDER !== "openrouter") return model;
	return OPENROUTER_MODELS[model] ?? model;
}

interface RunInputs {
	messages: unknown[];
	max_tokens?: number;
	temperature?: number;
}

/**
 * An `Ai`-shaped object: the `run()` subset lib/ai.ts uses (messages,
 * max_tokens, temperature; non-streaming), as an OpenAI-compatible chat
 * completion through the gateway. Never sends `stream_options` (Workers AI
 * answers 400 on a non-streaming call that carries it).
 */
export function gatewayAi(env: Cloudflare.Env, target?: GatewayCallFor): Ai {
	const provider = providerOf(env);
	// Made on first use: createGatewayFetch() throws ConfigurationError when
	// there is neither a gateway binding nor a dev key, and most requests
	// never call a model. A throw from run() is what lib/ai.ts expects of a
	// failed model call (it fails closed).
	let fetchViaGateway: typeof fetch | undefined;
	const ai = {
		async run(model: string, inputs: RunInputs): Promise<{ response: string }> {
			fetchViaGateway ??= createGatewayFetch({ env, for: target });
			const res = await fetchViaGateway(`${provider.base}/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: mapModel(env, model),
					messages: inputs.messages,
					max_tokens: inputs.max_tokens,
					temperature: inputs.temperature,
				}),
			});
			if (!res.ok) {
				throw new Error(`ai ${res.status}: ${(await res.text()).slice(0, 500)}`);
			}
			const body = (await res.json()) as {
				choices?: { message?: { content?: string | number | null } }[];
			};
			return { response: String(body.choices?.[0]?.message?.content ?? "") };
		},
	};
	return ai as unknown as Ai;
}

/** The ai-sdk provider the agent uses in place of createWorkersAI({ binding }). */
export function gatewayModel(env: Cloudflare.Env, target?: GatewayCallFor) {
	return createOpenAICompatible({
		name: "every-app-gateway",
		baseURL: providerOf(env).base,
		// The gateway holds the key; the SDK drops the Authorization header.
		apiKey: "gateway-managed",
		fetch: createGatewayFetch({ env, for: target }),
	});
}

/** The agent's model: AGENT_MODEL, else the provider's default. */
export function agentModelId(env: ProviderEnv): string {
	return env.AGENT_MODEL?.trim() || providerOf(env).agent;
}

/**
 * A `send_email`-shaped binding over the gateway's email capability.
 *
 * Until that capability (platform PR 3) is in the linked SDK this is a
 * stand-in with the same signature (lane L2 replaces the body with the SDK's
 * sendEmail()): in local dev it logs the message and reports a `dev-` id;
 * anywhere else it refuses, so a deployed Worker never reports a send that
 * didn't happen.
 */
export function gatewayEmail(env: Cloudflare.Env, target?: GatewayCallFor): SendEmail {
	void target;
	const send = async (message: EmailMessage | EmailMessageBuilder): Promise<EmailSendResult> => {
		const summary = describeMessage(message);
		if (!env.EVERYAPP_DEV) {
			throw Object.assign(
				new Error(`Email sending isn't connected to the gateway yet; not sent: ${summary}`),
				{ code: "email_not_configured" },
			);
		}
		const messageId = `dev-${crypto.randomUUID()}`;
		console.log(`[agentic-inbox dev] email not sent (the gateway email capability isn't wired yet): ${summary} (${messageId})`);
		return { messageId };
	};
	return { send } as SendEmail;
}

function describeMessage(message: EmailMessage | EmailMessageBuilder): string {
	const m = message as { from?: unknown; to?: unknown; subject?: unknown };
	const address = (v: unknown): string =>
		typeof v === "string" ? v : v && typeof v === "object" && "email" in v ? String((v as { email: unknown }).email) : "";
	const to = Array.isArray(m.to) ? m.to.map(address).join(", ") : address(m.to);
	return `from ${address(m.from)} to ${to} subject ${JSON.stringify(typeof m.subject === "string" ? m.subject : "")}`;
}

/** The env upstream's code expects: AI and EMAIL present, both brokered by the gateway. */
export function withGateway(env: Cloudflare.Env, target?: GatewayCallFor): Env {
	return { ...env, AI: gatewayAi(env, target), EMAIL: gatewayEmail(env, target) };
}
