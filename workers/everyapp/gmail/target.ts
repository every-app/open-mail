/**
 * Whom GmailSync's Gmail calls are for, and how a mailbox's GmailSync is
 * found. Apart from ./sync.ts so the wrappers (and Node tests) don't load
 * `cloudflare:workers`.
 */
import { ConfigurationError, type GatewayCallFor } from "@every-app/sdk/server";
import { GmailError } from "./client";

export interface GmailErrorInfo {
	code: string;
	status: number;
	message: string;
	reconnect: boolean;
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: GmailErrorInfo };

/** A background call on one member's own Google connection. */
export type MemberBackground = { background: true; organizationId?: string; userId: string };

/**
 * Whether a person is behind `target`: the request whose identity the
 * calls carry. Sends need one: OpenMail never sends in the background.
 */
export function personBehind(target: GatewayCallFor | undefined): target is Request {
	return target instanceof Request;
}

/** Whether `target` names a member for background work (`for: { background: true, userId }`). */
export function onMembersBehalf(target: GatewayCallFor | undefined): target is MemberBackground {
	return (
		target !== undefined &&
		!(target instanceof Request) &&
		"background" in target &&
		target.background === true &&
		typeof (target as { userId?: unknown }).userId === "string" &&
		Boolean((target as { userId: string }).userId.trim())
	);
}

/**
 * Whether a Gmail call can be made for `target`: a person behind the
 * request, or background work naming the member whose connection it uses
 * (docs/GMAIL.md, "Background sync"). Background work that names nobody
 * (the agent's model calls) can't reach anyone's Gmail.
 */
export function canReachGmail(target: GatewayCallFor | undefined): target is Request | MemberBackground {
	return personBehind(target) || onMembersBehalf(target);
}

/**
 * The target of GmailSync's background work for a mailbox's owner: the
 * organization the deploy pins (EVERY_APP_ORG_ID; none under `everyapp
 * dev`) and the owner's user id.
 */
export function memberBackground(env: { EVERY_APP_ORG_ID?: string }, userId: string): MemberBackground {
	const organizationId = env.EVERY_APP_ORG_ID?.trim();
	return { background: true, ...(organizationId ? { organizationId } : {}), userId };
}

/** `target` as it crosses into the Durable Object: the request's headers (its identity), no body. */
export function forwardTarget<T extends GatewayCallFor | undefined>(target: T): T {
	if (!personBehind(target)) return target;
	return new Request(target.url, { headers: target.headers }) as T;
}

export function errorInfo(error: GmailError): GmailErrorInfo {
	return { code: error.code, status: error.status, message: error.message, reconnect: error.reconnect };
}

/**
 * A failure the routes answer for, or null for a bug (rethrown): Gmail's or
 * the Gateway's refusal, or no way to reach Gmail at all (no gateway
 * binding and, in `everyapp dev`, no GOOGLE_WORKSPACE_ACCESS_TOKEN).
 */
export function knownFailure(error: unknown): GmailErrorInfo | null {
	if (error instanceof GmailError) return errorInfo(error);
	if (error instanceof ConfigurationError) {
		return { code: "gmail_not_configured", status: 503, message: error.message, reconnect: false };
	}
	return null;
}

/** The GmailSync stub of a mailbox, named by its address. */
export function gmailSyncOf(env: Pick<Cloudflare.Env, "GMAIL_SYNC">, mailboxId: string) {
	return env.GMAIL_SYNC.get(env.GMAIL_SYNC.idFromName(mailboxId.trim().toLowerCase()));
}
