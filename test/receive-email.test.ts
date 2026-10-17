/// <reference types="@cloudflare/vitest-pool-workers" />
// Inbound mail: upstream's receiveEmail() (byte-identical) against the real
// MailboxDO, R2 and SQLite in workerd, fed the raw RFC 5322 message Email
// Routing hands the Worker's email() handler.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MailboxDO } from "../workers/durableObject";
import { withNamedAgents } from "../workers/everyapp/inbound";
import { receiveEmail } from "../workers/index";
import type { Env } from "../workers/types";
import inboundEml from "./fixtures/inbound.eml?raw";
import type { RecordingAgent } from "./workers/entry";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		MAILBOX: DurableObjectNamespace<MailboxDO>;
		EMAIL_AGENT: DurableObjectNamespace<RecordingAgent>;
		BUCKET: R2Bucket;
		DOMAINS: string;
		EMAIL_ADDRESSES: string[];
	}
}

const FIXTURE_ID = "order-1042-question@example.org";

afterEach(() => vi.restoreAllMocks());
let count = 0;

/** A mailbox of its own for each test (storage is shared across tests). */
async function newMailbox(): Promise<string> {
	const address = `inbox-${Date.now()}-${count++}@example.com`;
	await env.BUCKET.put(`mailboxes/${address}.json`, JSON.stringify({ fromName: "Dev" }));
	return address;
}

function mailbox(address: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(address));
}

/** The fixture, addressed to `to`. */
function fixtureTo(to: string): string {
	return inboundEml.replace(/^To: .*$/m, `To: Dev Inbox <${to}>`);
}

/** A plain-text message with the given headers. */
function plainMessage(headers: Record<string, string>, body = "Thanks!"): string {
	const lines = Object.entries({
		Date: "Fri, 17 Oct 2026 10:00:00 +0000",
		"MIME-Version": "1.0",
		"Content-Type": "text/plain; charset=utf-8",
		...headers,
	}).map(([k, v]) => `${k}: ${v}`);
	return [...lines, "", body, ""].join("\r\n");
}

/**
 * Delivers `raw` as Email Routing would, with the env workers/app.ts's
 * email() handler passes (withNamedAgents()), and waits for the auto-draft
 * trigger.
 */
async function deliver(raw: string, receiveEnv: Env = withNamedAgents(env as unknown as Env)): Promise<void> {
	const bytes = new TextEncoder().encode(raw);
	const ctx = createExecutionContext();
	await receiveEmail({ raw: new Response(bytes).body!, rawSize: bytes.byteLength }, receiveEnv, ctx);
	await waitOnExecutionContext(ctx);
}

function agentCalls(address: string) {
	return env.EMAIL_AGENT.get(env.EMAIL_AGENT.idFromName(address)).calls();
}

async function attachmentKeys(): Promise<string[]> {
	return (await env.BUCKET.list({ prefix: "attachments/" })).objects.map((o) => o.key);
}

