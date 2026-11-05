// The Gmail sync engine against a fake Gmail: the first recent pull, history
// (adds, label changes, deletes, an expired cursor), the outbox (labels,
// moves, drafts, the Gateway's PUT/DELETE refusal and its fallbacks), labels
// both ways (Gmail's user labels as OpenMail's own), and draft-job timing.
import { describe, expect, it } from "vitest";
import {
	DEFAULT_ESTIMATE_MS,
	JOB_TIMEOUT_MS,
	draftJobs,
	estimate,
	flushOutbox,
	refreshJobs,
	runSync,
} from "../workers/everyapp/gmail/engine";
import { GMAIL_COLORS, localColorOf, syncLabels } from "../workers/everyapp/gmail/label-sync";
import { LABEL_COLORS, colorForName } from "../workers/everyapp/label-model";
import { fakeGmail, rfc822 } from "./fixtures/fake-gmail";
import { ADDRESS, harness } from "./fixtures/gmail-harness";

const HOUR = 60 * 60 * 1000;

function seeded() {
	const h = harness();
	const t = h.clock.now;
	h.gmail.add({ id: "m1", threadId: "t1", labelIds: ["INBOX", "UNREAD"], internalDate: String(t - HOUR), raw: rfc822({ subject: "Order 1042", messageId: "q1042@example.org" }) });
	h.gmail.add({ id: "m2", threadId: "t2", labelIds: ["INBOX", "STARRED"], internalDate: String(t - 2 * HOUR), raw: rfc822({ subject: "Read one", from: "bob@example.org" }) });
	h.gmail.add({
		id: "m3",
		threadId: "t3",
		labelIds: ["INBOX", "UNREAD", "Label_1"],
		internalDate: String(t - 10 * 24 * HOUR),
		raw: rfc822({ subject: "Old with file", attachment: { filename: "notes.txt", content: "hello" } }),
	});
	h.gmail.add({ id: "m4", threadId: "t1", labelIds: ["SENT"], internalDate: String(t - 30 * 60 * 1000), raw: rfc822({ from: ADDRESS, to: "alice@example.org", subject: "Re: Order 1042" }) });
	const draft = h.gmail.add({ id: "m5", threadId: "t2", labelIds: ["DRAFT"], internalDate: String(t), raw: rfc822({ from: ADDRESS, subject: "Re: Read one" }) });
	h.gmail.drafts.set("d-own", draft.id);
	return h;
}

