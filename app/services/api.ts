// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Email, Folder, Mailbox } from "~/types";

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * What a person reads for the refusals the gateway and this app answer with.
 * Refusals are `{ error: <code>, message? }` (the gateway's email capability,
 * relayed by the send routes as 502) or `{ error, code }` (the role check);
 * upstream's own routes put readable text in `error`, which passes through.
 * Each names the next step once, for the person who can take it; plain text,
 * since the composer's banner and the toasts render no markup. The composer
 * fills `<domain>` with the mailbox's own (useComposeForm's send).
 */
const REFUSAL_MESSAGES: Record<string, string> = {
	email_sender_not_allowed:
		"This mailbox's domain isn't allowed to send yet. An owner or admin allows it in the app's directory with pnpm everyapp email set --sender '*@<domain>'. Your mail is kept here.",
	email_sender_not_verified:
		"This mailbox's domain isn't verified for sending yet. An owner or admin onboards it to Email Sending on the gateway's Cloudflare account. Your mail is kept here.",
	email_budget_exhausted:
		"The gateway's sending limit for today is reached. Try again later.",
	email_provider_limited:
		"Cloudflare Email Sending is limiting this account right now. Try again later.",
	email_message_too_large:
		"This email is too large to send (5 MB at most, attachments included).",
	email_attachments_unsupported:
		"This gateway can't send attachments yet. Remove them and send again.",
	email_invalid_message:
		"The gateway refused this email as malformed. Check the recipients and try again.",
	email_send_failed: "The email couldn't be sent. Try again in a moment.",
	email_not_configured:
		"Email sending isn't set up on this gateway. An owner or admin sets its sender with pnpm everyapp secret set EMAIL_FROM EMAIL_FROM_NAME. Your mail is kept here; save it as a draft for now.",
	integration_not_configured:
		"Email sending isn't set up on this gateway. An owner or admin sets its sender with pnpm everyapp secret set EMAIL_FROM EMAIL_FROM_NAME. Your mail is kept here; save it as a draft for now.",
	capability_not_requested:
		"This app isn't allowed to send email on this gateway (its manifest doesn't request the email capability).",
	integration_read_only: "This connection is read only; it can't send email.",
	admin_required: "Only the organization's owners and admins can do this.",
	unauthenticated: "Your session has ended. Reload the page to sign in again.",
};

const text = (value: unknown) =>
	typeof value === "string" && value.trim() ? value : undefined;

/** A machine code (`email_sender_not_allowed`), never upstream's readable `error` text. */
function refusalCode(body: Record<string, unknown>): string | undefined {
	const code = text(body.code) ?? text(body.error);
	return code && /^[a-z][a-z0-9_]*$/.test(code) ? code : undefined;
}

function refusalMessage(status: number, body: Record<string, unknown>): string {
	const code = refusalCode(body);
	return (
		(code && REFUSAL_MESSAGES[code]) ||
		text(body.message) ||
		text(body.error) ||
		`Request failed: ${status}`
	);
}

export class ApiError extends Error {
	status: number;
	/** The refusal code (`body.code`, else a code-shaped `body.error`), e.g. `email_sender_not_allowed`. */
	code: string | undefined;
	body: Record<string, unknown>;

	constructor(status: number, body: Record<string, unknown>) {
		super(refusalMessage(status, body));
		this.name = "ApiError";
		this.status = status;
		this.code = refusalCode(body);
		this.body = body;
	}
}

const RELOAD_STAMP_KEY = "agentic-inbox:reloaded-for-401";
const RELOAD_GUARD_MS = 10_000;

/**
 * The gateway answers a request whose session has ended with 401 (JSON, no
 * redirect), so reload the page: the navigation goes through the gateway,
 * which sends the person to sign in. Once per 10 s at most, so a 401 the
 * gateway answers right after a reload can't loop.
 */
export function reloadForSignIn(): boolean {
	if (typeof window === "undefined") return false;
	try {
		const last = Number(window.sessionStorage.getItem(RELOAD_STAMP_KEY) ?? 0);
		if (Date.now() - last < RELOAD_GUARD_MS) return false;
		window.sessionStorage.setItem(RELOAD_STAMP_KEY, String(Date.now()));
	} catch {
		// sessionStorage unavailable: reload anyway.
	}
	window.location.reload();
	return true;
}

async function request<T>(
	url: string,
	options: RequestInit = {},
): Promise<T> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	// Combine caller signal (e.g. TanStack Query abort) with our timeout signal
	const signal = options.signal
		? AbortSignal.any([options.signal, controller.signal])
		: controller.signal;

	try {
		const res = await fetch(url, {
			...options,
			signal,
			headers: {
				"Content-Type": "application/json",
				...(options.headers as Record<string, string>),
			},
		});

		if (!res.ok) {
			if (res.status === 401) reloadForSignIn();
			const body = await res.json().catch(() => ({}));
			throw new ApiError(res.status, body as Record<string, unknown>);
		}

		if (res.status === 204) return undefined as T;

		const contentType = res.headers.get("content-type") ?? "";
		if (contentType.includes("application/json")) {
			return res.json() as Promise<T>;
		}
		return res.blob() as unknown as T;
	} finally {
		clearTimeout(timeout);
	}
}

