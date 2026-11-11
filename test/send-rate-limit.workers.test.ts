// The send rate limit (MailboxDO.checkSendRateLimit in workers/everyapp/mailbox.ts):
// 20 sends per hour and 100 per day per mailbox, counted from the Sent folder
// by time. Sent rows store ISO dates (`…T…Z`), which upstream compared as
// text with SQLite's `YYYY-MM-DD HH:MM:SS`, so every send since midnight UTC
// counted as within the last hour.
import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";

let count = 0;

/** A fresh mailbox with `ages` Sent rows, each `ageMs` milliseconds old. */
async function limitWithSent(ages: number[]): Promise<string | null> {
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(`rate-${Date.now()}-${count++}@example.com`));
	return runInDurableObject(stub, async (instance, state) => {
		const now = Date.now();
		ages.forEach((ageMs, i) =>
			state.storage.sql.exec(
				`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, read, starred, thread_id)
				 VALUES (?1, 'sent', 's', 'a@example.com', 'b@example.org', ?2, '', 1, 0, ?1)`,
				`sent-${i}`,
				new Date(now - ageMs).toISOString(),
			),
		);
		return instance.checkSendRateLimit();
	});
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

it("allows sends when the earlier ones are more than an hour old", async () => {
	expect(await limitWithSent(Array.from({ length: 20 }, () => 2 * HOUR))).toBeNull();
});

it("refuses the 21st send within an hour", async () => {
	expect(await limitWithSent(Array.from({ length: 20 }, () => 5 * MINUTE))).toBe(
		"Rate limit exceeded: max 20 emails per hour per mailbox",
	);
});

it("counts only the last hour's sends toward the hourly limit", async () => {
	const ages = [...Array.from({ length: 19 }, () => 5 * MINUTE), ...Array.from({ length: 10 }, () => 3 * HOUR)];
	expect(await limitWithSent(ages)).toBeNull();
});

it("refuses after 100 sends in a day", async () => {
	expect(await limitWithSent(Array.from({ length: 100 }, (_, i) => 2 * HOUR + i * MINUTE))).toBe(
		"Rate limit exceeded: max 100 emails per day per mailbox",
	);
});
