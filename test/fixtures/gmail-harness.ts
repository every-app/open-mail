// The sync engine's dependencies in Node: GmailStore over node:sqlite, an
// in-memory MailboxDO (its mail and its labels), an in-memory bucket, and
// gmailClient() over the fake Gmail (./fake-gmail.ts).
import { DatabaseSync } from "node:sqlite";
import { gmailClient } from "../../workers/everyapp/gmail/client";
import type { MailboxStubLike, NewEmail, SyncDeps } from "../../workers/everyapp/gmail/engine";
import { colorForName, isLabelColor, normalizeLabelName, type Label } from "../../workers/everyapp/label-model";
import { GmailStore, type Sql, type SqlValue } from "../../workers/everyapp/gmail/store";
import { fakeGmail, type FakeGmail } from "./fake-gmail";

export function nodeSql(): Sql {
	const db = new DatabaseSync(":memory:");
	return {
		exec: (query: string, ...params: SqlValue[]) =>
			db.prepare(query).all(...(params as (string | number | null)[])) as Record<string, SqlValue>[],
	};
}

export interface LocalRow {
	id: string;
	folder_id: string;
	read: boolean;
	starred: boolean;
	thread_id?: string | null;
	date: string;
	attachments: { id: string; filename: string }[];
	[key: string]: unknown;
}

export function fakeMailbox() {
	const emails = new Map<string, LocalRow>();
	const labels = new Map<string, Label>();
	/** Each email's label ids. */
	const emailLabels = new Map<string, Set<string>>();
	let nextLabel = 1;
	const taken = (name: string, except?: string) =>
		[...labels.values()].some((l) => l.id !== except && l.name.toLowerCase() === name.toLowerCase());
	const stub: MailboxStubLike & {
		emails: Map<string, LocalRow>;
		labels: Map<string, Label>;
		labelsOf(emailId: string): string[];
	} = {
		emails,
		labels,
		/** An email's labels, by name, sorted. */
		labelsOf: (emailId) => [...(emailLabels.get(emailId) ?? [])].map((id) => labels.get(id)!.name).sort(),
		async listLabels() {
			return [...labels.values()].map((l) => ({ ...l, unreadCount: 0 }));
		},
		async getLabel(id) {
			return labels.get(id) ?? null;
		},
		async createLabel(name, color) {
			const normalized = normalizeLabelName(name);
			if (!normalized) return { ok: false, error: "invalid_name" };
			if (taken(normalized)) return { ok: false, error: "duplicate" };
			const label: Label = { id: `local-${nextLabel++}`, name: normalized, color: isLabelColor(color) ? color : colorForName(normalized) };
			labels.set(label.id, label);
			return { ok: true, label };
		},
		async updateLabel(id, changes) {
			const current = labels.get(id);
			if (!current) return { ok: false, error: "not_found" };
			const name = changes.name === undefined ? current.name : normalizeLabelName(changes.name);
			if (!name) return { ok: false, error: "invalid_name" };
			if (taken(name, id)) return { ok: false, error: "duplicate" };
			const label: Label = { id, name, color: isLabelColor(changes.color) ? changes.color : current.color };
			labels.set(id, label);
			return { ok: true, label };
		},
		async deleteLabel(id) {
			if (!labels.delete(id)) return false;
			for (const set of emailLabels.values()) set.delete(id);
			return true;
		},
		async setEmailLabels(emailId, labelIds, scope) {
			if (!emails.has(emailId)) return false;
			const set = emailLabels.get(emailId) ?? new Set<string>();
			const before = [...set].sort().join();
			for (const id of scope) if (!labelIds.includes(id)) set.delete(id);
			for (const id of labelIds) if (scope.includes(id) && labels.has(id)) set.add(id);
			emailLabels.set(emailId, set);
			return [...set].sort().join() !== before;
		},
		async createEmail(folder, email, attachments) {
			const e = email as unknown as LocalRow;
			if (emails.has(e.id)) throw new Error("UNIQUE constraint failed: emails.id");
			emails.set(e.id, {
				...e,
				folder_id: folder,
				read: folder === "sent" ? true : Boolean(e.read),
				starred: Boolean(e.starred),
				attachments: attachments as unknown as LocalRow["attachments"],
			});
		},
		async updateEmail(id, { read, starred }) {
			const e = emails.get(id);
			if (!e) return null;
			if (read !== undefined) e.read = read;
			if (starred !== undefined) e.starred = starred;
			return e;
		},
		async moveEmail(id, folderId) {
			const e = emails.get(id);
			if (e) e.folder_id = folderId;
			return true;
		},
		async deleteEmail(id) {
			const e = emails.get(id);
			if (!e) return null;
			emails.delete(id);
			return e.attachments.map((a) => ({ id: a.id, filename: a.filename }));
		},
		async getEmail(id) {
			return (emails.get(id) as never) ?? null;
		},
		async getEmails({ folder, thread_id }) {
			return [...emails.values()].filter((e) => (!folder || e.folder_id === folder) && (!thread_id || e.thread_id === thread_id));
		},
	};
	return stub;
}

export function fakeBucket() {
	const objects = new Map<string, unknown>();
	return {
		objects,
		async put(key: string, value: unknown) {
			objects.set(key, value);
		},
		async delete(keys: string | string[]) {
			for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
		},
	};
}

export const ADDRESS = "me@example.com";

export function harness(gmail: FakeGmail = fakeGmail(ADDRESS), clock = { now: Date.parse("2026-10-30T12:00:00Z") }) {
	const store = new GmailStore(nodeSql());
	const mailbox = fakeMailbox();
	const bucket = fakeBucket();
	const pokes: NewEmail[] = [];
	// The mailbox's `autoDraft` setting; on here, so the engine's auto-draft tests poke the agent.
	const autoDraft = { on: true };
	const deps: SyncDeps = {
		store,
		gmail: gmailClient({}, new Request("https://openmail.example.com/"), gmail.fetch),
		mailbox,
		bucket,
		address: ADDRESS,
		pokeAgent: (email) => pokes.push(email),
		autoDraft: async () => autoDraft.on,
		now: () => clock.now,
	};
	return { deps, store, mailbox, bucket, pokes, gmail, clock, autoDraft };
}
