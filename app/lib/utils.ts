// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared utility functions used across the frontend.
 *
 * Date formatting has been consolidated into `shared/dates.ts`.
 * Re-export for backwards compatibility with existing imports.
 */
import { useQuery } from "@tanstack/react-query";
import DOMPurify from "dompurify";
import { formatQuotedDate } from "shared/dates";
import api from "~/services/api";
import type { Attachment, Mailbox } from "~/types";

export {
	formatListDate,
	formatDetailDate,
	formatShortDate,
} from "shared/dates";

/** @deprecated Use `formatQuotedDate` from `shared/dates` directly. */
export const formatComposeDate = formatQuotedDate;

/**
 * Format a byte count as a human-readable file size.
 */
export function formatBytes(bytes: number, decimals = 1): string {
	if (bytes === 0) return "0 B";
	const k = 1024;
	const dm = decimals < 0 ? 0 : decimals;
	const sizes = ["B", "KB", "MB", "GB"];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return `${Number.parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

/**
 * Split a comma-separated email field into individual addresses.
 */
export function splitEmailList(value?: string | null): string[] {
	return (value || "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

/**
 * Convert a list of addresses into the API payload format.
 */
export function toEmailListValue(addresses: string[]): string | string[] | undefined {
	if (addresses.length === 0) return undefined;
	return addresses.length === 1 ? addresses[0] : addresses;
}

/**
 * Convert HTML content to plain text.
 * Uses DOM APIs so must only be called client-side.
 */
export function htmlToPlainText(html: string): string {
	// Sanitize with DOMPurify before DOM parsing to prevent XSS during innerHTML assignment.
	// DOMPurify strips all dangerous content (scripts, event handlers, etc.)
	// while preserving structural HTML for text extraction.
	const sanitized = DOMPurify.sanitize(html);
	const div = document.createElement("div");
	div.innerHTML = sanitized
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n\n")
		.replace(/<p[^>]*>/gi, "")
		.replace(/<div[^>]*>/gi, "")
		.replace(/<\/div>/gi, "\n");
	return (div.textContent || div.innerText || "").trim();
}

/**
 * Strip all HTML tags from a string.
 */
export function stripHtml(html: string): string {
	return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&#(\d+);/g, (_match: string, code: string) =>
			String.fromCharCode(Number(code)),
		)
		.replace(/&#x([0-9a-f]+);/gi, (_match: string, hex: string) =>
			String.fromCharCode(Number.parseInt(hex, 16)),
		)
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&nbsp;/g, " ");
}

export function getSnippetText(
	snippet?: string | null,
	maxLength = 100,
): string {
	if (!snippet) return "";

	const clean = decodeHtmlEntities(
		snippet
			.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
			.replace(/<style[^>]*>[\s\S]*/gi, "")
			.replace(/<[^>]*>/g, " ")
			.replace(/<[^>]*$/g, ""),
	)
		.replace(/\s+/g, " ")
		.trim();

	if (!clean) return "";
	return clean.length > maxLength ? `${clean.slice(0, maxLength)}...` : clean;
}

/**
 * Escape all five OWASP-recommended HTML special characters in plain text.
 * Safe for use in both text content and attribute contexts.
 */
export function escapeHtml(text: string): string {
	if (!text) return "";
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * Generate the HTML signature block for compose forms.
 */
export function getSignatureBlock(settings?: {
	signature?: { enabled: boolean; text?: string; html?: string };
}): string {
	const sig = settings?.signature;
	if (sig?.enabled && (sig?.html || sig?.text)) {
		// Sanitize HTML signatures with DOMPurify to allow safe formatting
		// (bold, italic, links, etc.) while stripping scripts and event handlers.
		// Text signatures are HTML-escaped since they have no formatting.
		const content = sig.html
			? DOMPurify.sanitize(sig.html)
			: escapeHtml(sig.text || "");
		return `<div style="border-top: 1px solid #ccc; margin-top: 16px; padding-top: 12px;">${content}</div>`;
	}
	return "";
}

/**
 * Build a quoted reply block HTML string from original email data.
 */
export function buildQuotedReplyBlock(
	dateStr: string | undefined,
	sender: string,
	body: string,
): string {
	if (!body) return "";
	const formattedDate = formatComposeDate(dateStr);
	
	// HTML-escape sender to prevent <john@example.com> from disappearing as a tag
	const escapedSender = escapeHtml(sender);

	// Sanitize the body to plain text to prevent stored XSS.
	// The original HTML renders safely in the sandboxed iframe, but quoted
	// reply blocks are injected into the compose editor where raw HTML would
	// execute. Convert to escaped plain text instead.
	const bodyToQuote = escapeHtml(stripHtml(body)).replace(/\n/g, "<br>");

	return `<br><blockquote style="border-left: 2px solid #ccc; margin: 0; padding-left: 1em; color: #666;">On ${formattedDate}, ${escapedSender} wrote:<br><br>${bodyToQuote}</blockquote>`;
}

/** Inline images larger than this stay out of the message body and are listed as attachments. */
export const INLINE_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

type InlineAttachment = Pick<Attachment, "id"> & {
	content_id?: string | null;
	disposition?: string | null;
	mimetype?: string | null;
	filename?: string | null;
	size?: number | null;
};

type FetchAttachment = (
	mailboxId: string,
	emailId: string,
	attachmentId: string,
) => Promise<Blob>;

const IMAGE_TYPE_BY_EXTENSION: Record<string, string> = {
	avif: "image/avif",
	bmp: "image/bmp",
	gif: "image/gif",
	ico: "image/x-icon",
	jpeg: "image/jpeg",
	jpg: "image/jpeg",
	png: "image/png",
	svg: "image/svg+xml",
	webp: "image/webp",
};

// The type goes into the HTML as part of a data: URL, and it comes from the
// sender: only a plain `type/subtype` gets through.
const SAFE_MIME_TYPE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;

function imageTypeOf(mimetype?: string | null, filename?: string | null): string | null {
	const type = (mimetype ?? "").split(";")[0].trim().toLowerCase();
	if (type.startsWith("image/")) return SAFE_MIME_TYPE.test(type) ? type : null;
	// Some mailers label inline images application/octet-stream.
	const extension = filename?.split(".").pop()?.toLowerCase();
	return (extension && IMAGE_TYPE_BY_EXTENSION[extension]) || null;
}

function contentIdOf(attachment: InlineAttachment): string | null {
	const raw = attachment.content_id?.trim();
	if (!raw) return null;
	// Strip angle brackets from content_id if present
	const cid = raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw;
	return cid || null;
}

/**
 * Whether an attachment is shown inside the message body: an inline image
 * with a Content-ID, within the size cap (an unknown size is checked once
 * fetched). Everything else is listed as an attachment.
 */
export function isInlineImage(attachment: InlineAttachment): boolean {
	if (attachment.disposition !== "inline" || !contentIdOf(attachment)) return false;
	if ((attachment.size ?? 0) > INLINE_IMAGE_MAX_BYTES) return false;
	// No type information at all: the fetched body's type decides.
	if (!attachment.mimetype && !attachment.filename) return true;
	return imageTypeOf(attachment.mimetype, attachment.filename) !== null;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The inline images a body refers to with `cid:`, longest Content-ID first. */
function referencedInlineImages(body: string, attachments?: InlineAttachment[]) {
	if (!body || !attachments?.length) return [];
	const lowerBody = body.toLowerCase();
	return attachments
		.filter(isInlineImage)
		.map((attachment) => ({ attachment, cid: contentIdOf(attachment) as string }))
		.filter(({ cid }) => lowerBody.includes(`cid:${cid.toLowerCase()}`))
		// `cid:img10` is rewritten before `cid:img1` can match its head.
		.sort((a, b) => b.cid.length - a.cid.length);
}

async function blobToDataUrl(blob: Blob, type: string): Promise<string> {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
	}
	return `data:${type};base64,${btoa(binary)}`;
}

/**
 * Rewrite `cid:` references in email HTML to `data:` URLs for inline images.
 *
 * The body renders in a sandboxed `srcdoc` iframe without
 * `allow-same-origin`: its requests come from an opaque origin and never
 * carry the gateway's session cookie, so an attachment URL inside it would
 * answer 401. The page fetches each inline image itself (same-origin, with
 * the session, through `api.getAttachment`) and inlines it; the iframe's CSP
 * already allows `img-src data:`. Images over `INLINE_IMAGE_MAX_BYTES`,
 * non-images and failed fetches keep their `cid:` reference (shown as a
 * broken image); oversized and non-image ones are listed as attachments.
 */
export async function rewriteInlineImages(
	body: string,
	mailboxId: string,
	emailId: string,
	attachments?: InlineAttachment[],
	fetchAttachment: FetchAttachment = api.getAttachment,
): Promise<string> {
	const images = mailboxId ? referencedInlineImages(body, attachments) : [];
	if (images.length === 0) return body;

	const resolved = await Promise.all(
		images.map(async ({ attachment, cid }) => {
			try {
				const blob = await fetchAttachment(mailboxId, emailId, attachment.id);
				if (!(blob instanceof Blob) || blob.size > INLINE_IMAGE_MAX_BYTES) return null;
				const type =
					imageTypeOf(attachment.mimetype, attachment.filename) ?? imageTypeOf(blob.type);
				if (!type) return null;
				return { cid, url: await blobToDataUrl(blob, type) };
			} catch {
				// One image failing to load never stops the message from rendering.
				return null;
			}
		}),
	);

	let result = body;
	for (const image of resolved) {
		if (!image) continue;
		result = result.replace(new RegExp(`cid:${escapeRegExp(image.cid)}`, "gi"), () => image.url);
	}
	return result;
}

/**
 * The message body with its inline images as `data:` URLs. Renders the body
 * as it is at first and swaps in the rewritten one once the images are in;
 * the result is cached per message, so collapsing and expanding a thread
 * message doesn't fetch them again.
 */
export function useInlineImages(
	body: string,
	mailboxId: string | undefined,
	emailId: string,
	attachments?: InlineAttachment[],
): string {
	const needsRewrite = Boolean(mailboxId) && referencedInlineImages(body, attachments).length > 0;
	const { data } = useQuery({
		queryKey: ["inline-images", mailboxId, emailId, body],
		queryFn: () => rewriteInlineImages(body, mailboxId as string, emailId, attachments),
		enabled: needsRewrite,
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
	return needsRewrite ? (data ?? body) : body;
}

/** The attachments listed under a message: everything not shown inside its body. */
export function getNonInlineAttachments(attachments?: Attachment[]): Attachment[] {
	return attachments?.filter((attachment) => !isInlineImage(attachment)) ?? [];
}

export function getAttachmentUrl(
	mailboxId: string,
	emailId: string,
	attachmentId: string,
): string {
	return `/api/v1/mailboxes/${mailboxId}/emails/${emailId}/attachments/${attachmentId}`;
}

export function downloadFile(url: string, filename: string) {
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	link.target = "_blank";
	link.rel = "noopener noreferrer";
	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);
}

/**
 * What a mailbox is called wherever the app names it: the sender name from
 * Settings, else the name it was created with, else the local part of its
 * address, as typed. Before the mailbox loads, the local part of its id.
 */
export function mailboxDisplayName(
	mailbox: Pick<Mailbox, "email" | "name" | "settings"> | undefined,
	mailboxId?: string,
): string {
	if (!mailbox) return mailboxId?.split("@")[0] || "Mailbox";
	if (mailbox.settings?.fromName) return mailbox.settings.fromName;
	if (mailbox.name && mailbox.name !== mailbox.email) return mailbox.name;
	return mailbox.email.split("@")[0] || mailbox.name;
}
