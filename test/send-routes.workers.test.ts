// The send routes (new mail, reply, forward) against the real MailboxDO and
// R2 in workerd: sends are awaited, a refusal answers 502 with the gateway's
// code and leaves no Sent copy, and the Sent row is written only after the
// gateway accepted the message.
import { GatewayRefusalError, type SendEmailMessage, type SendEmailResult } from "@every-app/sdk/server";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Folders } from "../shared/folders";
import { emailAdapter, resetEmailReadyCache } from "../workers/everyapp/email";
import { withGateway } from "../workers/everyapp/gateway";
import { app } from "../workers/index";
import type { Env } from "../workers/types";

type Send = (message: SendEmailMessage) => Promise<SendEmailResult>;

const ORIGIN = "https://agentic-inbox.example.com";
let count = 0;

afterEach(() => vi.restoreAllMocks());

/** The env withGateway() gives the routes, with `send` standing in for the gateway. */
function envWith(send: Send): Env {
	return { ...(env as unknown as Cloudflare.Env), AI: undefined as unknown as Ai, EMAIL: emailAdapter(send) };
}

async function request(testEnv: Env, method: string, path: string, body?: unknown): Promise<Response> {
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

async function newMailbox(domain = "example.com"): Promise<string> {
	const address = `sender-${Date.now()}-${count++}@${domain}`;
	const created = await request(envWith(accept), "POST", "/api/v1/mailboxes", { email: address, name: "Support" });
	expect(created.status).toBe(201);
	return address;
}

function mailbox(address: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(address));
}

async function sentFolder(address: string) {
	return mailbox(address).getEmails({ folder: Folders.SENT });
}

/** An inbound message to reply to or forward. */
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

async function attachmentKeys(): Promise<string[]> {
	return (await env.BUCKET.list({ prefix: "attachments/" })).objects.map((o) => o.key);
}

const accept: Send = async () => ({ messageId: "<gw-1@example.com>", status: "queued" });

/** What the SDK's sendEmail() throws when the gateway refuses. */
function refuse(code: string, status = 403): Send {
	return async () => {
		throw new GatewayRefusalError({ status, code, message: `The gateway refused the send (${code}).` });
	};
}

const ATTACHMENT = { content: btoa("order details"), filename: "order.txt", type: "text/plain", disposition: "attachment" };

describe("POST /api/v1/mailboxes/:mailboxId/emails", () => {
	it("awaits the gateway, then writes the Sent copy and answers 200", async () => {
		const address = await newMailbox();
		let sentRowsDuringSend = -1;
		const send = vi.fn<Send>(async () => {
			sentRowsDuringSend = (await sentFolder(address)).length;
			return { messageId: "<gw-1@example.com>", status: "queued" };
		});

		const response = await request(envWith(send), "POST", `/api/v1/mailboxes/${address}/emails`, {
			to: "alice@example.org",
			from: { email: address, name: "Support" },
			subject: "Your order",
			html: "<p>It ships Tuesday.</p>",
			attachments: [ATTACHMENT],
		});

		expect(response.status).toBe(200);
		const body = (await response.json()) as { id: string; status: string };
		expect(body.status).toBe("sent");
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0]![0]).toEqual({
			to: "alice@example.org",
			subject: "Your order",
			html: "<p>It ships Tuesday.</p>",
			from: { address, name: "Support" },
			attachments: [{ filename: "order.txt", contentType: "text/plain", content: btoa("order details") }],
		});
		expect(sentRowsDuringSend).toBe(0);
		const sent = await sentFolder(address);
		expect(sent.map((e: { id: string }) => e.id)).toEqual([body.id]);
		expect((await attachmentKeys()).filter((k) => k.startsWith(`attachments/${body.id}/`))).toHaveLength(1);
	});

	it("answers 502 with the gateway's code on a refusal, with no Sent copy and no stored attachment", async () => {
		const address = await newMailbox();
		const keysBefore = await attachmentKeys();
		vi.spyOn(console, "error").mockImplementation(() => {});

		const response = await request(envWith(refuse("email_sender_not_allowed")), "POST", `/api/v1/mailboxes/${address}/emails`, {
			to: "alice@example.org",
			from: address,
			subject: "Your order",
			text: "It ships Tuesday.",
			attachments: [ATTACHMENT],
		});

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			error: "email_sender_not_allowed",
			message: "The gateway refused the send (email_sender_not_allowed).",
		});
		expect(await sentFolder(address)).toEqual([]);
		expect(await attachmentKeys()).toEqual(keysBefore);
	});

	it("answers 502 email_send_failed when the gateway can't be reached", async () => {
		const address = await newMailbox();
		vi.spyOn(console, "error").mockImplementation(() => {});
		const response = await request(
			envWith(async () => {
				throw new TypeError("Network connection lost.");
			}),
			"POST",
			`/api/v1/mailboxes/${address}/emails`,
			{ to: "alice@example.org", from: address, subject: "s", text: "t" },
		);
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({ error: "email_send_failed", message: "Network connection lost." });
		expect(await sentFolder(address)).toEqual([]);
	});

	it("still refuses a from address that isn't the mailbox before calling the gateway", async () => {
		const address = await newMailbox();
		const send = vi.fn<Send>(accept);
		const response = await request(envWith(send), "POST", `/api/v1/mailboxes/${address}/emails`, {
			to: "alice@example.org",
			from: "someone-else@example.com",
			subject: "s",
			text: "t",
		});
		expect(response.status).toBe(400);
		expect(send).not.toHaveBeenCalled();
	});
});