describe("the first sync", () => {
	it("pulls inbox, sent and drafts into MailboxDO under their Gmail ids, with folders, flags, threads and attachments", async () => {
		const h = seeded();
		const result = await runSync(h.deps);
		expect(result.error).toBeUndefined();
		expect(result.historyId).toBe("1000");
		expect(result.pulled).toBe(5);

		const m1 = h.mailbox.emails.get("m1")!;
		expect(m1).toMatchObject({ folder_id: "inbox", read: false, starred: false, thread_id: "t1", subject: "Order 1042", sender: "alice@example.org", message_id: "q1042@example.org" });
		expect(h.mailbox.emails.get("m2")).toMatchObject({ folder_id: "inbox", read: true, starred: true });
		expect(h.mailbox.emails.get("m4")).toMatchObject({ folder_id: "sent", thread_id: "t1" });
		expect(h.mailbox.emails.get("m5")).toMatchObject({ folder_id: "draft", thread_id: "t2" });
		expect(h.store.draftByLocal("m5")).toEqual({ localId: "m5", gmailDraftId: "d-own", gmailMessageId: "m5" });

		const m3 = h.mailbox.emails.get("m3")!;
		expect(m3.attachments).toHaveLength(1);
		const key = `attachments/m3/${m3.attachments[0].id}/notes.txt`;
		expect(new TextDecoder().decode(h.bucket.objects.get(key) as Uint8Array)).toBe("hello");
		expect(h.store.messageByLocal("m3")?.labels).toContain("Label_1");
		expect(h.store.labels().map((l) => l.name)).toContain("Customers");
	});

	it("drafts replies only for the newest unread inbox mail of the last days, not the backlog", async () => {
		const h = seeded();
		h.gmail.add({ id: "m7", threadId: "t7", labelIds: ["INBOX", "UNREAD"], internalDate: String(h.clock.now - 3 * HOUR), raw: rfc822({ subject: "Refund?", from: "carol@example.org" }) });
		await runSync(h.deps);
		// m1: unread but already answered (m4 is newer in t1). m2: read. m3:
		// ten days old. m5: a draft. m7: unread, recent, unanswered.
		expect(h.pokes).toEqual([{ mailboxId: ADDRESS, emailId: "m7", sender: "carol@example.org", subject: "Refund?", threadId: "t7" }]);
		expect(draftJobs(h.deps)).toEqual([{ emailId: "m7", threadId: "t7", state: "queued", queuedAt: h.clock.now, estimateMs: DEFAULT_ESTIMATE_MS }]);
	});

	it("drafts nothing, and queues no drafting job, while the mailbox's auto-drafting is off", async () => {
		const h = seeded();
		h.autoDraft.on = false;
		h.gmail.add({ id: "m7", threadId: "t7", labelIds: ["INBOX", "UNREAD"], internalDate: String(h.clock.now - 3 * HOUR), raw: rfc822({ subject: "Refund?", from: "carol@example.org" }) });
		await runSync(h.deps);
		expect(h.mailbox.emails.has("m7")).toBe(true);
		expect(h.pokes).toEqual([]);
		expect(draftJobs(h.deps)).toEqual([]);
	});

	it("asks Gmail for the last 30 days of inbox and sent mail", async () => {
		const h = seeded();
		await runSync(h.deps);
		const list = h.gmail.calls.find((c) => c.method === "GET" && c.path === "/messages")!;
		expect(list.query.q).toBe("newer_than:30d {in:inbox in:sent}");
	});
});

describe("history", () => {
	it("applies adds, label changes and deletes, and drafts the new inbox mail", async () => {
		const h = seeded();
		await runSync(h.deps);
		h.pokes.length = 0;
		h.gmail.add({ id: "m6", threadId: "t1", labelIds: ["INBOX", "UNREAD"], raw: rfc822({ subject: "Re: Order 1042", inReplyTo: "q1042@example.org" }) });
		h.gmail.state.historyId = 1010;
		h.gmail.state.history = [
			{ id: "1001", messagesAdded: [{ message: { id: "m6", threadId: "t1", labelIds: ["INBOX", "UNREAD"] } }] },
			{ id: "1002", labelsAdded: [{ message: { id: "m1", threadId: "t1" }, labelIds: ["STARRED"] }] },
			{ id: "1003", labelsRemoved: [{ message: { id: "m2", threadId: "t2", labelIds: ["STARRED"] }, labelIds: ["INBOX"] }] },
			{ id: "1004", labelsRemoved: [{ message: { id: "m1", threadId: "t1" }, labelIds: ["UNREAD"] }] },
			{ id: "1005", messagesDeleted: [{ message: { id: "m3", threadId: "t3" } }] },
		];
		const result = await runSync(h.deps);
		expect(result.historyId).toBe("1010");
		expect(h.mailbox.emails.get("m6")).toMatchObject({ folder_id: "inbox", thread_id: "t1", in_reply_to: "q1042@example.org" });
		expect(h.mailbox.emails.get("m1")).toMatchObject({ starred: true, read: true, folder_id: "inbox" });
		expect(h.mailbox.emails.get("m2")).toMatchObject({ folder_id: "archive", starred: true });
		expect(h.mailbox.emails.has("m3")).toBe(false);
		expect([...h.bucket.objects.keys()].some((k) => k.startsWith("attachments/m3/"))).toBe(false);
		expect(h.pokes.map((p) => p.emailId)).toEqual(["m6"]);
		// The Gmail calls bypass the outbox: nothing goes back to Gmail.
		expect(h.store.pending()).toEqual([]);
	});

	it("starts over with a recent pull when the cursor has expired, without duplicating mail", async () => {
		const h = seeded();
		await runSync(h.deps);
		h.gmail.state.historyExpired = true;
		h.gmail.state.historyId = 2000;
		const result = await runSync(h.deps);
		expect(result.error).toBeUndefined();
		expect(result.historyId).toBe("2000");
		expect(h.mailbox.emails.size).toBe(5);
		expect(h.gmail.calls.filter((c) => c.path === "/profile")).toHaveLength(2);
	});

	it("reports a connection that must be made again and keeps the outbox", async () => {
		const h = seeded();
		await runSync(h.deps);
		h.store.enqueue({ kind: "labels", localId: "m1", add: [], remove: ["UNREAD"] });
		h.gmail.state.disconnected = true;
		const result = await runSync(h.deps);
		expect(result.error).toMatchObject({ code: "integration_not_connected", reconnect: true });
		expect(h.store.pending()).toHaveLength(1);
	});
});

