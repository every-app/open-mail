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
 * `email`, that `from` matches a sender pattern the manifest declares, and
 * the mail budgets, then sends with its own Email Sending binding.
 *
 * A send throws an EmailSendError carrying the gateway's refusal code
 * (`email_sender_not_allowed`, `email_budget_exhausted`, ...). The send
 * routes await it and answer 502 with that code, writing the Sent copy only
 * after the gateway accepted the message.
 */
import {
	ConfigurationError,
	integrationStatus,
	type CapabilityId,
	type GatewayCallFor,
} from "@every-app/sdk/server";

// TODO(integration): lane inbox-L2b, once platform PR 3 (port/email-capability)
// is in the linked SDK, replace the stand-in below (GatewayEmailMessage,
// GatewaySendResult, GatewayRefusalError, sendEmail) with the SDK's:
//   import { sendEmail, type SendEmailRequest } from "@every-app/sdk/server";
// and drop the `as string as CapabilityId` cast in emailSendingReady().

/** The gateway's send request: PR 3's `SendEmailRequest`, as the plan specifies it. */
export interface GatewayEmailMessage {
	to: string | string[];
	cc?: string | string[];
	bcc?: string | string[];
	subject: string;
	text?: string;
	html?: string;
	/** Absent: the gateway's own sender. Present: must match the manifest's `senders`. */
	from?: { address: string; name?: string };
	replyTo?: string;
	headers?: Record<string, string>;
	attachments?: { filename: string; contentType: string; content: string /* base64 */ }[];
}

/** PR 3's send result. `logged`: local dev without Email Sending keys. */
interface GatewaySendResult {
	messageId?: string;
	status: "delivered" | "queued" | "logged";
}

/** The SDK's thrown twin of `gatewayRefusal()` (PR 3), stood in until it ships. */
class GatewayRefusalError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "GatewayRefusalError";
	}
}

/**
 * Stand-in for the SDK's `sendEmail({ env, for, message })` (PR 3), with its
 * signature. Local dev: logs the line the SDK logs when no Email Sending key
 * is in `.dev.vars` and reports a `dev-` id. Deployed: refuses, so a Worker
 * never reports a send that didn't happen.
 */
async function sendEmail({
	env,
	message,
}: {
	env: object;
	for?: GatewayCallFor;
	message: GatewayEmailMessage;
}): Promise<GatewaySendResult> {
	if (!(env as { EVERYAPP_DEV?: unknown }).EVERYAPP_DEV) {
		throw new GatewayRefusalError(
			503,
			"email_not_configured",
			"Email sending isn't connected to the gateway yet (the gateway's email capability); nothing was sent.",
		);
	}
	const recipients = [message.to, message.cc, message.bcc].flat().filter(Boolean).length;
	console.log(
		`[everyapp dev] email to ${recipients} recipients subject ${JSON.stringify(message.subject)} (logged by the app's stand-in until the gateway email capability is in the SDK; not sent)`,
	);
	return { status: "logged", messageId: `dev-${crypto.randomUUID()}` };
}

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

/** `env.EMAIL` for this request: the gateway's email capability as a `send_email` binding. */
export function gatewayEmail(env: Cloudflare.Env, target?: GatewayCallFor): SendEmail {
	return emailAdapter((message) => sendEmail({ env, for: target, message }));
}

/**
 * A `send_email`-shaped binding over `send`: maps the message to the
 * gateway's request and every failure to an EmailSendError.
 */
export function emailAdapter(
	send: (message: GatewayEmailMessage) => Promise<GatewaySendResult>,
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
 * the gateway's send request. Recipients go as bare addresses.
 */
export function toGatewayMessage(message: EmailMessage | EmailMessageBuilder): GatewayEmailMessage {
	if (!("subject" in message)) {
		// An EmailMessage carries raw MIME; the gateway takes structured mail only.
		throw new EmailSendError(
			"email_invalid_message",
			400,
			"Raw MIME messages can't be sent through the gateway; send a structured message.",
		);
	}
	const from = typeof message.from === "string" ? { email: message.from, name: "" } : message.from;
	return {
		to: addresses(message.to) ?? [],
		...(message.cc ? { cc: addresses(message.cc) } : {}),
		...(message.bcc ? { bcc: addresses(message.bcc) } : {}),
		subject: message.subject,
		...(message.text ? { text: message.text } : {}),
		...(message.html ? { html: message.html } : {}),
		from: { address: from.email, ...(from.name ? { name: from.name } : {}) },
		...(message.replyTo ? { replyTo: addressOf(message.replyTo) } : {}),
		...(message.headers && Object.keys(message.headers).length > 0 ? { headers: message.headers } : {}),
		...(message.attachments?.length
			? {
					// The gateway's shape has no disposition/contentId: inline
					// images go as ordinary attachments (TODO.md, "Decide").
					attachments: message.attachments.map((a) => ({
						filename: a.filename,
						contentType: a.type,
						content: base64(a.content),
					})),
				}
			: {}),
	};
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
	if (isGatewayRefusal(error)) {
		return new EmailSendError(error.code, error.status, error.message, { cause: error });
	}
	if (error instanceof ConfigurationError) {
		return new EmailSendError("email_not_configured", 503, error.message, { cause: error });
	}
	const message = error instanceof Error ? error.message : String(error);
	return new EmailSendError("email_send_failed", 502, message, { cause: error });
}

/** The gateway's refusal, by shape: the SDK's GatewayRefusalError or the stand-in's. */
function isGatewayRefusal(error: unknown): error is { status: number; code: string; message: string } {
	return (
		error instanceof Error &&
		typeof (error as { status?: unknown }).status === "number" &&
		typeof (error as { code?: unknown }).code === "string"
	);
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
let readyCache: { ready: boolean; at: number } | undefined;

/**
 * Whether sends would go through: the gateway's `GET /api/integrations/email`
 * `ready` (the manifest requests `email`, the gateway has a sender, the
 * capability is configured), cached per isolate for 60 s. False while the
 * linked SDK has no `email` capability (it refuses the unknown id).
 */
export async function emailSendingReady(env: Cloudflare.Env, now = Date.now()): Promise<boolean> {
	if (readyCache && now - readyCache.at < READY_TTL_MS) return readyCache.ready;
	try {
		const status = await integrationStatus({ env, provider: "email" as string as CapabilityId });
		readyCache = { ready: status.ready === true, at: now };
		return readyCache.ready;
	} catch (error) {
		if (!(error instanceof ConfigurationError)) {
			console.error("Reading the gateway's email status failed:", (error as Error).message);
		}
		return false;
	}
}

/** Tests only: forget the cached readiness. */
export function resetEmailReadyCache(): void {
	readyCache = undefined;
}
