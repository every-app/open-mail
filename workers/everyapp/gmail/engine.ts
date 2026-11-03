/**
 * The Gmail sync itself (docs/GMAIL.md), over plain dependencies so the
 * GmailSync Durable Object (./sync.ts) and the unit tests run the same
 * code: flush the outbox, bring the labels in step (./label-sync.ts), pull
 * Gmail's changes into the mailbox's MailboxDO, and poke the agent for new
 * inbox mail.
 *
 * Writes into MailboxDO here go to the raw stub, never through the wrapped
 * `env.MAILBOX` (./namespace.ts): a change that came from Gmail must not be
 * queued back to Gmail.
 */
import PostalMime from "postal-mime";
import { Folders } from "../../../shared/folders";
import { buildMime } from "./mime";
import { GmailError, fromBase64Url, toBase64Url, type GmailClient, type GmailDraft, type GmailHistoryRecord, type GmailMessage, type GmailMessageRef } from "./client";
import { createGmailLabel, deleteGmailLabel, ensureGmailLabel, patchGmailLabel, setLocalLabelsOf, syncLabels, type LabelMailbox } from "./label-sync";
import { applyLabelChange, stateOf, userLabelsOf } from "./labels";
import type { DraftJob, GmailStore, OutboxOp, PendingOp } from "./store";

/** The MailboxDO methods the sync uses (the raw stub satisfies it). */
export interface MailboxStubLike extends LabelMailbox {
	createEmail(folder: string, email: Record<string, unknown>, attachments: Record<string, unknown>[]): Promise<unknown>;
	updateEmail(id: string, patch: { read?: boolean; starred?: boolean }): Promise<unknown>;
	moveEmail(id: string, folderId: string): Promise<boolean>;
	deleteEmail(id: string): Promise<{ id: string; filename: string }[] | null>;
	getEmail(id: string): Promise<LocalEmail | null>;
	getEmails(options: { folder?: string; thread_id?: string; limit?: number }): Promise<{ id: string; date: string }[]>;
}

export interface LocalEmail {
	id: string;
	folder_id?: string | null;
	subject?: string | null;
	sender?: string | null;
	recipient?: string | null;
	cc?: string | null;
	bcc?: string | null;
	body?: string | null;
	date?: string | null;
	in_reply_to?: string | null;
	email_references?: string | null;
	thread_id?: string | null;
	message_id?: string | null;
}

export interface BucketLike {
	put(key: string, value: ArrayBuffer | Uint8Array | string): Promise<unknown>;
	delete(keys: string | string[]): Promise<void>;
}

/** What the agent's `/onNewEmail` takes (receiveEmail's body). */
export interface NewEmail {
	mailboxId: string;
	emailId: string;
	sender: string;
	subject: string;
	threadId: string;
}

export interface SyncDeps {
	store: GmailStore;
	gmail: GmailClient;
	mailbox: MailboxStubLike;
	bucket: BucketLike;
	/** The mailbox's address (its id). */
	address: string;
	/** Start the agent's auto-draft for one email (fire and forget). */
	pokeAgent?: (email: NewEmail) => void;
	now?: () => number;
	/** What a run changed besides new mail (runSync sets it). */
	tally?: { labels: number };
}

export interface SyncResult {
	pulled: number;
	pushed: number;
	/** OpenMail labels made, renamed or deleted, and emails whose labels changed, from Gmail. */
	relabeled: number;
	historyId: string | null;
	drafting: DraftJobView[];
	error?: { code: string; message: string; reconnect: boolean };
}

export interface DraftJobView extends DraftJob {
	estimateMs: number;
}

/** The first pull: the last 30 days of inbox and sent mail, at most 200 threads, a page per sync. */
export const RECENT_QUERY = "newer_than:30d {in:inbox in:sent}";
export const RECENT_MAX_THREADS = 200;
export const RECENT_PAGE = 50;
export const DRAFTS_MAX = 50;
/** Auto-drafts started per sync at most (each is a model run). */
export const AUTO_DRAFTS_PER_SYNC = 10;
/** On the first pull, only the newest few unread inbox threads get a draft; the rest is backlog. */
export const FIRST_PULL_AUTO_DRAFTS = 5;
export const FIRST_PULL_AUTO_DRAFT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
export const JOB_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_ESTIMATE_MS = 45_000;
const CONCURRENCY = 6;

