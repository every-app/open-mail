// The port's everyapp_2_rethread migration (workers/everyapp/mailbox.ts): a
// conversation stored split (replies under the first message's Message-ID,
// the first message under its own id) is joined again.
import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { everyappMailboxMigrations } from "../workers/everyapp/mailbox";

it("joins replies stored under the first message's Message-ID to its conversation", async () => {
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(`rethread-${Date.now()}@example.com`));
	const rows = await runInDurableObject(stub, async (_instance, state) => {
		const sql = state.storage.sql;
		const insert = (id: string, threadId: string, messageId: string, date: string) =>
			sql.exec(
				`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, read, starred, thread_id, message_id)
				 VALUES (?1, 'inbox', 's', 'a@example.org', 'b@example.com', ?4, '', 0, 0, ?2, ?3)`,
				id, threadId, messageId, date,
			);
		insert("first", "first", "root@example.org", "2026-10-01T00:00:00.000Z");
		insert("reply-1", "root@example.org", "r1@example.org", "2026-10-02T00:00:00.000Z");
		insert("reply-2", "root@example.org", "r2@example.org", "2026-10-03T00:00:00.000Z");
		insert("alone", "alone", "alone@example.org", "2026-10-04T00:00:00.000Z");
		sql.exec(everyappMailboxMigrations.find((m) => m.name === "everyapp_2_rethread")!.sql);
		return [...sql.exec<{ id: string; thread_id: string }>(`SELECT id, thread_id FROM emails ORDER BY id`)];
	});
	expect(Object.fromEntries(rows.map((r) => [r.id, r.thread_id]))).toEqual({
		alone: "alone",
		first: "first",
		"reply-1": "first",
		"reply-2": "first",
	});
});
