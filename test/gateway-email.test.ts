// env.EMAIL on Every App: the gateway's email capability as a send_email
// binding (workers/everyapp/email.ts), over the SDK's sendEmail().
import { EMAIL_SENDERS_ENV, parseSendEmailMessage } from "@every-app/sdk/internal";
import { ConfigurationError, GatewayRefusalError, type SendEmailMessage } from "@every-app/sdk/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendEmail as upstreamSendEmail } from "../workers/email-sender";
import {
	EmailSendError,
	emailAdapter,
	emailConfig,
	gatewayEmail,
	resetEmailReadyCache,
	sendFailure,
	toGatewayMessage,
} from "../workers/everyapp/email";

const GATEWAY = "http://every-app-gateway.internal";

function env(extra: Record<string, unknown> = {}) {
	return { DOMAINS: "example.com", ...extra } as unknown as Cloudflare.Env;
}

/** `everyapp dev`: .dev.vars supplies this installation's senders. */
function devEnv(extra: Record<string, unknown> = {}) {
	return env({ EVERYAPP_DEV: "1", [EMAIL_SENDERS_ENV]: JSON.stringify(["*@example.com"]), ...extra });
}

type Call = { method: string; url: string; headers: Headers; body: unknown };

/** A fake EVERY_APP_GATEWAY binding: records each request, answers with `reply`. */
function fakeGateway(reply: (call: Call) => Response) {
	const calls: Call[] = [];
	return {
		calls,
		binding: {
			async fetch(input: RequestInfo | URL, init?: RequestInit) {
				const request = new Request(input, init);
				const text = await request.text();
				const call = { method: request.method, url: request.url, headers: request.headers, body: text ? JSON.parse(text) : undefined };
				calls.push(call);
				return reply(call);
			},
		},
	};
}

/** The gateway's refusal on the wire: the code in `x-everyapp-error`, the message in the body. */
function refusalResponse(status: number, code: string, message: string) {
	return Response.json({ error: code, code, message }, { status, headers: { "x-everyapp-error": code } });
}

afterEach(() => {
	vi.restoreAllMocks();
	resetEmailReadyCache();
});

