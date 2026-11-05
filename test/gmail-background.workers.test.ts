// GmailSync's background sync in workerd (docs/GMAIL.md, "Background sync"):
// a person's sync arms the alarm; the alarm syncs on the owner's behalf
// (`for: { background: true, userId }`, the owner's own connection) and
// re-arms itself; a refusal only the owner can fix stops it until their
// next successful sync; a change queued by background work is flushed
// within seconds while it is on. The Gmail client is the fake Gmail,
// through GmailSync's clientFor() seam.
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import type { GatewayCallFor } from "@every-app/sdk/server";
import { describe, expect, it } from "vitest";
import { gmailClient } from "../workers/everyapp/gmail/client";
import {
	BACKGROUND_EVERY_MS,
	BACKGROUND_FLUSH_MS,
	BACKGROUND_MAX_MS,
	type GmailSync,
} from "../workers/everyapp/gmail/sync";
import { fakeGmail } from "./fixtures/fake-gmail";

let count = 0;

async function gmailMailbox(ownerId = "u-bg"): Promise<string> {
	const address = `bg-${Date.now()}-${count++}@example.com`;
	await env.BUCKET.put(`mailboxes/${address}.json`, JSON.stringify({ fromName: address, provider: "gmail", ownerId }));
	return address;
}

function sync(address: string) {
	return env.GMAIL_SYNC.get(env.GMAIL_SYNC.idFromName(address));
}

/** Route the mailbox's Gmail calls to `fetcher`, recording each call's target. */
async function useFake(address: string, fetcher: typeof fetch): Promise<GatewayCallFor[]> {
	const targets: GatewayCallFor[] = [];
	await runInDurableObject(sync(address), (instance: GmailSync) => {
		instance.clientFor = (target) => {
			targets.push(target instanceof Request ? ("person" as unknown as GatewayCallFor) : target);
			return gmailClient({}, target, fetcher);
		};
	});
	return targets;
}

const person = () => new Request("https://openmail.example.com/api/v1/mailboxes/x/gmail/sync", { method: "POST" });

async function alarmAt(address: string): Promise<number | null> {
	return runInDurableObject(sync(address), (_instance: GmailSync, state) => state.storage.getAlarm());
}

describe("background sync on the owner's behalf", () => {
	it("a person's sync arms it; the alarm syncs as the owner, turns on and re-arms; a queued change is flushed within seconds", async () => {
		const address = await gmailMailbox("u-owner-1");
		const gmail = fakeGmail(address);
		const targets = await useFake(address, gmail.fetch);

		const first = await sync(address).sync(address, person());
		expect(first.error).toBeUndefined();
		expect(first.background.state).toBe("pending");
		const armed = await alarmAt(address);
		expect(armed).not.toBeNull();
		expect(armed! - Date.now()).toBeLessThanOrEqual(BACKGROUND_FLUSH_MS);

		expect(await runDurableObjectAlarm(sync(address))).toBe(true);
		expect(targets.at(-1)).toMatchObject({ background: true, userId: "u-owner-1" });
		const after = await sync(address).backgroundView();
		expect(after.state).toBe("on");
		expect(after.lastRunAt).toBeGreaterThan(0);
		const next = await alarmAt(address);
		expect(next! - Date.now()).toBeGreaterThan(BACKGROUND_FLUSH_MS);
		expect(next! - Date.now()).toBeLessThanOrEqual(BACKGROUND_EVERY_MS);

		// The agent's draft, queued by background work, brings the alarm forward.
		await sync(address).enqueue(address, { kind: "labels", localId: "nope", add: ["STARRED"], remove: [] });
		expect((await alarmAt(address))! - Date.now()).toBeLessThanOrEqual(BACKGROUND_FLUSH_MS);
	});

	it("a refusal stops it, and the owner's next successful sync starts it again", async () => {
		const address = await gmailMailbox();
		const gmail = fakeGmail(address);
		await useFake(address, gmail.fetch);
		await sync(address).sync(address, person());

		// The connection is gone or expired: the Gateway's 409.
		gmail.state.disconnected = true;
		expect(await runDurableObjectAlarm(sync(address))).toBe(true);
		const off = await sync(address).backgroundView();
		expect(off).toMatchObject({ state: "off", code: "integration_not_connected" });
		expect(off.nextAt).toBeUndefined();
		expect(await alarmAt(address)).toBeNull();

		// The owner reconnects; their next sync arms the alarm again.
		gmail.state.disconnected = false;
		const mine = await sync(address).sync(address, person());
		expect(mine.error).toBeUndefined();
		expect(mine.background.state).toBe("pending");
		expect(await alarmAt(address)).not.toBeNull();
	});

	it("backs off on a failure that isn't a refusal, and stops for a mailbox that is gone", async () => {
		const address = await gmailMailbox();
		const gmail = fakeGmail(address);
		let down = false;
		const flaky = (async (input: RequestInfo | URL, init?: RequestInit) =>
			down
				? Response.json({ error: { message: "Backend Error", status: "UNAVAILABLE" } }, { status: 503 })
				: gmail.fetch(input, init)) as typeof fetch;
		await useFake(address, flaky);
		await sync(address).sync(address, person());
		expect(await runDurableObjectAlarm(sync(address))).toBe(true);
		expect((await sync(address).backgroundView()).state).toBe("on");

		down = true;
		await runDurableObjectAlarm(sync(address)); // the scheduled run, now failing
		const backoff = (await alarmAt(address))! - Date.now();
		expect(backoff).toBeGreaterThan(BACKGROUND_EVERY_MS);
		expect(backoff).toBeLessThanOrEqual(BACKGROUND_MAX_MS);
		expect((await sync(address).backgroundView()).state).toBe("on");

		await env.BUCKET.delete(`mailboxes/${address}.json`);
		await runDurableObjectAlarm(sync(address));
		expect(await sync(address).backgroundView()).toMatchObject({ state: "off", code: "gmail_mailbox_gone" });
		expect(await alarmAt(address)).toBeNull();
	});

	it("stops while the experimental Gmail integration is off", async () => {
		const address = await gmailMailbox("u-owner-off");
		const gmail = fakeGmail(address);
		const targets = await useFake(address, gmail.fetch);
		expect((await sync(address).sync(address, person())).error).toBeUndefined();
		const before = targets.length;
		await runInDurableObject(sync(address), async (instance: GmailSync) => {
			const on = (instance as unknown as { env: object }).env;
			Object.assign(instance, { env: { ...on, EXPERIMENTAL_GMAIL: "" } });
			try {
				await instance.alarm();
			} finally {
				Object.assign(instance, { env: on });
			}
		});
		expect(targets.length).toBe(before);
		expect(await sync(address).backgroundView()).toMatchObject({ state: "off", code: "gmail_disabled" });
		await runInDurableObject(sync(address), (_instance: GmailSync, state) => state.storage.deleteAlarm());
	});
});
