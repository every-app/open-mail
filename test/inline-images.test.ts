// Inline images reach the sandboxed message iframe as data: URLs: the page
// fetches them with its session, since the iframe's own requests carry none.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getNonInlineAttachments,
	INLINE_IMAGE_MAX_BYTES,
	isInlineImage,
	rewriteInlineImages,
} from "../app/lib/utils";
import type { Attachment } from "../app/types";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const PNG_DATA_URL = `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`;

function attachment(overrides: Partial<Attachment> = {}): Attachment {
	return {
		id: "att-1",
		filename: "logo.png",
		mimetype: "image/png",
		size: PNG.byteLength,
		content_id: "<logo@example.com>",
		disposition: "inline",
		...overrides,
	};
}

/** A stand-in for api.getAttachment that records its calls. */
function fetcher(blobs: Record<string, Blob | Error>) {
	const calls: string[] = [];
	const fetchAttachment = async (mailboxId: string, emailId: string, attachmentId: string) => {
		calls.push(`${mailboxId}/${emailId}/${attachmentId}`);
		const blob = blobs[attachmentId];
		if (!blob) throw new Error(`no attachment ${attachmentId}`);
		if (blob instanceof Error) throw blob;
		return blob;
	};
	return { calls, fetchAttachment };
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("rewriteInlineImages", () => {
	it("turns a cid: reference to an inline image into a data: URL fetched by the page", async () => {
		const { calls, fetchAttachment } = fetcher({ "att-1": new Blob([PNG], { type: "image/png" }) });
		const body = '<p>Hi</p><img src="cid:logo@example.com" alt="logo">';

		const result = await rewriteInlineImages(body, "dev@example.com", "email-1", [attachment()], fetchAttachment);

		expect(result).toBe(`<p>Hi</p><img src="${PNG_DATA_URL}" alt="logo">`);
		expect(result).not.toContain("cid:");
		expect(result).not.toContain("/api/v1/");
		expect(calls).toEqual(["dev@example.com/email-1/att-1"]);
	});

	it("leaves a non-inline attachment's cid: untouched and never fetches it", async () => {
		const { calls, fetchAttachment } = fetcher({ "att-1": new Blob([PNG], { type: "image/png" }) });
		const body = '<img src="cid:logo@example.com">';

		const result = await rewriteInlineImages(
			body,
			"dev@example.com",
			"email-1",
			[attachment({ disposition: "attachment" })],
			fetchAttachment,
		);

		expect(result).toBe(body);
		expect(calls).toEqual([]);
	});

	it("matches Content-IDs with or without angle brackets, case-insensitively", async () => {
		const { fetchAttachment } = fetcher({
			a: new Blob([PNG], { type: "image/png" }),
			b: new Blob([PNG], { type: "image/png" }),
		});
		const body = '<img src="CID:Logo@Example.com"><img src="cid:banner">';

		const result = await rewriteInlineImages(
			body,
			"m",
			"e",
			[attachment({ id: "a" }), attachment({ id: "b", content_id: "banner" })],
			fetchAttachment,
		);

		expect(result).toBe(`<img src="${PNG_DATA_URL}"><img src="${PNG_DATA_URL}">`);
	});

	it("rewrites cid:img10 as itself, not as cid:img1 followed by a 0", async () => {
		const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
		const { fetchAttachment } = fetcher({
			one: new Blob([PNG], { type: "image/png" }),
			ten: new Blob([gif], { type: "image/gif" }),
		});
		const body = '<img src="cid:img1"><img src="cid:img10">';

		const result = await rewriteInlineImages(
			body,
			"m",
			"e",
			[
				attachment({ id: "one", content_id: "img1" }),
				attachment({ id: "ten", content_id: "img10", mimetype: "image/gif", filename: "a.gif" }),
			],
			fetchAttachment,
		);

		expect(result).toBe(
			`<img src="${PNG_DATA_URL}"><img src="data:image/gif;base64,${Buffer.from(gif).toString("base64")}">`,
		);
	});

	it("skips images over the 2 MiB cap, by declared size without fetching and by fetched size", async () => {
		const big = new Uint8Array(INLINE_IMAGE_MAX_BYTES + 1);
		const { calls, fetchAttachment } = fetcher({
			declared: new Blob([PNG], { type: "image/png" }),
			actual: new Blob([big], { type: "image/png" }),
		});
		const body = '<img src="cid:declared"><img src="cid:actual">';

		const result = await rewriteInlineImages(
			body,
			"m",
			"e",
			[
				attachment({ id: "declared", content_id: "declared", size: INLINE_IMAGE_MAX_BYTES + 1 }),
				attachment({ id: "actual", content_id: "actual", size: 0 }),
			],
			fetchAttachment,
		);

		expect(result).toBe(body);
		expect(calls).toEqual(["m/e/actual"]);
	});

	it("keeps the cid: of an image that fails to load and still inlines the others", async () => {
		const { fetchAttachment } = fetcher({
			ok: new Blob([PNG], { type: "image/png" }),
			broken: new Error("502"),
		});
		const body = '<img src="cid:ok"><img src="cid:broken">';

		const result = await rewriteInlineImages(
			body,
			"m",
			"e",
			[attachment({ id: "ok", content_id: "ok" }), attachment({ id: "broken", content_id: "broken" })],
			fetchAttachment,
		);

		expect(result).toBe(`<img src="${PNG_DATA_URL}"><img src="cid:broken">`);
	});

	it("labels an octet-stream image by its file extension and refuses a type that could break out of the attribute", async () => {
		const { calls, fetchAttachment } = fetcher({
			octet: new Blob([PNG], { type: "application/octet-stream" }),
			evil: new Blob([PNG], { type: "image/png" }),
		});
		const body = '<img src="cid:octet"><img src="cid:evil">';
		const evil = attachment({ id: "evil", content_id: "evil", mimetype: 'image/png" onerror="alert(1)' });

		const result = await rewriteInlineImages(
			body,
			"m",
			"e",
			[attachment({ id: "octet", content_id: "octet", mimetype: "application/octet-stream" }), evil],
			fetchAttachment,
		);

		expect(result).toBe(`<img src="${PNG_DATA_URL}"><img src="cid:evil">`);
		expect(calls).toEqual(["m/e/octet"]);
		expect(isInlineImage(evil)).toBe(false);
	});

	it("fetches nothing when the body refers to no inline image or there is no mailbox", async () => {
		const { calls, fetchAttachment } = fetcher({ "att-1": new Blob([PNG], { type: "image/png" }) });

		expect(await rewriteInlineImages("<p>no images</p>", "m", "e", [attachment()], fetchAttachment)).toBe(
			"<p>no images</p>",
		);
		expect(
			await rewriteInlineImages('<img src="cid:logo@example.com">', "", "e", [attachment()], fetchAttachment),
		).toBe('<img src="cid:logo@example.com">');
		expect(await rewriteInlineImages("", "m", "e", [attachment()], fetchAttachment)).toBe("");
		expect(calls).toEqual([]);
	});

	it("by default fetches through api.getAttachment: a same-origin request to the attachment route (default credentials carry the session)", async () => {
		const requests: { url: string; credentials: RequestCredentials | undefined }[] = [];
		vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
			requests.push({ url, credentials: init?.credentials });
			return new Response(PNG, { headers: { "content-type": "image/png" } });
		});

		const result = await rewriteInlineImages(
			'<img src="cid:logo@example.com">',
			"dev@example.com",
			"email-1",
			[attachment()],
		);

		expect(result).toBe(`<img src="${PNG_DATA_URL}">`);
		expect(requests).toEqual([
			{ url: "/api/v1/mailboxes/dev@example.com/emails/email-1/attachments/att-1", credentials: undefined },
		]);
	});
});

describe("getNonInlineAttachments", () => {
	it("lists everything the body doesn't show: regular attachments, oversized and non-image inline parts", () => {
		const shown = attachment({ id: "shown" });
		const regular = attachment({ id: "regular", disposition: "attachment" });
		const oversized = attachment({ id: "oversized", size: INLINE_IMAGE_MAX_BYTES + 1 });
		const inlinePdf = attachment({ id: "pdf", mimetype: "application/pdf", filename: "terms.pdf" });

		expect(getNonInlineAttachments([shown, regular, oversized, inlinePdf]).map((a) => a.id)).toEqual([
			"regular",
			"oversized",
			"pdf",
		]);
		expect(getNonInlineAttachments(undefined)).toEqual([]);
	});
});