describe("toGatewayMessage", () => {
	it("maps what workers/email-sender.ts builds onto the gateway's send request", () => {
		const bytes = new TextEncoder().encode("binary attachment");
		const message = toGatewayMessage({
			from: { email: "support@example.com", name: "Support" },
			to: ["a@example.org", { email: "b@example.org", name: "B" }],
			cc: "c@example.org",
			subject: "Re: order",
			html: '<p>hi <img src="cid:logo"></p>',
			text: "hi",
			replyTo: { email: "replies@example.com", name: "Replies" },
			headers: { "In-Reply-To": "<m1@example.org>" },
			attachments: [
				{ content: "aGVsbG8=", filename: "a.txt", type: "text/plain", disposition: "attachment" },
				{ content: bytes, filename: "logo.png", type: "image/png", disposition: "inline", contentId: "logo" },
			],
		});
		expect(message).toEqual({
			to: ["a@example.org", "b@example.org"],
			cc: "c@example.org",
			subject: "Re: order",
			html: '<p>hi <img src="cid:logo"></p>',
			text: "hi",
			from: { address: "support@example.com", name: "Support" },
			replyTo: { address: "replies@example.com", name: "Replies" },
			headers: { "In-Reply-To": "<m1@example.org>" },
			attachments: [
				{ filename: "a.txt", contentType: "text/plain", content: "aGVsbG8=" },
				{ filename: "logo.png", contentType: "image/png", content: btoa("binary attachment"), disposition: "inline", contentId: "logo" },
			],
		} satisfies SendEmailMessage);
	});

	it("sends a bare from address without a name and leaves out what upstream left empty", () => {
		expect(
			toGatewayMessage({ from: "dev@example.com", to: "a@example.org", subject: "s", text: "t", headers: {}, attachments: [] }),
		).toEqual({ to: "a@example.org", subject: "s", text: "t", from: { address: "dev@example.com" } });
	});

	it("sends an inline part without a content id as an ordinary attachment (the gateway refuses inline without one)", () => {
		const message = toGatewayMessage({
			from: "dev@example.com",
			to: "a@example.org",
			subject: "s",
			html: "<p>x</p>",
			attachments: [{ content: "aGVsbG8=", filename: "x.png", type: "image/png", disposition: "inline", contentId: " " }],
		});
		expect(message.attachments).toEqual([{ filename: "x.png", contentType: "image/png", content: "aGVsbG8=" }]);
	});

	it("refuses raw MIME messages", () => {
		expect(() => toGatewayMessage({ from: "dev@example.com", to: "a@example.org" } as EmailMessage)).toThrow(
			expect.objectContaining({ code: "email_invalid_message" }),
		);
	});

	it("turns what upstream's send routes build into a message the gateway accepts", async () => {
		// workers/email-sender.ts, byte-identical to upstream, fed the adapter:
		// a reply with threading headers, an inline image and a file.
		let mapped: SendEmailMessage | undefined;
		const binding = emailAdapter(async (message) => {
			mapped = message;
			return { status: "delivered" };
		});
		await upstreamSendEmail(binding, {
			to: ["alice@example.org"],
			cc: "bob@example.org",
			from: { email: "support@example.com", name: "Support" },
			subject: "Re: Question about my order",
			html: '<p>Tuesday. <img src="cid:logo-1"></p>',
			text: "Tuesday.",
			attachments: [
				{ content: btoa("png bytes"), filename: "logo.png", type: "image/png", disposition: "inline", contentId: "logo-1" },
				{ content: btoa("order details"), filename: "order.txt", type: "text/plain", disposition: "attachment" },
			],
			headers: { "In-Reply-To": "<order-1042@example.org>", References: "<order-1040@example.org> <order-1042@example.org>" },
		});
		const checked = parseSendEmailMessage(mapped);
		expect(checked).toMatchObject({ ok: true });
		expect(checked.ok && checked.message.attachments).toEqual([
			{ filename: "logo.png", contentType: "image/png", content: btoa("png bytes"), disposition: "inline", contentId: "logo-1" },
			{ filename: "order.txt", contentType: "text/plain", content: btoa("order details"), disposition: "attachment" },
		]);
	});
});

describe("emailAdapter", () => {
	const message = { from: "dev@example.com", to: "a@example.org", subject: "hi", text: "x" };

	it("hands the mapped message to the gateway and returns its message id", async () => {
		const send = vi.fn(async (_m: SendEmailMessage) => ({ messageId: "<abc@example.com>", status: "queued" as const }));
		await expect(emailAdapter(send).send(message)).resolves.toEqual({ messageId: "<abc@example.com>" });
		expect(send).toHaveBeenCalledWith({ to: "a@example.org", subject: "hi", text: "x", from: { address: "dev@example.com" } });
	});

	it("answers an empty message id when the gateway reports none", async () => {
		await expect(emailAdapter(async () => ({ status: "delivered" })).send(message)).resolves.toEqual({ messageId: "" });
	});

	it("rethrows the SDK's GatewayRefusalError as an EmailSendError with the gateway's code, status and message", async () => {
		const adapter = emailAdapter(async () => {
			throw new GatewayRefusalError({
				status: 403,
				code: "email_sender_not_allowed",
				message: "dev@example.com isn't one of this app's senders.",
			});
		});
		const error = await adapter.send(message).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(EmailSendError);
		expect(error).toMatchObject({
			code: "email_sender_not_allowed",
			status: 403,
			message: "dev@example.com isn't one of this app's senders.",
		});
	});

	it("names a missing gateway email_not_configured and anything else email_send_failed", async () => {
		await expect(
			emailAdapter(async () => {
				throw new ConfigurationError("no gateway binding");
			}).send(message),
		).rejects.toMatchObject({ code: "email_not_configured", status: 503 });
		await expect(
			emailAdapter(async () => {
				throw new TypeError("network connection lost");
			}).send(message),
		).rejects.toMatchObject({ code: "email_send_failed", status: 502, message: "network connection lost" });
	});
});

