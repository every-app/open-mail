// The MCP tools through the production entry (workers/app.ts) in workerd,
// against the real MailboxDO and R2: the gateway's ToolBus calls
// `POST /__everyapp/tools/call` with an identity minted for that one call
// (`chan: "mcp"`), everyApp() verifies it and runs the tool. A fake
// EVERY_APP_GATEWAY binding stands in for the gateway's AI proxy and email
// capability and records what reaches it, so the tests can see that a tool's
// model calls and sends carry the caller's identity. Also: a call reaches
// only the caller's own and the shared mailboxes, the send tools need full
// send, sync_mailbox goes to the Gmail side (gmail-tools-port.ts), stood in
// for here, and the label tools reach the wrapped env.MAILBOX, which queues
// a Gmail mailbox's label changes for Gmail.
import { MCP_READ_SCOPE, MCP_WRITE_SCOPE, mintIdentityJwt, mintSystemJwt } from "@every-app/sdk/internal";
import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Folders } from "../shared/folders";
import worker from "../workers/app";
import { gmailOps } from "../workers/everyapp/gmail-tools-port";
import type { GmailSync } from "../workers/everyapp/gmail/sync";
import { GMAIL_SEND_REFUSED } from "../workers/everyapp/tools";

const ISSUER = env.EVERYAPP_IDENTITY_ISSUER as string;
const AUDIENCE = env.EVERYAPP_AUDIENCE as string;
const ORIGIN = "https://openmail.gateway.example.com";
const ORG = "org-1";
/** The MCP caller's user id. */
const CALLER = "user-mcp";

afterEach(() => vi.restoreAllMocks());

function pem(label: string, der: ArrayBuffer) {
	const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
	return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;
}

let privateKeyPem: string;
let keys: Record<string, string>;