describe("the outbox", () => {
	it("makes read, star, archive, trash and thread-read changes in Gmail", async () => {
		const h = seeded();
		await runSync(h.deps);
		h.gmail.calls.length = 0;
		h.store.enqueue({ kind: "labels", localId: "m1", add: ["STARRED"], remove: ["UNREAD"] });
		h.store.enqueue({ kind: "move", localId: "m2", change: { add: [], remove: ["INBOX", "SPAM"] } });
		h.store.enqueue({ kind: "move", localId: "m3", change: { trash: true, add: [], remove: [] } });
		h.store.enqueue({ kind: "thread_labels", localId: "t1", add: [], remove: ["UNREAD"] });
		expect(await flushOutbox(h.deps)).toBe(4);
		expect(h.gmail.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			"POST /messages/m1/modify",
			"POST /messages/m2/modify",
			"POST /messages/m3/trash",
			"POST /threads/t1/modify",
		]);
		expect(h.gmail.calls[0].body).toEqual({ addLabelIds: ["STARRED"], removeLabelIds: ["UNREAD"] });
		expect(h.gmail.messages.get("m2")!.labelIds).not.toContain("INBOX");
		expect(h.store.messageByLocal("m3")!.labels).toContain("TRASH");
		expect(h.store.pending()).toEqual([]);
	});

	it("creates the agent's reply as a Gmail draft in the thread, threaded under the original, and doesn't pull it back", async () => {
		const h = seeded();
		await runSync(h.deps);
		await h.mailbox.createEmail(
			"draft",
			{ id: "local-draft-1", subject: "Re: Order 1042", sender: ADDRESS, recipient: "alice@example.org", date: new Date(h.clock.now).toISOString(), body: "<p>Ships Friday.</p>", in_reply_to: "m1", thread_id: "t1" },
			[],
		);
		h.store.enqueue({ kind: "draft_upsert", localId: "local-draft-1" });
		await flushOutbox(h.deps);
		const create = h.gmail.calls.find((c) => c.method === "POST" && c.path === "/drafts")!;
		expect(create.body.message.threadId).toBe("t1");
		const raw = h.gmail.rawText(create.body.message.raw);
		expect(raw).toContain("In-Reply-To: <q1042@example.org>");
		expect(raw).toContain("References: <q1042@example.org>");
		expect(raw).toContain("To: alice@example.org");
		const draft = h.store.draftByLocal("local-draft-1")!;
		expect(h.gmail.drafts.get(draft.gmailDraftId)).toBe(draft.gmailMessageId);

		// Gmail's history then reports the draft as added: it is known already.
		h.gmail.state.history = [{ id: "1001", messagesAdded: [{ message: { id: draft.gmailMessageId, threadId: "t1", labelIds: ["DRAFT"] } }] }];
		await runSync(h.deps);
		expect([...h.mailbox.emails.values()].filter((e) => e.folder_id === "draft")).toHaveLength(2);
	});

	it("updates a draft with drafts.update (PUT) and deletes it with drafts.delete (DELETE), the routes gmail.modify allows (#923)", async () => {
		const h = seeded();
		await runSync(h.deps);
		await h.mailbox.createEmail("draft", { id: "ld", subject: "Re: x", sender: ADDRESS, recipient: "a@example.org", date: "2026-10-30T12:00:00.000Z", body: "v1", thread_id: "t1" }, []);
		h.store.enqueue({ kind: "draft_upsert", localId: "ld" });
		await flushOutbox(h.deps);
		const first = h.store.draftByLocal("ld")!;

		// An edit: the same Gmail draft, updated in place.
		h.gmail.calls.length = 0;
		h.store.enqueue({ kind: "draft_upsert", localId: "ld" });
		await flushOutbox(h.deps);
		expect(h.gmail.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`PUT /drafts/${first.gmailDraftId}`]);
		const second = h.store.draftByLocal("ld")!;
		expect(second.gmailDraftId).toBe(first.gmailDraftId);

		// Deleted in Gmail meanwhile: the update's 404 writes it again as a new draft.
		h.gmail.drafts.delete(second.gmailDraftId);
		h.gmail.calls.length = 0;
		h.store.enqueue({ kind: "draft_upsert", localId: "ld" });
		await flushOutbox(h.deps);
		expect(h.gmail.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`PUT /drafts/${second.gmailDraftId}`, "POST /drafts"]);
		const third = h.store.draftByLocal("ld")!;
		expect(third.gmailDraftId).not.toBe(second.gmailDraftId);

		// Discarded: drafts.delete, nothing trashed.
		h.gmail.calls.length = 0;
		h.store.enqueue({ kind: "draft_delete", localId: "ld" });
		await flushOutbox(h.deps);
		expect(h.gmail.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`DELETE /drafts/${third.gmailDraftId}`]);
		expect(h.store.draftByLocal("ld")).toBeUndefined();
		expect(h.gmail.drafts.has(third.gmailDraftId)).toBe(false);
	});

	it("deleting a draft that never reached Gmail cancels its creation", async () => {
		const h = harness();
		h.store.enqueue({ kind: "draft_upsert", localId: "ld" });
		h.store.enqueue({ kind: "draft_delete", localId: "ld" });
		expect(h.store.pending()).toEqual([]);
	});

	it("drops an op after five failures and keeps going", async () => {
		const h = seeded();
		await runSync(h.deps);
		h.store.enqueue({ kind: "labels", localId: "m1", add: ["NOPE"], remove: [] });
		h.store.enqueue({ kind: "labels", localId: "m2", add: [], remove: ["STARRED"] });
		h.gmail.messages.delete("m1"); // Gmail answers 404 for it
		await flushOutbox(h.deps);
		expect(h.store.pending()).toHaveLength(1);
		for (let i = 0; i < 4; i++) await flushOutbox(h.deps);
		expect(h.store.pending()).toEqual([]);
		expect(h.gmail.messages.get("m2")!.labelIds).not.toContain("STARRED");
	});
});

