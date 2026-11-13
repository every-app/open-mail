// What a conversation shows: the sender's display name from the stored From
// header, and a quoted reply that reads as text (entities decoded once).
import { describe, expect, it } from "vitest";
import { senderPerson } from "../app/components/conversation/people";
import { buildQuotedReplyBlock } from "../app/lib/utils";

const headers = (from: string) => JSON.stringify([{ key: "from", value: from }, { key: "to", value: "box@example.org" }]);

describe("senderPerson", () => {
	it("takes the display name from the From header when sender is a bare address", () => {
		expect(senderPerson({ sender: "tom@filtercoffee.example", raw_headers: headers("Tom Becker <tom@filtercoffee.example>") })).toEqual({
			name: "Tom Becker",
			address: "tom@filtercoffee.example",
			hasName: true,
		});
	});

	it("keeps the bare address when the header names someone else, has no name, or is missing", () => {
		const bare = { name: "tom@filtercoffee.example", address: "tom@filtercoffee.example", hasName: false };
		expect(senderPerson({ sender: "tom@filtercoffee.example", raw_headers: headers("Mallory <mallory@example.net>") })).toEqual(bare);
		expect(senderPerson({ sender: "tom@filtercoffee.example", raw_headers: headers("tom@filtercoffee.example") })).toEqual(bare);
		expect(senderPerson({ sender: "tom@filtercoffee.example", raw_headers: null })).toEqual(bare);
		expect(senderPerson({ sender: "tom@filtercoffee.example", raw_headers: "not json" })).toEqual(bare);
	});

	it("leaves a sender that already carries a name alone", () => {
		expect(senderPerson({ sender: "Priya Raman <priya@example.org>" }).name).toBe("Priya Raman");
	});
});

describe("buildQuotedReplyBlock", () => {
	it("decodes entities before escaping, so an apostrophe isn't shown as &#39;", () => {
		const block = buildQuotedReplyBlock("2026-10-31T03:11:00Z", "a@example.org", "<p>Filter Coffee Review&#39;s guides &amp; more</p>");
		expect(block).toContain("Filter Coffee Review&#39;s guides &amp; more");
		expect(block).not.toContain("&amp;#39;");
	});

	it("keeps paragraph breaks and still escapes markup", () => {
		const block = buildQuotedReplyBlock(undefined, "a@example.org", "<p>One</p><p>Two &lt;script&gt;</p>");
		expect(block).toContain("One<br><br>Two &lt;script&gt;");
		expect(block).not.toContain("<script>");
	});
});
