// Gmail under `everyapp dev`: with GOOGLE_WORKSPACE_ACCESS_TOKEN in
// .dev.vars, the SDK's dev twin puts the developer's token on calls to
// Google's hosts, for a person and in the background alike, and any method
// (drafts.update is a PUT, labels.patch a PATCH, drafts.delete and
// labels.delete DELETEs). Google itself is the fake Gmail (global fetch
// stubbed): no call leaves the machine.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import manifest from "../everyapp.config";
import { gmailClient, toBase64Url } from "../workers/everyapp/gmail/client";
import { fakeGmail, rfc822 } from "./fixtures/fake-gmail";

const ADDRESS = "dev@example.com";
const raw = (body: string) => toBase64Url(`From: ${ADDRESS}\r\nSubject: Re\r\n\r\n${body}`);

/** The env everyAppWorker() hands the dev Worker: EVERYAPP_DEV, the manifest's capabilities, the token. */
function devEnv() {
	return {
		EVERYAPP_DEV: "1",
		EVERYAPP_DEV_CAPABILITIES: JSON.stringify(manifest.capabilities),
		GOOGLE_WORKSPACE_ACCESS_TOKEN: "dev-token",
	};
}

let gmail: ReturnType<typeof fakeGmail>;
let tokens: (string | null)[];

beforeEach(() => {
	gmail = fakeGmail(ADDRESS);
	tokens = [];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		if (new URL(request.url).host !== "gmail.googleapis.com") throw new Error(`unexpected host: ${request.url}`);
		tokens.push(request.headers.get("authorization"));
		return gmail.fetch(request);
	});
});

afterEach(() => vi.unstubAllGlobals());

describe("Gmail under everyapp dev", () => {
	it("reads, drafts, updates and deletes a draft for a person, with the developer's token", async () => {
		gmail.add({ id: "m1", threadId: "t1", raw: rfc822({ to: ADDRESS }) });
		const client = gmailClient(devEnv(), new Request("http://openmail.localhost:8787/api/v1/mailboxes/x/gmail/sync"));
		expect((await client.profile()).emailAddress).toBe(ADDRESS);
		expect((await client.listMessages({ maxResults: 10 })).messages).toHaveLength(1);
		const draft = await client.createDraft(raw("v1"), "t1");
		await client.updateDraft(draft.id, raw("v2"), "t1");
		await client.deleteDraft(draft.id);
		expect(gmail.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			"GET /profile",
			"GET /messages",
			"POST /drafts",
			`PUT /drafts/${draft.id}`,
			`DELETE /drafts/${draft.id}`,
		]);
		expect(new Set(tokens)).toEqual(new Set(["Bearer dev-token"]));
	});

	it("creates, renames, recolors and deletes a label (labels.create, patch, delete), for a person and in the background", async () => {
		for (const target of [new Request("http://openmail.localhost:8787/"), { background: true as const, userId: "u-dev" }]) {
			gmail.calls.length = 0;
			const client = gmailClient(devEnv(), target);
			const label = await client.createLabel("Customers/VIP", { backgroundColor: "#4a86e8", textColor: "#ffffff" });
			await client.patchLabel(label.id, { name: "Clients", color: { backgroundColor: "#fb4c2f", textColor: "#ffffff" } });
			await client.deleteLabel(label.id);
			expect(gmail.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /labels", `PATCH /labels/${label.id}`, `DELETE /labels/${label.id}`]);
		}
	});
});
