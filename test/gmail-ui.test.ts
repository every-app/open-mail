// The Gmail UI's pure parts (docs/GMAIL.md): the drafting timer's words, the
// sync line's words, which job a row shows, the sync poll's schedule,
// and the routes the browser's Gmail client calls.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createSyncLoop,
	draftingText,
	findDraftJob,
	formatElapsed,
	formatEstimate,
	formatSyncedAgo,
	isGmailMailbox,
	isReconnectError,
	needsReconnect,
	syncChangedMail,
	toMillis,
} from "../app/lib/gmail";
import { ApiError } from "../app/services/api";
import gmailApi, { type DraftJob, type GmailStatus } from "../app/services/gmail-api";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

const job = (patch: Partial<DraftJob> = {}): DraftJob => ({
	emailId: "e1",
	threadId: "t1",
	state: "queued",
	queuedAt: 1_000_000,
	...patch,
});

describe("drafting status", () => {
	it("reads as a stopwatch, never negative", () => {
		expect(formatElapsed(0)).toBe("0:00");
		expect(formatElapsed(42_900)).toBe("0:42");
		expect(formatElapsed(70_000)).toBe("1:10");
		expect(formatElapsed(725_000)).toBe("12:05");
		expect(formatElapsed(3_723_000)).toBe("1:02:03");
		expect(formatElapsed(-5_000)).toBe("0:00");
		expect(formatElapsed(Number.NaN)).toBe("0:00");
	});

	it("rounds the estimate to 10 seconds, 10 s at least", () => {
		expect(formatEstimate(68_000)).toBe("~1:10");
		expect(formatEstimate(64_000)).toBe("~1:00");
		expect(formatEstimate(2_000)).toBe("~0:10");
	});

	it("says how long a queued job has run, with the estimate when there is one", () => {
		const now = 1_000_000 + 42_000;
		expect(draftingText(job({ estimateMs: 70_000 }), now)).toBe("Drafting reply… 0:42 (usually ~1:10)");
		expect(draftingText(job(), now)).toBe("Drafting reply… 0:42");
		expect(draftingText(job({ queuedAt: new Date(1_000_000).toISOString() }), now)).toBe("Drafting reply… 0:42");
		expect(draftingText(job({ queuedAt: "1000000" }), now)).toBe("Drafting reply… 0:42");
	});

	it("says a failed job failed and what to do, and nothing for a done one", () => {
		expect(draftingText(job({ state: "failed" }), 0)).toBe("Couldn't draft a reply. Ask the agent to draft one.");
		expect(draftingText(job({ state: "done" }), 0)).toBeNull();
		expect(draftingText(undefined, 0)).toBeNull();
	});

	it("finds the newest job for an email or its thread", () => {
		const jobs = [
			job({ emailId: "a", threadId: "t", state: "failed", queuedAt: 1 }),
			job({ emailId: "b", threadId: "t", state: "queued", queuedAt: 2 }),
			job({ emailId: "c", threadId: "other", queuedAt: 3 }),
		];
		expect(findDraftJob(jobs, { emailId: "a" })?.state).toBe("failed");
		expect(findDraftJob(jobs, { emailId: "a", threadId: "t" })?.emailId).toBe("b");
		expect(findDraftJob(jobs, { emailId: "x", threadId: null })).toBeUndefined();
		expect(findDraftJob(undefined, { emailId: "a" })).toBeUndefined();
	});

	it("reads times as ISO text or epoch milliseconds", () => {
		expect(toMillis(5)).toBe(5);
		expect(toMillis("2026-10-31T00:00:00.000Z")).toBe(Date.UTC(2026, 9, 31));
		expect(toMillis(undefined)).toBeNaN();
	});
});

describe("sync status", () => {
	it("says how long ago the last sync was", () => {
		expect(formatSyncedAgo(10_000, 12_000)).toBe("Synced just now");
		expect(formatSyncedAgo(0, 12_400)).toBe("Synced 12 s ago");
		expect(formatSyncedAgo(0, 3 * 60_000 + 5_000)).toBe("Synced 3 min ago");
		expect(formatSyncedAgo(0, 2 * 3_600_000)).toBe("Synced 2 h ago");
	});

	it("refreshes the lists only when mail moved", () => {
		expect(syncChangedMail({ pulled: 0, pushed: 0 })).toBe(false);
		expect(syncChangedMail({ pulled: 2, pushed: 0 })).toBe(true);
		expect(syncChangedMail({ pulled: 0, pushed: 1 })).toBe(true);
		expect(syncChangedMail({ pulled: 0, pushed: 0, relabeled: 1 })).toBe(true);
	});

	it("tells a reconnect refusal from other errors", () => {
		expect(isReconnectError(new ApiError(409, { error: "gmail_reconnect", reconnect: true }))).toBe(true);
		expect(isReconnectError(new ApiError(409, { error: "Mailbox already exists" }))).toBe(false);
		expect(isReconnectError(new ApiError(500, { reconnect: true }))).toBe(false);
		expect(isReconnectError(new Error("x"))).toBe(false);
	});
});

