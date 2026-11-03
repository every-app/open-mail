/**
 * GmailSync: one SQLite Durable Object per Gmail mailbox (docs/GMAIL.md),
 * named by the mailbox's address. It holds the history cursor, the id maps,
 * the label links, the outbox and the draft jobs (./store.ts) and runs the
 * sync (./engine.ts), labels included (./label-sync.ts).
 *
 * Every Gmail call is for the mailbox's owner, on the owner's own Google
 * connection: `target` is either the request of the person behind the call
 * (passed in on each call, body stripped) or, from this object's alarm,
 * background work naming the owner (`for: { background: true, userId }`;
 * docs/GMAIL.md, "Background sync"). Background work that names nobody
 * (the agent's own calls) never reaches Gmail: its changes wait in the
 * outbox for the next sync, which the alarm makes soon after.
 *
 * The alarm: a person's sync arms it; it syncs every BACKGROUND_EVERY_MS on
 * the owner's behalf and re-arms itself. A refusal only the owner can fix
 * (the connection is gone, expired or must be made again) stops it until
 * the owner's next successful sync; other failures back off up to
 * BACKGROUND_MAX_MS.
 *
 * RPC errors lose their class on the way back, so the methods the routes
 * call answer `{ error }` (a GmailErrorInfo) instead of throwing a
 * GmailError.
 */
import { DurableObject } from "cloudflare:workers";
import type { GatewayCallFor } from "@every-app/sdk/server";
import { withNamedAgents } from "../inbound";
import { gmailClient, gmailDraftUrl, gmailThreadUrl, type GmailClient } from "./client";
import {
	draftJobs,
	flushOutbox,
	refreshJobs,
	runSync,
	type DraftJobView,
	type MailboxStubLike,
	type NewEmail,
	type SyncDeps,
	type SyncResult,
} from "./engine";
import { GmailStore, type OutboxOp, type Sql } from "./store";
import { readMailboxSettings } from "../mailbox-settings";
import {
	canReachGmail,
	knownFailure,
	memberBackground,
	onMembersBehalf,
	personBehind,
	type GmailErrorInfo,
	type Outcome,
} from "./target";

export {
	canReachGmail,
	errorInfo,
	forwardTarget,
	gmailSyncOf,
	knownFailure,
	personBehind,
	type GmailErrorInfo,
	type Outcome,
} from "./target";

/** How often the alarm syncs on the owner's behalf while background sync is on. */
export const BACKGROUND_EVERY_MS = 2 * 60_000;
/** How soon the alarm flushes a change background work queued (the agent's draft). */
export const BACKGROUND_FLUSH_MS = 5_000;
/** The longest back-off after a failure that isn't a refusal (Gmail or the Gateway down). */
export const BACKGROUND_MAX_MS = 30 * 60_000;

/**
 * Background sync as the sync answer reports it: `on` (the last background
 * run reached Gmail), `off` (refused until the owner reconnects; `code` says
 * why), `pending` (armed, not run yet), `idle` (never armed).
 */
export interface BackgroundView {
	state: "on" | "off" | "pending" | "idle";
	/** The last background run (ms since the epoch). */
	lastRunAt?: number;
	/** The next alarm, if armed. */
	nextAt?: number;
	/** Why it is off: the Gateway's code (`integration_not_connected`, …). */
	code?: string;
	message?: string;
}

interface BackgroundRecord {
	state: "on" | "off" | "pending";
	at: number;
	lastRunAt?: number;
	failures?: number;
	code?: string;
	message?: string;
}

export type SyncAnswer = SyncResult & { background: BackgroundView };

