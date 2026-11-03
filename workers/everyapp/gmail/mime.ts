/**
 * RFC 822 messages for Gmail's drafts.create, drafts.update and
 * messages.send, which take the whole message as base64url `raw`. Gmail
 * threads a draft or a send by the `threadId` beside it plus matching
 * In-Reply-To/References and Subject headers, so both are built here.
 */
import { toBase64Url } from "./client";

export type MimeAddress = string | { email: string; name?: string };

export interface MimeAttachment {
	filename: string;
	type: string;
	/** base64 (what upstream passes around) or bytes. */
	content: string | ArrayBuffer | ArrayBufferView;
	disposition?: string;
	contentId?: string;
}

export interface MimeMessage {
	from: MimeAddress;
	to?: MimeAddress | MimeAddress[];
	cc?: MimeAddress | MimeAddress[];
	bcc?: MimeAddress | MimeAddress[];
	replyTo?: MimeAddress;
	subject: string;
	html?: string;
	text?: string;
	/** The Message-ID replied to, with or without angle brackets. */
	inReplyTo?: string | null;
	/** The thread's Message-IDs, oldest first. */
	references?: readonly string[];
	messageId?: string;
	date?: Date;
	/** Extra headers (upstream's threading headers arrive this way on a send). */
	headers?: Record<string, string>;
	attachments?: readonly MimeAttachment[];
}

const CRLF = "\r\n";

/** The message as RFC 822 text (CRLF line ends, ASCII only). */
export function buildMime(message: MimeMessage, boundarySeed: () => string = randomBoundary): string {
	const headers: [string, string][] = [];
	const extra = lowerKeys(message.headers);
	headers.push(["From", formatAddress(message.from)]);
	const to = list(message.to);
	if (to.length) headers.push(["To", to.map(formatAddress).join(", ")]);
	const cc = list(message.cc);
	if (cc.length) headers.push(["Cc", cc.map(formatAddress).join(", ")]);
	const bcc = list(message.bcc);
	if (bcc.length) headers.push(["Bcc", bcc.map(formatAddress).join(", ")]);
	if (message.replyTo) headers.push(["Reply-To", formatAddress(message.replyTo)]);
	headers.push(["Subject", encodeWord(message.subject ?? "")]);
	headers.push(["Date", (message.date ?? new Date()).toUTCString().replace("GMT", "+0000")]);
	if (message.messageId) headers.push(["Message-ID", angle(message.messageId)]);

	const inReplyTo = message.inReplyTo ?? extra["in-reply-to"];
	if (inReplyTo) headers.push(["In-Reply-To", angle(inReplyTo)]);
	const references = message.references?.length
		? message.references.map(angle).join(" ")
		: extra["references"]
			? extra["references"].split(/\s+/).filter(Boolean).map(angle).join(" ")
			: inReplyTo
				? angle(inReplyTo)
				: "";
	if (references) headers.push(["References", references]);
	for (const [name, value] of Object.entries(message.headers ?? {})) {
		const key = name.toLowerCase();
		if (key === "in-reply-to" || key === "references" || RESERVED.has(key)) continue;
		headers.push([name, encodeWord(value)]);
	}
	headers.push(["MIME-Version", "1.0"]);

	const body = bodyPart(message, boundarySeed);
	const attachments = message.attachments ?? [];
	let root: Part;
	if (attachments.length === 0) {
		root = body;
	} else {
		const boundary = boundarySeed();
		root = {
			headers: [["Content-Type", `multipart/mixed; boundary="${boundary}"`]],
			body: multipart(boundary, [body, ...attachments.map(attachmentPart)]),
		};
	}
	return [...headers, ...root.headers].map(([k, v]) => `${k}: ${v}`).join(CRLF) + CRLF + CRLF + root.body;
}

/** The message as Gmail's `raw`: base64url RFC 822. */
export function buildRaw(message: MimeMessage): string {
	return toBase64Url(buildMime(message));
}

interface Part {
	headers: [string, string][];
	body: string;
}