describe("POST /api/v1/mailboxes/:mailboxId/emails/:id/reply", () => {
	it("sends with threading headers, then writes the Sent copy and marks the thread read", async () => {
		const address = await newMailbox();
		const original = await inboundEmail(address);
		const send = vi.fn<Send>(accept);

		const response = await request(envWith(send), "POST", `/api/v1/mailboxes/${address}/emails/${original}/reply`, {
			to: "alice@example.org",
			from: address,
			subject: "Re: Question about my order",
			html: "<p>Tuesday.</p>",
		});

		expect(response.status).toBe(200);
		const { id } = (await response.json()) as { id: string };
		expect(send.mock.calls[0]![0].headers).toEqual({
			"In-Reply-To": "<order-1042-question@example.org>",
			References: "<order-1042-question@example.org>",
		});
		const sent = await mailbox(address).getEmail(id);
		expect(sent).toMatchObject({ folder_id: Folders.SENT, in_reply_to: "order-1042-question@example.org", thread_id: original });
		expect((await mailbox(address).getEmail(original))?.read).toBe(true);
	});

	it("answers 502 on a refusal: no Sent copy, the thread stays unread", async () => {
		const address = await newMailbox();
		const original = await inboundEmail(address);
		vi.spyOn(console, "error").mockImplementation(() => {});

		const response = await request(envWith(refuse("email_budget_exhausted", 429)), "POST", `/api/v1/mailboxes/${address}/emails/${original}/reply`, {
			to: "alice@example.org",
			from: address,
			subject: "Re: Question about my order",
			html: "<p>Tuesday.</p>",
		});

		expect(response.status).toBe(502);
		expect(((await response.json()) as { error: string }).error).toBe("email_budget_exhausted");
		expect(await sentFolder(address)).toEqual([]);
		expect((await mailbox(address).getEmail(original))?.read).toBe(false);
	});
});

describe("POST /api/v1/mailboxes/:mailboxId/emails/:id/forward", () => {
	it("sends, then writes the Sent copy", async () => {
		const address = await newMailbox();
		const original = await inboundEmail(address);
		const response = await request(envWith(accept), "POST", `/api/v1/mailboxes/${address}/emails/${original}/forward`, {
			to: "bob@example.org",
			from: address,
			subject: "Fwd: Question about my order",
			html: "<p>See below.</p>",
		});
		expect(response.status).toBe(200);
		const { id } = (await response.json()) as { id: string };
		expect((await sentFolder(address)).map((e: { id: string }) => e.id)).toEqual([id]);
	});

	it("answers 502 on a refusal with no Sent copy", async () => {
		const address = await newMailbox();
		const original = await inboundEmail(address);
		vi.spyOn(console, "error").mockImplementation(() => {});
		const response = await request(envWith(refuse("email_sender_not_verified", 422)), "POST", `/api/v1/mailboxes/${address}/emails/${original}/forward`, {
			to: "bob@example.org",
			from: address,
			subject: "Fwd: Question about my order",
			html: "<p>See below.</p>",
		});
		expect(response.status).toBe(502);
		expect(((await response.json()) as { error: string }).error).toBe("email_sender_not_verified");
		expect(await sentFolder(address)).toEqual([]);
	});
});

type GatewayCall = { url: string; identity: string | null; body: unknown };

/** A fake EVERY_APP_GATEWAY binding: records each request, answers with `reply`. */
function fakeGateway(reply: () => Response) {
	const calls: GatewayCall[] = [];
	return {
		calls,
		binding: {
			async fetch(input: RequestInfo | URL, init?: RequestInit) {
				const request = new Request(input, init);
				const text = await request.text();
				calls.push({ url: request.url, identity: request.headers.get("x-everyapp-identity"), body: text ? JSON.parse(text) : undefined });
				return reply();
			},
		},
	};
}

