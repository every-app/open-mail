// The browser's API client behind the gateway: refusals read as sentences,
// and a 401 (session ended) reloads the page so the gateway signs the person in.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import api, { ApiError, meQuery, reloadForSignIn } from "../app/services/api";

function respond(status: number, body: unknown) {
	const calls: { url: string; init?: RequestInit }[] = [];
	vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
		calls.push({ url, init });
		return Response.json(body, { status });
	});
	return calls;
}

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
	const error = await promise.then(
		() => {
			throw new Error("expected the request to fail");
		},
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(ApiError);
	return error as ApiError;
}

function fakeWindow() {
	const store = new Map<string, string>();
	const reload = vi.fn();
	vi.stubGlobal("window", {
		location: { reload },
		sessionStorage: {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => void store.set(key, value),
		},
	});
	return reload;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("send refusals", () => {
	it("a 502 email_sender_not_allowed from the send route reads as what to fix, and keeps its code", async () => {
		const calls = respond(502, {
			error: "email_sender_not_allowed",
			message: "from info@other.example is not in this app's capabilities.email.senders",
		});

		const error = await refusal(api.sendEmail("info@other.example", { to: "a@b.example", subject: "s" }));

		expect(error.status).toBe(502);
		expect(error.code).toBe("email_sender_not_allowed");
		expect(error.message).toBe(
			"This mailbox's domain isn't one this app may send from. An owner adds it to capabilities.email.senders in everyapp.config.ts and redeploys.",
		);
		expect(calls[0].url).toBe("/api/v1/mailboxes/info@other.example/emails");
		expect(calls[0].init?.method).toBe("POST");
	});

	it("the other gateway email refusals read as sentences too", async () => {
		for (const [code, text] of [
			["email_budget_exhausted", "The gateway's sending limit for today is reached. Try again later."],
			["email_sender_not_verified", "This mailbox's domain isn't set up for Email Sending"],
			["integration_not_configured", "Email sending isn't set up on this gateway."],
			["email_not_configured", "Email sending isn't set up on this gateway."],
		] as const) {
			respond(502, { error: code, message: "gateway text" });
			const error = await refusal(api.replyToEmail("m@example.com", "e1", {}));
			expect(error.code).toBe(code);
			expect(error.message).toContain(text);
		}
	});

	it("an unknown code shows the gateway's own message; upstream's readable errors pass through", async () => {
		respond(502, { error: "email_something_new", message: "The gateway explains it." });
		expect((await refusal(api.forwardEmail("m@example.com", "e1", {}))).message).toBe("The gateway explains it.");

		respond(404, { error: "Mailbox not found" });
		const notFound = await refusal(api.getMailbox("nobody@example.com"));
		expect(notFound.message).toBe("Mailbox not found");
		expect(notFound.status).toBe(404);
		expect(notFound.code).toBeUndefined();

		respond(500, {});
		expect((await refusal(api.listMailboxes())).message).toBe("Request failed: 500");
	});

	it("a member's 403 admin_required reads as a role problem", async () => {
		respond(403, { error: "forbidden", code: "admin_required" });
		const error = await refusal(api.createMailbox("new@example.com", "new"));
		expect(error.code).toBe("admin_required");
		expect(error.message).toBe("Only the organization's owners and admins can do this.");
	});
});

describe("401: the session ended", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
	});

	it("reloads the page so the gateway signs the person in, and still rejects the call", async () => {
		const reload = fakeWindow();
		respond(401, { error: "unauthenticated" });

		const error = await refusal(api.listMailboxes());

		expect(reload).toHaveBeenCalledTimes(1);
		expect(error.status).toBe(401);
		expect(error.message).toBe("Your session has ended. Reload the page to sign in again.");
	});

	it("reloads at most once per 10 seconds, so a 401 right after a reload can't loop", async () => {
		const reload = fakeWindow();
		respond(401, { error: "unauthenticated" });

		await refusal(api.listMailboxes());
		await refusal(api.getConfig());
		expect(reload).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(10_001);
		await refusal(api.listMailboxes());
		expect(reload).toHaveBeenCalledTimes(2);
	});

	it("never reloads for other statuses, and does nothing outside a browser", async () => {
		const reload = fakeWindow();
		respond(403, { error: "forbidden" });
		await refusal(api.listMailboxes());
		expect(reload).not.toHaveBeenCalled();

		vi.unstubAllGlobals();
		expect(reloadForSignIn()).toBe(false);
	});
});

describe("contracts L2 and L3 serve", () => {
	it("getMe reads /api/v1/me; getConfig carries ready", async () => {
		const me = { id: "dev-user", email: "dev@everyapp.localhost", orgId: "dev-org", role: "owner", gatewayUrl: "http://localhost:8787" };
		let calls = respond(200, me);
		expect(await meQuery.queryFn()).toEqual(me);
		expect(meQuery.queryKey).toEqual(["me"]);
		expect(calls[0].url).toBe("/api/v1/me");

		calls = respond(200, { domains: ["example.com"], emailAddresses: [], ready: false });
		const config = await api.getConfig();
		expect(config.ready).toBe(false);
		expect(calls[0].url).toBe("/api/v1/config");
	});
});