interface Backfill {
	pageToken?: string;
	threads: string[];
	done: boolean;
}

// ── sync ───────────────────────────────────────────────────────────

/** Flush, pull, poke: the one entry point (`GmailSync.sync()`). */
export async function runSync(input: SyncDeps): Promise<SyncResult> {
	const tally = { labels: 0 };
	const deps: SyncDeps = { ...input, tally };
	const { store } = deps;
	let pushed = 0;
	let pulled = 0;
	try {
		pushed = await flushOutbox(deps);
		pulled = await pull(deps);
	} catch (error) {
		if (!(error instanceof GmailError)) throw error;
		await refreshJobs(deps);
		return {
			pulled,
			pushed,
			relabeled: tally.labels,
			historyId: store.get<string>("historyId") ?? null,
			drafting: draftJobs(deps),
			error: { code: error.code, message: error.message, reconnect: error.reconnect },
		};
	}
	store.set("lastSyncAt", now(deps));
	await refreshJobs(deps);
	return { pulled, pushed, relabeled: tally.labels, historyId: store.get<string>("historyId") ?? null, drafting: draftJobs(deps) };
}

/** Gmail's changes since the last sync, or the first recent pull. Returns how many messages were added locally. */
export async function pull(deps: SyncDeps): Promise<number> {
	const { store, gmail } = deps;
	let historyId = store.get<string>("historyId");
	const candidates: Ingested[] = [];
	let pulled = 0;
	let firstPull = false;

	// Labels first (one labels.list), so the messages below find their links.
	const relabeled = await syncLabels(deps);
	if (deps.tally) deps.tally.labels += relabeled;

	if (historyId) {
		try {
			pulled += await applyHistory(deps, historyId, candidates);
		} catch (error) {
			// An expired or unknown startHistoryId: start over with a fresh recent pull.
			if (!(error instanceof GmailError) || error.status !== 404) throw error;
			store.set("historyId", undefined);
			store.set("backfill", undefined);
			store.set("draftsPulled", undefined);
			historyId = undefined;
		}
	}
	if (!historyId) {
		// The cursor is taken before the pull, so anything that changes while
		// the pull runs arrives through history next time.
		const profile = await gmail.profile();
		store.set("historyId", profile.historyId);
		store.set("backfill", { threads: [], done: false } satisfies Backfill);
		firstPull = true;
	}

	const before = candidates.length;
	pulled += await backfillPage(deps, candidates);
	if (!store.get<boolean>("draftsPulled")) {
		pulled += await pullDrafts(deps);
		store.set("draftsPulled", true);
	}

	// Auto-drafts: every new inbox message from history; from the recent
	// pull, only the newest unread inbox threads (the rest is backlog).
	const fromHistory = candidates.slice(0, before);
	const fromBackfill = firstPull ? firstPullDraftable(deps, candidates.slice(before)) : [];
	startAutoDrafts(deps, [...fromHistory.filter((m) => isInboundNew(deps, m)), ...fromBackfill]);
	return pulled;
}

/** One page of the recent pull, until RECENT_MAX_THREADS threads or the last page. */
async function backfillPage(deps: SyncDeps, added: Ingested[]): Promise<number> {
	const { store, gmail } = deps;
	const backfill = store.get<Backfill>("backfill");
	if (!backfill || backfill.done) return 0;
	const page = await gmail.listMessages({ q: RECENT_QUERY, maxResults: RECENT_PAGE, pageToken: backfill.pageToken });
	const threads = new Set(backfill.threads);
	const refs: GmailMessageRef[] = [];
	for (const ref of page.messages ?? []) {
		if (!threads.has(ref.threadId)) {
			if (threads.size >= RECENT_MAX_THREADS) continue;
			threads.add(ref.threadId);
		}
		refs.push(ref);
	}
	const results = await mapLimit(refs, CONCURRENCY, (ref) => ingest(deps, ref));
	const ingested = results.filter((r): r is Ingested => r !== null);
	added.push(...ingested);
	const done = !page.nextPageToken || threads.size >= RECENT_MAX_THREADS;
	store.set("backfill", { pageToken: page.nextPageToken, threads: [...threads], done } satisfies Backfill);
	return ingested.length;
}

