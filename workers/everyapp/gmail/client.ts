/**
 * Gmail's REST API through the gateway's held-token proxy (docs/GMAIL.md).
 *
 * The gateway holds each person's Google connection, made in OpenMail, and
 * puts the token on the call; the app never sees one. Every call is for one
 * person: the request's (`for: request`), or the mailbox owner's from
 * GmailSync's alarm (`for: { background: true, userId }`).
 *
 * In `everyapp dev` there is no gateway: the SDK sends the developer's own
 * token from `.dev.vars` (GOOGLE_WORKSPACE_ACCESS_TOKEN) straight to Google.
 */
import { gatewayRefusal, integrationFetch, type GatewayCallFor } from "@every-app/sdk/server";

export const GOOGLE_PROVIDER = "google-workspace";
const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

/** A Gmail call that failed: the gateway's refusal code, or Google's status. */
export class GmailError extends Error {
	constructor(
		message: string,
		readonly status: number,
		/** The gateway's code (`integration_not_connected`, …) or Google's reason. */
		readonly code: string,
		/** The person has to connect (or reconnect) Google. */
		readonly reconnect = false,
	) {
		super(message);
		this.name = "GmailError";
	}
}

export interface GmailHeader {
	name: string;
	value: string;
}

export interface GmailMessageRef {
	id: string;
	threadId: string;
}

export interface GmailMessage extends GmailMessageRef {
	labelIds?: string[];
	snippet?: string;
	historyId?: string;
	internalDate?: string;
	sizeEstimate?: number;
	/** base64url RFC 822, with `format: "raw"`. */
	raw?: string;
	payload?: { headers?: GmailHeader[] };
}

export interface GmailDraft {
	id: string;
	message: GmailMessage;
}

export interface GmailLabel {
	id: string;
	name: string;
	type?: "system" | "user";
	/** A user label's color, from Gmail's fixed palette (./label-sync.ts maps it). */
	color?: GmailLabelColor;
	messagesTotal?: number;
	messagesUnread?: number;
	threadsTotal?: number;
	threadsUnread?: number;
}

export interface GmailLabelColor {
	backgroundColor?: string;
	textColor?: string;
}

export interface GmailHistoryRecord {
	id: string;
	messagesAdded?: { message: GmailMessage }[];
	messagesDeleted?: { message: GmailMessage }[];
	labelsAdded?: { message: GmailMessage; labelIds: string[] }[];
	labelsRemoved?: { message: GmailMessage; labelIds: string[] }[];
}

export interface GmailProfile {
	emailAddress: string;
	messagesTotal: number;
	threadsTotal: number;
	historyId: string;
}

export type GmailFetch = (path: string, init?: RequestInit & { query?: Record<string, string | string[] | undefined> }) => Promise<unknown>;

/**
 * A Gmail client for one person. `target` is the request whose person the
 * calls are for; `fetcher` replaces the SDK's integrationFetch in tests.
 */