export class GmailSync extends DurableObject<Cloudflare.Env> {
	readonly store: GmailStore;
	private chain: Promise<unknown> = Promise.resolve();
	/**
	 * The run in progress, per kind: a person's and the alarm's are kept
	 * apart (serial() still runs them one at a time), each with its own
	 * target.
	 */
	private syncing = new Map<"person" | "background", Promise<SyncResult>>();

	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		this.store = new GmailStore(ctx.storage.sql as unknown as Sql);
	}

	/**
	 * Queue a Gmail change the wrapped `env.MAILBOX` applied locally. While
	 * background sync is on, the alarm flushes it within seconds (the
	 * agent's draft, made with nobody behind it).
	 */
	async enqueue(mailboxId: string, op: OutboxOp): Promise<void> {
		this.remember(mailboxId);
		this.store.enqueue(op);
		if (this.backgroundRecord()?.state === "on") await this.armAlarm(BACKGROUND_FLUSH_MS);
	}

	/** Make the queued changes in Gmail now, for the person behind `target` (or the owner, in the background). */
	async flush(mailboxId: string, target?: GatewayCallFor): Promise<{ pushed: number; error?: GmailErrorInfo }> {
		this.remember(mailboxId);
		if (!canReachGmail(target)) return { pushed: 0 };
		return this.serial(async () => {
			try {
				return { pushed: await flushOutbox(this.deps(mailboxId, this.clientFor(target))) };
			} catch (error) {
				const failure = knownFailure(error);
				if (failure) return { pushed: 0, error: failure };
				throw error;
			}
		});
	}

	/**
	 * Flush the outbox, pull Gmail's changes, poke the agent for new inbox
	 * mail. Concurrent calls (the UI's poll beside an MCP call, the alarm)
	 * share one run. A person's sync also arms background sync.
	 */
	async sync(mailboxId: string, target?: GatewayCallFor): Promise<SyncAnswer> {
		this.remember(mailboxId);
		if (!canReachGmail(target)) {
			const deps = this.deps(mailboxId);
			await refreshJobs(deps);
			return {
				pulled: 0,
				pushed: 0,
				relabeled: 0,
				historyId: this.store.get<string>("historyId") ?? null,
				drafting: draftJobs(deps),
				background: await this.backgroundView(),
			};
		}
		const result = await this.run(mailboxId, target);
		if (personBehind(target) && !result.error) await this.armForPerson();
		return { ...result, background: await this.backgroundView() };
	}

	/** One shared run of the sync for `target`. */
	private run(mailboxId: string, target: GatewayCallFor): Promise<SyncResult> {
		const kind = onMembersBehalf(target) ? "background" : "person";
		const running = this.syncing.get(kind);
		if (running) return running;
		const run = this.serial(async () => {
			try {
				return await this.syncWith(mailboxId, this.clientFor(target));
			} catch (error) {
				const failure = knownFailure(error);
				if (!failure) throw error;
				const deps = this.deps(mailboxId);
				return {
					pulled: 0,
					pushed: 0,
					relabeled: 0,
					historyId: this.store.get<string>("historyId") ?? null,
					drafting: draftJobs(deps),
					error: { code: failure.code, message: failure.message, reconnect: failure.reconnect },
				};
			}
		}).finally(() => {
			this.syncing.delete(kind);
		});
		this.syncing.set(kind, run);
		return run;
	}

	/**
	 * The alarm: one sync on the owner's behalf, then the next alarm. The
	 * owner comes from the mailbox's settings each time, so a deleted
	 * mailbox, or one that is no longer Gmail or has no owner, stops it.
	 */
	override async alarm(): Promise<void> {
		const mailboxId = this.store.get<string>("address");
		const settings = mailboxId ? await readMailboxSettings(this.env.BUCKET, mailboxId).catch(() => null) : null;
		if (!mailboxId || settings?.provider !== "gmail" || !settings.ownerId) {
			this.setBackground({ state: "off", at: Date.now(), code: "gmail_mailbox_gone", message: "The Gmail mailbox or its owner is gone." });
			return;
		}
		const result = await this.run(mailboxId, memberBackground(this.env, settings.ownerId));
		const now = Date.now();
		const before = this.backgroundRecord();
		if (!result.error) {
			this.setBackground({ state: "on", at: now, lastRunAt: now });
			await this.armAlarm(BACKGROUND_EVERY_MS);
			return;
		}
		if (needsPerson(result.error.code)) {
			// The connection is gone or must be made again: only the owner can fix it.
			this.setBackground({ state: "off", at: now, lastRunAt: before?.lastRunAt, code: result.error.code, message: result.error.message });
			return;
		}
		const failures = (before?.failures ?? 0) + 1;
		this.setBackground({ ...(before ?? { state: "pending" }), at: now, failures, code: result.error.code, message: result.error.message });
		await this.armAlarm(Math.min(BACKGROUND_EVERY_MS * 2 ** failures, BACKGROUND_MAX_MS));
	}

	/** Background sync as the UI shows it. */
	async backgroundView(): Promise<BackgroundView> {
		const record = this.backgroundRecord();
		const next = await this.ctx.storage.getAlarm();
		const view: BackgroundView = { state: record?.state ?? (next ? "pending" : "idle") };
		if (record?.lastRunAt) view.lastRunAt = record.lastRunAt;
		if (next) view.nextAt = next;
		if (record?.state === "off" && record.code) {
			view.code = record.code;
			if (record.message) view.message = record.message;
		}
		return view;
	}

	/**
	 * After a person's successful sync: arm the alarm unless it is armed. The
	 * owner's connection works again, so a stopped alarm starts again too.
	 */
	private async armForPerson(): Promise<void> {
		if (await this.ctx.storage.getAlarm()) return;
		const record = this.backgroundRecord();
		if (!record || record.state === "off") this.setBackground({ state: "pending", at: Date.now(), lastRunAt: record?.lastRunAt });
		await this.armAlarm(record?.state === "on" ? BACKGROUND_EVERY_MS : BACKGROUND_FLUSH_MS);
	}

	/** Set the alarm `delayMs` from now, or sooner if it is set sooner already. */
	private async armAlarm(delayMs: number): Promise<void> {
		const at = Date.now() + delayMs;
		const current = await this.ctx.storage.getAlarm();
		if (current === null || current > at) await this.ctx.storage.setAlarm(at);
	}

	private backgroundRecord(): BackgroundRecord | undefined {
		return this.store.get<BackgroundRecord>("background");
	}

	private setBackground(record: BackgroundRecord): void {
		this.store.set("background", record);
	}

	/**
	 * The Gmail client for `target`: the person's request, or the owner in
	 * the background. A seam the workers tests replace with a fake Gmail.
	 */
	clientFor(target: GatewayCallFor): GmailClient {
		return gmailClient(this.env, target);
	}

	/** The sync with a given client (the tests pass a fake Gmail). */
	syncWith(mailboxId: string, gmail: GmailClient): Promise<SyncResult> {
		return runSync(this.deps(mailboxId, gmail));
	}

	/** The draft jobs, refreshed against the mailbox's drafts. */
	async drafting(mailboxId: string): Promise<DraftJobView[]> {
		this.remember(mailboxId);
		const deps = this.deps(mailboxId);
		await refreshJobs(deps);
		return draftJobs(deps);
	}

	/** Where the email opens in Gmail: its draft, else its thread. Flushes first so a new draft has one. */
	async gmailLink(mailboxId: string, target: GatewayCallFor | undefined, emailId: string): Promise<Outcome<string> | null> {
		this.remember(mailboxId);
		if (canReachGmail(target) && this.store.pending().some((p) => p.op.localId === emailId)) {
			const flushed = await this.flush(mailboxId, target);
			if (flushed.error) return { ok: false, error: flushed.error };
		}
		const draft = this.store.draftByLocal(emailId);
		if (draft) return { ok: true, value: gmailDraftUrl(mailboxId, draft.gmailMessageId) };
		const known = this.store.messageByLocal(emailId);
		if (known) return { ok: true, value: gmailThreadUrl(mailboxId, known.gmailThreadId) };
		const thread = this.store.gmailThreadOf(emailId);
		return thread ? { ok: true, value: gmailThreadUrl(mailboxId, thread) } : null;
	}

	/** The Gmail thread an RFC Message-ID (or a local email id) belongs to, for a send's threadId. */
	async gmailThreadFor(idOrMessageId: string): Promise<string | null> {
		const bare = idOrMessageId.trim().replace(/^<|>$/g, "");
		return (this.store.messageByRfcId(bare) ?? this.store.messageByLocal(bare))?.gmailThreadId ?? null;
	}

	/** The engine's dependencies for this mailbox: the raw MailboxDO (no outbox echo), R2, the agent. */
	deps(mailboxId: string, gmail?: GmailClient): SyncDeps {
		const mailbox = this.env.MAILBOX.get(this.env.MAILBOX.idFromName(mailboxId)) as unknown as MailboxStubLike;
		return {
			store: this.store,
			gmail: gmail ?? (undefined as unknown as GmailClient),
			mailbox,
			bucket: this.env.BUCKET,
			address: mailboxId,
			pokeAgent: (email) => this.pokeAgent(email),
		};
	}

	/** The agent's auto-draft, started as receiveEmail() starts it (fire and forget). */
	private pokeAgent(email: NewEmail): void {
		const agents = withNamedAgents(this.env).EMAIL_AGENT as unknown as DurableObjectNamespace;
		const agent = agents.get(agents.idFromName(email.mailboxId));
		this.ctx.waitUntil(
			agent
				.fetch(
					new Request("https://agents/onNewEmail", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(email),
					}),
				)
				.then((response) => response.body?.cancel())
				.catch((e) => console.error("[gmail] auto-draft trigger failed:", (e as Error).message)),
		);
	}

	private remember(mailboxId: string): void {
		if (this.store.get<string>("address") !== mailboxId) this.store.set("address", mailboxId);
	}

	/** One Gmail run at a time: the outbox and the cursor are not safe to interleave. */
	private serial<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.chain.then(fn, fn);
		this.chain = run.catch(() => undefined);
		return run;
	}
}

/**
 * A refusal only the owner can fix: the Gateway's integration_* codes (no
 * connection, or one that must be made again) and Google's 401.
 */
export function needsPerson(code: string): boolean {
	return code.startsWith("integration_") || code === "gmail_not_configured" || code === "http_401" || code === "authError";
}