async function pullDrafts(deps: SyncDeps): Promise<number> {
	const { drafts = [] } = await deps.gmail.listDrafts({ maxResults: DRAFTS_MAX });
	const results = await mapLimit(drafts, CONCURRENCY, (d) => ingest(deps, d.message, d.id));
	return results.filter(Boolean).length;
}

/** Apply `users.history` since `startHistoryId`; throws GmailError 404 when it has expired. */
export async function applyHistory(deps: SyncDeps, startHistoryId: string, added: Ingested[]): Promise<number> {
	const { store, gmail } = deps;
	const records: GmailHistoryRecord[] = [];
	let pageToken: string | undefined;
	let latest = startHistoryId;
	do {
		const page = await gmail.history(startHistoryId, pageToken);
		records.push(...(page.history ?? []));
		latest = page.historyId ?? latest;
		pageToken = page.nextPageToken;
	} while (pageToken);

	const deleted = new Set(records.flatMap((r) => (r.messagesDeleted ?? []).map((d) => d.message.id)));
	let draftIds: Map<string, string> | undefined;
	const draftIdOf = async (messageId: string) => {
		draftIds ??= await listDraftIds(gmail);
		return draftIds.get(messageId);
	};
	let pulled = 0;

	for (const record of records) {
		for (const { message } of record.messagesAdded ?? []) {
			if (deleted.has(message.id) || store.messageByGmail(message.id)) continue;
			const draftId = message.labelIds?.includes("DRAFT") ? await draftIdOf(message.id) : undefined;
			const ingested = await ingest(deps, message, draftId);
			if (ingested) {
				added.push(ingested);
				pulled++;
			}
		}
		for (const change of record.labelsAdded ?? []) {
			const known = store.messageByGmail(change.message.id);
			if (known) {
				await applyLabels(deps, known.localId, change.message.labelIds ?? applyLabelChange(known.labels, change.labelIds));
			} else if (!deleted.has(change.message.id) && change.labelIds.some((l) => l === "INBOX" || l === "SENT")) {
				// Mail older than the recent pull, moved back into the inbox.
				const ingested = await ingest(deps, change.message);
				if (ingested) pulled++;
			}
		}
		for (const change of record.labelsRemoved ?? []) {
			const known = store.messageByGmail(change.message.id);
			if (known) await applyLabels(deps, known.localId, change.message.labelIds ?? applyLabelChange(known.labels, [], change.labelIds));
		}
		for (const { message } of record.messagesDeleted ?? []) {
			const known = store.messageByGmail(message.id);
			if (known) await removeLocal(deps, known.localId);
		}
	}
	store.set("historyId", latest);
	return pulled;
}

async function listDraftIds(gmail: GmailClient): Promise<Map<string, string>> {
	const ids = new Map<string, string>();
	let pageToken: string | undefined;
	for (let i = 0; i < 5; i++) {
		const page = await gmail.listDrafts({ maxResults: 100, pageToken });
		for (const d of page.drafts ?? []) ids.set(d.message.id, d.id);
		pageToken = page.nextPageToken;
		if (!pageToken) break;
	}
	return ids;
}

/** A label change from Gmail, applied to MailboxDO's read, starred, folder and labels. */
async function applyLabels(deps: SyncDeps, localId: string, labels: string[]): Promise<void> {
	const { store, mailbox } = deps;
	const before = store.messageByLocal(localId);
	store.setLabelsOf(localId, labels);
	const own = userLabelsOf(labels);
	const ownBefore = before ? userLabelsOf(before.labels) : null;
	if (!ownBefore || ownBefore.length !== own.length || own.some((id) => !ownBefore.includes(id))) {
		if ((await setLocalLabelsOf(deps, localId, own)) && deps.tally) deps.tally.labels++;
	}
	const next = stateOf(labels);
	const prev = before ? stateOf(before.labels) : null;
	if (!prev || prev.read !== next.read || prev.starred !== next.starred) {
		await mailbox.updateEmail(localId, { read: next.read, starred: next.starred });
	}
	if (!prev || prev.folder !== next.folder) await mailbox.moveEmail(localId, next.folder);
	if (!labels.includes("DRAFT")) store.deleteDraft(localId);
}

