/**
 * `env.EMAIL` for Gmail mailboxes (docs/GMAIL.md, "Sending"). A send whose
 * `from` is a Gmail mailbox goes out through Gmail's messages.send, as the
 * person behind the request: the Send button in OpenMail. Background work
 * never sends (no person behind it), and the MCP send tools refuse a Gmail
 * mailbox before they get here (tools.ts). Every other sender keeps the
 * gateway's email capability.
 */
import type { GatewayCallFor } from "@every-app/sdk/server";
import { EmailSendError } from "../email";
import { readMailboxSettings } from "../mailbox-settings";
import { GmailError, gmailClient } from "./client";
import { buildRaw, type MimeAddress } from "./mime";
import { forwardTarget, gmailSyncOf, personBehind } from "./target";

type WrapperEnv = Pick<Cloudflare.Env, "BUCKET" | "GMAIL_SYNC">;

/**
 * `fallback` (the gateway's email capability) with Gmail mailboxes routed
 * through Gmail. `fetcher` replaces the gateway in tests.
 */
export function gmailAwareEmail(env: WrapperEnv, target: GatewayCallFor | undefined, fallback: SendEmail, fetcher?: typeof fetch): SendEmail {
	if (!env.BUCKET) return fallback;
	return {
		async send(message: EmailMessage | EmailMessageBuilder): Promise<EmailSendResult> {
			const from = addressOf((message as { from?: MimeAddress }).from).toLowerCase();
			const settings = from ? await readMailboxSettings(env.BUCKET, from) : null;
			if (settings?.provider !== "gmail") return fallback.send(message as EmailMessageBuilder);

			const headers = "headers" in message && message.headers ? lowerKeys(message.headers) : {};
			const replyTo = headers["in-reply-to"];
			const gmailThreadId = replyTo && env.GMAIL_SYNC ? await gmailSyncOf(env, from).gmailThreadFor(replyTo) : null;

			if (!personBehind(target)) {
				throw new EmailSendError("gmail_send_needs_person", 409, "Gmail sends only for a signed-in person; background work never sends from Gmail.");
			}
			if (!("subject" in message)) {
				throw new EmailSendError("email_invalid_message", 400, "Raw MIME messages can't be sent through Gmail; send a structured message.");
			}
			const raw = buildRaw({
				from: message.from as MimeAddress,
				to: message.to as MimeAddress | MimeAddress[],
				cc: message.cc as MimeAddress | MimeAddress[] | undefined,
				bcc: message.bcc as MimeAddress | MimeAddress[] | undefined,
				replyTo: message.replyTo as MimeAddress | undefined,
				subject: message.subject,
				html: message.html,
				text: message.text,
				headers: message.headers,
				attachments: message.attachments?.map((a) => ({
					filename: a.filename,
					type: a.type,
					content: a.content,
					disposition: a.disposition,
					contentId: a.contentId,
				})),
			});
			try {
				const sent = await gmailClient(env, forwardTarget(target)!, fetcher).sendMessage(raw, gmailThreadId ?? undefined);
				return { messageId: sent.id };
			} catch (error) {
				if (error instanceof GmailError) {
					throw new EmailSendError(error.code, error.status, error.message, { cause: error });
				}
				throw error;
			}
		},
	} as SendEmail;
}

function addressOf(address: MimeAddress | undefined): string {
	if (!address) return "";
	return typeof address === "string" ? address.trim() : address.email;
}

function lowerKeys(headers: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
	return out;
}