beforeAll(async () => {
	const pair = (await crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	privateKeyPem = pem("PRIVATE KEY", (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
	const publicKeyPem = pem("PUBLIC KEY", (await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer);
	keys = { EVERYAPP_IDENTITY_PUBLIC_KEYS: JSON.stringify([publicKeyPem]) };
});

interface GatewayCall {
	path: string;
	identity: string | null;
	body: Record<string, unknown>;
}

/**
 * The gateway, as far as the tools reach it: the AI proxy echoes the text it
 * was asked to proofread (lib/ai.ts then keeps the draft as written), the
 * email capability accepts the send, or refuses it with `refuse`.
 */
function fakeGateway(options: { refuse?: { code: string; message: string } } = {}) {
	const calls: GatewayCall[] = [];
	const binding = {
		async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
			const request = new Request(input, init);
			const path = new URL(request.url).pathname;
			const body = (await request.json()) as Record<string, unknown>;
			calls.push({ path, identity: request.headers.get("x-everyapp-identity"), body });
			if (path.endsWith("/chat/completions")) {
				const messages = body.messages as { role: string; content: string }[];
				const asked = messages.find((m) => m.role === "user")?.content ?? "";
				return Response.json({ choices: [{ message: { role: "assistant", content: asked } }] });
			}
			if (path === "/api/integrations/email/send") {
				if (options.refuse) {
					return Response.json(
						{ error: options.refuse.code, message: options.refuse.message },
						{ status: 403, headers: { "x-everyapp-error": options.refuse.code } },
					);
				}
				return Response.json({ messageId: "<gw-1@example.com>", status: "queued" });
			}
			return new Response("not found", { status: 404 });
		},
	};
	return { calls, binding };
}

interface ToolAnswer {
	status: number;
	identity: string;
	body: {
		v: number;
		result?: { content: { type: string; text: string }[]; isError?: boolean };
		error?: { code: string; message: string };
	};
}

async function callTool(
	name: string,
	args: Record<string, unknown>,
	options: { sub?: string; orgId?: string; scopes?: string[]; env?: Record<string, unknown> } = {},
): Promise<ToolAnswer> {
	const callId = crypto.randomUUID();
	const identity = await mintIdentityJwt(privateKeyPem, {
		issuer: ISSUER,
		audience: AUDIENCE,
		subject: { sub: options.sub ?? CALLER, email: "member@example.com", orgId: options.orgId ?? ORG, orgRole: "member" },
		channel: "mcp",
		scopes: options.scopes ?? [MCP_READ_SCOPE, MCP_WRITE_SCOPE],
		toolCall: { id: callId, name },
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(
		new Request(`${ORIGIN}/__everyapp/tools/call`, {
			method: "POST",
			headers: { "x-everyapp-identity": identity, "content-type": "application/json" },
			body: JSON.stringify({ v: 1, name, arguments: args, callId }),
		}),
		{ ...env, ...keys, ...options.env } as Cloudflare.Env,
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return { status: response.status, identity, body: (await response.json()) as ToolAnswer["body"] };
}

function textOf(answer: ToolAnswer): string {
	return answer.body.result?.content.map((c) => c.text).join("\n") ?? "";
}

function mailbox(address: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(address));
}

/**
 * A mailbox as the REST route created it before ownership (shared), or with
 * `settings` added (an owner, the Gmail provider); storage is
 * shared, so a fresh address each test.
 */
async function newMailbox(settings: Record<string, unknown> = {}): Promise<string> {
	const address = `mcp-${crypto.randomUUID().slice(0, 8)}@example.com`;
	await env.BUCKET.put(`mailboxes/${address}.json`, JSON.stringify({ fromName: "Team", ...settings }));
	await mailbox(address).getFolders();
	return address;
}

/** The caller's own native mailbox, which the send tools send from. */
async function sendingMailbox(): Promise<string> {
	return newMailbox({ ownerId: CALLER });
}

async function inboundEmail(address: string): Promise<string> {
	const id = crypto.randomUUID();
	await mailbox(address).createEmail(
		Folders.INBOX,
		{
			id,
			subject: "Question about my order",
			sender: "alice@example.org",
			recipient: address,
			date: new Date().toISOString(),
			body: "<p>When does order 1042 ship?</p>",
			message_id: "order-1042-question@example.org",
			thread_id: id,
		},
		[],
	);
	return id;
}

const BODY = "<p>Thanks for your order. It ships on Tuesday by courier.</p>";

describe("the catalog through the production entry", () => {
	it("everyApp() in workers/app.ts answers the gateway's tools/list with the eighteen tools", async () => {
		const token = await mintSystemJwt(privateKeyPem, { audience: AUDIENCE, issuer: ISSUER, purpose: "tools.list" });
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new Request(`${ORIGIN}/__everyapp/tools/list`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-everyapp-system": token },
				body: JSON.stringify({ v: 1 }),
			}),
			{ ...env, ...keys } as Cloudflare.Env,
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const catalog = (await response.json()) as { tools: { name: string }[] };
		expect(catalog.tools).toHaveLength(18);
	});
});

describe("tool calls", () => {
	it("list_mailboxes lists the caller's own mailboxes and the shared ones, not anyone else's", async () => {
		const shared = await newMailbox();
		const mine = await newMailbox({ ownerId: CALLER });
		const theirs = await newMailbox({ ownerId: "user-other" });
		const answer = await callTool("list_mailboxes", {});
		expect(answer.status).toBe(200);
		expect(answer.body.result?.isError).toBeUndefined();
		const listed = JSON.parse(textOf(answer)) as { id: string; email: string }[];
		expect(listed).toContainEqual(expect.objectContaining({ id: shared, email: shared }));
		expect(listed).toContainEqual({ id: mine, email: mine, settings: { ownerId: CALLER } });
		expect(listed.map((m) => m.id)).not.toContain(theirs);

		const other = JSON.parse(textOf(await callTool("list_mailboxes", {}, { sub: "user-other" }))) as { id: string }[];
		expect(other.map((m) => m.id)).toContain(theirs);
		expect(other.map((m) => m.id)).not.toContain(mine);
	});

	it("someone else's mailbox reads as a missing one, for every tool", async () => {
		const theirs = await newMailbox({ ownerId: "user-other" });
		const id = await inboundEmail(theirs);
		const notFound = {
			content: [{ type: "text", text: `Mailbox "${theirs}" not found. Call list_mailboxes for the mailboxes you can use.` }],
			isError: true,
		};
		const gateway = fakeGateway();
		for (const [name, args] of [
			["list_emails", { mailboxId: theirs }],
			["get_email", { mailboxId: theirs, emailId: id }],
			["archive_email", { mailboxId: theirs, emailId: id }],
			["send_email", { mailboxId: theirs, to: "alice@example.org", subject: "Hi", bodyHtml: BODY }],
		] as const) {
			const answer = await callTool(name, args, { env: { EVERY_APP_GATEWAY: gateway.binding } });
			expect(answer.body.result, name).toEqual(notFound);
		}
		expect(gateway.calls).toEqual([]);
		expect(((await mailbox(theirs).getEmails({ folder: Folders.INBOX })) as unknown[]).length).toBe(1);
		expect((await callTool("get_email", { mailboxId: theirs, emailId: id }, { sub: "user-other" })).body.result?.isError).toBeUndefined();
	});

	it("list_emails, move_email and mark_email_read work on the mailbox's Durable Object", async () => {
		const address = await newMailbox();
		const id = await inboundEmail(address);

		const listed = await callTool("list_emails", { mailboxId: address });
		expect((JSON.parse(textOf(listed)) as { id: string }[]).map((e) => e.id)).toEqual([id]);

		const moved = await callTool("move_email", { mailboxId: address, emailId: id, folderId: Folders.ARCHIVE });
		expect(JSON.parse(textOf(moved))).toEqual({ status: "moved", emailId: id, folder: Folders.ARCHIVE });
		const marked = await callTool("mark_email_read", { mailboxId: address.toUpperCase(), emailId: id, read: true });
		expect(JSON.parse(textOf(marked))).toEqual({ status: "updated", emailId: id, read: true });

		const archived = (await mailbox(address).getEmails({ folder: Folders.ARCHIVE })) as { id: string; read: boolean }[];
		expect(archived.map((e) => [e.id, e.read])).toEqual([[id, true]]);
	});

	it("send_email: the verifier's model call and the send go through the gateway as the MCP caller", async () => {
		const address = await sendingMailbox();
		const gateway = fakeGateway();
		const answer = await callTool(
			"send_email",
			{ mailboxId: address, to: "alice@example.org", subject: "Your order", bodyHtml: BODY },
			{ env: { EVERY_APP_GATEWAY: gateway.binding } },
		);

		expect(answer.body.result?.isError).toBeUndefined();
		const sent = JSON.parse(textOf(answer)) as { status: string; messageId: string };
		expect(sent.status).toBe("sent");

		// The Worker's default build (AI_PROVIDER empty): the Gateway's default model.
		expect(gateway.calls.map((c) => c.path)).toEqual(["/api/ai/default/v1/chat/completions", "/api/integrations/email/send"]);
		for (const call of gateway.calls) expect(call.identity).toBe(answer.identity);
		expect(gateway.calls[0]!.body).toMatchObject({ model: "default", max_tokens: 1024 });
		expect(gateway.calls[1]!.body).toMatchObject({
			from: { address },
			to: "alice@example.org",
			subject: "Your order",
			html: BODY,
		});

		const sentFolder = (await mailbox(address).getEmails({ folder: Folders.SENT })) as { id: string }[];
		expect(sentFolder.map((e) => e.id)).toEqual([sent.messageId]);
	});

	it("send_reply threads the reply and sends it as the caller", async () => {
		const address = await sendingMailbox();
		const original = await inboundEmail(address);
		const gateway = fakeGateway();
		const answer = await callTool(
			"send_reply",
			{ mailboxId: address, originalEmailId: original, to: "alice@example.org", subject: "Re: Question about my order", bodyHtml: BODY },
			{ env: { EVERY_APP_GATEWAY: gateway.binding } },
		);
		expect(JSON.parse(textOf(answer))).toMatchObject({ status: "sent", message: "Reply sent to alice@example.org" });
		const send = gateway.calls.find((c) => c.path === "/api/integrations/email/send")!;
		expect(send.identity).toBe(answer.identity);
		expect(send.body.headers).toMatchObject({ "In-Reply-To": "<order-1042-question@example.org>" });
	});

	it("a refused send is a tool error with the gateway's reason, and nothing is copied to Sent", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const address = await sendingMailbox();
		const gateway = fakeGateway({
			refuse: { code: "email_sender_not_allowed", message: `This app may not send as ${address}.` },
		});
		const answer = await callTool(
			"send_email",
			{ mailboxId: address, to: "alice@example.org", subject: "Your order", bodyHtml: BODY },
			{ env: { EVERY_APP_GATEWAY: gateway.binding } },
		);
		expect(answer.status).toBe(200);
		expect(answer.body.result).toEqual({
			content: [{ type: "text", text: `Failed to send email: This app may not send as ${address}.` }],
			isError: true,
		});
		expect(await mailbox(address).getEmails({ folder: Folders.SENT })).toEqual([]);
	});

	it("the send tools refuse on a Gmail mailbox, even the caller's own, and send nothing", async () => {
		const refused = { content: [{ type: "text", text: GMAIL_SEND_REFUSED }], isError: true };
		const address = await newMailbox({ ownerId: CALLER, provider: "gmail" });
		const gateway = fakeGateway();
		const sent = await callTool(
			"send_email",
			{ mailboxId: address, to: "alice@example.org", subject: "Your order", bodyHtml: BODY },
			{ env: { EVERY_APP_GATEWAY: gateway.binding } },
		);
		expect(sent.body.result).toEqual(refused);
		const replied = await callTool(
			"send_reply",
			{ mailboxId: address, originalEmailId: await inboundEmail(address), to: "alice@example.org", subject: "Re: Hi", bodyHtml: BODY },
			{ env: { EVERY_APP_GATEWAY: gateway.binding } },
		);
		expect(replied.body.result).toEqual(refused);
		expect(gateway.calls).toEqual([]);
		expect(await mailbox(address).getEmails({ folder: Folders.SENT })).toEqual([]);
	});

	it("draft_reply saves a draft that quotes the original and sends nothing", async () => {
		const address = await newMailbox();
		const original = await inboundEmail(address);
		const gateway = fakeGateway();
		const answer = await callTool(
			"draft_reply",
			{ mailboxId: address, originalEmailId: original, to: "alice@example.org", subject: "Re: Question", bodyHtml: BODY },
			{ env: { EVERY_APP_GATEWAY: gateway.binding } },
		);
		const draft = JSON.parse(textOf(answer)) as { status: string; draftId: string };
		expect(draft.status).toBe("draft_saved");
		expect(gateway.calls.map((c) => c.path)).toEqual(["/api/ai/default/v1/chat/completions"]);
		const drafts = (await mailbox(address).getEmails({ folder: Folders.DRAFT })) as { id: string; thread_id: string }[];
		expect(drafts.map((d) => [d.id, d.thread_id])).toEqual([[draft.draftId, original]]);
	});

	it("an unknown mailbox is a tool error the model can act on, with no Durable Object or gateway call", async () => {
		const gateway = fakeGateway();
		const answer = await callTool(
			"send_email",
			{ mailboxId: "nobody@example.com", to: "alice@example.org", subject: "Hi", bodyHtml: BODY },
			{ env: { EVERY_APP_GATEWAY: gateway.binding } },
		);
		expect(answer.body.result).toEqual({
			content: [{ type: "text", text: 'Mailbox "nobody@example.com" not found. Call list_mailboxes for the mailboxes you can use.' }],
			isError: true,
		});
		expect(gateway.calls).toEqual([]);
	});

	it("on an organization's own copy, another organization's caller is refused", async () => {
		await newMailbox();
		const pinned = { EVERY_APP_ORG_ID: ORG };
		const refused = await callTool("list_mailboxes", {}, { orgId: "org-2", env: pinned });
		// Since @every-app/sdk rc.9, everyApp() refuses it before the tool runs
		// (toolEnv()'s own refusal stays as a second check).
		expect(refused.status).toBe(401);
		expect((refused.body as unknown as { error: { code: string } }).error.code).toBe("unauthenticated");
		expect((await callTool("list_mailboxes", {}, { env: pinned })).body.result?.isError).toBeUndefined();
	});

	it("a read-only connection can't send or delete", async () => {
		const address = await newMailbox();
		const id = await inboundEmail(address);
		const send = await callTool(
			"send_email",
			{ mailboxId: address, to: "alice@example.org", subject: "Hi", bodyHtml: BODY },
			{ scopes: [MCP_READ_SCOPE] },
		);
		expect(send.status).toBe(403);
		expect(send.body.error).toMatchObject({ code: "forbidden", message: "Calling send_email needs the mcp:write scope." });

		const remove = await callTool("delete_email", { mailboxId: address, emailId: id }, { scopes: [MCP_READ_SCOPE] });
		expect(remove.status).toBe(403);
		expect(remove.body.error).toMatchObject({ code: "forbidden", message: "Calling delete_email needs the mcp:write scope." });
		expect(((await mailbox(address).getEmails({ folder: Folders.INBOX })) as unknown[]).length).toBe(1);
	});

	it("archive_email moves an email to the archive, on an OpenMail mailbox too", async () => {
		const address = await newMailbox({ ownerId: CALLER });
		const id = await inboundEmail(address);
		const answer = await callTool("archive_email", { mailboxId: address, emailId: id });
		expect(JSON.parse(textOf(answer))).toEqual({ status: "archived", emailId: id });
		expect(await mailbox(address).getEmails({ folder: Folders.INBOX })).toEqual([]);
		expect(((await mailbox(address).getEmails({ folder: Folders.ARCHIVE })) as { id: string }[]).map((e) => e.id)).toEqual([id]);
	});

	it("sync_mailbox refuses an OpenMail mailbox, naming why", async () => {
		const address = await newMailbox({ ownerId: CALLER });
		const sync = vi.spyOn(gmailOps, "sync");
		const answer = await callTool("sync_mailbox", { mailboxId: address });
		expect(answer.body.result).toEqual({
			content: [{ type: "text", text: `sync_mailbox: this tool works on Gmail mailboxes, and "${address}" is an OpenMail mailbox.` }],
			isError: true,
		});
		expect(sync).not.toHaveBeenCalled();
	});

	it("sync_mailbox refuses while the experimental Gmail integration is off", async () => {
		const address = await newMailbox({ ownerId: CALLER, provider: "gmail" });
		const sync = vi.spyOn(gmailOps, "sync");
		const answer = await callTool("sync_mailbox", { mailboxId: address }, { env: { EXPERIMENTAL_GMAIL: "" } });
		expect(answer.body.result?.isError).toBe(true);
		expect(textOf(answer)).toContain("EXPERIMENTAL_GMAIL");
		expect(sync).not.toHaveBeenCalled();
	});

	it("sync_mailbox goes to the Gmail side for the caller's Gmail mailbox, with the call's request", async () => {
		const address = await newMailbox({ ownerId: CALLER, provider: "gmail" });
		const sync = vi.spyOn(gmailOps, "sync").mockResolvedValue({ pulled: 2, pushed: 1 });
		expect(JSON.parse(textOf(await callTool("sync_mailbox", { mailboxId: address.toUpperCase() })))).toEqual({ pulled: 2, pushed: 1 });
		expect(sync.mock.calls[0]![1]).toBe(address);
		expect(sync.mock.calls[0]![2]).toBeInstanceOf(Request);

		// Someone else's Gmail mailbox never reaches the Gmail side.
		const theirs = await newMailbox({ ownerId: "user-other", provider: "gmail" });
		expect((await callTool("sync_mailbox", { mailboxId: theirs })).body.result?.isError).toBe(true);
		expect(sync).toHaveBeenCalledTimes(1);
	});

	it("sync_mailbox reaches the mailbox's GmailSync, and says so when Gmail can't be reached", async () => {
		const address = await newMailbox({ ownerId: CALLER, provider: "gmail" });
		const answer = await callTool("sync_mailbox", { mailboxId: address });
		expect(answer.body.result?.isError).toBe(true);
		expect(textOf(answer)).toMatch(/^Gmail refused/);
	});

	it("the label tools on a Gmail mailbox queue the changes for Gmail, through the wrapped env.MAILBOX", async () => {
		const address = await newMailbox({ ownerId: CALLER, provider: "gmail" });
		const id = await inboundEmail(address);
		const created = JSON.parse(textOf(await callTool("create_label", { mailboxId: address, name: "Customers" })));
		await callTool("label_conversation", { mailboxId: address, threadId: id, add: ["Customers", "VIP"], createMissing: true });
		const gmailSync = env.GMAIL_SYNC.get(env.GMAIL_SYNC.idFromName(address));
		await runInDurableObject(gmailSync, (instance: GmailSync) => {
			const ops = instance.store.pending().map((p) => p.op);
			expect(ops.map((op) => op.kind)).toEqual(["label_create", "label_create", "label_thread"]);
			expect(ops[0]).toMatchObject({ localId: created.id, name: "Customers" });
			expect(ops[2]).toMatchObject({ kind: "label_thread", add: [created.id, ops[1]!.localId], remove: [] });
		});
	});

	it("arguments are checked against the tool's schema before it runs", async () => {
		const address = await newMailbox();
		const answer = await callTool("list_emails", { mailboxId: address, limit: 500 });
		expect(answer.status).toBe(400);
		expect(answer.body.error?.code).toBe("invalid_arguments");
		expect(answer.body.error?.message).toContain("limit");
	});
});

describe("label tools", () => {
	it("create_label, list_labels and label_conversation (by name, creating only when asked)", async () => {
		const address = await newMailbox();
		const id = await inboundEmail(address);

		const created = await callTool("create_label", { mailboxId: address, name: "Work", color: "amber" });
		expect(JSON.parse(textOf(created))).toMatchObject({ name: "Work", color: "amber" });
		const duplicate = await callTool("create_label", { mailboxId: address, name: "work" });
		expect(duplicate.body.result?.isError).toBe(true);
		expect(textOf(duplicate)).toContain("already exists");

		const missing = await callTool("label_conversation", { mailboxId: address, threadId: id, add: ["Work", "Reports"] });
		expect(missing.body.result?.isError).toBe(true);
		expect(textOf(missing)).toContain('"Reports"');

		// An unknown conversation is refused before createMissing creates anything.
		const nowhere = await callTool("label_conversation", {
			mailboxId: address,
			threadId: "no-such-thread",
			add: ["Ghost"],
			createMissing: true,
		});
		expect(nowhere.body.result?.isError).toBe(true);
		expect(textOf(nowhere)).toContain('No conversation or email "no-such-thread"');
		const untouched = JSON.parse(textOf(await callTool("list_labels", { mailboxId: address }))) as { name: string }[];
		expect(untouched.map((l) => l.name)).toEqual(["Work"]);

		const labeled = await callTool("label_conversation", {
			mailboxId: address,
			threadId: id,
			add: ["work", "Work/Reports"],
			createMissing: true,
		});
		expect(labeled.body.result?.isError).toBeUndefined();
		const answer = JSON.parse(textOf(labeled)) as { threadId: string; labels: { name: string }[] };
		expect(answer.threadId).toBe(id);
		expect(answer.labels.map((l) => l.name)).toEqual(["Work", "Work/Reports"]);

		const removed = await callTool("label_conversation", { mailboxId: address, threadId: id, remove: ["Work"] });
		expect((JSON.parse(textOf(removed)) as { labels: { name: string }[] }).labels.map((l) => l.name)).toEqual([
			"Work/Reports",
		]);

		const listed = JSON.parse(textOf(await callTool("list_labels", { mailboxId: address }))) as { name: string; unreadCount: number }[];
		expect(listed.map((l) => [l.name, l.unreadCount])).toEqual([
			["Work", 0],
			["Work/Reports", 1],
		]);

		// list_emails (upstream's tool) shows each conversation's labels.
		const emails = JSON.parse(textOf(await callTool("list_emails", { mailboxId: address }))) as { labels: { name: string }[] }[];
		expect(emails[0]!.labels.map((l) => l.name)).toEqual(["Work/Reports"]);
	});
});
