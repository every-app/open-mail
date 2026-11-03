// withGateway()'s Gmail seams in workerd, against the real MailboxDO and
// GmailSync: the wrapped env.MAILBOX applies a Gmail mailbox's changes
// locally and queues them in GmailSync's outbox (flushed with a fake Gmail),
// labels included, also from the REST label routes; the sync brings Gmail's
// labels into MailboxDO; native mailboxes are left alone; and a send from a
// Gmail mailbox goes out through Gmail's messages.send by the real send route.
import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import { gmailClient } from "../workers/everyapp/gmail/client";
import { gmailRoutes } from "../workers/everyapp/gmail/routes";
import { users } from "../workers/everyapp/identity";
import { flushOutbox } from "../workers/everyapp/gmail/engine";
import type { GmailSync } from "../workers/everyapp/gmail/sync";
import { withGateway } from "../workers/everyapp/gateway";
import { labeledMailbox } from "../workers/everyapp/label-model";
import { app } from "../workers/index";
import { fakeGmail, rfc822 } from "./fixtures/fake-gmail";

let count = 0;
const base = env as unknown as Cloudflare.Env;

async function mailbox(settings: Record<string, unknown>): Promise<string> {
	const address = `gmail-${Date.now()}-${count++}@example.com`;
	await env.BUCKET.put(`mailboxes/${address}.json`, JSON.stringify({ fromName: address, ...settings }));
	return address;
}

async function seedInbox(address: string, id: string, threadId: string) {
	await env.MAILBOX.get(env.MAILBOX.idFromName(address)).createEmail(
		Folders.INBOX,
		{ id, subject: "Order 1042", sender: "alice@example.org", recipient: address, date: new Date().toISOString(), body: "<p>When?</p>", thread_id: threadId, message_id: `${id}@example.org` },
		[],
	);
}

function sync(address: string) {
	return env.GMAIL_SYNC.get(env.GMAIL_SYNC.idFromName(address));
}

