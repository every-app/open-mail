/**
 * Outbound mail through the gateway's email capability, shaped as the
 * `send_email` binding upstream's code calls.
 *
 * On Every App the app's Worker may not bind `send_email` (the deploy
 * refuses it). withGateway() puts gatewayEmail() at `env.EMAIL` instead, so
 * workers/email-sender.ts and the MCP tools stay as upstream wrote them:
 * `env.EMAIL.send(message)` becomes a POST to the gateway's
 * `/api/integrations/email/send`, attributed to the request's person (or the
 * background work's organization). The gateway checks the manifest grants
 * `email`, that `from` matches a sender pattern the installation allows, and
 * the mail budgets, then sends with its own Email Sending binding.
 *
 * A send throws an EmailSendError carrying the gateway's refusal code
 * (`email_sender_not_allowed`, `email_budget_exhausted`, ...). The send
 * routes await it and answer 502 with that code, writing the Sent copy only
 * after the gateway accepted the message.
 */
import {
	ConfigurationError,
	GatewayRefusalError,
	integrationStatus,
	sendEmail,
	type EmailAttachmentInput,
	type GatewayCallFor,
	type SendEmailMessage,
	type SendEmailResult,
} from "@every-app/sdk/server";

/** A failed send: the gateway's refusal code and message, or `email_send_failed`. */
export class EmailSendError extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "EmailSendError";
	}
}

type Address = string | EmailAddress;
type Recipients = Address | Address[];

/**
 * `env.EMAIL` for this request: the gateway's email capability as a
 * `send_email` binding. `target` says whom the mail is for (the request's
 * person, or the organization's background work); the SDK attributes the
 * call with it. Deployed, the SDK posts to the gateway over the
 * EVERY_APP_GATEWAY binding. Under `everyapp dev` it applies the gateway's
 * checks (the message, EVERYAPP_EMAIL_SENDERS) and prints the mail, or sends
 * it through Email Sending's REST API with EMAIL_REST_API_TOKEN,
 * CLOUDFLARE_ACCOUNT_ID and EMAIL_FROM in `.dev.vars`.
 */
export function gatewayEmail(env: Cloudflare.Env, target?: GatewayCallFor): SendEmail {
	return emailAdapter((message) => sendEmail({ env, for: target, message }));
}

/**
 * A `send_email`-shaped binding over `send`: maps the message to the
 * gateway's request and every failure to an EmailSendError.
 */
export function emailAdapter(
	send: (message: SendEmailMessage) => Promise<SendEmailResult>,
): SendEmail {
	return {
		async send(message: EmailMessage | EmailMessageBuilder): Promise<EmailSendResult> {
			const request = toGatewayMessage(message);
			try {
				const result = await send(request);
				return { messageId: result.messageId ?? "" };
			} catch (error) {
				throw toSendError(error);
			}
		},
	} as SendEmail;
}

/**
 * The Workers `send_email` message (what workers/email-sender.ts builds) as
 * the gateway's send request (the SDK's SendEmailMessage). Recipients go as
 * bare addresses; `from` and `replyTo` keep their display names.
 */
export function toGatewayMessage(message: EmailMessage | EmailMessageBuilder): SendEmailMessage {
	if (!("subject" in message)) {
		// An EmailMessage carries raw MIME; the gateway takes structured mail only.
		throw new EmailSendError(
			"email_invalid_message",
			400,
			"Raw MIME messages can't be sent through the gateway; send a structured message.",
		);
	}
	return {
		to: addresses(message.to) ?? [],
		...(message.cc ? { cc: addresses(message.cc) } : {}),
		...(message.bcc ? { bcc: addresses(message.bcc) } : {}),
		subject: message.subject,
		...(message.text ? { text: message.text } : {}),
		...(message.html ? { html: message.html } : {}),
		from: named(message.from),
		...(message.replyTo ? { replyTo: named(message.replyTo) } : {}),
		...(message.headers && Object.keys(message.headers).length > 0 ? { headers: message.headers } : {}),
		...(message.attachments?.length ? { attachments: message.attachments.map(attachment) } : {}),
	};
}

