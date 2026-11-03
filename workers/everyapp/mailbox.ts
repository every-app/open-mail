/**
 * Gmail-style labels on top of upstream's mailbox: the `MailboxDO` the entry
 * exports (workers/app.ts) is this subclass, under upstream's class name, so
 * the MAILBOX binding and every stored object stay as they were.
 *
 * Folders say where a message is (one per email); labels are tags on top,
 * many per conversation. A conversation is `COALESCE(thread_id, id)`: every
 * path that writes mail sets thread_id, and an email without one is its own
 * conversation. A conversation's labels are the union of its messages'
 * labels, and labeling a conversation labels every message in it.
 *
 * The two tables come from the port's own migrations, applied after
 * upstream's through upstream's runner and its `d1_migrations` table, under
 * names upstream's numbered ones can't take (`everyapp_<n>_…`). That keeps
 * `workers/durableObject/*` and `workers/db/*` byte-identical for upstream
 * merges.
 *
 * The listings, the search and the single-email and thread reads are
 * overridden to carry `labels: { id, name, color }[]` (the conversation's),
 * so the REST routes, the chat agent and the MCP tools all see them.
 */
import { MailboxDO as UpstreamMailboxDO } from "../durableObject";
import { applyMigrations, type Migration } from "../durableObject/migrations";
import { Folders } from "../../shared/folders";
import type { Env } from "../types";
import {
	type Label,
	type LabelColor,
	type LabelResult,
	type LabelThreadResult,
	type LabelWithCounts,
	colorForName,
	conversationKey,
	isLabelColor,
	normalizeLabelName,
} from "./label-model";

export * from "./label-model";

export const everyappMailboxMigrations: Migration[] = [
	{
		// email_labels.email_id cascades from emails: a deleted email (one at a
		// time, or with its folder) takes its label rows with it. Beware on an
		// upstream merge: a migration that rebuilds `emails` (create a new
		// table, copy, DROP the old one) would cascade-delete every label
		// assignment, since DROP TABLE deletes its rows first. Such a migration
		// needs `PRAGMA foreign_keys = OFF` around it or a copy of email_labels
		// (TODO.md "Decide": the email_labels foreign key).
		name: "everyapp_1_labels",
		sql: `
			CREATE TABLE IF NOT EXISTS labels (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL UNIQUE COLLATE NOCASE,
				color TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
			CREATE TABLE IF NOT EXISTS email_labels (
				email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
				label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
				PRIMARY KEY (email_id, label_id)
			);
			CREATE INDEX IF NOT EXISTS idx_email_labels_label_id ON email_labels(label_id);
		`,
	},
	{
		// Rejoin threads createEmail() used to split: a reply's thread_id was the
		// first message's Message-ID header while the first message kept its own
		// id. Points such replies at the conversation of the message they name.
		name: "everyapp_2_rethread",
		sql: `
			UPDATE emails SET thread_id = COALESCE((
				SELECT COALESCE(p.thread_id, p.id) FROM emails p
				WHERE p.message_id = emails.thread_id AND p.id != emails.id
				ORDER BY p.date LIMIT 1
			), thread_id)
			WHERE thread_id IN (
				SELECT message_id FROM emails
				WHERE message_id IS NOT NULL AND COALESCE(thread_id, id) != message_id
			);
		`,
	},
];

/** Folders a label's listing (and its unread count) leaves out, as Gmail does. */
const HIDDEN_FOLDERS = [Folders.TRASH, Folders.SPAM] as const;

interface SearchOptions {
	query: string;
	folder?: string;
	from?: string;
	to?: string;
	subject?: string;
	date_start?: string;
	date_end?: string;
	is_read?: boolean;
	is_starred?: boolean;
	has_attachment?: boolean;
	/** The port's: only conversations carrying this label id. */
	label_id?: string;
}

type Row = { id: string; thread_id?: string | null };

/** A conversation's labels, on every row the port's reads return. */
export interface WithLabels {
	labels: Label[];
}

