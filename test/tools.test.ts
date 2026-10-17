// The MCP tool catalog (workers/everyapp/tools.ts), read the way the
// gateway reads it: over the internal tools contract that everyApp() answers
// (`POST /__everyapp/tools/list` with a system token), then checked against
// the ToolBus's catalog limits. Also: the MCP panel's static copy of the
// names, the zod/v4 schemas as `{ jsonSchema, validate }`, the organization
// pin and mailbox check every call goes through, and the cap on model calls
// inside a tool. The calls themselves, against the real Durable Objects, are
// in tools.workers.test.ts.
import { generateKeyPairSync } from "node:crypto";
import {
	MCP_READ_SCOPE,
	MCP_WRITE_SCOPE,
	TOOL_NAME_PATTERN,
	mintIdentityJwt,
	mintSystemJwt,
	verifyIdentityJwt,
} from "@every-app/sdk/internal";
import { ToolError, everyApp, type EveryAppUser } from "@every-app/sdk/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { MCP_TOOLS } from "../app/components/MCPPanel";
import manifest from "../everyapp.config";
import {
	INSTRUCTIONS,
	TOOL_MODEL_MAX_TOKENS,
	estimatedTokens,
	plainSchema,
	requireToolMailbox,
	toolEnv,
	tools,
	withinCallBudget,
} from "../workers/everyapp/tools";

const AUDIENCE = "every-acme-agentic-inbox";
const ISSUER = "https://apps.example.com";
let privateKeyPem: string;
let publicKeyPem: string;

beforeAll(() => {
	const keys = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicKeyEncoding: { type: "spki", format: "pem" },
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
	});
	privateKeyPem = keys.privateKey;
	publicKeyPem = keys.publicKey;
});

// The ToolBus's limits (packages/toolbus/src/catalog.ts CATALOG_LIMITS and
// names.ts MAX_TOOL_NAME_LENGTH); instructions are held to the plan's 1,024.
const LIMITS = { schemaBytes: 20 * 1024, descriptionChars: 2048, titleChars: 100, instructionsChars: 1024, namespacedName: 64 };

const READ = ["get_email", "get_thread", "list_emails", "list_mailboxes", "search_emails"];
const WRITE = ["create_draft", "draft_reply", "mark_email_read", "move_email", "send_email", "send_reply", "update_draft"];

interface Descriptor {
	name: string;
	title?: string;
	description: string;
	risk: string;
	inputSchema: Record<string, unknown>;
	annotations?: Record<string, boolean>;
}
interface Catalog {
	v: number;
	hash: string;
	instructions?: string;
	tools: Descriptor[];
	warnings?: string[];
}