describe("gatewayEmail: the SDK's sendEmail over the EVERY_APP_GATEWAY binding", () => {
	const message = {
		from: { email: "support@example.com", name: "Support" },
		to: ["alice@example.org"],
		subject: "Your order",
		html: "<p>It ships Tuesday.</p>",
		headers: { "In-Reply-To": "<order-1042@example.org>" },
	};

	it("posts the mapped message to /api/integrations/email/send, attributed to the request's person", async () => {
		const gateway = fakeGateway(() => Response.json({ messageId: "<gw-1@example.com>", status: "delivered" }));
		const request = new Request("https://agentic-inbox.example.com/api/v1/mailboxes/x/emails", {
			headers: { "x-everyapp-identity": "token-of-the-person", "x-everyapp-org": "forged-by-the-app" },
		});
		const sent = await gatewayEmail(env({ EVERY_APP_GATEWAY: gateway.binding }), request).send(message);
		expect(sent).toEqual({ messageId: "<gw-1@example.com>" });
		expect(gateway.calls).toHaveLength(1);
		const call = gateway.calls[0]!;
		expect(call.method).toBe("POST");
		expect(call.url).toBe(`${GATEWAY}/api/integrations/email/send`);
		expect(call.headers.get("content-type")).toBe("application/json");
		expect(call.headers.get("x-everyapp-identity")).toBe("token-of-the-person");
		expect(call.headers.get("x-everyapp-org")).toBeNull();
		expect(call.body).toEqual({
			to: ["alice@example.org"],
			subject: "Your order",
			html: "<p>It ships Tuesday.</p>",
			from: { address: "support@example.com", name: "Support" },
			headers: { "In-Reply-To": "<order-1042@example.org>" },
		});
	});

	it("attributes background work (a mailbox's agent) to the organization it names", async () => {
		const gateway = fakeGateway(() => Response.json({ status: "queued" }));
		await gatewayEmail(env({ EVERY_APP_GATEWAY: gateway.binding }), { background: true, organizationId: "org_acme" }).send(message);
		expect(gateway.calls[0]!.headers.get("x-everyapp-org")).toBe("org_acme");
		expect(gateway.calls[0]!.headers.get("x-everyapp-identity")).toBeNull();
	});

	it("turns the gateway's refusal into an EmailSendError carrying its code, status and message", async () => {
		const gateway = fakeGateway(() =>
			refusalResponse(403, "email_sender_not_allowed", "This app may not send as support@example.com: list it in capabilities.email.senders."),
		);
		const error = await gatewayEmail(env({ EVERY_APP_GATEWAY: gateway.binding })).send(message).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(EmailSendError);
		expect(error).toMatchObject({
			code: "email_sender_not_allowed",
			status: 403,
			message: "This app may not send as support@example.com: list it in capabilities.email.senders.",
		});
		expect((error as Error).cause).toBeInstanceOf(GatewayRefusalError);
	});

	it("names an unexplained gateway failure email_send_failed", async () => {
		const gateway = fakeGateway(() => new Response("upstream exploded", { status: 500 }));
		await expect(gatewayEmail(env({ EVERY_APP_GATEWAY: gateway.binding })).send(message)).rejects.toMatchObject({
			code: "email_send_failed",
			status: 500,
		});
	});

	it("refuses on a deployed Worker without the gateway binding (email_not_configured), sending nothing", async () => {
		await expect(gatewayEmail(env()).send(message)).rejects.toMatchObject({ code: "email_not_configured", status: 503 });
	});
});

