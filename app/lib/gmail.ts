/**
 * Pure helpers behind the Gmail UI (docs/GMAIL.md): which mailbox is a Gmail
 * one, the drafting timer's words, the sync line's words, and
 * the sync poll's schedule. No React here, so test/gmail-ui.test.ts covers it.
 */
import type { DraftJob, GmailStatus, GmailSyncResult } from "~/services/gmail-api";
import { ApiError } from "~/services/api";

/** Whether a mailbox (from the list or the detail route) mirrors a Gmail account. */
export function isGmailMailbox(mailbox: { settings?: unknown } | null | undefined): boolean {
	const settings = mailbox?.settings as { provider?: unknown } | undefined;
	return settings?.provider === "gmail";
}

/** A time the API gives as ISO text or epoch milliseconds, in milliseconds (NaN if neither). */
export function toMillis(time: string | number | undefined): number {
	if (typeof time === "number") return time;
	if (typeof time === "string") return /^\d+$/.test(time) ? Number(time) : Date.parse(time);
	return Number.NaN;
}

/** `0:42`, `1:10`, `12:05`, `1:02:03`: a stopwatch, never negative. */
export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = String(total % 60).padStart(2, "0");
	return hours > 0
		? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
		: `${minutes}:${seconds}`;
}

/** An estimate, to the nearest 10 seconds (10 s at least): `~1:10`. */
export function formatEstimate(ms: number): string {
	const rounded = Math.max(10_000, Math.round(ms / 10_000) * 10_000);
	return `~${formatElapsed(rounded)}`;
}

/** What a drafting job reads as at `now`, or null when there is nothing to show (done). */
export function draftingStatus(
	job: DraftJob | undefined,
	now: number,
): { state: "queued"; elapsed: string; estimate?: string } | { state: "failed" } | null {
	if (!job) return null;
	if (job.state === "failed") return { state: "failed" };
	if (job.state !== "queued") return null;
	const queuedAt = toMillis(job.queuedAt);
	const elapsed = formatElapsed(Number.isFinite(queuedAt) ? now - queuedAt : 0);
	const estimate =
		typeof job.estimateMs === "number" && job.estimateMs > 0
			? formatEstimate(job.estimateMs)
			: undefined;
	return { state: "queued", elapsed, estimate };
}

/** The full sentence: "Drafting reply… 0:42 (usually ~1:10)". */
export function draftingText(job: DraftJob | undefined, now: number): string | null {
	const status = draftingStatus(job, now);
	if (!status) return null;
	if (status.state === "failed") return "Couldn't draft a reply. Ask the agent to draft one.";
	return `Drafting reply… ${status.elapsed}${status.estimate ? ` (usually ${status.estimate})` : ""}`;
}

/**
 * The job for a message or a list row: the newest that names the email, or
 * its thread. Done jobs count too, so a finished draft hides an older failure.
 */
export function findDraftJob(
	jobs: DraftJob[] | undefined,
	target: { emailId?: string; threadId?: string | null },
): DraftJob | undefined {
	let found: DraftJob | undefined;
	for (const job of jobs ?? []) {
		const matches =
			(target.emailId && job.emailId === target.emailId) ||
			(target.threadId && job.threadId === target.threadId);
		if (!matches) continue;
		if (!found || toMillis(job.queuedAt) > toMillis(found.queuedAt)) found = job;
	}
	return found;
}

/** Whether any job is still being written (the timer only ticks then). */
export function hasQueuedJob(jobs: DraftJob[] | undefined): boolean {
	return (jobs ?? []).some((job) => job.state === "queued");
}

/** "Synced just now", "Synced 12 s ago", "Synced 3 min ago", "Synced 2 h ago". */
export function formatSyncedAgo(syncedAt: number, now: number): string {
	const seconds = Math.max(0, Math.floor((now - syncedAt) / 1000));
	if (seconds < 5) return "Synced just now";
	if (seconds < 60) return `Synced ${seconds} s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `Synced ${minutes} min ago`;
	return `Synced ${Math.floor(minutes / 60)} h ago`;
}

/** Whether a sync brought, sent or relabeled anything, so the lists, counts and labels are stale. */
export function syncChangedMail(result: Pick<GmailSyncResult, "pulled" | "pushed" | "relabeled">): boolean {
	return result.pulled > 0 || result.pushed > 0 || (result.relabeled ?? 0) > 0;
}

/** A refusal that only reconnecting Google fixes (409 `reconnect: true`). */
export function isReconnectError(err: unknown): boolean {
	return err instanceof ApiError && err.status === 409 && err.body.reconnect === true;
}

/** The setup for personal @gmail.com accounts (the Gateway's Google app must allow them). */
export const PERSONAL_GMAIL_DOCS = "https://everyapp.com/docs/google-personal-accounts";

/** Whether the Google connection must be renewed before Gmail works. */
export function needsReconnect(status: GmailStatus | undefined): boolean {
	const connection = status?.connection;
	return !!connection && (connection.reconnect || !connection.ready);
}

// ---------- The sync poll's schedule ----------

export const SYNC_INTERVAL_MS = 30_000;
/** Focus and visibility changes within this long of the last sync don't sync again. */
export const SYNC_FOCUS_GAP_MS = 5_000;

export interface SyncLoopOptions {
	/** One sync; the loop catches what it throws. */
	run: () => Promise<void>;
	isVisible: () => boolean;
	intervalMs?: number;
	focusGapMs?: number;
	now?: () => number;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (timer: unknown) => void;
}

export interface SyncLoop {
	/** Sync now unless one is running (mount, a click). */
	syncNow: () => Promise<boolean>;
	/** The window got focus or the tab became visible: sync unless one ran within the gap. */
	wake: () => Promise<boolean>;
	stop: () => void;
}

/**
 * Sync now, then every `intervalMs` after the last sync ends while the tab is
 * visible (a hidden tab's tick waits for the next one), and on `wake()`.
 * Never two at once: a call while one runs is dropped, not queued.
 */
export function createSyncLoop(options: SyncLoopOptions): SyncLoop {
	const intervalMs = options.intervalMs ?? SYNC_INTERVAL_MS;
	const focusGapMs = options.focusGapMs ?? SYNC_FOCUS_GAP_MS;
	const now = options.now ?? Date.now;
	const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
	const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
	let timer: unknown;
	let running = false;
	let stopped = false;
	let lastStart = Number.NEGATIVE_INFINITY;

	const cancel = () => {
		if (timer !== undefined) clearTimer(timer);
		timer = undefined;
	};
	const schedule = () => {
		cancel();
		if (stopped) return;
		timer = setTimer(() => {
			timer = undefined;
			if (options.isVisible()) void syncNow();
			else schedule();
		}, intervalMs);
	};
	const syncNow = async (): Promise<boolean> => {
		if (stopped || running) return false;
		running = true;
		lastStart = now();
		cancel();
		try {
			await options.run();
		} catch {
			// run() reports its own failures; the loop only keeps time.
		} finally {
			running = false;
			schedule();
		}
		return true;
	};

	return {
		syncNow,
		wake: async () => (now() - lastStart >= focusGapMs ? syncNow() : false),
		stop: () => {
			stopped = true;
			cancel();
		},
	};
}