function get<T>(url: string, opts?: { params?: Record<string, string>; responseType?: string; signal?: AbortSignal }) {
	const query = opts?.params ? `?${new URLSearchParams(opts.params)}` : "";
	return request<T>(`${url}${query}`, {
		method: "GET",
		signal: opts?.signal,
		...(opts?.responseType === "blob" ? { headers: { Accept: "*/*" } } : {}),
	});
}

function post<T>(url: string, body?: unknown, opts?: { signal?: AbortSignal }) {
	return request<T>(url, {
		method: "POST",
		signal: opts?.signal,
		body: body != null ? JSON.stringify(body) : undefined,
	});
}

function put<T>(url: string, body?: unknown) {
	return request<T>(url, {
		method: "PUT",
		body: body != null ? JSON.stringify(body) : undefined,
	});
}

function del<T>(url: string) {
	return request<T>(url, { method: "DELETE" });
}

// ---------- Typed response shapes ----------

interface EmailListResponse {
	emails: Email[];
	totalCount: number;
}

/** `GET /api/v1/config`. `ready` is whether the gateway can send mail (absent: unknown). */
export interface AppConfig {
	domains: string[];
	emailAddresses: string[];
	ready?: boolean;
}

/** `GET /api/v1/me`: the verified person, from the gateway's identity. */
export interface Me {
	id: string;
	email: string;
	orgId: string;
	role: "owner" | "admin" | "member";
	/**
	 * The gateway's origin (sign-out, personal access tokens, its `/mcp`);
	 * null only if the Worker knows no gateway URL (never under `everyapp
	 * dev` or a deploy, which both set the identity issuer).
	 */
	gatewayUrl: string | null;
}

// ---------- API client ----------

const api = {
	// Config
	getConfig: () => get<AppConfig>("/api/v1/config"),
	getMe: () => get<Me>("/api/v1/me"),

	// Mailboxes
	listMailboxes: () => get<Mailbox[]>("/api/v1/mailboxes"),
	createMailbox: (email: string, name: string, settings?: unknown) =>
		post<Mailbox>("/api/v1/mailboxes", { email, name, settings }),
	getMailbox: (mailboxId: string) =>
		get<Mailbox>(`/api/v1/mailboxes/${mailboxId}`),
	updateMailbox: (mailboxId: string, settings: unknown) =>
		put<Mailbox>(`/api/v1/mailboxes/${mailboxId}`, { settings }),
	deleteMailbox: (mailboxId: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}`),

	// Emails
	listEmails: (mailboxId: string, params: Record<string, string>, opts?: { signal?: AbortSignal }) =>
		get<EmailListResponse | Email[]>(`/api/v1/mailboxes/${mailboxId}/emails`, { params, signal: opts?.signal }),
	sendEmail: (mailboxId: string, email: unknown) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails`, email),
	getEmail: (mailboxId: string, id: string, opts?: { signal?: AbortSignal }) =>
		get<Email>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`, { signal: opts?.signal }),
	updateEmail: (mailboxId: string, id: string, data: unknown) =>
		put<Email>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`, data),
	deleteEmail: (mailboxId: string, id: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`),
	moveEmail: (mailboxId: string, id: string, folderId: string) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails/${id}/move`, { folderId }),
	getThread: (mailboxId: string, threadId: string, opts?: { signal?: AbortSignal }) =>
		get<Email[]>(`/api/v1/mailboxes/${mailboxId}/threads/${threadId}`, { signal: opts?.signal }),
	markThreadRead: (mailboxId: string, threadId: string) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/threads/${threadId}/read`),
	getAttachment: (mailboxId: string, emailId: string, attachmentId: string) =>
		get<Blob>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/attachments/${attachmentId}`, { responseType: "blob" }),
	saveDraft: (
		mailboxId: string,
		draft: {
			to?: string;
			cc?: string;
			bcc?: string;
			subject?: string;
			body: string;
			in_reply_to?: string;
			thread_id?: string;
			draft_id?: string;
		},
	) => post<{ draft_id: string }>(`/api/v1/mailboxes/${mailboxId}/drafts`, draft),
	replyToEmail: (mailboxId: string, emailId: string, email: unknown) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/reply`, email),
	forwardEmail: (mailboxId: string, emailId: string, email: unknown) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/forward`, email),

	// Folders
	listFolders: (mailboxId: string) =>
		get<Folder[]>(`/api/v1/mailboxes/${mailboxId}/folders`),
	createFolder: (mailboxId: string, name: string) =>
		post<Folder>(`/api/v1/mailboxes/${mailboxId}/folders`, { name }),
	updateFolder: (mailboxId: string, id: string, name: string) =>
		put<Folder>(`/api/v1/mailboxes/${mailboxId}/folders/${id}`, { name }),
	deleteFolder: (mailboxId: string, id: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/folders/${id}`),

	// Search
	searchEmails: (mailboxId: string, params: Record<string, string>) =>
		get<EmailListResponse | Email[]>(`/api/v1/mailboxes/${mailboxId}/search`, { params }),
};

export default api;

/** The `/api/v1/me` query, shared by every component that needs the person. */
export const meQuery = {
	queryKey: ["me"] as const,
	queryFn: () => api.getMe(),
	staleTime: 5 * 60_000,
};
