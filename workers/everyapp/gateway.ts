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
 * L2 owns gatewayEmail (./email.ts); withGateway() itself stays as it is.
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
	createGatewayFetch,
	gatewayRefusal,
	type GatewayCallFor,
} from "@every-app/sdk/server";
import type { Env } from "../types";
import { gatewayEmail } from "./email";

/**
 * Any origin does: the SDK sends the request's path over the
 * EVERY_APP_GATEWAY binding (or, in local dev with a key in `.dev.vars`,
 * straight to the provider).
 */
const GATEWAY = "http://every-app-gateway.internal";

/**
 * Where the app's model calls go: the Gateway's default model provider
 * unless the Worker was built with a pin (AI_PROVIDER). For each, where its
 * OpenAI-compatible API sits behind the gateway, the settings it needs (the
 * gateway's secrets, under the same names in `.dev.vars` for local
 * development), and the model ids the app sends.
 */
export const PROVIDERS = {
	// The Gateway's default (`ai.chat` in the manifest): the operator's choice
	// (`everyapp ai default <provider>`), else the first of OpenRouter, Workers
	// AI, OpenAI, Anthropic, Groq, Mistral and Gemini whose key is set. The
	// Gateway decides, so the app names no setting, and "default" as the
	// model is the operator's model, filled in by the Gateway.
	default: {
		base: `${GATEWAY}/api/ai/default/v1`,
		settings: [],
		scanner: "default",
		verifier: "default",
		agent: "default",
	},
	// Pins, for an operator who wants one provider (AI_PROVIDER=workers-ai or
	// openrouter when the Worker is built), or a developer who wants
	// `everyapp dev` to call one provider directly.
	"workers-ai": {
		base: `${GATEWAY}/api/ai/workers-ai/v1`,
		settings: ["WORKERS_AI_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
		scanner: "@cf/meta/llama-3.1-8b-instruct-fast",
		verifier: "@cf/meta/llama-4-scout-17b-16e-instruct",
		// Function calling at 300 requests a minute. Its numeric tokens arrive
		// as JSON numbers, which the gateway turns back into strings.
		agent: "@cf/meta/llama-4-scout-17b-16e-instruct",
	},
	openrouter: {
		base: `${GATEWAY}/api/ai/openrouter/api/v1`,
		settings: ["OPENROUTER_API_KEY"],
		scanner: "meta-llama/llama-3.1-8b-instruct",
		verifier: "meta-llama/llama-4-scout",
		// Llama 4 Scout writes tool calls out as text often enough to leave
		// "draft_reply(...)" as a draft's body; Haiku calls them.
		agent: "anthropic/claude-haiku-5.5",
	},
} as const;

type ProviderEnv = Pick<Cloudflare.Env, "AI_PROVIDER" | "AGENT_MODEL">;

export type ProviderId = keyof typeof PROVIDERS;

/**
 * The provider id AI_PROVIDER selects: the pin when it names one
 * ("openrouter" or "workers-ai"), else (empty, unset, anything else) the
 * Gateway's default.
 */
export function providerIdOf(env: Pick<Cloudflare.Env, "AI_PROVIDER">): ProviderId {
	const pin = env.AI_PROVIDER?.trim();
	return pin === "openrouter" || pin === "workers-ai" ? pin : "default";
}

/** The provider AI_PROVIDER selects. */
export function providerOf(env: Pick<Cloudflare.Env, "AI_PROVIDER">) {
	return PROVIDERS[providerIdOf(env)];
}

/**
 * The step on the default route: any one model provider's key (OpenRouter's
 * first, as the Gateway's order and its setup ask), or the operator's pick.
 */
export const DEFAULT_SETUP_STEP =
	"An admin sets one model provider's key (OpenRouter first): `pnpm everyapp secret set OPENROUTER_API_KEY`, or picks one with `pnpm everyapp ai default <provider>`.";

/**
 * The step that sets the selected provider's key on the gateway, which every
 * "AI isn't set up" sentence ends with: the key's name and the command that
 * sets it (on the default route, DEFAULT_SETUP_STEP). Nothing else: pinning
 * a provider is a redeploy with AI_PROVIDER (read when the Worker is built),
 * which is the operator's business and docs/EVERY_APP.md's to say, not a
 * sentence a member reads.
 */
export function aiProviderSetupStep(env: Pick<Cloudflare.Env, "AI_PROVIDER">): string {
	const id = providerIdOf(env);
	if (id === "default") return DEFAULT_SETUP_STEP;
	const name = PROVIDERS[id].settings[0];
	return `An admin sets ${name} with \`pnpm everyapp secret set ${name}\`.`;
}

/**
 * The gateway's refusals that mean no model is set up for this call: the
 * pinned provider's key isn't set (`ai_provider_not_configured`), or the
 * default resolves to nothing configured (`ai_default_not_configured`).
 */
export function isNotConfigured(code: string | undefined): boolean {
	return code === "ai_provider_not_configured" || code === "ai_default_not_configured";
}

/**
 * What a person reads when the gateway refuses a model call with
 * `ai_default_not_configured` (no model provider's key is set, or the
 * operator's pick isn't) or `ai_provider_not_configured` (a pinned
 * provider's key isn't set). One plain sentence, then the step. The
 * manifest's `ai.chat` keeps the app shut until a provider is set up, so
 * this is mostly what a Worker says when a key is unset later, or when it is
 * pinned to a provider whose key the gateway doesn't hold. The auto-draft
 * skip shows it as is ("No draft for this email: …"); the chat says what it
 * can't do first (aiFailureMessage()).
 */
export function aiProviderNotSetUpMessage(env: Pick<Cloudflare.Env, "AI_PROVIDER">): string {
	return `AI isn't set up on this gateway yet. ${aiProviderSetupStep(env)}`;
}

/**
 * Workers AI's deprecated Kimi id answers as kimi-k2.6 (paid-only, 20
 * requests a minute per account); sending the current id makes the usage log
 * name the model that is billed.
 */
const WORKERS_AI_MODELS: Record<string, string> = {
	"@cf/moonshotai/kimi-k2.5": "@cf/moonshotai/kimi-k2.6",
};

/** OpenRouter's ids for the Workers AI models upstream's code names. */
const OPENROUTER_MODELS: Record<string, string> = {
	[PROVIDERS["workers-ai"].scanner]: PROVIDERS.openrouter.scanner,
	[PROVIDERS["workers-ai"].verifier]: PROVIDERS.openrouter.verifier,
	"@cf/moonshotai/kimi-k2.5": "moonshotai/kimi-k2.6",
	"@cf/moonshotai/kimi-k2.6": "moonshotai/kimi-k2.6",
};

/**
 * The id to send for `model`. Upstream's code (lib/ai.ts) and AGENT_MODEL may
 * name Workers AI models. On the default route those become "default" (the
 * operator's model: the default may be any provider, and few serve `@cf/`
 * ids), and any other id is sent as it is (the operator's provider must
 * serve it). Pinned to OpenRouter they become OpenRouter's ids for the same
 * models. On a pin, any other id is sent as it is (the manifest's
 * `ai.models` decides whether the gateway accepts it; the default route
 * doesn't read that list).
 */
export function mapModel(env: Pick<Cloudflare.Env, "AI_PROVIDER">, model: string): string {
	const id = providerIdOf(env);
	if (id === "default") return model.startsWith("@cf/") ? "default" : model;
	const models = id === "openrouter" ? OPENROUTER_MODELS : WORKERS_AI_MODELS;
	return models[model] ?? model;
}

interface RunInputs {
	messages: unknown[];
	max_tokens?: number;
	temperature?: number;
}

/** Why each `Ai` from gatewayAi() last failed, cleared by its next success. */
const lastFailures = new WeakMap<object, string>();

/**
 * Why the last `run()` on this `Ai` failed, if it did. lib/ai.ts fails
 * closed on any error (the scanner then reports prompt injection), so the
 * agent asks here whether the model call ran at all before it tells anyone
 * an email looks malicious.
 */
export function aiFailureOf(ai: Ai): string | undefined {
	return lastFailures.get(ai);
}

/**
 * An `Ai`-shaped object: the `run()` subset lib/ai.ts uses (messages,
 * max_tokens, temperature; non-streaming), as an OpenAI-compatible chat
 * completion through the gateway. Never sends `stream_options` (Workers AI
 * answers 400 on a non-streaming call that carries it). Throws on any
 * failure, as a binding's `run()` does, with the gateway's refusal (code and
 * message) when the gateway refused the call, or, when no model is set up on
 * the gateway (isNotConfigured()), the sentence that names the key to set:
 * the agent shows it where it skips an auto-draft.
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
			try {
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
					const refusal = await gatewayRefusal(res.clone());
					if (isNotConfigured(refusal?.code)) throw new Error(aiProviderNotSetUpMessage(env));
					throw new Error(
						refusal
							? `ai ${res.status} ${refusal.code}: ${refusal.message}`
							: `ai ${res.status}: ${(await res.text()).slice(0, 500)}`,
					);
				}
				const body = (await res.json()) as {
					choices?: { message?: { content?: string | number | null } }[];
				};
				lastFailures.delete(ai);
				// Workers AI may send an all-digit reply as a JSON number.
				return { response: String(body.choices?.[0]?.message?.content ?? "") };
			} catch (error) {
				lastFailures.set(ai, error instanceof Error ? error.message : String(error));
				throw error;
			}
		},
	};
	return ai as unknown as Ai;
}

/**
 * The ai-sdk provider the agent uses in place of createWorkersAI({ binding }):
 * OpenAI-compatible chat completions on the selected provider's path through
 * the gateway (`provider.chatModel(agentModelId(env))`). Throws
 * ConfigurationError when there is neither a gateway binding nor a dev key
 * (aiSetupProblem() in ./agent-ai.ts says so first).
 */
export function gatewayModel(env: Cloudflare.Env, target?: GatewayCallFor) {
	return createOpenAICompatible({
		name: "every-app-gateway",
		baseURL: providerOf(env).base,
		// The gateway holds the key; the SDK drops the Authorization header.
		apiKey: "gateway-managed",
		fetch: createGatewayFetch({ env, for: target }),
	});
}

/**
 * The agent's model: AGENT_MODEL, else the provider's default, as the
 * provider names it ("default" on the default route: the operator's model).
 */
export function agentModelId(env: ProviderEnv): string {
	return mapModel(env, env.AGENT_MODEL?.trim() || providerOf(env).agent);
}

/**
 * `env.EMAIL`: the gateway's email capability as a `send_email` binding,
 * over the SDK's sendEmail() (lane L2; the adapter lives in ./email.ts).
 */
export { gatewayEmail };

/** The env upstream's code expects: AI and EMAIL present, both brokered by the gateway. */
export function withGateway(env: Cloudflare.Env, target?: GatewayCallFor): Env {
	return { ...env, AI: gatewayAi(env, target), EMAIL: gatewayEmail(env, target) };
}