describe("receiveEmail", () => {
	it("files the message in the mailbox's Inbox and asks the agent for an auto-draft", async () => {
		const address = await newMailbox();
		await deliver(fixtureTo(address));

		const inbox = await mailbox(address).getEmails({ folder: "inbox" });
		expect(inbox).toHaveLength(1);
		const email = inbox[0]!;
		expect(email).toMatchObject({
			subject: "Question about my order",
			sender: "alice@example.org",
			recipient: address,
			read: false,
		});
		// A new conversation: no References, no In-Reply-To, no earlier thread.
		expect(email.thread_id).toBe(email.id);
		const full = await mailbox(address).getEmail(email.id);
		expect(full).toMatchObject({ message_id: FIXTURE_ID, in_reply_to: null, email_references: null });
		expect(full?.body).toContain("Could you tell me when order 1042 ships?");

		expect(await agentCalls(address)).toEqual([
			{
				path: "/onNewEmail",
				body: {
					mailboxId: address,
					emailId: email.id,
					sender: "alice@example.org",
					subject: "Question about my order",
					threadId: email.id,
				},
			},
		]);
	});

	it("reaches the agent of a mailbox nobody has opened yet only with the agent named (withNamedAgents)", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const bare = await newMailbox();
		await deliver(fixtureTo(bare), env as unknown as Env);
		expect(await mailbox(bare).getEmails({ folder: "inbox" })).toHaveLength(1);
		expect(await agentCalls(bare)).toEqual([]);
		// partyserver logs the refusal and answers 500; receiveEmail doesn't look.
		expect(error.mock.calls.flat().map(String).join(" ")).toContain("Missing namespace or room headers");

		const named = await newMailbox();
		await deliver(fixtureTo(named));
		expect(await agentCalls(named)).toHaveLength(1);
	});

	it("stores attachments in R2 under attachments/<emailId>/<attachmentId>/<filename>", async () => {
		const address = await newMailbox();
		await deliver(fixtureTo(address));

		const [email] = await mailbox(address).getEmails({ folder: "inbox" });
		const full = await mailbox(address).getEmail(email!.id);
		expect(full?.attachments).toHaveLength(1);
		const attachment = full!.attachments[0]!;
		expect(attachment).toMatchObject({ email_id: email!.id, filename: "order-1042.txt", mimetype: "text/plain", disposition: "attachment" });

		const key = `attachments/${email!.id}/${attachment.id}/order-1042.txt`;
		expect(await attachmentKeys()).toContain(key);
		const object = await env.BUCKET.get(key);
		expect(await object!.text()).toBe("Order 1042: two blue mugs, one teapot.\nDelivery window: Tuesday 9-12.\n");
		expect(attachment.size).toBe(70);
	});

	it("threads replies by In-Reply-To and References", async () => {
		const address = await newMailbox();
		await deliver(fixtureTo(address));
		await deliver(
			plainMessage({
				From: "Alice Example <alice@example.org>",
				To: address,
				Subject: "Re: Question about my order",
				"Message-ID": "<order-1042-followup@example.org>",
				"In-Reply-To": `<${FIXTURE_ID}>`,
			}),
		);
		await deliver(
			plainMessage({
				From: "Alice Example <alice@example.org>",
				To: address,
				Subject: "Re: Question about my order",
				"Message-ID": "<order-1042-second@example.org>",
				"In-Reply-To": "<order-1042-followup@example.org>",
				References: `<${FIXTURE_ID}> <order-1042-followup@example.org>`,
			}),
		);

		// The RPC type of getThreadEmails' rows is too deep for tsc (upstream's
		// routes cast the stub to any for it, too).
		const stub = mailbox(address) as unknown as { getThreadEmails(id: string): Promise<{ message_id: string }[]> };
		const thread = await stub.getThreadEmails(FIXTURE_ID);
		expect(thread.map((e) => e.message_id).sort()).toEqual([
			"order-1042-followup@example.org",
			"order-1042-second@example.org",
		]);
		const byId = Object.fromEntries(thread.map((e) => [e.message_id, e]));
		expect(byId["order-1042-followup@example.org"]).toMatchObject({ in_reply_to: FIXTURE_ID, email_references: null, thread_id: FIXTURE_ID });
		expect(byId["order-1042-second@example.org"]).toMatchObject({
			in_reply_to: "order-1042-followup@example.org",
			email_references: JSON.stringify([FIXTURE_ID, "order-1042-followup@example.org"]),
			thread_id: FIXTURE_ID,
		});
		expect(await mailbox(address).getEmails({ folder: "inbox" })).toHaveLength(3);
	});

	it("ignores mail for an address that has no mailbox", async () => {
		const address = `nobody-${Date.now()}@example.com`;
		const keysBefore = await attachmentKeys();
		await deliver(fixtureTo(address));

		expect(await mailbox(address).getEmails({ folder: "inbox" })).toEqual([]);
		expect(await agentCalls(address)).toEqual([]);
		expect(await attachmentKeys()).toEqual(keysBefore);
	});

	it("throws on a message without a recipient, so Email Routing can retry or bounce it", async () => {
		await expect(
			deliver(plainMessage({ From: "alice@example.org", Subject: "no To", "Message-ID": "<no-to@example.org>" })),
		).rejects.toThrow("received email with empty to");
	});
});