describe("labels, both ways", () => {
	const byName = (h: ReturnType<typeof harness>, name: string) => [...h.mailbox.labels.values()].find((l) => l.name === name);
	const labelCalls = (h: ReturnType<typeof harness>) =>
		h.gmail.calls.filter((c) => c.path.startsWith("/labels") && c.method !== "GET").map((c) => `${c.method} ${c.path}`);

	it("each OpenMail color maps to a Gmail palette pair and back; any Gmail color to the nearest", () => {
		for (const color of LABEL_COLORS) expect(localColorOf(GMAIL_COLORS[color])).toBe(color);
		expect(localColorOf({ backgroundColor: "#cc3a21", textColor: "#ffffff" })).toBe("rose");
		expect(localColorOf({ backgroundColor: "#3c78d8" })).toBe("sky");
		expect(localColorOf(undefined)).toBeNull();
	});

	it("Gmail's user labels appear in OpenMail with their colors, and each message carries its own", async () => {
		const h = seeded();
		h.gmail.labels.find((l) => l.id === "Label_1")!.color = { backgroundColor: "#16a766", textColor: "#ffffff" };
		h.gmail.labels.push({ id: "Label_2", name: "Work/Reports", type: "user", color: { backgroundColor: "#cc3a21", textColor: "#ffffff" } });
		h.gmail.labels.push({ id: "Label_3", name: "Plain", type: "user" });
		h.gmail.messages.get("m1")!.labelIds.push("Label_2");
		const result = await runSync(h.deps);
		expect(result.relabeled).toBe(3);
		expect([...h.mailbox.labels.values()].map((l) => [l.name, l.color]).sort()).toEqual([
			["Customers", "emerald"],
			["Plain", colorForName("Plain")],
			["Work/Reports", "rose"],
		]);
		expect(h.mailbox.labelsOf("m3")).toEqual(["Customers"]);
		expect(h.mailbox.labelsOf("m1")).toEqual(["Work/Reports"]);
		expect(h.mailbox.labelsOf("m2")).toEqual([]);
		expect(h.store.gmailLabelOf(byName(h, "Customers")!.id)).toBe("Label_1");
		// One labels.list per sync, and nothing written back to Gmail.
		expect(h.gmail.calls.filter((c) => c.path === "/labels")).toHaveLength(1);
		expect(labelCalls(h)).toEqual([]);
		expect(h.store.pending()).toEqual([]);

		h.gmail.calls.length = 0;
		expect((await runSync(h.deps)).relabeled).toBe(0);
		expect(h.gmail.calls.filter((c) => c.path === "/labels")).toHaveLength(1);
	});

	it("a rename, a recolor and a delete in Gmail reach OpenMail", async () => {
		const h = seeded();
		h.gmail.labels.push({ id: "Label_2", name: "Old", type: "user" });
		h.gmail.messages.get("m1")!.labelIds.push("Label_2");
		await runSync(h.deps);
		const customers = byName(h, "Customers")!;
		expect(h.mailbox.labelsOf("m1")).toEqual(["Old"]);

		const label = h.gmail.labels.find((l) => l.id === "Label_1")!;
		label.name = "Clients";
		label.color = { backgroundColor: "#a479e2", textColor: "#ffffff" };
		h.gmail.labels.splice(h.gmail.labels.findIndex((l) => l.id === "Label_2"), 1);
		const result = await runSync(h.deps);
		expect(result.relabeled).toBe(2);
		expect(h.mailbox.labels.get(customers.id)).toEqual({ id: customers.id, name: "Clients", color: "violet" });
		expect(byName(h, "Old")).toBeUndefined();
		expect(h.mailbox.labelsOf("m1")).toEqual([]);
		expect(h.mailbox.labelsOf("m3")).toEqual(["Clients"]);
		expect(h.store.labelLinks()).toEqual([{ localId: customers.id, gmailId: "Label_1" }]);
		expect(labelCalls(h)).toEqual([]);
	});

	it("an OpenMail label with no Gmail label is made in Gmail, with its color, once; one of the same name is linked instead", async () => {
		const h = seeded();
		const receipts = await h.mailbox.createLabel("Receipts", "sky");
		const customers = await h.mailbox.createLabel("customers", "amber");
		if (!receipts.ok || !customers.ok) throw new Error("labels");
		await runSync(h.deps);
		expect(labelCalls(h)).toEqual(["POST /labels"]);
		const create = h.gmail.calls.find((c) => c.method === "POST" && c.path === "/labels")!;
		expect(create.body).toMatchObject({ name: "Receipts", color: { backgroundColor: "#4a86e8", textColor: "#ffffff" } });
		const gmailId = h.store.gmailLabelOf(receipts.label.id)!;
		expect(h.gmail.labels.find((l) => l.id === gmailId)?.name).toBe("Receipts");
		// Gmail's Customers is the local customers: linked, not made twice.
		expect(h.store.gmailLabelOf(customers.label.id)).toBe("Label_1");
		expect(h.mailbox.labels.size).toBe(2);
		expect(h.mailbox.labelsOf("m3")).toEqual(["customers"]);

		h.gmail.calls.length = 0;
		await runSync(h.deps);
		expect(labelCalls(h)).toEqual([]);
	});

	it("a queued creation isn't made twice by the sync; a refused color is tried again without one", async () => {
		const h = seeded();
		await runSync(h.deps);
		const vip = await h.mailbox.createLabel("VIP", "rose");
		if (!vip.ok) throw new Error("label");
		h.store.enqueue({ kind: "label_create", localId: vip.label.id, name: "VIP", color: "rose" });
		h.gmail.calls.length = 0;
		await syncLabels(h.deps);
		expect(labelCalls(h)).toEqual([]);

		h.gmail.state.refuseColors = true;
		expect(await flushOutbox(h.deps)).toBe(1);
		const creates = h.gmail.calls.filter((c) => c.method === "POST" && c.path === "/labels");
		expect(creates.map((c) => c.body.color ?? null)).toEqual([{ backgroundColor: "#fb4c2f", textColor: "#ffffff" }, null]);
		expect(h.store.gmailLabelOf(vip.label.id)).toBe(h.gmail.labels.find((l) => l.name === "VIP")!.id);
	});

	it("history's labelAdded and labelRemoved set the email's OpenMail labels, and leave a label not linked yet alone", async () => {
		const h = seeded();
		h.gmail.labels.push({ id: "Label_7", name: "VIP", type: "user" });
		await runSync(h.deps);
		expect(h.mailbox.labelsOf("m3")).toEqual(["Customers"]);
		h.gmail.state.history = [
			{ id: "1001", labelsAdded: [{ message: { id: "m1", threadId: "t1" }, labelIds: ["Label_7", "STARRED"] }] },
			{ id: "1002", labelsRemoved: [{ message: { id: "m3", threadId: "t3" }, labelIds: ["Label_1"] }] },
		];
		const result = await runSync(h.deps);
		expect(result.relabeled).toBe(2);
		expect(h.mailbox.labelsOf("m1")).toEqual(["VIP"]);
		expect(h.mailbox.emails.get("m1")).toMatchObject({ starred: true });
		expect(h.mailbox.labelsOf("m3")).toEqual([]);

		// A label made in OpenMail whose creation is still queued: Gmail's labels don't touch it.
		const local = await h.mailbox.createLabel("Later");
		if (!local.ok) throw new Error("label");
		await h.mailbox.setEmailLabels("m1", [local.label.id], [local.label.id]);
		h.store.enqueue({ kind: "label_create", localId: local.label.id, name: "Later", color: local.label.color });
		h.gmail.state.failMethods.add("POST");
		h.gmail.state.history = [{ id: "1003", labelsRemoved: [{ message: { id: "m1", threadId: "t1" }, labelIds: ["Label_7"] }] }];
		await runSync(h.deps);
		expect(h.mailbox.labelsOf("m1")).toEqual(["Later"]);
	});

	it("the outbox renames, recolors, labels a conversation (making a missing label first) and deletes in Gmail", async () => {
		const h = seeded();
		await runSync(h.deps);
		const customers = byName(h, "Customers")!;
		const fresh = await h.mailbox.createLabel("Fresh", "lime");
		if (!fresh.ok) throw new Error("label");
		h.gmail.calls.length = 0;
		h.store.enqueue({ kind: "label_update", localId: customers.id, name: "Clients", color: "violet" });
		h.store.enqueue({ kind: "label_thread", localId: "t1", add: [customers.id, fresh.label.id], remove: [] });
		h.store.enqueue({ kind: "label_thread", localId: "t3", add: [], remove: [customers.id] });
		expect(await flushOutbox(h.deps)).toBe(3);
		const freshId = h.store.gmailLabelOf(fresh.label.id)!;
		expect(h.gmail.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			"PATCH /labels/Label_1",
			"POST /labels",
			"POST /threads/t1/modify",
			"POST /threads/t3/modify",
		]);
		expect(h.gmail.calls[0].body).toEqual({ name: "Clients", color: { backgroundColor: "#a479e2", textColor: "#ffffff" } });
		expect(h.gmail.calls[2].body).toEqual({ addLabelIds: ["Label_1", freshId], removeLabelIds: [] });
		expect(h.gmail.messages.get("m4")!.labelIds).toEqual(expect.arrayContaining(["Label_1", freshId]));
		expect(h.store.messageByLocal("m1")!.labels).toEqual(expect.arrayContaining(["Label_1", freshId]));
		expect(h.store.messageByLocal("m3")!.labels).not.toContain("Label_1");

		// Deleted in OpenMail: the queued deletion keeps the Gmail id after the local label is gone.
		h.store.enqueue({ kind: "label_delete", localId: customers.id });
		await h.mailbox.deleteLabel(customers.id);
		h.gmail.calls.length = 0;
		await runSync(h.deps);
		expect(labelCalls(h)).toEqual(["DELETE /labels/Label_1"]);
		expect(h.gmail.labels.some((l) => l.id === "Label_1")).toBe(false);
		expect(h.store.gmailLabelOf(customers.id)).toBeUndefined();
		expect(byName(h, "Clients")).toBeUndefined();

		// Already gone from Gmail: fine.
		h.store.enqueue({ kind: "label_delete", localId: fresh.label.id });
		await h.mailbox.deleteLabel(fresh.label.id);
		h.gmail.labels.splice(h.gmail.labels.findIndex((l) => l.id === freshId), 1);
		expect(await flushOutbox(h.deps)).toBe(1);
	});

	it("deleting a label whose creation never reached Gmail cancels the creation", () => {
		const h = harness();
		h.store.enqueue({ kind: "label_create", localId: "l1", name: "X", color: "sky" });
		h.store.enqueue({ kind: "label_update", localId: "l1", name: "Y", color: "sky" });
		h.store.enqueue({ kind: "label_delete", localId: "l1" });
		expect(h.store.pending().map((p) => p.op)).toEqual([{ kind: "label_delete", localId: "l1" }]);
	});
});

