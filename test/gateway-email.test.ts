// env.EMAIL on Every App: the gateway's email capability as a send_email
// binding (workers/everyapp/email.ts).
import { ConfigurationError } from "@every-app/sdk/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	EmailSendError,
	emailAdapter,
	emailSendingReady,
	gatewayEmail,
	resetEmailReadyCache,
	sendFailure,
	toGatewayMessage,
	type GatewayEmailMessage,
} from "../workers/everyapp/email";

function env(extra: Record<string, unknown> = {}) {
	return { DOMAINS: "example.com", ...extra } as unknown as Cloudflare.Env;
}

/** A refusal shaped like the SDK's GatewayRefusalError (PR 3). */
function refusal(status: number, code: string, message: string) {
	return Object.assign(new Error(message), { name: "GatewayRefusalError", status, code });
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
			html: "<p>hi</p>",
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
			html: "<p>hi</p>",
			text: "hi",
			from: { address: "support@example.com", name: "Support" },
			replyTo: "replies@example.com",
			headers: { "In-Reply-To": "<m1@example.org>" },
			attachments: [
				{ filename: "a.txt", contentType: "text/plain", content: "aGVsbG8=" },
				{ filename: "logo.png", contentType: "image/png", content: btoa("binary attachment") },
			],
		} satisfies GatewayEmailMessage);
	});

	it("sends a bare from address without a name and leaves out what upstream left empty", () => {
		expect(
			toGatewayMessage({ from: "dev@example.com", to: "a@example.org", subject: "s", text: "t", headers: {}, attachments: [] }),
		).toEqual({ to: "a@example.org", subject: "s", text: "t", from: { address: "dev@example.com" } });
	});

	it("refuses raw MIME messages", () => {
		expect(() => toGatewayMessage({ from: "dev@example.com", to: "a@example.org" } as EmailMessage)).toThrow(
			expect.objectContaining({ code: "email_invalid_message" }),
		);
	});
});

describe("emailAdapter", () => {
	const message = { from: "dev@example.com", to: "a@example.org", subject: "hi", text: "x" };

	it("hands the mapped message to the gateway and returns its message id", async () => {
		const send = vi.fn(async (_m: GatewayEmailMessage) => ({ messageId: "<abc@example.com>", status: "queued" as const }));
		await expect(emailAdapter(send).send(message)).resolves.toEqual({ messageId: "<abc@example.com>" });
		expect(send).toHaveBeenCalledWith({ to: "a@example.org", subject: "hi", text: "x", from: { address: "dev@example.com" } });
	});

	it("answers an empty message id when the gateway reports none", async () => {
		await expect(emailAdapter(async () => ({ status: "delivered" })).send(message)).resolves.toEqual({ messageId: "" });
	});

	it("rethrows a gateway refusal as an EmailSendError with the gateway's code, status and message", async () => {
		const adapter = emailAdapter(async () => {
			throw refusal(403, "email_sender_not_allowed", "dev@example.com isn't one of this app's senders.");
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

describe("gatewayEmail (the stand-in until the SDK's sendEmail)", () => {
	const message = { from: "dev@example.com", to: ["a@example.org", "b@example.org"], cc: "c@example.org", subject: "Hello", text: "x" };

	it("logs the SDK's dev line and reports a dev- id under everyapp dev", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const sent = await gatewayEmail(env({ EVERYAPP_DEV: "1" })).send(message);
		expect(sent.messageId).toMatch(/^dev-[0-9a-f-]{36}$/);
		expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[everyapp dev\] email to 3 recipients subject "Hello"/));
	});

	it("refuses on a deployed Worker, so nothing reports a send that didn't happen", async () => {
		await expect(gatewayEmail(env()).send(message)).rejects.toMatchObject({ code: "email_not_configured", status: 503 });
	});
});

describe("sendFailure", () => {
	it("is the 502 body: the code as error, and the message", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect(sendFailure(new EmailSendError("email_budget_exhausted", 429, "Daily budget spent."))).toEqual({
			error: "email_budget_exhausted",
			message: "Daily budget spent.",
		});
		expect(sendFailure(new Error("boom"))).toEqual({ error: "email_send_failed", message: "boom" });
	});
});

describe("emailSendingReady", () => {
	it("is false while the linked SDK has no email capability", async () => {
		await expect(emailSendingReady(env({ EVERYAPP_DEV: "1" }))).resolves.toBe(false);
	});

	it("reads the gateway's email status and caches it for 60 s", async () => {
		vi.resetModules();
		const integrationStatus = vi.fn(async () => ({ requested: true, configured: true, ready: true }));
		vi.doMock("@every-app/sdk/server", async (importOriginal) => ({
			...(await importOriginal<typeof import("@every-app/sdk/server")>()),
			integrationStatus,
		}));
		try {
			const email = await import("../workers/everyapp/email");
			const e = env();
			await expect(email.emailSendingReady(e, 1_000)).resolves.toBe(true);
			expect(integrationStatus).toHaveBeenCalledWith({ env: e, provider: "email" });
			integrationStatus.mockResolvedValue({ requested: true, configured: false, ready: false });
			await expect(email.emailSendingReady(e, 60_999)).resolves.toBe(true);
			expect(integrationStatus).toHaveBeenCalledTimes(1);
			await expect(email.emailSendingReady(e, 61_000)).resolves.toBe(false);
			expect(integrationStatus).toHaveBeenCalledTimes(2);
		} finally {
			vi.doUnmock("@every-app/sdk/server");
			vi.resetModules();
		}
	});
});