/**
 * One attachment in the gateway's shape: base64 content, and `inline` with
 * its `contentId` (an HTML body's `cid:` image). An inline part without a
 * content id can't be referenced, and the gateway refuses it, so it goes as
 * an ordinary attachment.
 */
function attachment(a: EmailAttachment): EmailAttachmentInput {
	const contentId = a.contentId?.trim();
	return {
		filename: a.filename,
		contentType: a.type,
		content: base64(a.content),
		...(a.disposition === "inline" && contentId ? { disposition: "inline", contentId } : {}),
	};
}

/** `{ address, name? }`: the display name only when there is one. */
function named(address: Address): { address: string; name?: string } {
	const { email, name } = typeof address === "string" ? { email: address, name: "" } : address;
	return { address: email, ...(name?.trim() ? { name } : {}) };
}

function addressOf(address: Address): string {
	return typeof address === "string" ? address : address.email;
}

function addresses(recipients: Recipients | undefined): string | string[] | undefined {
	if (recipients === undefined) return undefined;
	return Array.isArray(recipients) ? recipients.map(addressOf) : addressOf(recipients);
}

/** Upstream passes base64 strings already; binary content is encoded. */
function base64(content: string | ArrayBuffer | ArrayBufferView): string {
	if (typeof content === "string") return content;
	const bytes =
		content instanceof ArrayBuffer
			? new Uint8Array(content)
			: new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

function toSendError(error: unknown): EmailSendError {
	if (error instanceof EmailSendError) return error;
	if (error instanceof GatewayRefusalError) {
		return new EmailSendError(error.code, error.status, error.message, { cause: error });
	}
	if (error instanceof ConfigurationError) {
		return new EmailSendError("email_not_configured", 503, error.message, { cause: error });
	}
	const message = error instanceof Error ? error.message : String(error);
	return new EmailSendError("email_send_failed", 502, message, { cause: error });
}

// -- For the send routes (workers/index.ts, workers/routes/reply-forward.ts)

/** The 502 body a send route answers when the send failed: `{ error: <code>, message }`. */
export function sendFailure(error: unknown): { error: string; message: string } {
	const failure = toSendError(error);
	console.error(`Email send failed (${failure.code}): ${failure.message}`);
	return { error: failure.code, message: failure.message };
}

/** Removes the attachments a send route stored for mail that was not sent. */
export async function discardAttachments(
	bucket: R2Bucket,
	emailId: string,
	attachments: { id: string; filename: string }[],
): Promise<void> {
	if (attachments.length === 0) return;
	await bucket
		.delete(attachments.map((a) => `attachments/${emailId}/${a.id}/${a.filename}`))
		.catch((e) => console.error("Discarding unsent attachments failed:", (e as Error).message));
}

// -- Readiness, for GET /api/v1/config

const READY_TTL_MS = 60_000;
type EmailConfig = { domains: string[]; ready: boolean };
let readyCache: { config: EmailConfig; at: number } | undefined;

/**
 * Mailbox domains and send readiness from the installation's email status,
 * cached for 60 s. In dev, senders come from EVERYAPP_EMAIL_SENDERS and
 * readiness requires EMAIL_FROM in .dev.vars.
 */
export async function emailConfig(env: Cloudflare.Env, now = Date.now()): Promise<EmailConfig> {
	if (readyCache && now - readyCache.at < READY_TTL_MS) return readyCache.config;
	try {
		const status = await integrationStatus({ env, provider: "email" });
		const config = {
			domains: [...new Set(status.senders.map((sender) => sender.slice(sender.lastIndexOf("@") + 1)))],
			ready: status.ready === true && status.senders.length > 0,
		};
		readyCache = { config, at: now };
		return config;
	} catch (error) {
		if (!(error instanceof ConfigurationError)) {
			console.error("Reading the gateway's email status failed:", (error as Error).message);
		}
		return { domains: [], ready: false };
	}
}

/** Tests only: forget the cached readiness. */
export function resetEmailReadyCache(): void {
	readyCache = undefined;
}
