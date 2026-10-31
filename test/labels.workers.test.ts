// Labels (workers/everyapp/mailbox.ts, workers/everyapp/labels.ts) through
// upstream's API app, against the real MailboxDO subclass and R2 in workerd:
// the port's migrations beside upstream's, the CRUD routes, labeling a whole
// conversation, the `labels` on list rows, `?label=` listings, `label:` in
// search, and label rows going with deleted mail.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import { app } from "../workers/index";
import { labeledMailbox } from "../workers/everyapp/label-model";
import type { Env } from "../workers/types";

const ORIGIN = "https://openmail.example.com";
let count = 0;

const testEnv = { ...(env as unknown as Cloudflare.Env), AI: undefined as unknown as Ai, EMAIL: undefined as unknown as SendEmail } as Env;

interface Label {
	id: string;
	name: string;
	color: string;
}
interface Row {
	id: string;
	thread_id: string | null;
	folder_id: string;
	thread_count: number;
	thread_unread_count: number;
	labels: Label[];
}

async function request(method: string, path: string, body?: unknown): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await app.fetch(
		new Request(`${ORIGIN}${path}`, {
			method,
			headers: { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
		testEnv,
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return response;
}

async function json<T>(method: string, path: string, body?: unknown, status = 200): Promise<T> {
	const response = await request(method, path, body);
	expect(response.status, `${method} ${path}`).toBe(status);
	return (await response.json()) as T;
}

async function newMailbox(): Promise<string> {
	const address = `labels-${Date.now()}-${count++}@example.com`;
	const created = await request("POST", "/api/v1/mailboxes", { email: address, name: "Labels" });
	expect(created.status).toBe(201);
	return address;
}

async function addEmail(
	address: string,
	opts: { thread?: string | null; folder?: string; subject?: string; read?: boolean; minutesAgo?: number } = {},
): Promise<string> {
	const id = crypto.randomUUID();
	await labeledMailbox(testEnv, address).createEmail(
		opts.folder ?? Folders.INBOX,
		{
			id,
			subject: opts.subject ?? "Order 1042",
			sender: "alice@example.org",
			recipient: address,
			date: new Date(Date.now() - (opts.minutesAgo ?? 0) * 60_000).toISOString(),
			body: "<p>When does order 1042 ship?</p>",
			read: opts.read ?? false,
			thread_id: opts.thread === undefined ? id : opts.thread,
		},
		[],
	);
	return id;
}

const base = (address: string) => `/api/v1/mailboxes/${address}`;

async function createLabel(address: string, name: string, color?: string): Promise<Label> {
	return json<Label>("POST", `${base(address)}/labels`, { name, color }, 201);
}

describe("migrations", () => {
	it("upstream's migrations and the port's both run, under distinct names", async () => {
		const address = await newMailbox();
		const folders = (await labeledMailbox(testEnv, address).getFolders()).map((f) => f.id).sort();
		expect(folders).toEqual(["archive", "draft", "inbox", "sent", "spam", "trash"]);
		expect(await labeledMailbox(testEnv, address).listLabels()).toEqual([]);
	});
});

describe("label CRUD", () => {
	it("creates, lists, renames, recolors and deletes", async () => {
		const address = await newMailbox();
		const work = await createLabel(address, "  Work  ", "sky");
		expect(work).toMatchObject({ name: "Work", color: "sky" });
		const nested = await createLabel(address, "Work/Reports");
		expect(["slate", "rose", "amber", "lime", "emerald", "sky", "violet", "fuchsia"]).toContain(nested.color);
		// The default color depends on the name only.
		const other = await newMailbox();
		expect((await createLabel(other, "Work/Reports")).color).toBe(nested.color);

		let listed = await json<(Label & { unreadCount: number })[]>("GET", `${base(address)}/labels`);
		expect(listed.map((l) => [l.name, l.unreadCount])).toEqual([
			["Work", 0],
			["Work/Reports", 0],
		]);

		const renamed = await json<Label>("PUT", `${base(address)}/labels/${work.id}`, { name: "Clients" });
		expect(renamed).toEqual({ id: work.id, name: "Clients", color: "sky" });
		const recolored = await json<Label>("PUT", `${base(address)}/labels/${work.id}`, { color: "rose" });
		expect(recolored).toEqual({ id: work.id, name: "Clients", color: "rose" });

		expect((await request("DELETE", `${base(address)}/labels/${work.id}`)).status).toBe(204);
		listed = await json("GET", `${base(address)}/labels`);
		expect(listed.map((l) => l.name)).toEqual(["Work/Reports"]);
		expect((await request("DELETE", `${base(address)}/labels/${work.id}`)).status).toBe(404);
	});

	it("refuses a duplicate name (any case) with 409 and bad bodies with 400", async () => {
		const address = await newMailbox();
		const work = await createLabel(address, "Work");
		const other = await createLabel(address, "Personal");
		expect((await request("POST", `${base(address)}/labels`, { name: "work" })).status).toBe(409);
		expect((await request("PUT", `${base(address)}/labels/${other.id}`, { name: "WORK" })).status).toBe(409);
		expect((await request("POST", `${base(address)}/labels`, { name: "   " })).status).toBe(400);
		expect((await request("POST", `${base(address)}/labels`, { name: "x".repeat(101) })).status).toBe(400);
		expect((await request("POST", `${base(address)}/labels`, { name: "Fine", color: "chartreuse" })).status).toBe(400);
		expect((await request("PUT", `${base(address)}/labels/${work.id}`, {})).status).toBe(400);
		expect((await request("PUT", `${base(address)}/labels/nope`, { name: "Nope" })).status).toBe(404);
	});
});

describe("labeling conversations", () => {
	it("labels every message of a 2-message thread, and list rows carry the conversation's labels", async () => {
		const address = await newMailbox();
		const first = await addEmail(address, { minutesAgo: 10 });
		const reply = await addEmail(address, { thread: first, minutesAgo: 1 });
		const loner = await addEmail(address, { thread: null, subject: "Unrelated", minutesAgo: 5 });
		const work = await createLabel(address, "Work");
		const urgent = await createLabel(address, "Urgent");

		const result = await json<{ threadKey: string; labels: Label[] }>("POST", `${base(address)}/threads/${first}/labels`, {
			add: [work.id, urgent.id],
		});
		expect(result.threadKey).toBe(first);
		expect(result.labels.map((l) => l.name)).toEqual(["Urgent", "Work"]);

		// Both messages carry both labels.
		const rows = [...(await labeledMailbox(testEnv, address).getThreadEmails(first))];
		expect(rows.map((r) => r.id).sort()).toEqual([first, reply].sort());
		for (const row of rows) expect(row.labels.map((l: Label) => l.name)).toEqual(["Urgent", "Work"]);

		// The folder listing (threaded) carries them; the loner carries none.
		const inbox = await json<{ emails: Row[]; totalCount: number }>("GET", `${base(address)}/emails?folder=inbox&threaded=true`);
		const byId = Object.fromEntries(inbox.emails.map((e) => [e.id, e]));
		expect(byId[reply]!.labels.map((l) => l.name)).toEqual(["Urgent", "Work"]);
		expect(byId[loner]!.labels).toEqual([]);

		// Single email and thread reads carry them too.
		const single = await json<{ labels: Label[] }>("GET", `${base(address)}/emails/${reply}`);
		expect(single.labels.map((l) => l.id).sort()).toEqual([work.id, urgent.id].sort());
		const thread = await json<{ labels: Label[] }[]>("GET", `${base(address)}/threads/${first}`);
		expect(thread.every((e) => e.labels.length === 2)).toBe(true);

		// By an email's id, removing one; an email without a thread is its own conversation.
		await json("POST", `${base(address)}/threads/${reply}/labels`, { remove: [urgent.id] });
		await json("POST", `${base(address)}/threads/${loner}/labels`, { add: [urgent.id] });
		const after = await json<{ emails: Row[] }>("GET", `${base(address)}/emails?folder=inbox&threaded=true`);
		const labelsOf = Object.fromEntries(after.emails.map((e) => [e.id, e.labels.map((l) => l.name)]));
		expect(labelsOf[reply]).toEqual(["Work"]);
		expect(labelsOf[loner]).toEqual(["Urgent"]);
	});

	it("answers 404 on unknown label ids and unknown conversations, changing nothing", async () => {
		const address = await newMailbox();
		const id = await addEmail(address);
		const work = await createLabel(address, "Work");
		const unknown = await request("POST", `${base(address)}/threads/${id}/labels`, { add: [work.id, "no-such-label"] });
		expect(unknown.status).toBe(404);
		expect(await unknown.json()).toMatchObject({ ids: ["no-such-label"] });
		expect((await labeledMailbox(testEnv, address).labelsForThreads([id]))[id]).toBeUndefined();
		expect((await request("POST", `${base(address)}/threads/no-such-thread/labels`, { add: [work.id] })).status).toBe(404);
	});

	it("lists a label's conversations across folders but Trash and Spam, threaded and paginated, with unread counts", async () => {
		const address = await newMailbox();
		const work = await createLabel(address, "Work");
		const inInbox = await addEmail(address, { minutesAgo: 30 });
		const inboxReply = await addEmail(address, { thread: inInbox, minutesAgo: 2, read: true });
		const archived = await addEmail(address, { folder: Folders.ARCHIVE, read: true, minutesAgo: 20 });
		const trashed = await addEmail(address, { folder: Folders.TRASH, minutesAgo: 10 });
		await addEmail(address, { minutesAgo: 1 }); // unlabeled
		for (const key of [inInbox, archived, trashed]) {
			await json("POST", `${base(address)}/threads/${key}/labels`, { add: [work.id] });
		}

		const listed = await json<{ emails: Row[]; totalCount: number }>("GET", `${base(address)}/emails?label=${work.id}`);
		expect(listed.totalCount).toBe(2);
		expect(listed.emails.map((e) => e.id)).toEqual([inboxReply, archived]);
		expect(listed.emails[0]).toMatchObject({ thread_count: 2, thread_unread_count: 1, labels: [{ id: work.id, name: "Work" }] });

		const page2 = await json<{ emails: Row[]; totalCount: number }>("GET", `${base(address)}/emails?label=${work.id}&limit=1&page=2`);
		expect(page2.emails.map((e) => e.id)).toEqual([archived]);
		expect(page2.totalCount).toBe(2);

		const labels = await json<(Label & { unreadCount: number })[]>("GET", `${base(address)}/labels`);
		expect(labels).toEqual([{ ...work, unreadCount: 1 }]);

		expect((await request("GET", `${base(address)}/emails?label=no-such-label`)).status).toBe(404);
	});

	it("a label's row is never a draft unless the conversation is only drafts; drafts still set has_draft", async () => {
		const address = await newMailbox();
		const work = await createLabel(address, "Work");
		const received = await addEmail(address, { minutesAgo: 30 });
		// The newest message of the thread is a reply draft.
		const draft = await addEmail(address, { thread: received, folder: Folders.DRAFT, minutesAgo: 1 });
		const onlyDraft = await addEmail(address, { folder: Folders.DRAFT, subject: "Just a draft", minutesAgo: 10 });
		for (const key of [received, onlyDraft]) {
			await json("POST", `${base(address)}/threads/${key}/labels`, { add: [work.id] });
		}

		const listed = await json<{ emails: (Row & { has_draft: boolean })[] }>("GET", `${base(address)}/emails?label=${work.id}`);
		const byThread = Object.fromEntries(listed.emails.map((e) => [e.thread_id, e]));
		expect(byThread[received]).toMatchObject({ id: received, folder_id: Folders.INBOX, has_draft: true, thread_count: 2 });
		expect(byThread[onlyDraft]).toMatchObject({ id: onlyDraft, folder_id: Folders.DRAFT, has_draft: true });
		expect(listed.emails.some((e) => e.id === draft)).toBe(false);
	});

	it("the folder listing flags a conversation with a reply draft (upstream's has_draft never matches)", async () => {
		const address = await newMailbox();
		const received = await addEmail(address, { minutesAgo: 30 });
		const plain = await addEmail(address, { subject: "No draft here", minutesAgo: 20 });
		await addEmail(address, { thread: received, folder: Folders.DRAFT, minutesAgo: 1 });

		const listed = await json<{ emails: (Row & { has_draft: boolean })[] }>("GET", `${base(address)}/emails?folder=${Folders.INBOX}&threaded=true`);
		const byId = Object.fromEntries(listed.emails.map((e) => [e.id, e]));
		expect(byId[received]).toMatchObject({ has_draft: true });
		expect(byId[plain]).toMatchObject({ has_draft: false });
	});

	it("search understands label:<name>, quoted names included", async () => {
		const address = await newMailbox();
		const ready = await createLabel(address, "Work/Reports");
		const tagged = await addEmail(address, { subject: "Invoice 7" });
		await addEmail(address, { subject: "Invoice 8" });
		await json("POST", `${base(address)}/threads/${tagged}/labels`, { add: [ready.id] });

		const found = await json<{ emails: Row[]; totalCount: number }>(
			"GET",
			`${base(address)}/search?${new URLSearchParams({ query: "Invoice", label: "work/REPORTS" })}`,
		);
		expect(found.totalCount).toBe(1);
		expect(found.emails.map((e) => e.id)).toEqual([tagged]);
		expect(found.emails[0]!.labels.map((l) => l.name)).toEqual(["Work/Reports"]);

		const none = await json<{ emails: Row[]; totalCount: number }>("GET", `${base(address)}/search?label=Nope`);
		expect(none).toEqual({ emails: [], totalCount: 0 });

		// Without a label, upstream's search answers, rows labeled.
		const all = await json<{ emails: Row[]; totalCount: number }>("GET", `${base(address)}/search?query=Invoice`);
		expect(all.totalCount).toBe(2);
		expect(all.emails.find((e) => e.id === tagged)!.labels).toHaveLength(1);
	});
});

describe("label rows go with deleted mail and deleted labels", () => {
	it("deleting an email removes its label rows; deleting a folder removes its emails' rows", async () => {
		const address = await newMailbox();
		const work = await createLabel(address, "Work");
		const first = await addEmail(address, { minutesAgo: 5 });
		const reply = await addEmail(address, { thread: first, minutesAgo: 1 });
		await json("POST", `${base(address)}/threads/${first}/labels`, { add: [work.id] });

		expect((await request("DELETE", `${base(address)}/emails/${reply}`)).status).toBe(204);
		const stub = labeledMailbox(testEnv, address);
		expect((await stub.getThreadEmails(first)).map((e) => e.labels.length)).toEqual([1]);
		expect((await request("DELETE", `${base(address)}/emails/${first}`)).status).toBe(204);
		expect(await stub.countThreadedEmailsByLabel(work.id)).toBe(0);

		// A custom folder's deletion cascades to its emails, and their label rows.
		const folder = await json<{ id: string }>("POST", `${base(address)}/folders`, { name: "Projects" }, 201);
		const filed = await addEmail(address, { folder: folder.id });
		await json("POST", `${base(address)}/threads/${filed}/labels`, { add: [work.id] });
		expect(await stub.countThreadedEmailsByLabel(work.id)).toBe(1);
		expect((await request("DELETE", `${base(address)}/folders/${folder.id}`)).status).toBe(204);
		expect(await stub.countThreadedEmailsByLabel(work.id)).toBe(0);
		// A label row whose email is gone would show in the label's unread count.
		expect(await stub.listLabels()).toEqual([{ ...work, unreadCount: 0 }]);
	});

	it("deleting a label takes it off its conversations and leaves the mail", async () => {
		const address = await newMailbox();
		const work = await createLabel(address, "Work");
		const keep = await createLabel(address, "Keep");
		const id = await addEmail(address);
		await json("POST", `${base(address)}/threads/${id}/labels`, { add: [work.id, keep.id] });

		expect((await request("DELETE", `${base(address)}/labels/${work.id}`)).status).toBe(204);
		const inbox = await json<{ emails: Row[] }>("GET", `${base(address)}/emails?folder=inbox&threaded=true`);
		expect(inbox.emails.map((e) => [e.id, e.labels.map((l) => l.name)])).toEqual([[id, ["Keep"]]]);
	});
});
