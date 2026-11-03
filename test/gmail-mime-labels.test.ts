// The RFC 822 builder (drafts and sends through Gmail) and the label ↔
// folder mapping.
import PostalMime from "postal-mime";
import { describe, expect, it } from "vitest";
import { fromBase64Url } from "../workers/everyapp/gmail/client";
import { applyLabelChange, flagChange, folderOf, moveChange, stateOf, userLabelsOf } from "../workers/everyapp/gmail/labels";
import { buildMime, buildRaw, encodeWord, formatAddress } from "../workers/everyapp/gmail/mime";

describe("buildMime", () => {
	it("builds a threaded HTML reply Gmail can file in the thread", async () => {
		const raw = buildRaw({
			from: { email: "me@example.com", name: "Me" },
			to: "alice@example.org, bob@example.org",
			cc: ["carol@example.org"],
			subject: "Re: Order 1042",
			html: "<p>Ships Friday.</p>",
			inReplyTo: "q1042@example.org",
			references: ["first@example.org", "<q1042@example.org>"],
		});
		const text = new TextDecoder().decode(fromBase64Url(raw));
		expect(text).toContain('From: "Me" <me@example.com>\r\n');
		expect(text).toContain("To: alice@example.org, bob@example.org\r\n");
		expect(text).toContain("In-Reply-To: <q1042@example.org>\r\n");
		expect(text).toContain("References: <first@example.org> <q1042@example.org>\r\n");
		const parsed = await new PostalMime().parse(text);
		expect(parsed.subject).toBe("Re: Order 1042");
		expect(parsed.html).toBe("<p>Ships Friday.</p>");
		expect(parsed.to?.map((a) => a.address)).toEqual(["alice@example.org", "bob@example.org"]);
		expect(parsed.cc?.map((a) => a.address)).toEqual(["carol@example.org"]);
		expect(parsed.inReplyTo).toBe("<q1042@example.org>");
	});

	it("takes upstream's threading headers from a send, and References defaults to In-Reply-To", () => {
		const text = buildMime({ from: "me@example.com", to: "a@example.org", subject: "Re: x", text: "ok", headers: { "In-Reply-To": "<x@example.org>", "X-Extra": "1" } });
		expect(text).toContain("In-Reply-To: <x@example.org>\r\n");
		expect(text).toContain("References: <x@example.org>\r\n");
		expect(text).toContain("X-Extra: 1\r\n");
		expect(text.match(/In-Reply-To/g)).toHaveLength(1);
	});

	it("encodes non-ASCII headers and bodies, alternatives and attachments", async () => {
		const text = buildMime({
			from: { email: "me@example.com", name: "Zoë" },
			to: "a@example.org",
			subject: "Café ☕",
			text: "Grüße",
			html: "<p>Grüße</p>",
			attachments: [{ filename: "a.png", type: "image/png", content: btoa("hello"), contentId: "img1", disposition: "inline" }],
		});
		expect(text).toMatch(/^[\x00-\x7f]*$/);
		const parsed = await new PostalMime().parse(text);
		expect(parsed.subject).toBe("Café ☕");
		expect(parsed.from?.name).toBe("Zoë");
		expect(parsed.text?.trim()).toBe("Grüße");
		expect(parsed.html).toBe("<p>Grüße</p>");
		expect(parsed.attachments).toHaveLength(1);
		expect(parsed.attachments[0]).toMatchObject({ filename: "a.png", contentId: "<img1>", disposition: "inline" });
		expect(new TextDecoder().decode(parsed.attachments[0].content as ArrayBuffer)).toBe("hello");
	});

	it("keeps header injection out", () => {
		expect(encodeWord("a\r\nBcc: x@evil.example")).toBe("a Bcc: x@evil.example");
		expect(formatAddress({ email: "a@example.org", name: 'x"\r\ny' })).toBe('"x\\" y" <a@example.org>');
	});
});

describe("labels and folders", () => {
	it("derives the folder from the system labels", () => {
		expect(folderOf(["INBOX", "UNREAD"])).toBe("inbox");
		expect(folderOf(["SENT"])).toBe("sent");
		expect(folderOf(["INBOX", "SENT"])).toBe("inbox");
		expect(folderOf(["DRAFT"])).toBe("draft");
		expect(folderOf(["TRASH", "INBOX"])).toBe("trash");
		expect(folderOf(["SPAM"])).toBe("spam");
		expect(folderOf(["Label_1", "IMPORTANT", "CATEGORY_UPDATES"])).toBe("archive");
		expect(stateOf(["INBOX", "UNREAD", "STARRED"])).toEqual({ folder: "inbox", read: false, starred: true });
		expect(userLabelsOf(["INBOX", "Label_1", "CATEGORY_SOCIAL", "Label_2"])).toEqual(["Label_1", "Label_2"]);
	});

	it("maps moves and flags to Gmail changes", () => {
		expect(moveChange("inbox", "archive")).toEqual({ add: [], remove: ["INBOX", "SPAM"] });
		expect(moveChange("archive", "inbox")).toEqual({ add: ["INBOX"], remove: ["SPAM"] });
		expect(moveChange("inbox", "spam")).toEqual({ add: ["SPAM"], remove: ["INBOX"] });
		expect(moveChange("inbox", "trash")).toEqual({ trash: true, add: [], remove: [] });
		expect(moveChange("trash", "inbox")).toEqual({ untrash: true, add: ["INBOX"], remove: ["SPAM"] });
		expect(moveChange("inbox", "receipts")).toBeNull();
		expect(moveChange("inbox", "inbox")).toBeNull();
		expect(flagChange({ read: true })).toEqual({ add: [], remove: ["UNREAD"] });
		expect(flagChange({ read: false, starred: true })).toEqual({ add: ["UNREAD", "STARRED"], remove: [] });
		expect(applyLabelChange(["INBOX", "UNREAD"], ["STARRED", "INBOX"], ["UNREAD"])).toEqual(["INBOX", "STARRED"]);
	});
});