export function gmailClient(env: object, target: GatewayCallFor, fetcher?: typeof fetch) {
	const send = fetcher ?? integrationFetch({ env, provider: GOOGLE_PROVIDER, for: target });

	const call: GmailFetch = async (path, init = {}) => {
		const { query, ...rest } = init;
		const url = new URL(BASE + path);
		for (const [key, value] of Object.entries(query ?? {})) {
			if (value === undefined) continue;
			for (const v of Array.isArray(value) ? value : [value]) url.searchParams.append(key, v);
		}
		const headers = new Headers(rest.headers);
		if (rest.body && !headers.has("content-type")) headers.set("content-type", "application/json");
		const response = await send(url.toString(), { ...rest, headers });
		if (response.ok) return response.status === 204 ? null : response.json();
		throw await gmailErrorOf(response);
	};

	return {
		call,
		profile: () => call("/profile") as Promise<GmailProfile>,

		listMessages: (q: { q?: string; labelIds?: string[]; maxResults?: number; pageToken?: string }) =>
			call("/messages", {
				query: { q: q.q, labelIds: q.labelIds, maxResults: q.maxResults?.toString(), pageToken: q.pageToken },
			}) as Promise<{ messages?: GmailMessageRef[]; nextPageToken?: string; resultSizeEstimate?: number }>,

		getMessage: (id: string, format: "raw" | "metadata" | "minimal" = "raw") =>
			call(`/messages/${encodeURIComponent(id)}`, { query: { format } }) as Promise<GmailMessage>,

		getAttachment: (messageId: string, attachmentId: string) =>
			call(`/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`) as Promise<{ data: string; size: number }>,

		history: (startHistoryId: string, pageToken?: string) =>
			call("/history", {
				query: {
					startHistoryId,
					pageToken,
					historyTypes: ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"],
				},
			}) as Promise<{ history?: GmailHistoryRecord[]; historyId: string; nextPageToken?: string }>,

		modifyMessage: (id: string, addLabelIds: string[] = [], removeLabelIds: string[] = []) =>
			call(`/messages/${encodeURIComponent(id)}/modify`, {
				method: "POST",
				body: JSON.stringify({ addLabelIds, removeLabelIds }),
			}) as Promise<GmailMessage>,

		modifyThread: (id: string, addLabelIds: string[] = [], removeLabelIds: string[] = []) =>
			call(`/threads/${encodeURIComponent(id)}/modify`, {
				method: "POST",
				body: JSON.stringify({ addLabelIds, removeLabelIds }),
			}),

		trashMessage: (id: string) => call(`/messages/${encodeURIComponent(id)}/trash`, { method: "POST" }) as Promise<GmailMessage>,
		untrashMessage: (id: string) => call(`/messages/${encodeURIComponent(id)}/untrash`, { method: "POST" }) as Promise<GmailMessage>,

		listLabels: async () => ((await call("/labels")) as { labels?: GmailLabel[] }).labels ?? [],
		getLabel: (id: string) => call(`/labels/${encodeURIComponent(id)}`) as Promise<GmailLabel>,
		createLabel: (name: string, color?: GmailLabelColor) =>
			call("/labels", {
				method: "POST",
				body: JSON.stringify({ name, labelListVisibility: "labelShow", messageListVisibility: "show", ...(color ? { color } : {}) }),
			}) as Promise<GmailLabel>,
		/** labels.patch: rename or recolor. */
		patchLabel: (id: string, changes: { name?: string; color?: GmailLabelColor }) =>
			call(`/labels/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(changes) }) as Promise<GmailLabel>,
		/** labels.delete: the label comes off every message, no mail is touched. */
		deleteLabel: (id: string) => call(`/labels/${encodeURIComponent(id)}`, { method: "DELETE" }),

		/** `raw`: base64url RFC 822 (mime.ts builds it); `threadId` files it in a thread. */
		createDraft: (raw: string, threadId?: string) =>
			call("/drafts", { method: "POST", body: JSON.stringify({ message: { raw, threadId } }) }) as Promise<GmailDraft>,
		updateDraft: (id: string, raw: string, threadId?: string) =>
			call(`/drafts/${encodeURIComponent(id)}`, {
				method: "PUT",
				body: JSON.stringify({ id, message: { raw, threadId } }),
			}) as Promise<GmailDraft>,
		deleteDraft: (id: string) => call(`/drafts/${encodeURIComponent(id)}`, { method: "DELETE" }),
		listDrafts: (q: { maxResults?: number; pageToken?: string } = {}) =>
			call("/drafts", {
				query: { maxResults: q.maxResults?.toString(), pageToken: q.pageToken },
			}) as Promise<{ drafts?: { id: string; message: GmailMessageRef }[]; nextPageToken?: string }>,
		getDraft: (id: string) => call(`/drafts/${encodeURIComponent(id)}`, { query: { format: "minimal" } }) as Promise<GmailDraft>,

		/** Only for a person's own Send (./send.ts). */
		sendMessage: (raw: string, threadId?: string) =>
			call("/messages/send", { method: "POST", body: JSON.stringify({ raw, threadId }) }) as Promise<GmailMessage>,
	};
}

export type GmailClient = ReturnType<typeof gmailClient>;

async function gmailErrorOf(response: Response): Promise<GmailError> {
	const refusal = await gatewayRefusal(response.clone());
	if (refusal) {
		const reconnect =
			refusal.code === "integration_not_connected" || Boolean((refusal as { reconnect?: boolean }).reconnect);
		return new GmailError(refusal.message ?? refusal.code, response.status, refusal.code, reconnect);
	}
	const body = (await response.json().catch(() => null)) as {
		error?: { message?: string; status?: string; errors?: { reason?: string }[] };
	} | null;
	const reason = body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? `http_${response.status}`;
	return new GmailError(
		body?.error?.message ?? `Gmail answered ${response.status}`,
		response.status,
		reason,
		response.status === 401,
	);
}

/** base64url to bytes and back (Gmail's `raw` and attachment `data`). */
export function fromBase64Url(data: string): Uint8Array {
	const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
	const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
	return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function toBase64Url(bytes: Uint8Array | string): string {
	const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
	let bin = "";
	for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The Gmail web UI link that opens one draft for the person to review and send. */
export function gmailDraftUrl(address: string, gmailMessageId: string): string {
	return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(address)}#drafts?compose=${encodeURIComponent(gmailMessageId)}`;
}

export function gmailThreadUrl(address: string, gmailThreadId: string): string {
	return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(address)}#all/${encodeURIComponent(gmailThreadId)}`;
}