async function removeLocal(deps: SyncDeps, localId: string): Promise<void> {
	const attachments = await deps.mailbox.deleteEmail(localId);
	if (attachments?.length) {
		await deps.bucket.delete(attachments.map((a) => `attachments/${localId}/${a.id}/${a.filename}`)).catch(() => {});
	}
	deps.store.deleteMessage(localId);
	deps.store.deleteDraft(localId);
}

// ── ingest: one Gmail message into MailboxDO ───────────────────────

export interface Ingested {
	localId: string;
	threadId: string;
	labels: string[];
	sender: string;
	subject: string;
	date: number;
}

/**
 * Fetch one message (`format=raw`), parse it as receiveEmail() does, store
 * its attachments in R2 at upstream's keys and write it into MailboxDO
 * under its Gmail id. Null when it was known already or is gone.
 */
export async function ingest(deps: SyncDeps, ref: GmailMessageRef, draftId?: string): Promise<Ingested | null> {
	const { store, gmail, mailbox, bucket } = deps;
	if (store.messageByGmail(ref.id)) return null;
	let message: GmailMessage;
	try {
		message = await gmail.getMessage(ref.id, "raw");
	} catch (error) {
		if (error instanceof GmailError && error.status === 404) return null;
		throw error;
	}
	if (!message.raw) return null;
	const labels = message.labelIds ?? [];
	if (labels.includes("CHAT")) return null;
	const parsed = await new PostalMime().parse(fromBase64Url(message.raw));
	const localId = message.id;
	const threadId = store.localThreadOf(message.threadId);
	const state = stateOf(labels);

	const attachments: Record<string, unknown>[] = [];
	for (const att of parsed.attachments ?? []) {
		const attId = crypto.randomUUID();
		const filename = (att.filename || "untitled").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
		const content = typeof att.content === "string" ? new TextEncoder().encode(att.content) : att.content;
		await bucket.put(`attachments/${localId}/${attId}/${filename}`, content);
		attachments.push({
			id: attId,
			email_id: localId,
			filename,
			mimetype: att.mimeType,
			size: content.byteLength,
			content_id: att.contentId || null,
			disposition: att.disposition || "attachment",
		});
	}

	const inReplyTo = parsed.inReplyTo ? extractMsgId(parsed.inReplyTo) : null;
	const references = parsed.references ? parsed.references.split(/\s+/).filter(Boolean).map(extractMsgId) : [];
	const rfcMessageId = parsed.messageId ? extractMsgId(parsed.messageId) : null;
	const sender = (parsed.from?.address || "").toLowerCase();
	const subject = parsed.subject || "";
	const date = Number(message.internalDate) || (parsed.date ? Date.parse(parsed.date) : now(deps));
	const joined = (list?: { address?: string }[]) =>
		(list ?? []).map((a) => a.address?.toLowerCase()).filter(Boolean).join(", ") || null;

	try {
		await mailbox.createEmail(
			state.folder,
			{
				id: localId,
				subject,
				sender,
				recipient: joined(parsed.to) ?? "",
				cc: joined(parsed.cc),
				bcc: joined(parsed.bcc),
				date: new Date(date).toISOString(),
				body: parsed.html || parsed.text || "",
				read: state.read,
				starred: state.starred,
				in_reply_to: inReplyTo,
				email_references: references.length > 0 ? JSON.stringify(references) : null,
				thread_id: threadId,
				message_id: rfcMessageId,
				raw_headers: JSON.stringify(parsed.headers),
			},
			attachments,
		);
	} catch (error) {
		// Written by an earlier sync that stopped before it recorded the map.
		if (!(error instanceof Error && error.message.includes("UNIQUE constraint failed"))) throw error;
	}
	store.putMessage({ localId, gmailId: message.id, gmailThreadId: message.threadId, labels, rfcMessageId });
	const own = userLabelsOf(labels);
	if (own.length > 0) await setLocalLabelsOf(deps, localId, own);
	if (draftId) store.putDraft({ localId, gmailDraftId: draftId, gmailMessageId: message.id });
	return { localId, threadId, labels, sender, subject, date };
}