const RESERVED = new Set(["from", "to", "cc", "bcc", "reply-to", "subject", "date", "message-id", "mime-version", "content-type", "content-transfer-encoding"]);

function bodyPart(message: MimeMessage, boundarySeed: () => string): Part {
	const text = message.text;
	const html = message.html;
	if (text !== undefined && html !== undefined) {
		const boundary = boundarySeed();
		return {
			headers: [["Content-Type", `multipart/alternative; boundary="${boundary}"`]],
			body: multipart(boundary, [textPart("text/plain", text), textPart("text/html", html)]),
		};
	}
	if (html !== undefined) return textPart("text/html", html);
	return textPart("text/plain", text ?? "");
}

function textPart(type: string, content: string): Part {
	return {
		headers: [
			["Content-Type", `${type}; charset="UTF-8"`],
			["Content-Transfer-Encoding", "base64"],
		],
		body: wrap(base64(new TextEncoder().encode(content))),
	};
}

function attachmentPart(a: MimeAttachment): Part {
	const filename = a.filename || "attachment";
	const disposition = a.disposition === "inline" ? "inline" : "attachment";
	const headers: [string, string][] = [
		["Content-Type", `${a.type || "application/octet-stream"}; name="${quoted(filename)}"`],
		["Content-Transfer-Encoding", "base64"],
		["Content-Disposition", `${disposition}; filename="${quoted(filename)}"`],
	];
	if (a.contentId) headers.push(["Content-ID", angle(a.contentId)]);
	const content = typeof a.content === "string" ? a.content.replace(/\s+/g, "") : base64(bytesOf(a.content));
	return { headers, body: wrap(content) };
}

function multipart(boundary: string, parts: Part[]): string {
	return (
		parts
			.map((p) => `--${boundary}${CRLF}${p.headers.map(([k, v]) => `${k}: ${v}`).join(CRLF)}${CRLF}${CRLF}${p.body}${CRLF}`)
			.join("") + `--${boundary}--`
	);
}

function list(value: MimeAddress | MimeAddress[] | undefined): MimeAddress[] {
	if (value === undefined || value === "") return [];
	const values = Array.isArray(value) ? value : [value];
	// "a@x.com, b@y.com" as one string is a list too (upstream's drafts store recipients that way).
	return values.flatMap((v): MimeAddress[] => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : [v]));
}

export function formatAddress(address: MimeAddress): string {
	if (typeof address === "string") return address.trim();
	const name = address.name?.replace(/[\r\n]+/g, " ").trim();
	if (!name) return address.email;
	return /^[\x20-\x7e]*$/.test(name) ? `"${quoted(name)}" <${address.email}>` : `${encodeWord(name)} <${address.email}>`;
}

/** RFC 2047: a header value with anything beyond printable ASCII as one UTF-8 B-word. */
export function encodeWord(value: string): string {
	const clean = value.replace(/[\r\n]+/g, " ");
	if (/^[\x20-\x7e]*$/.test(clean)) return clean;
	return `=?UTF-8?B?${base64(new TextEncoder().encode(clean))}?=`;
}

function angle(id: string): string {
	const bare = id.trim().replace(/^<+|>+$/g, "");
	return `<${bare}>`;
}

function quoted(value: string): string {
	return value.replace(/[\r\n]+/g, " ").replace(/(["\\])/g, "\\$1");
}

function lowerKeys(headers: Record<string, string> | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(headers ?? {})) out[k.toLowerCase()] = v;
	return out;
}

function bytesOf(content: ArrayBuffer | ArrayBufferView): Uint8Array {
	return content instanceof ArrayBuffer ? new Uint8Array(content) : new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
}

function base64(bytes: Uint8Array): string {
	let bin = "";
	for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(bin);
}

function wrap(b64: string): string {
	return b64.replace(/.{1,76}/g, (line) => line + CRLF).replace(/\r\n$/, "");
}

function randomBoundary(): string {
	return `openmail-${crypto.randomUUID()}`;
}