describe("mailboxes and connections", () => {
	it("knows a Gmail mailbox by its settings", () => {
		expect(isGmailMailbox({ settings: { provider: "gmail" } })).toBe(true);
		expect(isGmailMailbox({ settings: { fromName: "x" } })).toBe(false);
		expect(isGmailMailbox({})).toBe(false);
		expect(isGmailMailbox(undefined)).toBe(false);
	});

	it("reads whether the connection needs reconnecting", () => {
		const status = (connection: GmailStatus["connection"]): GmailStatus => ({
			configured: true,
			connection,
			connectUrl: "https://gw/connect/google-workspace?app=openmail",
		});
		const base = { label: "ben@openseo.so", ready: true, reconnect: false };
		expect(needsReconnect(status(base))).toBe(false);
		expect(needsReconnect(status({ ...base, reconnect: true }))).toBe(true);
		expect(needsReconnect(status({ ...base, ready: false }))).toBe(true);
		expect(needsReconnect(status(null))).toBe(false);
	});
});

describe("the sync poll's schedule", () => {
	function harness(options: { visible?: boolean; run?: () => Promise<void> } = {}) {
		vi.useFakeTimers();
		let visible = options.visible ?? true;
		const run = vi.fn(options.run ?? (async () => {}));
		const loop = createSyncLoop({ run, isVisible: () => visible, now: () => Date.now() });
		return { loop, run, setVisible: (v: boolean) => (visible = v) };
	}

	it("syncs at once, then every 30 s after the last one ends", async () => {
		const { loop, run } = harness();
		await loop.syncNow();
		expect(run).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(29_999);
		expect(run).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(run).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(run).toHaveBeenCalledTimes(3);
		loop.stop();
		await vi.advanceTimersByTimeAsync(120_000);
		expect(run).toHaveBeenCalledTimes(3);
	});

	it("never runs two at once: a call while one runs is dropped", async () => {
		let finish!: () => void;
		const { loop, run } = harness({ run: () => new Promise<void>((resolve) => (finish = resolve)) });
		const first = loop.syncNow();
		expect(await loop.syncNow()).toBe(false);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(run).toHaveBeenCalledTimes(1);
		finish();
		expect(await first).toBe(true);
		loop.stop();
	});

	it("skips ticks while the tab is hidden, and syncs on wake unless it just did", async () => {
		const { loop, run, setVisible } = harness();
		await loop.syncNow();
		expect(await loop.wake()).toBe(false); // within the 5 s gap
		setVisible(false);
		await vi.advanceTimersByTimeAsync(90_000);
		expect(run).toHaveBeenCalledTimes(1);
		setVisible(true);
		expect(await loop.wake()).toBe(true);
		expect(run).toHaveBeenCalledTimes(2);
		loop.stop();
	});

	it("keeps polling after a failed sync", async () => {
		const { loop, run } = harness({
			run: async () => {
				throw new Error("offline");
			},
		});
		expect(await loop.syncNow()).toBe(true);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(run).toHaveBeenCalledTimes(2);
		loop.stop();
	});
});

describe("the Gmail client's routes", () => {
	function record(body: unknown, status = 200) {
		const calls: { url: string; method: string; body?: string }[] = [];
		vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
			calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
			return Response.json(body, { status });
		});
		return calls;
	}

	it("calls the routes docs/GMAIL.md names", async () => {
		const calls = record({});
		await gmailApi.getStatus();
		await gmailApi.createMailbox();
		await gmailApi.sync("me@openseo.so");
		await gmailApi.getDrafting("me@openseo.so");
		await gmailApi.getGmailLink("me@openseo.so", "e1");
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			"GET /api/v1/gmail/status",
			"POST /api/v1/gmail/mailboxes",
			"POST /api/v1/mailboxes/me@openseo.so/gmail/sync",
			"GET /api/v1/mailboxes/me@openseo.so/gmail/drafting",
			"GET /api/v1/mailboxes/me@openseo.so/emails/e1/gmail-link",
		]);
	});
});

describe("a build without the Gmail routes", () => {
	it("reads the HTML page an unknown route falls through to as a 404", async () => {
		vi.stubGlobal("fetch", async () => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }));
		const error = await gmailApi.getStatus().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ApiError);
		expect((error as ApiError).status).toBe(404);
	});
});