describe("gatewayEmail under everyapp dev (no gateway)", () => {
	const message = { from: "dev@example.com", to: ["a@example.org", "b@example.org"], cc: "c@example.org", subject: "Hello", text: "x" };

	it("checks the sender against the manifest's senders, prints the mail and reports a dev- id", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		const sent = await gatewayEmail(devEnv()).send(message);
		expect(sent.messageId).toMatch(/^dev-[0-9a-f-]{36}$/);
		expect(info).toHaveBeenCalledWith(expect.stringMatching(/^\[everyapp dev\] email to 3 recipients subject "Hello"/));
	});

	it("refuses a mailbox on a domain the manifest's senders don't name, as the gateway would", async () => {
		await expect(gatewayEmail(devEnv()).send({ ...message, from: "info@other.example" })).rejects.toMatchObject({
			code: "email_sender_not_allowed",
			status: 403,
		});
	});

	it("sends through Email Sending's REST API from the developer's account when .dev.vars has the settings", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({ success: true, result: { message_id: "<rest-1@example.com>", delivered: ["a@example.org"] } }),
		);
		const sent = await gatewayEmail(
			devEnv({ EMAIL_REST_API_TOKEN: "dev-token", CLOUDFLARE_ACCOUNT_ID: "acct-1", EMAIL_FROM: "noreply@example.com" }),
		).send({ from: "dev@example.com", to: "a@example.org", subject: "Hello", text: "x" });
		expect(sent).toEqual({ messageId: "<rest-1@example.com>" });
		const [url, init] = fetchSpy.mock.calls[0]!;
		expect(String(url)).toBe("https://api.cloudflare.com/client/v4/accounts/acct-1/email/sending/send");
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer dev-token");
		expect(JSON.parse(String(init?.body))).toMatchObject({ to: "a@example.org", from: "dev@example.com", subject: "Hello" });
	});
});

describe("sendFailure", () => {
	it("is the 502 body: the code as error, and the message", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect(sendFailure(new EmailSendError("email_budget_exhausted", 429, "Daily budget spent."))).toEqual({
			error: "email_budget_exhausted",
			message: "Daily budget spent.",
		});
		expect(
			sendFailure(new GatewayRefusalError({ status: 422, code: "email_sender_not_verified", message: "Onboard example.com." })),
		).toEqual({ error: "email_sender_not_verified", message: "Onboard example.com." });
		expect(sendFailure(new Error("boom"))).toEqual({ error: "email_send_failed", message: "boom" });
	});
});

describe("emailConfig", () => {
	const ready = { capability: "email", requested: true, configured: true, ready: true, sender: { address: "noreply@example.com", name: "Inbox" }, senders: ["*@example.com"] };

	it("reads the gateway's GET /api/integrations/email and caches the answer for 60 s", async () => {
		let status: object = ready;
		const gateway = fakeGateway(() => Response.json(status));
		const e = env({ EVERY_APP_GATEWAY: gateway.binding });
		await expect(emailConfig(e, 1_000)).resolves.toEqual({ domains: ["example.com"], ready: true });
		expect(gateway.calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${GATEWAY}/api/integrations/email`]);
		status = { ...ready, configured: false, ready: false, sender: null };
		await expect(emailConfig(e, 60_999)).resolves.toEqual({ domains: ["example.com"], ready: true });
		expect(gateway.calls).toHaveLength(1);
		await expect(emailConfig(e, 61_000)).resolves.toEqual({ domains: ["example.com"], ready: false });
		expect(gateway.calls).toHaveLength(2);
	});

	it("is false when the gateway accepts none of the app's senders (a hosted gateway), since every mailbox sends as itself", async () => {
		const gateway = fakeGateway(() => Response.json({ ...ready, senders: [] }));
		await expect(emailConfig(env({ EVERY_APP_GATEWAY: gateway.binding }))).resolves.toEqual({ domains: [], ready: false });
	});

	it("is false when the gateway answers with an error", async () => {
		const gateway = fakeGateway(() => refusalResponse(403, "capability_not_requested", "The app doesn't list email."));
		await expect(emailConfig(env({ EVERY_APP_GATEWAY: gateway.binding }))).resolves.toEqual({ domains: [], ready: false });
	});

	it("under everyapp dev follows .dev.vars: false while mail is only printed, true with EMAIL_FROM", async () => {
		await expect(emailConfig(devEnv(), 1_000)).resolves.toEqual({ domains: ["example.com"], ready: false });
		resetEmailReadyCache();
		await expect(emailConfig(devEnv({ EMAIL_FROM: "noreply@example.com" }), 1_000)).resolves.toEqual({ domains: ["example.com"], ready: true });
	});

	it("is false on a deployed Worker without the gateway binding", async () => {
		await expect(emailConfig(env())).resolves.toEqual({ domains: [], ready: false });
	});
});