/** withGateway()'s env, as the entry builds it for a request with the person's identity. */
function gatewayEnv(extra: Record<string, unknown>): Env {
	const request = new Request(`${ORIGIN}/api/v1/x`, { headers: { "x-everyapp-identity": "token-of-the-person" } });
	return withGateway({ ...(env as unknown as Cloudflare.Env), ...extra } as Cloudflare.Env, request);
}

describe("withGateway()'s env.EMAIL: the SDK's sendEmail()", () => {
	const message = (from: string) => ({ to: "alice@example.org", from, subject: "Hello", text: "t" });

	it("deployed: the gateway accepts, so the route answers 200 and writes the Sent copy", async () => {
		const address = await newMailbox();
		const gateway = fakeGateway(() => Response.json({ messageId: "<gw-1@example.com>", status: "delivered" }));
		const response = await request(gatewayEnv({ EVERY_APP_GATEWAY: gateway.binding }), "POST", `/api/v1/mailboxes/${address}/emails`, message(address));
		expect(response.status).toBe(200);
		expect(gateway.calls).toEqual([
			{
				url: "http://every-app-gateway.internal/api/integrations/email/send",
				identity: "token-of-the-person",
				body: { to: "alice@example.org", subject: "Hello", text: "t", from: { address } },
			},
		]);
		expect(await sentFolder(address)).toHaveLength(1);
	});

	it("deployed: the gateway refuses the sender, so the route answers 502 with its code and writes no Sent copy", async () => {
		const address = await newMailbox();
		vi.spyOn(console, "error").mockImplementation(() => {});
		const gateway = fakeGateway(() =>
			Response.json(
				{ error: "email_sender_not_allowed", code: "email_sender_not_allowed", message: `This app may not send as ${address}.` },
				{ status: 403, headers: { "x-everyapp-error": "email_sender_not_allowed" } },
			),
		);
		const response = await request(gatewayEnv({ EVERY_APP_GATEWAY: gateway.binding }), "POST", `/api/v1/mailboxes/${address}/emails`, message(address));
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({ error: "email_sender_not_allowed", message: `This app may not send as ${address}.` });
		expect(await sentFolder(address)).toEqual([]);
	});

	it("deployed without the gateway binding: 502 email_not_configured, no Sent copy", async () => {
		const address = await newMailbox();
		vi.spyOn(console, "error").mockImplementation(() => {});
		const response = await request(gatewayEnv({}), "POST", `/api/v1/mailboxes/${address}/emails`, message(address));
		expect(response.status).toBe(502);
		expect(((await response.json()) as { error: string }).error).toBe("email_not_configured");
		expect(await sentFolder(address)).toEqual([]);
	});

	it("everyapp dev: a mailbox on a sender domain is printed (200, a Sent copy); one on another domain is refused (502)", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		// .dev.vars supplies this installation's senders.
		const dev = gatewayEnv({ EVERYAPP_DEV: "1", EVERYAPP_EMAIL_SENDERS: JSON.stringify(["*@example.com"]) });

		const address = await newMailbox();
		const sent = await request(dev, "POST", `/api/v1/mailboxes/${address}/emails`, message(address));
		expect(sent.status).toBe(200);
		expect(info).toHaveBeenCalledWith(expect.stringMatching(/^\[everyapp dev\] email to 1 recipient subject "Hello"/));
		expect(await sentFolder(address)).toHaveLength(1);

		const other = await newMailbox("other.example");
		const refused = await request(dev, "POST", `/api/v1/mailboxes/${other}/emails`, message(other));
		expect(refused.status).toBe(502);
		expect(((await refused.json()) as { error: string }).error).toBe("email_sender_not_allowed");
		expect(await sentFolder(other)).toEqual([]);
	});
});

describe("GET /api/v1/config", () => {
	beforeEach(() => resetEmailReadyCache());
	afterEach(() => resetEmailReadyCache());

	it("lists no domains and says ready: false without a gateway", async () => {
		const response = await request(envWith(accept), "GET", "/api/v1/config");
		expect(await response.json()).toEqual({ domains: [], emailAddresses: [], ready: false });
	});

	it("says ready: true when the gateway's email status is ready and accepts the app's senders", async () => {
		const gateway = fakeGateway(() =>
			Response.json({ capability: "email", requested: true, configured: true, ready: true, sender: null, senders: ["*@example.com", "support@example.com", "*@mail.example.org"] }),
		);
		const response = await request(gatewayEnv({ EVERY_APP_GATEWAY: gateway.binding }), "GET", "/api/v1/config");
		expect(await response.json()).toEqual({ domains: ["example.com", "mail.example.org"], emailAddresses: [], ready: true });
		expect(gateway.calls.map((c) => c.url)).toEqual(["http://every-app-gateway.internal/api/integrations/email"]);
	});
});