function extractMsgId(s: string): string {
	const m = s.match(/<([^>]+)>/);
	return m ? m[1] : s.trim().split(/\s+/)[0];
}

// ── auto-drafts and draft jobs ─────────────────────────────────────

function isInboundNew(deps: SyncDeps, m: Ingested): boolean {
	return m.labels.includes("INBOX") && !m.labels.includes("DRAFT") && !m.labels.includes("SENT") && m.sender !== deps.address.toLowerCase();
}

/** The first pull's few drafts: the newest unread inbox message of the newest threads, recent only. */
function firstPullDraftable(deps: SyncDeps, pulled: Ingested[]): Ingested[] {
	const cutoff = now(deps) - FIRST_PULL_AUTO_DRAFT_WINDOW_MS;
	const newestPerThread = new Map<string, Ingested>();
	for (const m of pulled) {
		const seen = newestPerThread.get(m.threadId);
		if (!seen || m.date > seen.date) newestPerThread.set(m.threadId, m);
	}
	return [...newestPerThread.values()]
		.filter((m) => isInboundNew(deps, m) && m.labels.includes("UNREAD") && m.date >= cutoff)
		.sort((a, b) => b.date - a.date)
		.slice(0, FIRST_PULL_AUTO_DRAFTS);
}

function startAutoDrafts(deps: SyncDeps, emails: Ingested[]): void {
	if (!deps.pokeAgent) return;
	const queuedAt = now(deps);
	for (const m of emails.filter((e) => !deps.store.hasJob(e.localId)).slice(0, AUTO_DRAFTS_PER_SYNC)) {
		deps.store.addJob(m.localId, m.threadId, queuedAt);
		deps.pokeAgent({ mailboxId: deps.address, emailId: m.localId, sender: m.sender, subject: m.subject, threadId: m.threadId });
	}
}

/** A queued job is done once a draft written after it was queued sits in its thread; failed after JOB_TIMEOUT_MS. */
export async function refreshJobs(deps: SyncDeps): Promise<void> {
	const t = now(deps);
	for (const job of deps.store.queuedJobs()) {
		const drafts = await deps.mailbox.getEmails({ folder: Folders.DRAFT, thread_id: job.threadId, limit: 5 });
		if (drafts.some((d) => Date.parse(d.date) >= job.queuedAt - 1000)) {
			deps.store.finishJob(job.emailId, "done", t);
		} else if (t - job.queuedAt > JOB_TIMEOUT_MS) {
			deps.store.finishJob(job.emailId, "failed", t);
		}
	}
}

/** Recent jobs (the last hour, and every queued one), each with the estimate. */
export function draftJobs(deps: Pick<SyncDeps, "store" | "now">): DraftJobView[] {
	const estimateMs = estimate(deps.store.doneDurations(20));
	return deps.store.jobs(now(deps) - 60 * 60 * 1000).map((job) => ({ ...job, estimateMs }));
}