describe("draft jobs", () => {
	it("a job is done when a draft written after it appears in its thread, failed after five minutes", async () => {
		const h = harness(fakeGmail(ADDRESS));
		const t = h.clock.now;
		h.store.addJob("e1", "t1", t);
		h.store.addJob("e2", "t2", t);
		await h.mailbox.createEmail("draft", { id: "old", thread_id: "t1", date: new Date(t - HOUR).toISOString() }, []);
		h.clock.now = t + 30_000;
		await refreshJobs(h.deps);
		expect(h.store.queuedJobs().map((j) => j.emailId)).toEqual(["e1", "e2"]);
		await h.mailbox.createEmail("draft", { id: "new", thread_id: "t1", date: new Date(t + 20_000).toISOString() }, []);
		await refreshJobs(h.deps);
		expect(draftJobs(h.deps).find((j) => j.emailId === "e1")).toMatchObject({ state: "done", finishedAt: t + 30_000, estimateMs: 30_000 });
		h.clock.now = t + JOB_TIMEOUT_MS + 1;
		await refreshJobs(h.deps);
		expect(draftJobs(h.deps).find((j) => j.emailId === "e2")).toMatchObject({ state: "failed" });
	});

	it("the estimate is the median of recent jobs", () => {
		expect(estimate([])).toBe(DEFAULT_ESTIMATE_MS);
		expect(estimate([30_000, 10_000, 50_000])).toBe(30_000);
		expect(estimate([10_000, 20_000])).toBe(15_000);
	});
});