describe("the wrapped env.MAILBOX", () => {
	it("applies a Gmail mailbox's changes locally, queues them, and the flush makes them in Gmail", async () => {
		const address = await mailbox({ provider: "gmail", ownerId: "u1" });
		const gmail = fakeGmail(address);
		gmail.add({ id: "m1", threadId: "t1", labelIds: ["INBOX", "UNREAD"], raw: rfc822({ to: address }) });
		await seedInbox(address, "m1", "t1");
		await runInDurableObject(sync(address), (instance: GmailSync) => {
			instance.store.putMessage({ localId: "m1", gmailId: "m1", gmailThreadId: "t1", labels: ["INBOX", "UNREAD"], rfcMessageId: "m1@example.org" });
		});

		// Background work (the agent): no person, so nothing is flushed yet.
		const wrapped = withGateway(base);
		const stub = wrapped.MAILBOX.get(wrapped.MAILBOX.idFromName(address));
		expect(await stub.updateEmail("m1", { read: true, starred: true })).toMatchObject({ read: true, starred: true });
		expect(await stub.moveEmail("m1", Folders.ARCHIVE)).toBe(true);
		await stub.createEmail(
			Folders.DRAFT,
			{ id: "draft-1", subject: "Re: Order 1042", sender: address, recipient: "alice@example.org", date: new Date().toISOString(), body: "<p>Friday.</p>", in_reply_to: "m1", thread_id: "t1" },
			[],
		);
		await stub.createEmail(Folders.SENT, { id: "sent-1", subject: "x", sender: address, recipient: "a@example.org", date: new Date().toISOString(), body: "x" }, []);

		const raw = env.MAILBOX.get(env.MAILBOX.idFromName(address));
		expect(await raw.getEmail("m1")).toMatchObject({ folder_id: Folders.ARCHIVE, read: true, starred: true });
		expect(await raw.getEmail("draft-1")).toMatchObject({ folder_id: Folders.DRAFT });
		expect(await raw.getEmail("sent-1")).toBeNull();

		await runInDurableObject(sync(address), async (instance: GmailSync) => {
			expect(instance.store.pending().map((p) => p.op.kind)).toEqual(["labels", "move", "draft_upsert"]);
			const client = gmailClient({}, new Request("https://openmail.example.com/"), gmail.fetch);
			expect(await flushOutbox(instance.deps(address, client))).toBe(3);
			expect(instance.store.pending()).toEqual([]);
			expect(instance.store.draftByLocal("draft-1")).toBeTruthy();
		});
		expect(gmail.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /messages/m1/modify", "POST /messages/m1/modify", "POST /drafts"]);
		expect(gmail.messages.get("m1")!.labelIds).toEqual(["STARRED"]);
		const draftCall = gmail.calls[2];
		expect(draftCall.body.message.threadId).toBe("t1");
		expect(gmail.rawText(draftCall.body.message.raw)).toContain("In-Reply-To: <m1@example.org>");

		// Discarding the draft queues its deletion in Gmail.
		expect(await stub.deleteEmail("draft-1")).toEqual([]);
		await runInDurableObject(sync(address), (instance: GmailSync) => {
			expect(instance.store.pending().map((p) => p.op)).toEqual([{ kind: "draft_delete", localId: "draft-1" }]);
		});
	});

	it("queues a Gmail mailbox's label changes (create, label a conversation, rename, delete), and the flush makes them in Gmail", async () => {
		const address = await mailbox({ provider: "gmail", ownerId: "u1" });
		const gmail = fakeGmail(address);
		gmail.add({ id: "m1", threadId: "t1", labelIds: ["INBOX"], raw: rfc822({ to: address }) });
		await seedInbox(address, "m1", "t1");
		await runInDurableObject(sync(address), (instance: GmailSync) => {
			instance.store.putMessage({ localId: "m1", gmailId: "m1", gmailThreadId: "t1", labels: ["INBOX"], rfcMessageId: "m1@example.org" });
		});
		const client = gmailClient({}, new Request("https://openmail.example.com/"), gmail.fetch);
		const flush = () => runInDurableObject(sync(address), (instance: GmailSync) => flushOutbox(instance.deps(address, client)));

		const stub = labeledMailbox(withGateway(base), address);
		const created = await stub.createLabel("Customers/VIP", "sky");
		if (!created.ok) throw new Error("label");
		const labeled = await stub.labelThread("m1", [created.label.id], []);
		expect(labeled).toMatchObject({ ok: true, threadKey: "t1", labels: [{ name: "Customers/VIP" }] });
		await runInDurableObject(sync(address), (instance: GmailSync) => {
			expect(instance.store.pending().map((p) => p.op)).toEqual([
				{ kind: "label_create", localId: created.label.id, name: "Customers/VIP", color: "sky" },
				{ kind: "label_thread", localId: "t1", add: [created.label.id], remove: [] },
			]);
		});
		expect(await flush()).toBe(2);
		const gmailId = gmail.labels.find((l) => l.name === "Customers/VIP")!.id;
		expect(gmail.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /labels", "POST /threads/t1/modify"]);
		expect(gmail.calls[0].body.color).toEqual({ backgroundColor: "#4a86e8", textColor: "#ffffff" });
		expect(gmail.messages.get("m1")!.labelIds).toContain(gmailId);

		gmail.calls.length = 0;
		expect(await stub.updateLabel(created.label.id, { name: "Clients" })).toMatchObject({ ok: true });
		expect(await stub.deleteLabel(created.label.id)).toBe(true);
		await runInDurableObject(sync(address), (instance: GmailSync) => {
			// The rename is dropped (the label is going); the deletion carries the Gmail id.
			expect(instance.store.pending().map((p) => p.op)).toEqual([{ kind: "label_delete", localId: created.label.id, gmailId }]);
		});
		expect(await flush()).toBe(1);
		expect(gmail.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`DELETE /labels/${gmailId}`]);
		expect(gmail.labels.some((l) => l.id === gmailId)).toBe(false);
		await runInDurableObject(sync(address), (instance: GmailSync) => {
			expect(instance.store.labelLinks()).toEqual([]);
		});
	});

	it("the sync brings Gmail's labels into MailboxDO, on the messages that carry them", async () => {
		const address = await mailbox({ provider: "gmail", ownerId: "u1" });
		const gmail = fakeGmail(address);
		gmail.labels.find((l) => l.id === "Label_1")!.color = { backgroundColor: "#16a766", textColor: "#ffffff" };
		gmail.add({ id: "m1", threadId: "t1", labelIds: ["INBOX", "Label_1"], raw: rfc822({ to: address }) });
		gmail.add({ id: "m2", threadId: "t2", labelIds: ["INBOX"], raw: rfc822({ to: address, subject: "Other" }) });
		const client = gmailClient({}, new Request("https://openmail.example.com/"), gmail.fetch);
		const result = await runInDurableObject(sync(address), (instance: GmailSync) => instance.syncWith(address, client));
		expect(result.error).toBeUndefined();
		const raw = labeledMailbox(base, address);
		expect((await raw.listLabels()).map((l) => [l.name, l.color])).toEqual([["Customers", "emerald"]]);
		expect((await raw.getEmail("m1"))!.labels.map((l) => l.name)).toEqual(["Customers"]);
		expect((await raw.getEmail("m2"))!.labels).toEqual([]);

		// Taken off in Gmail: off in OpenMail at the next sync.
		gmail.messages.get("m1")!.labelIds = ["INBOX"];
		gmail.state.history = [{ id: "1001", labelsRemoved: [{ message: { id: "m1", threadId: "t1" }, labelIds: ["Label_1"] }] }];
		await runInDurableObject(sync(address), (instance: GmailSync) => instance.syncWith(address, client));
		expect((await raw.getEmail("m1"))!.labels).toEqual([]);
		await runInDurableObject(sync(address), (instance: GmailSync) => {
			expect(instance.store.pending()).toEqual([]);
		});
	});

	it("the REST label routes reach the wrapped env.MAILBOX: a Gmail mailbox's label changes are queued", async () => {
		const address = await mailbox({ provider: "gmail", ownerId: "u1" });
		await seedInbox(address, "m1", "t1");
		const send = async (method: string, path: string, body?: unknown) => {
			const request = new Request(`https://openmail.example.com/api/v1/mailboxes/${address}${path}`, {
				method,
				headers: { "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			const ctx = createExecutionContext();
			const response = await app.fetch(request, withGateway(base), ctx);
			await waitOnExecutionContext(ctx);
			return { status: response.status, body: response.status === 204 ? null : ((await response.json()) as any) };
		};
		const created = await send("POST", "/labels", { name: "Work" });
		expect(created.status).toBe(201);
		expect((await send("POST", "/threads/t1/labels", { add: [created.body.id] })).status).toBe(200);
		expect((await send("PUT", `/labels/${created.body.id}`, { color: "rose" })).status).toBe(200);
		expect((await send("DELETE", `/labels/${created.body.id}`)).status).toBe(204);
		await runInDurableObject(sync(address), (instance: GmailSync) => {
			// Never in Gmail, so its deletion cancels its creation and rename; the conversation's change stays (a no-op at flush).
			expect(instance.store.pending().map((p) => p.op.kind)).toEqual(["label_thread", "label_delete"]);
		});
	});

	it("passes a native mailbox straight through, queueing nothing", async () => {
		const address = await mailbox({});
		await seedInbox(address, "n1", "nt1");
		const wrapped = withGateway(base);
		const stub = wrapped.MAILBOX.get(wrapped.MAILBOX.idFromName(address));
		const label = await labeledMailbox(wrapped, address).createLabel("Native");
		if (!label.ok) throw new Error("label");
		expect(await labeledMailbox(wrapped, address).labelThread("n1", [label.label.id])).toMatchObject({ ok: true });
		expect(await labeledMailbox(wrapped, address).deleteLabel(label.label.id)).toBe(true);
		await stub.updateEmail("n1", { read: true });
		await stub.createEmail(Folders.SENT, { id: "ns1", subject: "x", sender: address, recipient: "a@example.org", date: new Date().toISOString(), body: "x" }, []);
		const raw = env.MAILBOX.get(env.MAILBOX.idFromName(address));
		expect(await raw.getEmail("n1")).toMatchObject({ read: true });
		expect(await raw.getEmail("ns1")).toMatchObject({ folder_id: Folders.SENT });
		await runInDurableObject(sync(address), (instance: GmailSync) => {
			expect(instance.store.pending()).toEqual([]);
		});
	});
});

describe("sending from a Gmail mailbox", () => {
	it("the Send route sends through Gmail's messages.send, for the person", async () => {
		const address = await mailbox({ provider: "gmail", ownerId: "u1" });
		const gmail = fakeGmail(address);
		const gatewayBinding = {
			async fetch(input: RequestInfo | URL, init?: RequestInit) {
				const request = new Request(input, init);
				const url = new URL(request.url);
				const upstream = url.pathname.replace("/api/integrations/google-workspace/", "https://");
				return gmail.fetch(new Request(upstream + url.search, request));
			},
		};
		const request = new Request(`https://openmail.example.com/api/v1/mailboxes/${address}/emails`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-everyapp-identity": "person" },
			body: JSON.stringify({ to: "alice@example.org", from: address, subject: "Hi", html: "<p>Hi</p>" }),
		});
		const testEnv = { ...base, EVERY_APP_GATEWAY: gatewayBinding } as unknown as Cloudflare.Env;
		const ctx = createExecutionContext();
		const response = await app.fetch(request, withGateway(testEnv, request), ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBeLessThan(300);
		const sent = gmail.calls.filter((c) => c.method === "POST" && c.path === "/messages/send");
		expect(sent).toHaveLength(1);
		expect(gmail.rawText(sent[0]!.body.raw)).toContain("To: alice@example.org");
	});
});

describe("the Gmail routes", () => {
	const owner = { id: "u-owner", email: "owner@example.com", orgId: "org-1", orgRole: "member" };

	/** The gateway binding: Google's API through the held-token proxy (the fake Gmail), and the status. */
	function gateway(gmail: ReturnType<typeof fakeGmail>, connection: unknown) {
		return {
			async fetch(input: RequestInfo | URL, init?: RequestInit) {
				const request = new Request(input, init);
				const url = new URL(request.url);
				if (url.pathname === "/api/integrations/google-workspace") {
					return Response.json({ capability: "google-workspace", requested: true, configured: true, ready: true, connection });
				}
				const upstream = url.pathname.replace("/api/integrations/google-workspace/", "https://");
				return gmail.fetch(new Request(upstream + url.search, request));
			},
		};
	}

	async function call(method: string, path: string, user: typeof owner | null, extra: Record<string, unknown> = {}, body?: unknown) {
		const request = new Request(`https://openmail.example.com${path}`, {
			method,
			headers: { "content-type": "application/json", "x-everyapp-identity": "person" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		users.set(request, user as never);
		const testEnv = { ...base, GATEWAY_URL: "https://gateway.example.com", ...extra } as unknown as Cloudflare.Env;
		const response = await gmailRoutes.fetch(request, withGateway(testEnv, request));
		return { status: response.status, body: (await response.json()) as any };
	}

	it("status: the person's connection and the one connect link", async () => {
		const gmail = fakeGmail("x@example.com");
		const connection = { label: "x@example.com", ready: true };
		const { status, body } = await call("GET", "/api/v1/gmail/status?returnTo=/mailbox/x", owner, {
			EVERY_APP_GATEWAY: gateway(gmail, connection),
			EVERYAPP_APP_ID: "openmail",
		});
		expect(status).toBe(200);
		expect(body.configured).toBe(true);
		expect(body.connection).toEqual({ label: "x@example.com", ready: true, reconnect: false });
		// Connect Gmail and Reconnect: one plain connect for this app, back to where the person was.
		const connect = new URL(body.connectUrl);
		expect(connect.origin + connect.pathname).toBe("https://gateway.example.com/connect/google-workspace");
		expect(connect.searchParams.get("app")).toBe("openmail");
		expect(connect.searchParams.get("return")).toBe("https://openmail.example.com/mailbox/x");
		expect(body).not.toHaveProperty("background");
		expect(body).not.toHaveProperty("reconnectUrl");
	});

	it("creates the caller's Gmail mailbox from the Gmail profile, once; only its owner reaches its Gmail routes", async () => {
		const address = `routes-${Date.now()}-${count++}@example.com`;
		const gmail = fakeGmail(address);
		const binding = { EVERY_APP_GATEWAY: gateway(gmail, null) };
		const created = await call("POST", "/api/v1/gmail/mailboxes", owner, binding);
		expect(created.status).toBe(201);
		expect(created.body).toMatchObject({ id: address, email: address, settings: { provider: "gmail", ownerId: owner.id } });
		// The first sync runs in GmailSync (the request crosses into it), whose
		// own env has no gateway here: the SDK's local twin finds no token.
		expect(created.body.sync).toMatchObject({ pulled: 0, pushed: 0, error: { code: "integration_not_connected", reconnect: true } });
		expect((await call("POST", "/api/v1/gmail/mailboxes", owner, binding)).status).toBe(409);

		const other = { ...owner, id: "u-other" };
		expect((await call("POST", `/api/v1/mailboxes/${address}/gmail/sync`, other)).status).toBe(404);
		expect((await call("GET", `/api/v1/mailboxes/${address}/gmail/drafting`, owner)).body).toEqual([]);

		await runInDurableObject(sync(address), (instance: GmailSync) => {
			instance.store.putMessage({ localId: "m1", gmailId: "m1", gmailThreadId: "t1", labels: ["INBOX"], rfcMessageId: null });
		});
		const link = await call("GET", `/api/v1/mailboxes/${address}/emails/m1/gmail-link`, owner);
		expect(link.body).toEqual({ url: `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(address)}#all/t1` });
		expect((await call("GET", `/api/v1/mailboxes/${address}/emails/nope/gmail-link`, owner)).status).toBe(404);
	});

	it("a native mailbox has no Gmail routes; a refused connection asks the person to connect", async () => {
		const native = await mailbox({ ownerId: owner.id });
		expect((await call("POST", `/api/v1/mailboxes/${native}/gmail/sync`, owner)).body.error).toBe("not_gmail");
		const gmail = fakeGmail("y@example.com");
		gmail.state.disconnected = true;
		const refused = await call("POST", "/api/v1/gmail/mailboxes", owner, { EVERY_APP_GATEWAY: gateway(gmail, null) });
		expect(refused.status).toBe(409);
		expect(refused.body).toMatchObject({ error: "integration_not_connected", reconnect: true });
		expect(refused.body.connectUrl).toContain("/connect/google-workspace");
	});
});