/** The median of the durations, or DEFAULT_ESTIMATE_MS without any. */
export function estimate(durations: number[]): number {
	if (durations.length === 0) return DEFAULT_ESTIMATE_MS;
	const sorted = [...durations].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// ── outbox ─────────────────────────────────────────────────────────

/**
 * Make the queued changes in Gmail, oldest first. A refusal that needs the
 * person to (re)connect stops the flush and is thrown, leaving the rest
 * queued; any other failure counts against the op (dropped after
 * MAX_ATTEMPTS) and the flush goes on. Returns how many ops were applied.
 */
export async function flushOutbox(deps: SyncDeps): Promise<number> {
	let pushed = 0;
	for (const pending of deps.store.pending()) {
		try {
			await applyOp(deps, pending);
			deps.store.complete(pending.id);
			pushed++;
		} catch (error) {
			if (error instanceof GmailError && error.reconnect) throw error;
			deps.store.fail(pending.id, error instanceof Error ? error.message : String(error));
		}
	}
	return pushed;
}

async function applyOp(deps: SyncDeps, { op }: PendingOp): Promise<void> {
	const { store, gmail } = deps;
	switch (op.kind) {
		case "labels": {
			const known = store.messageByLocal(op.localId);
			if (!known || (op.add.length === 0 && op.remove.length === 0)) return;
			const result = await gmail.modifyMessage(known.gmailId, op.add, op.remove);
			store.setLabelsOf(op.localId, result.labelIds ?? applyLabelChange(known.labels, op.add, op.remove));
			return;
		}
		case "thread_labels": {
			const gmailThread = store.gmailThreadOf(op.localId);
			if (!gmailThread) return;
			await gmail.modifyThread(gmailThread, op.add, op.remove);
			for (const m of store.messagesInGmailThread(gmailThread)) store.setLabelsOf(m.localId, applyLabelChange(m.labels, op.add, op.remove));
			return;
		}
		case "move": {
			const known = store.messageByLocal(op.localId);
			if (!known) return;
			const { change } = op;
			let labels = known.labels;
			if (change.trash) {
				labels = (await gmail.trashMessage(known.gmailId)).labelIds ?? applyLabelChange(labels, ["TRASH"]);
			} else {
				if (change.untrash) labels = (await gmail.untrashMessage(known.gmailId)).labelIds ?? applyLabelChange(labels, [], ["TRASH"]);
				if (change.add.length || change.remove.length) {
					labels = (await gmail.modifyMessage(known.gmailId, change.add, change.remove)).labelIds ?? applyLabelChange(labels, change.add, change.remove);
				}
			}
			store.setLabelsOf(op.localId, labels);
			return;
		}
		case "draft_upsert":
			return upsertDraft(deps, op.localId);
		case "draft_delete": {
			const draft = store.draftByLocal(op.localId);
			if (!draft) return;
			await deleteGmailDraft(gmail, draft.gmailDraftId);
			store.deleteDraft(op.localId);
			store.deleteMessage(op.localId);
			return;
		}
		case "label_create": {
			// Linked already: by the sync, by name, or by a conversation labelled first.
			await ensureGmailLabel(deps, op.localId, { name: op.name, color: op.color });
			return;
		}
		case "label_update": {
			const gmailId = store.gmailLabelOf(op.localId);
			if (!gmailId) {
				await ensureGmailLabel(deps, op.localId, { name: op.name, color: op.color });
				return;
			}
			if (!(await patchGmailLabel(gmail, gmailId, op.name, op.color))) {
				// Deleted in Gmail meanwhile: made again with the new name.
				store.unlinkLabel(op.localId);
				const created = await createGmailLabel(gmail, op.name, op.color);
				store.linkLabel(op.localId, created.id);
			}
			store.putLabel({ id: store.gmailLabelOf(op.localId)!, name: op.name, type: "user" });
			return;
		}
		case "label_delete": {
			const gmailId = op.gmailId ?? store.gmailLabelOf(op.localId);
			if (gmailId) await deleteGmailLabel(gmail, gmailId);
			store.unlinkLabel(op.localId);
			return;
		}
		case "label_thread":
			return labelGmailThreads(deps, op.localId, op.add, op.remove);
	}
}

/**
 * An OpenMail conversation's label change, made with threads.modify on each
 * Gmail thread its messages are in (one, nearly always), with the linked
 * Gmail labels; a label without a Gmail one gets it first.
 */
async function labelGmailThreads(deps: SyncDeps, threadKey: string, addLocal: string[], removeLocal: string[]): Promise<void> {
	const { store, gmail, mailbox } = deps;
	const threads = new Set<string>();
	const direct = store.gmailThreadOf(threadKey) ?? store.messageByLocal(threadKey)?.gmailThreadId;
	if (direct) threads.add(direct);
	for (const email of await mailbox.getEmails({ thread_id: threadKey, limit: 100 })) {
		const known = store.messageByLocal(email.id);
		if (known) threads.add(known.gmailThreadId);
	}
	if (threads.size === 0) return;
	const add: string[] = [];
	for (const id of addLocal) {
		const gmailId = await ensureGmailLabel(deps, id);
		if (gmailId) add.push(gmailId);
	}
	const remove = removeLocal.flatMap((id) => store.gmailLabelOf(id) ?? []);
	if (add.length === 0 && remove.length === 0) return;
	for (const thread of threads) {
		await gmail.modifyThread(thread, add, remove);
		for (const m of store.messagesInGmailThread(thread)) store.setLabelsOf(m.localId, applyLabelChange(m.labels, add, remove));
	}
}

/** drafts.delete. A draft already gone is fine. */
export async function deleteGmailDraft(gmail: GmailClient, gmailDraftId: string): Promise<void> {
	try {
		await gmail.deleteDraft(gmailDraftId);
	} catch (error) {
		if (!(error instanceof GmailError && error.status === 404)) throw error;
	}
}

/** The local draft written to Gmail: drafts.update, or drafts.create when it is new or gone from Gmail. */
async function upsertDraft(deps: SyncDeps, localId: string): Promise<void> {
	const { store, gmail, mailbox } = deps;
	const email = await mailbox.getEmail(localId);
	if (!email || email.folder_id !== Folders.DRAFT) return;
	const { raw, gmailThreadId } = await draftMessage(deps, email);
	const existing = store.draftByLocal(localId);
	let draft: GmailDraft | undefined;
	if (existing) {
		try {
			draft = await gmail.updateDraft(existing.gmailDraftId, raw, gmailThreadId);
		} catch (error) {
			// Deleted in Gmail meanwhile: write it again as a new draft.
			if (!(error instanceof GmailError && error.status === 404)) throw error;
		}
	}
	draft ??= await gmail.createDraft(raw, gmailThreadId);
	store.putDraft({ localId, gmailDraftId: draft.id, gmailMessageId: draft.message.id });
	store.putMessage({
		localId,
		gmailId: draft.message.id,
		gmailThreadId: draft.message.threadId,
		labels: draft.message.labelIds ?? ["DRAFT"],
		rfcMessageId: null,
	});
	if (email.thread_id) store.putThread(email.thread_id, draft.message.threadId);
}

/** The RFC 822 of a local draft, threaded under the email it replies to. */
export async function draftMessage(deps: Pick<SyncDeps, "store" | "mailbox" | "address">, email: LocalEmail): Promise<{ raw: string; gmailThreadId?: string }> {
	const { store, mailbox, address } = deps;
	// Upstream's drafts name the local id of the email they reply to; a few
	// name its Message-ID.
	const original = email.in_reply_to ? await mailbox.getEmail(email.in_reply_to) : null;
	const inReplyTo = original?.message_id ?? (original ? null : email.in_reply_to) ?? null;
	const references = [...parseReferences(original?.email_references), ...(original?.message_id ? [original.message_id] : [])];
	const gmailThreadId =
		(email.thread_id && store.gmailThreadOf(email.thread_id)) ||
		(original && store.messageByLocal(original.id)?.gmailThreadId) ||
		(inReplyTo && store.messageByRfcId(inReplyTo)?.gmailThreadId) ||
		undefined;
	const mime = buildMime({
		from: address,
		to: email.recipient ?? "",
		cc: email.cc ?? undefined,
		bcc: email.bcc ?? undefined,
		subject: email.subject ?? "",
		html: email.body ?? "",
		inReplyTo,
		references: references.length ? references : undefined,
	});
	return { raw: toBase64Url(mime), gmailThreadId };
}

function parseReferences(value: string | null | undefined): string[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
	} catch {
		return value.split(/\s+/).filter(Boolean);
	}
}

// ── helpers ────────────────────────────────────────────────────────

function now(deps: Pick<SyncDeps, "now">): number {
	return deps.now ? deps.now() : Date.now();
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]);
		}
	});
	await Promise.all(workers);
	return out;
}

export type { OutboxOp };
