// withGateway()'s env.EMAIL for Gmail mailboxes: a send from a Gmail mailbox
// goes through Gmail's messages.send for the person behind the request (the
// Send button), and never for background work. Native senders keep the
// gateway's capability.
import { describe, expect, it } from "vitest";
import { EmailSendError, sendFailure } from "../workers/everyapp/email";
import { gmailAwareEmail } from "../workers/everyapp/gmail/send";
import { fakeGmail } from "./fixtures/fake-gmail";

const GMAIL = "me@example.com";

function fakeR2(objects: Record<string, unknown>) {
	return {
		async get(key: string) {
			return key in objects ? { json: async () => objects[key] } : null;
		},
	} as unknown as R2Bucket;
}

function setup() {
	const gmail = fakeGmail(GMAIL);
	const fallbackSent: unknown[] = [];
	const fallback = { send: async (m: unknown) => (fallbackSent.push(m), { messageId: "gw-1" }) } as unknown as SendEmail;
	const env = {
		BUCKET: fakeR2({
			"mailboxes/me@example.com.json": { provider: "gmail", ownerId: "u1" },
			"mailboxes/support@example.com.json": { fromName: "Support" },
		}),
		GMAIL_SYNC: {
			idFromName: (name: string) => name,
			get: () => ({ gmailThreadFor: async (id: string) => (id.includes("q1042") ? "t1" : null) }),
		},
	} as unknown as Cloudflare.Env;
	const request = new Request("https://openmail.example.com/api/v1/x", { headers: { "x-everyapp-identity": "person" } });
	return { gmail, fallbackSent, email: (target?: Request) => gmailAwareEmail(env, target, fallback, gmail.fetch), request };
}

const reply = {
	from: GMAIL,
	to: "alice@example.org",
	subject: "Re: Order 1042",
	html: "<p>Ships Friday.</p>",
	headers: { "In-Reply-To": "<q1042@example.org>", References: "<q1042@example.org>" },
};

describe("sending from a Gmail mailbox", () => {
	it("native senders keep the gateway's email capability", async () => {
		const { email, fallbackSent, gmail, request } = setup();
		await email(request).send({ ...reply, from: "support@example.com" } as never);
		expect(fallbackSent).toHaveLength(1);
		expect(gmail.calls).toEqual([]);
	});

	it("goes through messages.send in the Gmail thread, for the person", async () => {
		const { email, gmail, request } = setup();
		const sent = await email(request).send(reply as never);
		const call = gmail.calls.find((c) => c.path === "/messages/send")!;
		expect(sent.messageId).toBe(gmail.messages.get(sent.messageId)!.id);
		expect(call.body.threadId).toBe("t1");
		const raw = gmail.rawText(call.body.raw);
		expect(raw).toContain("In-Reply-To: <q1042@example.org>");
		expect(raw).toContain("To: alice@example.org");
	});

	it("with no person behind it (background work), refuses", async () => {
		const { email, gmail } = setup();
		await expect(email(undefined).send(reply as never)).rejects.toMatchObject({ code: "gmail_send_needs_person", status: 409 });
		expect(gmail.calls.filter((c) => c.path === "/messages/send")).toEqual([]);
	});

	it("passes a Gateway refusal through", async () => {
		const { email, gmail, request } = setup();
		gmail.state.disconnected = true;
		await expect(email(request).send(reply as never)).rejects.toMatchObject({ code: "integration_not_connected", status: 409 });
	});
});

describe("sendFailure()", () => {
	it("answers a failure as the 502 body", () => {
		expect(sendFailure(new EmailSendError("email_budget_exhausted", 429, "Budget."))).toEqual({ error: "email_budget_exhausted", message: "Budget." });
	});
});
