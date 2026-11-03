/**
 * The Gmail routes (docs/GMAIL.md, "API"). The port's own module: the
 * routes live in workers/everyapp/gmail/routes.ts; refusals read as sentences through
 * app/services/api.ts.
 */
import type { PortMailboxSettings } from "../../workers/everyapp/mailbox-settings";
import type { Mailbox, MailboxSettings } from "~/types";
import { ApiError, apiRequest } from "./api";

export type { PortMailboxSettings };

/** A mailbox's settings with the port's fields (`provider`, `ownerId`). */
export type PortSettings = MailboxSettings & PortMailboxSettings;

/** A mailbox as the list and detail routes answer it, with the port's settings. */
export type PortMailbox = Omit<Mailbox, "settings"> & { settings?: PortSettings };

export interface GmailConnection {
	label: string;
	ready: boolean;
	reconnect: boolean;
}

/** `GET /api/v1/gmail/status`. */
export interface GmailStatus {
	/** Whether the operator has set Google up on the Gateway. */
	configured: boolean;
	connection: GmailConnection | null;
	/** Connect Gmail, and Reconnect: Google's consent, then back to OpenMail. */
	connectUrl: string | null;
}

/** One auto-draft: queued when the sync pokes the agent, done when a draft appears in the thread. */
export interface DraftJob {
	emailId: string;
	threadId: string;
	state: "queued" | "done" | "failed";
	/** ISO time or epoch milliseconds. */
	queuedAt: string | number;
	finishedAt?: string | number;
	/** The median of recent jobs, when there are any. */
	estimateMs?: number;
}

/** `POST /api/v1/mailboxes/:id/gmail/sync`. */
export interface GmailSyncResult {
	pulled: number;
	pushed: number;
	/** Labels made, renamed or deleted, and messages relabeled, from Gmail. */
	relabeled?: number;
	historyId: string;
	drafting: DraftJob[];
	error?: string;
}

const mailboxPath = (mailboxId: string) => `/api/v1/mailboxes/${mailboxId}`;

/**
 * A route the Worker doesn't have falls through to the app's HTML page (200,
 * not JSON), which `apiRequest` hands back as a Blob: read it as the 404 it
 * is, so a build without the Gmail routes shows no Gmail UI.
 */
async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
	const answer = await apiRequest<T>(url, init);
	if (typeof Blob !== "undefined" && answer instanceof Blob) {
		throw new ApiError(404, { error: "not_found", message: `No such route: ${url}` });
	}
	return answer;
}
const json = (method: string, body?: unknown): RequestInit => ({
	method,
	body: body != null ? JSON.stringify(body) : undefined,
});

const gmailApi = {
	getStatus: () => apiJson<GmailStatus>("/api/v1/gmail/status"),
	createMailbox: () =>
		apiJson<PortMailbox>("/api/v1/gmail/mailboxes", json("POST")),
	sync: (mailboxId: string) =>
		apiJson<GmailSyncResult>(`${mailboxPath(mailboxId)}/gmail/sync`, json("POST")),
	getDrafting: (mailboxId: string) =>
		apiJson<DraftJob[]>(`${mailboxPath(mailboxId)}/gmail/drafting`),
	getGmailLink: (mailboxId: string, emailId: string) =>
		apiJson<{ url: string }>(`${mailboxPath(mailboxId)}/emails/${emailId}/gmail-link`),
};

export default gmailApi;