/** A row of a threaded listing (upstream's folder listing's shape) or of the search. */
export interface EmailListRow extends WithLabels {
	id: string;
	subject: string | null;
	sender: string | null;
	recipient: string | null;
	cc?: string | null;
	bcc?: string | null;
	date: string | null;
	read: boolean;
	starred: boolean;
	thread_id: string | null;
	folder_id: string;
	folder_name?: string | null;
	in_reply_to: string | null;
	email_references: string | null;
	snippet: string | null;
	thread_count?: number;
	thread_unread_count?: number;
	participants?: string;
	needs_reply?: boolean;
	has_draft?: boolean;
}

/** A message of getThreadEmails(): the whole row, with its attachments. */
export interface ThreadEmail extends EmailListRow {
	body: string | null;
	message_id: string | null;
	raw_headers: string | null;
	attachments: {
		id: string;
		email_id: string;
		filename: string;
		mimetype: string;
		size: number;
		content_id: string | null;
		disposition: string | null;
	}[];
}

type UpstreamResult<K extends keyof UpstreamMailboxDO> = UpstreamMailboxDO[K] extends (...args: never[]) => Promise<infer R>
	? R
	: never;

export class MailboxDO extends UpstreamMailboxDO {
	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		applyMigrations(this.ctx.storage.sql, everyappMailboxMigrations, this.ctx.storage);
	}

	// ── Labels ─────────────────────────────────────────────────────

	async listLabels(): Promise<LabelWithCounts[]> {
		const rows = this.ctx.storage.sql.exec(
			`WITH
			labeled AS (
				SELECT DISTINCT el.label_id, COALESCE(e.thread_id, e.id) AS ck
				FROM email_labels el JOIN emails e ON e.id = el.email_id
			),
			unread AS (
				SELECT DISTINCT COALESCE(thread_id, id) AS ck FROM emails
				WHERE read = 0 AND folder_id NOT IN (?1, ?2)
			)
			SELECT l.id, l.name, l.color, COUNT(u.ck) AS unreadCount
			FROM labels l
			LEFT JOIN labeled lb ON lb.label_id = l.id
			LEFT JOIN unread u ON u.ck = lb.ck
			GROUP BY l.id
			ORDER BY l.name COLLATE NOCASE`,
			...HIDDEN_FOLDERS,
		);
		return [...rows].map((r) => ({
			id: String(r.id),
			name: String(r.name),
			color: r.color as LabelColor,
			unreadCount: Number(r.unreadCount ?? 0),
		}));
	}

	async getLabel(id: string): Promise<Label | null> {
		const row = [...this.ctx.storage.sql.exec(`SELECT id, name, color FROM labels WHERE id = ?1`, id)][0];
		return row ? { id: String(row.id), name: String(row.name), color: row.color as LabelColor } : null;
	}

	/** A label by id, else by name (case-insensitive). */
	async findLabel(idOrName: string): Promise<Label | null> {
		const row = [
			...this.ctx.storage.sql.exec(
				`SELECT id, name, color FROM labels WHERE id = ?1 OR name = ?2 COLLATE NOCASE
				 ORDER BY CASE WHEN id = ?1 THEN 0 ELSE 1 END LIMIT 1`,
				idOrName,
				idOrName.trim(),
			),
		][0];
		return row ? { id: String(row.id), name: String(row.name), color: row.color as LabelColor } : null;
	}

	async createLabel(name: string, color?: string): Promise<LabelResult> {
		const normalized = normalizeLabelName(name);
		if (!normalized) return { ok: false, error: "invalid_name" };
		const label: Label = {
			id: crypto.randomUUID(),
			name: normalized,
			color: isLabelColor(color) ? color : colorForName(normalized),
		};
		try {
			this.ctx.storage.sql.exec(
				`INSERT INTO labels (id, name, color) VALUES (?1, ?2, ?3)`,
				label.id,
				label.name,
				label.color,
			);
		} catch (e) {
			if (e instanceof Error && e.message.includes("UNIQUE constraint failed")) return { ok: false, error: "duplicate" };
			throw e;
		}
		return { ok: true, label };
	}

	async updateLabel(id: string, changes: { name?: string; color?: string }): Promise<LabelResult> {
		const current = await this.getLabel(id);
		if (!current) return { ok: false, error: "not_found" };
		let name = current.name;
		if (changes.name !== undefined) {
			const normalized = normalizeLabelName(changes.name);
			if (!normalized) return { ok: false, error: "invalid_name" };
			name = normalized;
		}
		const color = isLabelColor(changes.color) ? changes.color : current.color;
		try {
			this.ctx.storage.sql.exec(`UPDATE labels SET name = ?2, color = ?3 WHERE id = ?1`, id, name, color);
		} catch (e) {
			if (e instanceof Error && e.message.includes("UNIQUE constraint failed")) return { ok: false, error: "duplicate" };
			throw e;
		}
		return { ok: true, label: { id, name, color } };
	}

	/** Deletes the label and takes it off every conversation; no mail is touched. */
	async deleteLabel(id: string): Promise<boolean> {
		if (!(await this.getLabel(id))) return false;
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec(`DELETE FROM email_labels WHERE label_id = ?1`, id);
			this.ctx.storage.sql.exec(`DELETE FROM labels WHERE id = ?1`, id);
		});
		return true;
	}

	/**
	 * Add and remove labels (ids) on a whole conversation: every message of
	 * it. `threadKey` is a thread id or the id of any email in the thread.
	 */
	async labelThread(threadKey: string, add: string[] = [], remove: string[] = []): Promise<LabelThreadResult> {
		const wanted = [...new Set([...add, ...remove])];
		if (wanted.length > 0) {
			const known = new Set(
				[...this.ctx.storage.sql.exec(`SELECT id FROM labels WHERE id IN (SELECT value FROM json_each(?1))`, JSON.stringify(wanted))].map(
					(r) => String(r.id),
				),
			);
			const unknown = wanted.filter((id) => !known.has(id));
			if (unknown.length > 0) return { ok: false, error: "unknown_labels", ids: unknown };
		}
		const key = this.#resolveConversation(threadKey);
		if (!key) return { ok: false, error: "not_found" };

		const toRemove = remove.filter((id) => !add.includes(id));
		this.ctx.storage.transactionSync(() => {
			for (const labelId of new Set(add)) {
				this.ctx.storage.sql.exec(
					`INSERT OR IGNORE INTO email_labels (email_id, label_id)
					 SELECT id, ?2 FROM emails WHERE thread_id = ?1 OR (thread_id IS NULL AND id = ?1)`,
					key,
					labelId,
				);
			}
			if (toRemove.length > 0) {
				this.ctx.storage.sql.exec(
					`DELETE FROM email_labels
					 WHERE label_id IN (SELECT value FROM json_each(?2))
					   AND email_id IN (SELECT id FROM emails WHERE thread_id = ?1 OR (thread_id IS NULL AND id = ?1))`,
					key,
					JSON.stringify(toRemove),
				);
			}
		});
		return { ok: true, threadKey: key, labels: (await this.labelsForThreads([key]))[key] ?? [] };
	}

	/**
	 * Set one email's labels among `scope` (label ids) to `labelIds`, leaving
	 * its other labels alone. The Gmail sync's (gmail/label-sync.ts): an
	 * email's labels as Gmail has them, where `scope` is the labels linked to
	 * Gmail ones. Not a route or a tool. Answers whether anything changed.
	 */
	async setEmailLabels(emailId: string, labelIds: string[], scope: string[]): Promise<boolean> {
		const sql = this.ctx.storage.sql;
		const inScope = new Set(scope);
		const wanted = [...new Set(labelIds)].filter((id) => inScope.has(id));
		const before = new Set(
			[
				...sql.exec(
					`SELECT label_id FROM email_labels WHERE email_id = ?1 AND label_id IN (SELECT value FROM json_each(?2))`,
					emailId,
					JSON.stringify([...inScope]),
				),
			].map((r) => String(r.label_id)),
		);
		const add = wanted.filter((id) => !before.has(id));
		const remove = [...before].filter((id) => !wanted.includes(id));
		if (add.length === 0 && remove.length === 0) return false;
		if ([...sql.exec(`SELECT 1 FROM emails WHERE id = ?1`, emailId)].length === 0) return false;
		this.ctx.storage.transactionSync(() => {
			if (remove.length > 0) {
				sql.exec(
					`DELETE FROM email_labels WHERE email_id = ?1 AND label_id IN (SELECT value FROM json_each(?2))`,
					emailId,
					JSON.stringify(remove),
				);
			}
			for (const labelId of add) {
				sql.exec(`INSERT OR IGNORE INTO email_labels (email_id, label_id) SELECT ?1, id FROM labels WHERE id = ?2`, emailId, labelId);
			}
		});
		return true;
	}

	/** Each conversation's labels, by conversation key (thread id, or email id). Keys with none are absent. */
	async labelsForThreads(threadKeys: string[]): Promise<Record<string, Label[]>> {
		const keys = [...new Set(threadKeys.filter(Boolean))];
		const out: Record<string, Label[]> = {};
		if (keys.length === 0) return out;
		const rows = this.ctx.storage.sql.exec(
			`SELECT DISTINCT COALESCE(e.thread_id, e.id) AS ck, l.id, l.name, l.color
			 FROM email_labels el
			 JOIN emails e ON e.id = el.email_id
			 JOIN labels l ON l.id = el.label_id
			 WHERE COALESCE(e.thread_id, e.id) IN (SELECT value FROM json_each(?1))
			 ORDER BY l.name COLLATE NOCASE`,
			JSON.stringify(keys),
		);
		for (const r of rows) {
			const ck = String(r.ck);
			(out[ck] ??= []).push({ id: String(r.id), name: String(r.name), color: r.color as LabelColor });
		}
		return out;
	}

	/**
	 * A label's conversations, threaded like upstream's folder listing (the
	 * same row shape), across every folder but Trash and Spam. Each row is
	 * the conversation's latest message outside those two and Drafts (a draft
	 * only when the conversation has nothing else); drafts still count for
	 * has_draft.
	 */
	async getThreadedEmailsByLabel(labelId: string, options: { page?: number; limit?: number } = {}): Promise<EmailListRow[]> {
		const { page = 1, limit: rawLimit = 25 } = options;
		const limit = Math.min(Math.max(rawLimit, 1), 100);
		const offset = (Math.max(page, 1) - 1) * limit;
		const rows = this.ctx.storage.sql.exec(
			`WITH
			labeled AS (
				SELECT DISTINCT COALESCE(e.thread_id, e.id) AS ck
				FROM email_labels el JOIN emails e ON e.id = el.email_id
				WHERE el.label_id = ?1
			),
			conv AS (
				SELECT e.*, COALESCE(e.thread_id, e.id) AS ck
				FROM emails e JOIN labeled lb ON lb.ck = COALESCE(e.thread_id, e.id)
				WHERE e.folder_id NOT IN (?4, ?5)
			),
			stats AS (
				SELECT ck,
					COUNT(*) AS thread_count,
					SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) AS thread_unread_count,
					SUM(CASE WHEN read = 1 THEN 1 ELSE 0 END) AS thread_read_count,
					GROUP_CONCAT(DISTINCT sender) AS participants,
					SUM(CASE WHEN folder_id = ?6 THEN 1 ELSE 0 END) AS has_draft
				FROM conv GROUP BY ck
			),
			latest AS (
				SELECT c.*, ROW_NUMBER() OVER (
					PARTITION BY c.ck ORDER BY CASE WHEN c.folder_id = ?6 THEN 1 ELSE 0 END, c.date DESC
				) AS rn FROM conv c
			)
			SELECT
				l.id, l.subject, l.sender, l.recipient, l.date,
				l.read, l.starred, l.thread_id, l.folder_id,
				l.in_reply_to, l.email_references,
				SUBSTR(l.body, 1, 300) AS snippet,
				s.thread_count, s.thread_unread_count, s.participants,
				CASE WHEN s.has_draft > 0 THEN 1 ELSE 0 END AS has_draft
			FROM latest l JOIN stats s ON s.ck = l.ck
			WHERE l.rn = 1
			ORDER BY l.date DESC
			LIMIT ?2 OFFSET ?3`,
			labelId,
			limit,
			offset,
			...HIDDEN_FOLDERS,
			Folders.DRAFT,
		);
		const emails = [...rows].map((row: any) => ({
			...row,
			read: !!row.read,
			starred: !!row.starred,
			thread_count: row.thread_count || 1,
			thread_unread_count: row.thread_unread_count || 0,
			participants: row.participants || row.sender,
			// Upstream's folder listing never sets it (its Sent and Drafts lookups miss); kept false here to match.
			needs_reply: false,
			has_draft: !!row.has_draft,
		}));
		return this.#withLabels(emails as Omit<EmailListRow, "labels">[]);
	}

	/** The number of a label's conversations, as getThreadedEmailsByLabel() lists them. */
	async countThreadedEmailsByLabel(labelId: string): Promise<number> {
		const row = [
			...this.ctx.storage.sql.exec(
				`SELECT COUNT(DISTINCT COALESCE(e.thread_id, e.id)) AS total
				 FROM emails e
				 WHERE e.folder_id NOT IN (?2, ?3)
				   AND COALESCE(e.thread_id, e.id) IN (
					SELECT COALESCE(e2.thread_id, e2.id)
					FROM email_labels el JOIN emails e2 ON e2.id = el.email_id
					WHERE el.label_id = ?1
				   )`,
				labelId,
				...HIDDEN_FOLDERS,
			),
		][0];
		return Number(row?.total ?? 0);
	}

	// ── Upstream's reads, with each conversation's labels ──────────

	override async getEmails(
		...[options = {}]: Parameters<UpstreamMailboxDO["getEmails"]>
	): Promise<(UpstreamResult<"getEmails">[number] & WithLabels)[]> {
		const thread_id = options.thread_id && this.#resolveThreadId(options.thread_id);
		return this.#withLabels(await super.getEmails({ ...options, ...(thread_id ? { thread_id } : {}) }));
	}

	override async countEmails(...[options = {}]: Parameters<UpstreamMailboxDO["countEmails"]>) {
		const thread_id = options.thread_id && this.#resolveThreadId(options.thread_id);
		return super.countEmails({ ...options, ...(thread_id ? { thread_id } : {}) });
	}

	override async markThreadRead(threadId: string) {
		return super.markThreadRead(this.#resolveThreadId(threadId));
	}

	/**
	 * Upstream's folder listing, with labels and a working `has_draft`:
	 * upstream finds Drafts by `name = 'draft'`, but the folder is named
	 * "Drafts" (id `draft`), so its flag is always false. Recomputed here by
	 * folder id over each row's conversation. (Its `needs_reply` has the same
	 * name mismatch and stays false; the UI doesn't show it. TODO.md.)
	 */
	override async getThreadedEmails(...args: Parameters<UpstreamMailboxDO["getThreadedEmails"]>): Promise<EmailListRow[]> {
		const rows = (await super.getThreadedEmails(...args)) as Omit<EmailListRow, "labels">[];
		const keys = rows.map(conversationKey);
		const withDraft = new Set(
			[
				...this.ctx.storage.sql.exec<{ k: string }>(
					`SELECT DISTINCT COALESCE(thread_id, id) AS k FROM emails
					 WHERE folder_id = 'draft' AND COALESCE(thread_id, id) IN (SELECT value FROM json_each(?1))`,
					JSON.stringify(keys),
				),
			].map((r) => r.k),
		);
		return this.#withLabels(rows.map((row) => ({ ...row, has_draft: row.has_draft || withDraft.has(conversationKey(row)) })));
	}

	override async getEmail(id: string): Promise<(NonNullable<UpstreamResult<"getEmail">> & WithLabels) | null> {
		const email = await super.getEmail(id);
		if (!email) return null;
		return (await this.#withLabels([email]))[0]!;
	}

	override async getThreadEmails(threadId: string): Promise<ThreadEmail[]> {
		return this.#withLabels((await super.getThreadEmails(this.#resolveThreadId(threadId))) as Omit<ThreadEmail, "labels">[]);
	}

	override async searchEmails(options: SearchOptions & { page?: number; limit?: number }): Promise<EmailListRow[]> {
		if (!options.label_id) return this.#withLabels((await super.searchEmails(options)) as Omit<EmailListRow, "labels">[]);
		const { page = 1, limit: rawLimit = 25 } = options;
		const limit = Math.min(Math.max(rawLimit, 1), 100);
		const { conditions, params } = searchConditions(options, "e");
		const where = `WHERE ${conditions.join(" AND ")}`;
		params.push(limit, (Math.max(page, 1) - 1) * limit);
		const rows = this.ctx.storage.sql.exec(
			`SELECT e.id, e.subject, e.sender, e.recipient, e.cc, e.bcc, e.date,
				e.read, e.starred, e.in_reply_to, e.email_references,
				e.thread_id, e.folder_id,
				SUBSTR(e.body, 1, 300) as snippet,
				f.name as folder_name
			FROM emails e
			LEFT JOIN folders f ON e.folder_id = f.id
			${where}
			ORDER BY e.date DESC LIMIT ?${params.length - 1} OFFSET ?${params.length}`,
			...params,
		);
		return this.#withLabels(
			[...rows].map((row: any) => ({ ...row, read: !!row.read, starred: !!row.starred })) as Omit<EmailListRow, "labels">[],
		);
	}

	override async countSearchResults(options: SearchOptions) {
		if (!options.label_id) return super.countSearchResults(options);
		const { conditions, params } = searchConditions(options, "");
		const row = [...this.ctx.storage.sql.exec(`SELECT COUNT(*) as total FROM emails WHERE ${conditions.join(" AND ")}`, ...params)][0];
		return Number(row?.total ?? 0);
	}

	// ── Writes: threading and the Date header ──────────────────────

	/**
	 * Upstream's insert, with two fixes for mail that refers to other mail
	 * (inbound, replies, drafts):
	 *
	 * - The thread: upstream threads a reply under its first reference's
	 *   Message-ID, but the message that ID names keeps its own id as its
	 *   thread, so a conversation splits in two. A reply joins the conversation
	 *   of the oldest stored message it refers to (In-Reply-To or References),
	 *   and a first message that arrives after its replies joins theirs.
	 * - The date: upstream stores the time of receipt. Inbound mail (the one
	 *   path that keeps its headers) takes its Date header instead, unless it
	 *   is missing, unreadable or in the future.
	 */
	override async createEmail(...[folder, email, attachments]: Parameters<UpstreamMailboxDO["createEmail"]>) {
		return super.createEmail(
			folder,
			{ ...email, thread_id: this.#threadFor(email), date: dateHeaderOf(email.raw_headers) ?? email.date },
			attachments,
		);
	}

	#threadFor(email: Parameters<UpstreamMailboxDO["createEmail"]>[1]): string | null | undefined {
		let refs: string[] = [];
		try {
			refs = email.email_references ? (JSON.parse(email.email_references) as string[]) : [];
		} catch {}
		const named = [email.in_reply_to, ...refs].filter((r): r is string => typeof r === "string" && r !== "");
		if (named.length > 0) {
			const parent = [
				...this.ctx.storage.sql.exec<{ k: string }>(
					`SELECT COALESCE(thread_id, id) AS k FROM emails
					 WHERE message_id IN (SELECT value FROM json_each(?1)) ORDER BY date LIMIT 1`,
					JSON.stringify(named),
				),
			][0];
			if (parent) return parent.k;
		}
		if (email.message_id) {
			const reply = [
				...this.ctx.storage.sql.exec<{ k: string }>(
					`SELECT COALESCE(thread_id, id) AS k FROM emails WHERE thread_id = ?1 OR in_reply_to = ?1 LIMIT 1`,
					email.message_id,
				),
			][0];
			if (reply) return reply.k;
		}
		return email.thread_id;
	}

	// ── Deletes: label rows go with the email ──────────────────────

	// The foreign key cascades already; deleting explicitly keeps it so even
	// where foreign keys aren't enforced.
	override async deleteEmail(id: string) {
		const result = await super.deleteEmail(id);
		if (result !== null) this.ctx.storage.sql.exec(`DELETE FROM email_labels WHERE email_id = ?1`, id);
		return result;
	}

	override async deleteFolder(id: string) {
		const deleted = await super.deleteFolder(id);
		if (deleted) this.ctx.storage.sql.exec(`DELETE FROM email_labels WHERE email_id NOT IN (SELECT id FROM emails)`);
		return deleted;
	}

	/** The conversation key (thread id, or email id) `threadKey` names, or null when there's no such mail. */
	async findConversation(threadKey: string): Promise<string | null> {
		return this.#resolveConversation(threadKey);
	}

	// ── Helpers ────────────────────────────────────────────────────

	/**
	 * The conversation a thread id names. Upstream hands out a reply's first
	 * reference (a Message-ID header) as its thread id, to the agent's
	 * new-mail trigger among others, while createEmail() files the reply under
	 * the conversation of the message that header names: resolve one to the other.
	 */
	#resolveThreadId(threadId: string): string {
		const direct = [...this.ctx.storage.sql.exec(`SELECT 1 FROM emails WHERE thread_id = ?1 LIMIT 1`, threadId)];
		if (direct.length > 0) return threadId;
		const named = [
			...this.ctx.storage.sql.exec<{ k: string }>(
				`SELECT COALESCE(thread_id, id) AS k FROM emails WHERE message_id = ?1 ORDER BY date LIMIT 1`,
				threadId,
			),
		][0];
		return named?.k ?? threadId;
	}

	#resolveConversation(threadKey: string): string | null {
		const byId = [...this.ctx.storage.sql.exec(`SELECT id, thread_id FROM emails WHERE id = ?1`, threadKey)][0];
		if (byId) return conversationKey({ id: String(byId.id), thread_id: byId.thread_id as string | null });
		const byThread = [...this.ctx.storage.sql.exec(`SELECT 1 FROM emails WHERE thread_id = ?1 LIMIT 1`, threadKey)];
		return byThread.length > 0 ? threadKey : null;
	}

	async #withLabels<T extends Row>(rows: T[]): Promise<(T & WithLabels)[]> {
		const byKey = await this.labelsForThreads(rows.map(conversationKey));
		return rows.map((row) => ({ ...row, labels: byKey[conversationKey(row)] ?? [] }));
	}
}

