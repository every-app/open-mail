/**
 * The chat agent's side of the gateway's AI (workers/agent/index.ts): whom a
 * mailbox's model calls are for, what the agent says when AI isn't set up,
 * and every failure as a sentence the chat shows.
 *
 * The chat panel renders the assistant's text and tool calls but not a
 * stream error (upstream's AgentPanel reads no `error`), so a failure reaches
 * the person as an assistant message: "AI isn't set up on this gateway (…)
 * or in .dev.vars (…)", "AI isn't set up on this gateway yet, so I can't
 * help with this inbox. An admin sets …" (no model set up on the gateway),
 * or the gateway's refusal.
 */
import {
	ConfigurationError,
	createGatewayFetch,
	type GatewayCallFor,
} from "@every-app/sdk/server";
import {
	APICallError,
	createUIMessageStream,
	createUIMessageStreamResponse,
	type UIMessage,
	type UIMessageChunk,
} from "ai";
import { aiProviderNotSetUpMessage, aiProviderSetupStep, isNotConfigured, providerIdOf, providerOf } from "./gateway";

/**
 * Whom a mailbox's agent calls are for. Nothing a person sent starts them
 * (an inbound email, a chat turn on a Durable Object), so they are the
 * organization's background work: named when the Worker knows its
 * organization (an org-owned deploy sets EVERY_APP_ORG_ID), else the app's
 * own (local dev), which the gateway attributes to the app's organization.
 */
export function forMailbox(env: Pick<Cloudflare.Env, "EVERY_APP_ORG_ID">): GatewayCallFor | undefined {
	const organizationId = env.EVERY_APP_ORG_ID?.trim();
	return organizationId ? { background: true, organizationId } : undefined;
}

/**
 * What the agent says when no model can be reached, naming what to set. In
 * practice local development's (a deployed Worker has the gateway binding):
 * on the default route any model provider's key in `.dev.vars` (the SDK
 * resolves the default on it, OpenRouter first), on a pin that provider's.
 */
export function aiNotSetUpMessage(env: Pick<Cloudflare.Env, "AI_PROVIDER">): string {
	if (providerIdOf(env) === "default") {
		return "AI isn't set up on this gateway (a model provider's key, OpenRouter's first) or in .dev.vars (OPENROUTER_API_KEY, or another model provider's key).";
	}
	const { settings } = providerOf(env);
	return `AI isn't set up on this gateway (${settings[0]}) or in .dev.vars (${settings.join(" and ")}).`;
}

/**
 * Why the agent can't call a model, as far as the app can tell before it
 * tries; null when it can. With a gateway binding the gateway decides (its
 * refusals are readable, see aiFailureMessage()); in local development a
 * pinned provider needs every setting in `.dev.vars` (the default route
 * names none: the SDK resolves it, and says so when it can't). An AttributionError
 * (a call that doesn't say whom it is for where it must) is a bug and is
 * thrown, not shown.
 */
export function aiSetupProblem(env: Cloudflare.Env, target?: GatewayCallFor): string | null {
	try {
		createGatewayFetch({ env, for: target });
	} catch (error) {
		if (error instanceof ConfigurationError) return aiNotSetUpMessage(env);
		throw error;
	}
	if (env.EVERY_APP_GATEWAY) return null;
	const values = env as unknown as Record<string, unknown>;
	const missing = providerOf(env).settings.filter((name) => {
		const value = values[name];
		return typeof value !== "string" || !value.trim();
	});
	return missing.length > 0 ? aiNotSetUpMessage(env) : null;
}

/**
 * A failed model call as a sentence: the configuration message, what the
 * agent can't do and the key to set when no model is set up on the gateway
 * (`ai_default_not_configured`, or `ai_provider_not_configured` on a pin:
 * aiProviderSetupStep()), any other gateway refusal with its code
 * (`model_not_allowed`, …, read from the response body), or the provider's
 * own error. (An AttributionError can only come from making the gateway
 * fetch, which aiSetupProblem() does first and throws.)
 */