/** The catalog as the gateway snapshots it. */
async function listCatalog(): Promise<Catalog> {
	const worker = everyApp(() => new Response("not found", { status: 404 }), { tools });
	const token = await mintSystemJwt(privateKeyPem, { audience: AUDIENCE, issuer: ISSUER, purpose: "tools.list" });
	const response = await worker.fetch(
		new Request("https://agentic-inbox.acme.example/__everyapp/tools/list", {
			method: "POST",
			headers: { "content-type": "application/json", "x-everyapp-system": token },
			body: JSON.stringify({ v: 1 }),
		}),
		{
			EVERYAPP_APP_ID: manifest.id,
			EVERYAPP_AUDIENCE: AUDIENCE,
			EVERYAPP_IDENTITY_ISSUER: ISSUER,
			EVERYAPP_IDENTITY_PUBLIC_KEYS: JSON.stringify([publicKeyPem]),
		},
		{ waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
	);
	expect(response.status).toBe(200);
	return (await response.json()) as Catalog;
}

describe("the catalog the gateway snapshots", () => {
	it("has upstream's thirteen tools, within the ToolBus's limits", async () => {
		const catalog = await listCatalog();
		expect(catalog.warnings).toBeUndefined();
		expect(catalog.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(catalog.tools.map((t) => t.name).sort()).toEqual([...READ, ...WRITE, "delete_email"].sort());
		expect(catalog.instructions).toBe(INSTRUCTIONS);
		expect(INSTRUCTIONS.length).toBeLessThanOrEqual(LIMITS.instructionsChars);
		for (const tool of catalog.tools) {
			expect(tool.name).toMatch(TOOL_NAME_PATTERN);
			expect(`${manifest.id}_${tool.name}`.length).toBeLessThanOrEqual(LIMITS.namespacedName);
			expect(tool.description.trim().length).toBeGreaterThan(0);
			expect(tool.description.length).toBeLessThanOrEqual(LIMITS.descriptionChars);
			expect(tool.title?.length ?? 0).toBeLessThanOrEqual(LIMITS.titleChars);
			expect(tool.inputSchema.type).toBe("object");
			expect(tool.inputSchema.$schema).toBeUndefined();
			expect(new TextEncoder().encode(JSON.stringify(tool.inputSchema)).byteLength).toBeLessThan(LIMITS.schemaBytes);
		}
	});

	it("reads are read, drafts, moves and sends are write, delete_email is destructive", async () => {
		const risks = Object.fromEntries((await listCatalog()).tools.map((t) => [t.name, t.risk]));
		for (const name of READ) expect(risks[name], name).toBe("read");
		for (const name of WRITE) expect(risks[name], name).toBe("write");
		expect(risks.delete_email).toBe("destructive");
	});

	it("the send tools reach outside the app; marking and moving can be repeated", async () => {
		const byName = Object.fromEntries((await listCatalog()).tools.map((t) => [t.name, t]));
		expect(byName.send_email!.annotations).toEqual({ openWorldHint: true });
		expect(byName.send_reply!.annotations).toEqual({ openWorldHint: true });
		expect(byName.mark_email_read!.annotations).toEqual({ idempotentHint: true });
		expect(byName.move_email!.annotations).toEqual({ idempotentHint: true });
	});

	it("describes what a client sends: defaulted arguments are optional, mailboxId is required", async () => {
		const byName = Object.fromEntries((await listCatalog()).tools.map((t) => [t.name, t.inputSchema]));
		expect(byName.list_emails).toMatchObject({
			type: "object",
			required: ["mailboxId"],
			properties: {
				folder: { type: "string", default: "inbox" },
				limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
				page: { type: "integer", minimum: 1, default: 1 },
			},
		});
		expect(byName.list_mailboxes).toMatchObject({ type: "object", properties: {} });
		expect(byName.send_email).toMatchObject({
			required: ["mailboxId", "to", "subject", "bodyHtml"],
			properties: { to: { type: "string", format: "email" } },
		});
		for (const [name, schema] of Object.entries(byName)) {
			if (name !== "list_mailboxes") expect((schema.required as string[]) ?? [], name).toContain("mailboxId");
		}
	});

	it("the MCP panel lists every tool an AI client can see, in step with the catalog", async () => {
		const visible = (await listCatalog()).tools.filter((t) => t.risk !== "destructive").map((t) => t.name);
		expect(visible).toHaveLength(12);
		expect(MCP_TOOLS.map((t) => t.name).sort()).toEqual(visible.sort());
	});
});

describe("plainSchema(): a zod/v4 schema as { jsonSchema, validate }", () => {
	const schema = plainSchema(
		z.object({ mailboxId: z.string().min(1), limit: z.number().int().max(100).default(20) }),
	);

	it("validates and fills defaults the way zod does", async () => {
		expect(await schema.validate({ mailboxId: "a@example.com" })).toEqual({ value: { mailboxId: "a@example.com", limit: 20 } });
	});

	it("reports issues with their paths, for the SDK's invalid_arguments answer", async () => {
		const result = await schema.validate({ mailboxId: "", limit: 500 });
		expect("issues" in result && result.issues?.map((i) => i.path)).toEqual([["mailboxId"], ["limit"]]);
	});

	it("zod 3.25's Standard Schema has no JSON Schema converter, which is why the pair is needed", () => {
		const standard = z.object({})["~standard"] as unknown as Record<string, unknown>;
		expect(standard.jsonSchema).toBeUndefined();
	});
});

describe("model calls inside a tool call", () => {
	function recordingAi() {
		const calls: { model: string; inputs: Record<string, unknown> }[] = [];
		const ai = {
			async run(model: string, inputs: Record<string, unknown>) {
				calls.push({ model, inputs });
				return { response: "checked" };
			},
		} as unknown as Ai;
		return { ai, calls };
	}

	it("ask for at most TOOL_MODEL_MAX_TOKENS tokens (the draft verifier asks for 4,096)", async () => {
		const { ai, calls } = recordingAi();
		const messages = [
			{ role: "system", content: "You are a proofreader." },
			{ role: "user", content: "Thanks for the order, it ships on Tuesday." },
		];
		const answer = await withinCallBudget(ai).run("@cf/meta/llama-4-scout-17b-16e-instruct" as never, { messages, max_tokens: 4096, temperature: 0 } as never);
		expect(answer).toEqual({ response: "checked" });
		expect(calls).toEqual([
			{ model: "@cf/meta/llama-4-scout-17b-16e-instruct", inputs: { messages, max_tokens: TOOL_MODEL_MAX_TOKENS, temperature: 0 } },
		]);
		expect(TOOL_MODEL_MAX_TOKENS).toBe(1024);
	});

	it("skip a text too long to come back whole under the cap: lib/ai.ts then keeps the draft as written", async () => {
		const { ai, calls } = recordingAi();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const long = "This sentence is part of a long reply. ".repeat(100);
		const answer = await withinCallBudget(ai).run("m" as never, { messages: [{ role: "user", content: long }], max_tokens: 4096 } as never);
		expect(answer).toEqual({ response: "" });
		expect(calls).toEqual([]);
	});

	it("estimate tokens on the high side for any script", () => {
		expect(estimatedTokens("abc")).toBe(1);
		expect(estimatedTokens("a".repeat(2700))).toBe(900);
		expect(estimatedTokens("日本語")).toBe(6);
		expect(estimatedTokens("😀")).toBe(2);
	});
});

describe("what every call goes through", () => {
	async function mcpUser(orgId: string): Promise<EveryAppUser> {
		const token = await mintIdentityJwt(privateKeyPem, {
			subject: { sub: "user_1", email: "member@acme.example", orgId, orgRole: "member" },
			audience: AUDIENCE,
			issuer: ISSUER,
			channel: "mcp",
			scopes: [MCP_READ_SCOPE, MCP_WRITE_SCOPE],
			toolCall: { id: "call_1", name: "list_mailboxes" },
		});
		return verifyIdentityJwt(token, { audience: AUDIENCE, issuer: ISSUER, publicKeys: [publicKeyPem] } as never);
	}

	function bucket(keys: string[]) {
		return { head: async (key: string) => (keys.includes(key) ? { key } : null) } as unknown as R2Bucket;
	}

	it("the organization pin: another organization's caller is refused on an organization's own copy", async () => {
		const user = await mcpUser("org_other");
		const env = { EVERY_APP_ORG_ID: "org_acme", AI_PROVIDER: "workers-ai" } as unknown as Cloudflare.Env;
		const request = new Request("https://agentic-inbox.acme.example/__everyapp/tools/call");
		await expect(toolEnv({ user, env, request })).rejects.toThrow(
			new ToolError("Not allowed: this app belongs to another organization."),
		);
	});

	it("the caller's own organization gets AI and EMAIL brokered by the gateway", async () => {
		const user = await mcpUser("org_acme");
		const env = { EVERY_APP_ORG_ID: "org_acme", AI_PROVIDER: "workers-ai" } as unknown as Cloudflare.Env;
		const request = new Request("https://agentic-inbox.acme.example/__everyapp/tools/call");
		const brokered = await toolEnv({ user, env, request });
		expect(typeof brokered.AI.run).toBe("function");
		expect(typeof brokered.EMAIL.send).toBe("function");
	});

	it("a mailbox must exist, as the REST routes require; ids are matched lowercase", async () => {
		const env = { BUCKET: bucket(["mailboxes/team@example.com.json"]) };
		expect(await requireToolMailbox(env, " Team@Example.com ")).toBe("team@example.com");
		await expect(requireToolMailbox(env, "nobody@example.com")).rejects.toThrow(
			new ToolError('Mailbox "nobody@example.com" not found. Call list_mailboxes for the mailboxes you can use.'),
		);
		await expect(requireToolMailbox(env, "  ")).rejects.toBeInstanceOf(ToolError);
	});
});