/** A stored message's Date header as an ISO string, when it has a sensible one. */
export function dateHeaderOf(rawHeaders: string | null | undefined, now = Date.now()): string | null {
	if (!rawHeaders) return null;
	try {
		const headers = JSON.parse(rawHeaders) as { key?: string; value?: string }[];
		const value = headers.find((h) => h?.key?.toLowerCase() === "date")?.value;
		const time = value ? Date.parse(value) : Number.NaN;
		// A few minutes of clock skew is fine; a date in the future would pin the message to the top.
		if (Number.isNaN(time) || time > now + 5 * 60_000) return null;
		return new Date(time).toISOString();
	} catch {
		return null;
	}
}

/**
 * Upstream's search conditions (its private #buildSearchConditions, copied
 * because a subclass can't reach it), plus the label: a message matches when
 * its conversation carries the label.
 */
function searchConditions(options: SearchOptions, tableAlias: string): { conditions: string[]; params: (string | number)[] } {
	const { query, folder, from, to, subject, date_start, date_end, is_read, is_starred, has_attachment, label_id } = options;
	const p = tableAlias ? `${tableAlias}.` : "";
	const conditions: string[] = [];
	const params: (string | number)[] = [];
	const add = (value: string | number) => {
		params.push(value);
		return `?${params.length}`;
	};
	if (query) {
		const q = add(`%${query}%`);
		conditions.push(`(${p}subject LIKE ${q} OR ${p}body LIKE ${q} OR ${p}sender LIKE ${q} OR ${p}recipient LIKE ${q} OR ${p}cc LIKE ${q} OR ${p}bcc LIKE ${q})`);
	}
	if (folder) {
		const f = add(folder);
		conditions.push(`${p}folder_id = (SELECT id FROM folders WHERE name = ${f} OR id = ${f} LIMIT 1)`);
	}
	if (from) conditions.push(`${p}sender LIKE ${add(`%${from}%`)}`);
	if (to) {
		const t = add(`%${to}%`);
		conditions.push(`(${p}recipient LIKE ${t} OR ${p}cc LIKE ${t} OR ${p}bcc LIKE ${t})`);
	}
	if (subject) conditions.push(`${p}subject LIKE ${add(`%${subject}%`)}`);
	if (date_start) conditions.push(`${p}date >= ${add(date_start)}`);
	if (date_end) conditions.push(`${p}date <= ${add(date_end)}`);
	if (is_read !== undefined) conditions.push(`${p}read = ${add(is_read ? 1 : 0)}`);
	if (is_starred !== undefined) conditions.push(`${p}starred = ${add(is_starred ? 1 : 0)}`);
	if (has_attachment) conditions.push(`${p}id IN (SELECT DISTINCT email_id FROM attachments)`);
	if (label_id) {
		conditions.push(
			`COALESCE(${p}thread_id, ${p}id) IN (
				SELECT COALESCE(le.thread_id, le.id) FROM email_labels el JOIN emails le ON le.id = el.email_id
				WHERE el.label_id = ${add(label_id)}
			)`,
		);
	}
	return { conditions, params };
}