export function aiFailureMessage(env: Cloudflare.Env, error: unknown): string {
	if (error instanceof ConfigurationError) return aiNotSetUpMessage(env);
	if (APICallError.isInstance(error)) {
		const refusal = refusalOf(error);
		if (isNotConfigured(refusal?.code)) {
			return `AI isn't set up on this gateway yet, so I can't help with this inbox. ${aiProviderSetupStep(env)}`;
		}
		if (refusal) return `The gateway refused the AI call: ${refusal.message} (${refusal.code})`;
		return `The AI provider answered ${error.statusCode ?? "with an error"}: ${error.message || "no details"}`;
	}
	return error instanceof Error && error.message ? error.message : "The AI call failed.";
}

/** The gateway's refusal behind an ai-sdk APICallError, from its header and body. */
function refusalOf(error: APICallError): { code: string; message: string } | null {
	// ai-sdk records the response's headers by their lowercase names.
	const code = error.responseHeaders?.["x-everyapp-error"];
	if (!code) return null;
	let message = error.message;
	try {
		const body = JSON.parse(error.responseBody ?? "") as {
			message?: unknown;
			error?: { message?: unknown } | string;
		};
		if (typeof body.message === "string") message = body.message;
		else if (typeof body.error === "object" && typeof body.error?.message === "string") message = body.error.message;
		else if (typeof body.error === "string") message = body.error;
	} catch {
		// not JSON: keep the error's own message
	}
	return { code, message: message || `The Every App gateway refused the call (${code}).` };
}

/** One assistant text part, as UI message chunks. */
function textChunks(text: string): UIMessageChunk[] {
	const id = `notice-${crypto.randomUUID()}`;
	return [
		{ type: "text-start", id },
		{ type: "text-delta", id, delta: text },
		{ type: "text-end", id },
	];
}

/** A chat reply that is only `text`, for when the agent can't run (aiSetupProblem()). */
export function chatNotice(text: string): Response {
	return createUIMessageStreamResponse({
		stream: createUIMessageStream({
			execute: ({ writer }) => {
				writer.write({ type: "start" });
				for (const chunk of textChunks(`⚠️ ${text}`)) writer.write(chunk);
				writer.write({ type: "finish" });
			},
		}),
	});
}

/**
 * The agent's reply stream as the chat's response, each `error` chunk
 * turned into an assistant text part the chat panel shows. Pass the
 * stream from `result.toUIMessageStream({ onError })` with aiFailureMessage()
 * as `onError` so the text is the readable reason.
 */
export function chatReply(stream: ReadableStream<UIMessageChunk>): Response {
	return createUIMessageStreamResponse({
		stream: stream.pipeThrough(
			new TransformStream<UIMessageChunk, UIMessageChunk>({
				transform(chunk, controller) {
					if (chunk.type !== "error") {
						controller.enqueue(chunk);
						return;
					}
					console.error("Agent chat failed:", chunk.errorText);
					for (const text of textChunks(`⚠️ ${chunk.errorText}`)) controller.enqueue(text);
				},
			}),
		),
	});
}

/**
 * Why an auto-draft is skipped when the prompt-injection scan didn't run
 * (`aiFailureOf()` after `isPromptInjection()` failed closed): the not-set-up
 * sentence by itself, since nothing about the scan helps the person reading
 * it, and any other failure as the scan's.
 */
export function scanFailureReason(env: Pick<Cloudflare.Env, "AI_PROVIDER">, failure: string): string {
	return failure === aiProviderNotSetUpMessage(env) ? failure : `the prompt-injection scan couldn't run (${failure})`;
}

/**
 * Skip a new email's auto-draft and say why in the agent's chat, as upstream
 * does when it blocks one: the email stays in the inbox, only the draft is
 * not written. The note leads with what didn't happen ("No draft for this
 * email: …"), and the reason is one plain sentence (scanFailureReason()).
 */
export async function skipAutoDraft(
	agent: { messages: UIMessage[]; persistMessages(messages: UIMessage[]): Promise<void> },
	email: { emailId: string; sender: string; subject: string },
	reason: string,
): Promise<{ status: "skipped"; reason: string }> {
	console.warn(`Skipping auto-draft for ${email.emailId}: ${reason}`);
	const trigger = `New email from ${email.sender}: "${email.subject}"`;
	const note = `⚠️ No draft for this email: ${reason}`;
	await agent.persistMessages([
		...agent.messages,
		{ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: trigger }] },
		{ id: crypto.randomUUID(), role: "assistant", parts: [{ type: "text", text: note }] },
	]);
	return { status: "skipped", reason };
}
