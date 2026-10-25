// The MCP tools through the production entry (workers/app.ts) in workerd,
// against the real MailboxDO and R2: the gateway's ToolBus calls
// `POST /__everyapp/tools/call` with an identity minted for that one call
// (`chan: "mcp"`), everyApp() verifies it and runs the tool. A fake
// EVERY_APP_GATEWAY binding stands in for the gateway's AI proxy and email
// capability and records what reaches it, so the tests can see that a tool's
// model calls and sends carry the caller's identity.
import { MCP_READ_SCOPE, MCP_WRITE_SCOPE, mintIdentityJwt, mintSystemJwt } from "@every-app/sdk/internal";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Folders } from "../shared/folders";
import worker from "../workers/app";

const ISSUER = env.EVERYAPP_IDENTITY_ISSUER as string;
const AUDIENCE = env.EVERYAPP_AUDIENCE as string;
const ORIGIN = "https://agentic-inbox.gateway.example.com";
const ORG = "org-1";

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
	options: { orgId?: string; scopes?: string[]; env?: Record<string, unknown> } = {},
): Promise<ToolAnswer> {
	const callId = crypto.randomUUID();
	const identity = await mintIdentityJwt(privateKeyPem, {
		issuer: ISSUER,
		audience: AUDIENCE,
		subject: { sub: "user-mcp", email: "member@example.com", orgId: options.orgId ?? ORG, orgRole: "member" },
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

/** A mailbox as the REST route creates it; storage is shared, so a fresh address each test. */
async function newMailbox(): Promise<string> {
	const address = `mcp-${crypto.randomUUID().slice(0, 8)}@example.com`;
	await env.BUCKET.put(`mailboxes/${address}.json`, JSON.stringify({ fromName: "Team" }));
	await mailbox(address).getFolders();
	return address;
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
	it("everyApp() in workers/app.ts answers the gateway's tools/list with the thirteen tools", async () => {
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
		expect(catalog.tools).toHaveLength(13);
	});
});

describe("tool calls", () => {
	it("list_mailboxes lists the organization's mailboxes", async () => {
		const address = await newMailbox();
		const answer = await callTool("list_mailboxes", {});
		expect(answer.status).toBe(200);
		expect(answer.body.result?.isError).toBeUndefined();
		expect(JSON.parse(textOf(answer))).toContainEqual({ id: address, email: address });
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
		const address = await newMailbox();
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
		const address = await newMailbox();
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
		const address = await newMailbox();
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
		expect(refused.body.result).toEqual({
			content: [{ type: "text", text: "Not allowed: this app belongs to another organization." }],
			isError: true,
		});
		expect((await callTool("list_mailboxes", {}, { env: pinned })).body.result?.isError).toBeUndefined();
	});

	it("a read-only connection can't send, and nobody can delete until the gateway has approvals", async () => {
		const address = await newMailbox();
		const id = await inboundEmail(address);
		const send = await callTool(
			"send_email",
			{ mailboxId: address, to: "alice@example.org", subject: "Hi", bodyHtml: BODY },
			{ scopes: [MCP_READ_SCOPE] },
		);
		expect(send.status).toBe(403);
		expect(send.body.error).toMatchObject({ code: "forbidden", message: "Calling send_email needs the mcp:write scope." });

		const remove = await callTool("delete_email", { mailboxId: address, emailId: id });
		expect(remove.status).toBe(403);
		expect(remove.body.error).toMatchObject({ code: "forbidden", message: "Calling delete_email needs the mcp:destructive scope." });
		expect(((await mailbox(address).getEmails({ folder: Folders.INBOX })) as unknown[]).length).toBe(1);
	});

	it("arguments are checked against the tool's schema before it runs", async () => {
		const address = await newMailbox();
		const answer = await callTool("list_emails", { mailboxId: address, limit: 500 });
		expect(answer.status).toBe(400);
		expect(answer.body.error?.code).toBe("invalid_arguments");
		expect(answer.body.error?.message).toContain("limit");
	});
});
