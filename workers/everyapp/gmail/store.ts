/**
 * GmailSync's tables (docs/GMAIL.md): the history cursor, the id maps, the
 * copy of Gmail's labels, the links between Gmail's user labels and
 * OpenMail's own labels (MailboxDO's), the outbox of Gmail changes still
 * to make, and draft-job timing. Written over a minimal `exec(query, ...params)` so the Durable
 * Object's SQLite and Node's (in the unit tests) run the same code.
 *
 * Ids: a message pulled from Gmail keeps its Gmail id as its local id, so
 * most rows map an id to itself. A draft written in OpenMail has its own
 * id (upstream's uuid), mapped to the Gmail draft and its message once the
 * outbox has created it. A local thread id is Gmail's threadId unless the
 * thread started in OpenMail (a new draft), then the draft's own thread id.
 */
import type { LabelColor } from "../label-model";
import type { MoveChange } from "./labels";

export type SqlValue = string | number | null | ArrayBuffer;

/** What both SQLite flavors offer: one statement, its rows. */
export interface Sql {
	exec(query: string, ...params: SqlValue[]): Iterable<Record<string, SqlValue>>;
}

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS messages (
		local_id TEXT PRIMARY KEY,
		gmail_id TEXT NOT NULL UNIQUE,
		gmail_thread_id TEXT NOT NULL,
		labels TEXT NOT NULL DEFAULT '[]',
		rfc_message_id TEXT
	)`,
	`CREATE INDEX IF NOT EXISTS messages_thread ON messages (gmail_thread_id)`,
	`CREATE INDEX IF NOT EXISTS messages_rfc ON messages (rfc_message_id)`,
	`CREATE TABLE IF NOT EXISTS threads (local_thread_id TEXT PRIMARY KEY, gmail_thread_id TEXT NOT NULL UNIQUE)`,
	`CREATE TABLE IF NOT EXISTS drafts (local_id TEXT PRIMARY KEY, gmail_draft_id TEXT NOT NULL, gmail_message_id TEXT NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS labels (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT)`,
	// One OpenMail label (MailboxDO's labels.id) per Gmail user label.
	`CREATE TABLE IF NOT EXISTS label_links (local_id TEXT PRIMARY KEY, gmail_id TEXT NOT NULL UNIQUE)`,
	`CREATE TABLE IF NOT EXISTS outbox (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		kind TEXT NOT NULL,
		local_id TEXT NOT NULL,
		payload TEXT NOT NULL,
		attempts INTEGER NOT NULL DEFAULT 0,
		last_error TEXT,
		created_at INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS jobs (
		email_id TEXT PRIMARY KEY,
		thread_id TEXT NOT NULL,
		state TEXT NOT NULL,
		queued_at INTEGER NOT NULL,
		finished_at INTEGER
	)`,
	`CREATE INDEX IF NOT EXISTS jobs_queued ON jobs (queued_at)`,
];

/** One Gmail change OpenMail made locally and still has to make in Gmail. */
export type OutboxOp =
	/** messages.modify: read/unread, star, user labels. */
	| { kind: "labels"; localId: string; add: string[]; remove: string[] }
	/** threads.modify: markThreadRead. */
	| { kind: "thread_labels"; localId: string; add: string[]; remove: string[] }
	/** A folder move: trash, untrash, INBOX/SPAM labels. */
	| { kind: "move"; localId: string; change: MoveChange }
	/** drafts.create, or drafts.update when the local draft already has a Gmail draft; the content is read from MailboxDO at flush time. */
	| { kind: "draft_upsert"; localId: string }
	/** drafts.delete. */
	| { kind: "draft_delete"; localId: string }
	/** labels.create for an OpenMail label (`localId`, MailboxDO's label id), then the link. */
	| { kind: "label_create"; localId: string; name: string; color: LabelColor }
	/** labels.patch: the OpenMail label's name and color, renamed or recolored. */
	| { kind: "label_update"; localId: string; name: string; color: LabelColor }
	/** labels.delete, then the link goes. `gmailId` is the link's, read when the label was deleted locally. */
	| { kind: "label_delete"; localId: string; gmailId?: string }
	/** threads.modify with OpenMail label ids (`add`, `remove`) on a conversation (`localId`, its key). */
	| { kind: "label_thread"; localId: string; add: string[]; remove: string[] };

export interface PendingOp {
	id: number;
	op: OutboxOp;
	attempts: number;
}

export interface MessageRow {
	localId: string;
	gmailId: string;
	gmailThreadId: string;
	labels: string[];
	rfcMessageId: string | null;
}

export interface DraftRow {
	localId: string;
	gmailDraftId: string;
	gmailMessageId: string;
}

export type DraftJobState = "queued" | "done" | "failed";

export interface DraftJob {
	emailId: string;
	threadId: string;
	state: DraftJobState;
	queuedAt: number;
	finishedAt?: number;
}

/** After this many failures (other than a reconnect) an outbox op is dropped. */
export const MAX_ATTEMPTS = 5;

export class GmailStore {
	constructor(private readonly sql: Sql) {
		for (const statement of SCHEMA) this.run(statement);
	}

	private run(query: string, ...params: SqlValue[]): Record<string, SqlValue>[] {
		return [...this.sql.exec(query, ...params)];
	}

	private one(query: string, ...params: SqlValue[]): Record<string, SqlValue> | undefined {
		return this.run(query, ...params)[0];
	}

	// ── state ────────────────────────────────────────────────────────

	get<T>(key: string): T | undefined {
		const row = this.one(`SELECT value FROM state WHERE key = ?`, key);
		return row ? (JSON.parse(String(row.value)) as T) : undefined;
	}

	set(key: string, value: unknown): void {
		if (value === undefined) {
			this.run(`DELETE FROM state WHERE key = ?`, key);
			return;
		}
		this.run(`INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, JSON.stringify(value));
	}

	// ── messages ─────────────────────────────────────────────────────

	putMessage(row: MessageRow): void {
		this.run(`DELETE FROM messages WHERE gmail_id = ? AND local_id != ?`, row.gmailId, row.localId);
		this.run(
			`INSERT INTO messages (local_id, gmail_id, gmail_thread_id, labels, rfc_message_id) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(local_id) DO UPDATE SET gmail_id = excluded.gmail_id, gmail_thread_id = excluded.gmail_thread_id,
			   labels = excluded.labels, rfc_message_id = COALESCE(excluded.rfc_message_id, messages.rfc_message_id)`,
			row.localId,
			row.gmailId,
			row.gmailThreadId,
			JSON.stringify(row.labels),
			row.rfcMessageId,
		);
	}

	setLabelsOf(localId: string, labels: readonly string[]): void {
		this.run(`UPDATE messages SET labels = ? WHERE local_id = ?`, JSON.stringify(labels), localId);
	}

	messageByLocal(localId: string): MessageRow | undefined {
		return messageRow(this.one(`SELECT * FROM messages WHERE local_id = ?`, localId));
	}

	messageByGmail(gmailId: string): MessageRow | undefined {
		return messageRow(this.one(`SELECT * FROM messages WHERE gmail_id = ?`, gmailId));
	}

	messageByRfcId(rfcMessageId: string): MessageRow | undefined {
		return messageRow(this.one(`SELECT * FROM messages WHERE rfc_message_id = ? LIMIT 1`, rfcMessageId));
	}

	messagesInGmailThread(gmailThreadId: string): MessageRow[] {
		return this.run(`SELECT * FROM messages WHERE gmail_thread_id = ?`, gmailThreadId).map((r) => messageRow(r)!);
	}

	deleteMessage(localId: string): void {
		this.run(`DELETE FROM messages WHERE local_id = ?`, localId);
	}

	countMessages(): number {
		return Number(this.one(`SELECT COUNT(*) AS n FROM messages`)?.n ?? 0);
	}

	// ── threads ──────────────────────────────────────────────────────

	/** The local thread id for a Gmail thread: the mapped one, else Gmail's own. */
	localThreadOf(gmailThreadId: string): string {
		const row = this.one(`SELECT local_thread_id FROM threads WHERE gmail_thread_id = ?`, gmailThreadId);
		return row ? String(row.local_thread_id) : gmailThreadId;
	}

	/** The Gmail thread of a local thread id: mapped, else one of its messages', else none. */
	gmailThreadOf(localThreadId: string): string | undefined {
		const row = this.one(`SELECT gmail_thread_id FROM threads WHERE local_thread_id = ?`, localThreadId);
		if (row) return String(row.gmail_thread_id);
		const own = this.one(`SELECT gmail_thread_id FROM messages WHERE gmail_thread_id = ? LIMIT 1`, localThreadId);
		return own ? String(own.gmail_thread_id) : undefined;
	}

	putThread(localThreadId: string, gmailThreadId: string): void {
		if (localThreadId === gmailThreadId) return;
		this.run(
			`INSERT INTO threads (local_thread_id, gmail_thread_id) VALUES (?, ?) ON CONFLICT DO NOTHING`,
			localThreadId,
			gmailThreadId,
		);
	}

	// ── drafts ───────────────────────────────────────────────────────

	putDraft(row: DraftRow): void {
		this.run(
			`INSERT INTO drafts (local_id, gmail_draft_id, gmail_message_id) VALUES (?, ?, ?)
			 ON CONFLICT(local_id) DO UPDATE SET gmail_draft_id = excluded.gmail_draft_id, gmail_message_id = excluded.gmail_message_id`,
			row.localId,
			row.gmailDraftId,
			row.gmailMessageId,
		);
	}

	draftByLocal(localId: string): DraftRow | undefined {
		const row = this.one(`SELECT * FROM drafts WHERE local_id = ?`, localId);
		return row ? { localId: String(row.local_id), gmailDraftId: String(row.gmail_draft_id), gmailMessageId: String(row.gmail_message_id) } : undefined;
	}

	draftByGmailMessage(gmailMessageId: string): DraftRow | undefined {
		const row = this.one(`SELECT * FROM drafts WHERE gmail_message_id = ?`, gmailMessageId);
		return row ? { localId: String(row.local_id), gmailDraftId: String(row.gmail_draft_id), gmailMessageId: String(row.gmail_message_id) } : undefined;
	}

	deleteDraft(localId: string): void {
		this.run(`DELETE FROM drafts WHERE local_id = ?`, localId);
	}

	// ── labels ───────────────────────────────────────────────────────

	replaceLabels(labels: readonly { id: string; name: string; type?: string }[]): void {
		this.run(`DELETE FROM labels`);
		for (const l of labels) this.putLabel(l);
	}

	putLabel(label: { id: string; name: string; type?: string }): void {
		this.run(
			`INSERT INTO labels (id, name, type) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, type = excluded.type`,
			label.id,
			label.name,
			label.type ?? null,
		);
	}

	labels(): { id: string; name: string; type?: "system" | "user" }[] {
		return this.run(`SELECT * FROM labels ORDER BY type DESC, name`).map((r) => ({
			id: String(r.id),
			name: String(r.name),
			...(r.type ? { type: String(r.type) as "system" | "user" } : {}),
		}));
	}

	// ── label links ──────────────────────────────────────────────────

	linkLabel(localId: string, gmailId: string): void {
		this.run(`DELETE FROM label_links WHERE gmail_id = ? AND local_id != ?`, gmailId, localId);
		this.run(
			`INSERT INTO label_links (local_id, gmail_id) VALUES (?, ?) ON CONFLICT(local_id) DO UPDATE SET gmail_id = excluded.gmail_id`,
			localId,
			gmailId,
		);
	}

	unlinkLabel(localId: string): void {
		this.run(`DELETE FROM label_links WHERE local_id = ?`, localId);
	}

	/** The Gmail label an OpenMail label is linked to. */
	gmailLabelOf(localId: string): string | undefined {
		const row = this.one(`SELECT gmail_id FROM label_links WHERE local_id = ?`, localId);
		return row ? String(row.gmail_id) : undefined;
	}

	/** The OpenMail label a Gmail label is linked to. */
	localLabelOf(gmailId: string): string | undefined {
		const row = this.one(`SELECT local_id FROM label_links WHERE gmail_id = ?`, gmailId);
		return row ? String(row.local_id) : undefined;
	}

	labelLinks(): { localId: string; gmailId: string }[] {
		return this.run(`SELECT local_id, gmail_id FROM label_links`).map((r) => ({ localId: String(r.local_id), gmailId: String(r.gmail_id) }));
	}

	// ── outbox ───────────────────────────────────────────────────────

	/**
	 * Queue a Gmail change. Deleting a draft whose creation hasn't reached
	 * Gmail yet cancels the creation instead: nothing to do in Gmail.
	 * Deleting a label drops its queued renames, and its queued creation when
	 * it has no Gmail label yet; the deletion itself is queued with the
	 * link's Gmail id, so it still finds the Gmail label once the local one
	 * is gone (a creation already on its way links it before the flush).
	 */
	enqueue(op: OutboxOp, now = Date.now()): void {
		if (op.kind === "draft_delete" && !this.draftByLocal(op.localId)) {
			this.run(`DELETE FROM outbox WHERE kind = 'draft_upsert' AND local_id = ?`, op.localId);
			return;
		}
		if (op.kind === "label_delete") {
			const gmailId = op.gmailId ?? this.gmailLabelOf(op.localId);
			this.run(`DELETE FROM outbox WHERE kind = 'label_update' AND local_id = ?`, op.localId);
			if (!gmailId) this.run(`DELETE FROM outbox WHERE kind = 'label_create' AND local_id = ?`, op.localId);
			op = gmailId ? { ...op, gmailId } : op;
		}
		if (op.kind === "draft_upsert") {
			// One pending upsert per draft: the content is read at flush time anyway.
			const pending = this.one(`SELECT id FROM outbox WHERE kind = 'draft_upsert' AND local_id = ?`, op.localId);
			if (pending) return;
		}
		this.run(`INSERT INTO outbox (kind, local_id, payload, created_at) VALUES (?, ?, ?, ?)`, op.kind, op.localId, JSON.stringify(op), now);
	}

	/** Whether an op of `kind` is queued for `localId`. */
	hasPending(kind: OutboxOp["kind"], localId: string): boolean {
		return Boolean(this.one(`SELECT 1 AS x FROM outbox WHERE kind = ? AND local_id = ? LIMIT 1`, kind, localId));
	}

	pending(): PendingOp[] {
		return this.run(`SELECT id, payload, attempts FROM outbox ORDER BY id`).map((r) => ({
			id: Number(r.id),
			op: JSON.parse(String(r.payload)) as OutboxOp,
			attempts: Number(r.attempts),
		}));
	}

	complete(id: number): void {
		this.run(`DELETE FROM outbox WHERE id = ?`, id);
	}

	/** Record a failure; returns true when the op was dropped (MAX_ATTEMPTS reached). */
	fail(id: number, error: string): boolean {
		this.run(`UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?`, error.slice(0, 500), id);
		const row = this.one(`SELECT attempts FROM outbox WHERE id = ?`, id);
		if (row && Number(row.attempts) >= MAX_ATTEMPTS) {
			console.error(`[gmail] dropping outbox op ${id} after ${MAX_ATTEMPTS} failures: ${error}`);
			this.complete(id);
			return true;
		}
		return false;
	}

	// ── draft jobs ───────────────────────────────────────────────────

	addJob(emailId: string, threadId: string, queuedAt: number): void {
		this.run(
			`INSERT INTO jobs (email_id, thread_id, state, queued_at) VALUES (?, ?, 'queued', ?) ON CONFLICT(email_id) DO NOTHING`,
			emailId,
			threadId,
			queuedAt,
		);
	}

	hasJob(emailId: string): boolean {
		return Boolean(this.one(`SELECT 1 AS x FROM jobs WHERE email_id = ?`, emailId));
	}

	finishJob(emailId: string, state: "done" | "failed", finishedAt: number): void {
		this.run(`UPDATE jobs SET state = ?, finished_at = ? WHERE email_id = ? AND state = 'queued'`, state, finishedAt, emailId);
	}

	jobs(since: number): DraftJob[] {
		return this.run(`SELECT * FROM jobs WHERE queued_at >= ? OR state = 'queued' ORDER BY queued_at DESC LIMIT 100`, since).map(jobRow);
	}

	queuedJobs(): DraftJob[] {
		return this.run(`SELECT * FROM jobs WHERE state = 'queued' ORDER BY queued_at`).map(jobRow);
	}

	/** The last `n` finished-done jobs' durations, newest first. */
	doneDurations(n: number): number[] {
		return this.run(
			`SELECT finished_at - queued_at AS ms FROM jobs WHERE state = 'done' AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT ?`,
			n,
		).map((r) => Number(r.ms));
	}
}

function messageRow(row: Record<string, SqlValue> | undefined): MessageRow | undefined {
	if (!row) return undefined;
	return {
		localId: String(row.local_id),
		gmailId: String(row.gmail_id),
		gmailThreadId: String(row.gmail_thread_id),
		labels: JSON.parse(String(row.labels ?? "[]")) as string[],
		rfcMessageId: row.rfc_message_id == null ? null : String(row.rfc_message_id),
	};
}

function jobRow(row: Record<string, SqlValue>): DraftJob {
	return {
		emailId: String(row.email_id),
		threadId: String(row.thread_id),
		state: String(row.state) as DraftJobState,
		queuedAt: Number(row.queued_at),
		...(row.finished_at == null ? {} : { finishedAt: Number(row.finished_at) }),
	};
}
