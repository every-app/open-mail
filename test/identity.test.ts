// The auth seam (workers/everyapp/identity.ts) through the Worker's own entry
// (workers/app.ts): identities minted the way the gateway mints them, the
// real upstream API (workers/index.ts) over a fake R2 bucket and fake Durable
// Object namespaces, and the chat agent's socket lifetime.
//
// Node can't load `cloudflare:workers`, so the modules that need it are
// stood in for: the Agents SDK's router (a stand-in that routes exactly as
// partyserver 0.3.3 does, below), the chat agent's base class, the MCP
// server and the mailbox Durable Object. The real router is exercised by
// `everyapp dev` (scripts/dev-probe.sh).
import { generateKeyPairSync } from "node:crypto";
import { mintIdentityJwt } from "@every-app/sdk/internal";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("agents", () => {
	// partyserver 0.3.3 routePartykitRequest (partyserver/dist/index.js:276-347),
	// the parts the guards see: /agents/<kebab-case binding>/<name>[/...],
	// `lobby.className` is the env key, onBeforeConnect for an upgrade and
	// onBeforeRequest otherwise, a Response from either is the answer.
	const kebab = (key: string) =>
		key === key.toUpperCase() ? key.toLowerCase().replace(/_/g, "-") : key.replace(/[A-Z]/g, (l) => `-${l.toLowerCase()}`).replace(/^-/, "");
	type Lobby = { className: string; name: string };
	type Hook = (req: Request, lobby: Lobby) => Promise<Request | Response | undefined | void> | Request | Response | undefined | void;
	return {
		async routeAgentRequest(
			req: Request,
			env: Record<string, unknown>,
			options: { onBeforeConnect?: Hook; onBeforeRequest?: Hook },
		) {
			const parts = new URL(req.url).pathname.split("/").filter(Boolean);
			if (parts[0] !== "agents" || parts.length < 3) return null;
			const key = Object.keys(env).find((k) => {
				const v = env[k] as { idFromName?: unknown } | undefined;
				return !!v && typeof v === "object" && typeof v.idFromName === "function" && kebab(k) === parts[1];
			});
			if (!key) return new Response("Invalid request", { status: 400 });
			const lobby = { className: key, name: parts[2]! };
			const upgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";
			const verdict = await (upgrade ? options.onBeforeConnect : options.onBeforeRequest)?.(req, lobby);
			if (verdict instanceof Response) return verdict;
			const ns = env[key] as { idFromName(n: string): unknown; get(id: unknown): { fetch(r: Request): Promise<Response> } };
			return ns.get(ns.idFromName(lobby.name)).fetch(verdict instanceof Request ? verdict : req);
		},
	};
});

vi.mock("@cloudflare/ai-chat", () => {
	// The parts of the Agents SDK's Agent the socket lifetime uses, in memory.
	class AIChatAgent {
		schedules: { id: string; time: number; callback: string; payload: unknown }[] = [];
		scheduled = 0;
		connections = new Map<string, { close(code?: number, reason?: string): void }>();
		name = "dev@example.com";
		env: unknown = {};
		messages: unknown[] = [];
		async onConnect(_connection: unknown, _ctx: unknown) {}
		async schedule(when: number, callback: string, payload: unknown) {
			const schedule = { id: `s${++this.scheduled}`, time: when, callback, payload };
			this.schedules.push(schedule);
			return schedule;
		}
		getSchedules() {
			return [...this.schedules];
		}
		async cancelSchedule(id: string) {
			const before = this.schedules.length;
			this.schedules = this.schedules.filter((s) => s.id !== id);
			return this.schedules.length < before;
		}
		getConnection(id: string) {
			return this.connections.get(id);
		}
	}
	return { AIChatAgent };
});

vi.mock("../workers/mcp", () => ({
	EmailMCP: { serve: () => ({ fetch: async () => new Response("mcp") }) },
}));
vi.mock("../workers/durableObject", () => ({ MailboxDO: class {} }));

import worker from "../workers/app";
import { EmailAgent } from "../workers/agent";
import {
	gatewayUrlOf,
	requireOrganization,
	roleOf,
	SOCKET_LIFETIME_CLOSE,
	SOCKET_LIFETIME_SECONDS,
} from "../workers/everyapp/identity";

// The organization's own copy of the app, as `everyapp deploy` configures it.
const AUDIENCE = "every-acme-agentic-inbox";
const ISSUER = "https://apps.example.com";
const ORG = "org_acme";
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

const FOLDERS = ["inbox", "sent", "draft", "archive", "trash", "spam"].map((id) => ({ id, name: id }));

function fakeBucket() {
	const objects = new Map<string, string>();
	return {
		objects,
		async head(key: string) {
			return objects.has(key) ? { key } : null;
		},
		async get(key: string) {
			const value = objects.get(key);
			return value === undefined ? null : { key, json: async () => JSON.parse(value), text: async () => value };
		},
		async put(key: string, value: string) {
			objects.set(key, String(value));
			return { key };
		},
		async delete(key: string) {
			objects.delete(key);
		},
		async list({ prefix = "" }: { prefix?: string } = {}) {
			return { objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false };
		},
	};
}

function fakeNamespace(stub: (name: string) => object) {
	return {
		idFromName: (name: string) => ({ name }),
		get: (id: { name: string }) => stub(id.name),
	};
}

function makeEnv(extra: Record<string, unknown> = {}) {
	const bucket = fakeBucket();
	const agentCalls: string[] = [];
	const env = {
		EVERYAPP_APP_ID: "agentic-inbox",
		EVERYAPP_AUDIENCE: AUDIENCE,
		EVERYAPP_IDENTITY_ISSUER: ISSUER,
		EVERYAPP_IDENTITY_PUBLIC_KEYS: JSON.stringify([publicKeyPem]),
		EVERY_APP_ORG_ID: ORG,
		GATEWAY_URL: `${ISSUER}/`,
		DOMAINS: "example.com",
		EMAIL_ADDRESSES: [],
		AI_PROVIDER: "workers-ai",
		AGENT_MODEL: "",
		BUCKET: bucket,
		MAILBOX: fakeNamespace(() => ({ getFolders: async () => FOLDERS })),
		EMAIL_AGENT: fakeNamespace((name) => ({
			async fetch(request: Request) {
				agentCalls.push(`${name} ${new URL(request.url).pathname}`);
				return Response.json({ agent: name });
			},
		})),
		EMAIL_MCP: fakeNamespace(() => ({ fetch: async () => new Response("mcp") })),
		...extra,
	};
	return { env, bucket, agentCalls };
}

const ctx = { waitUntil() {}, passThroughOnException() {} };

async function identity(orgRole: string, orgId = ORG) {
	return mintIdentityJwt(privateKeyPem, {
		subject: { sub: `user_${orgRole}`, email: `${orgRole}@acme.example`, orgId, orgRole },
		audience: AUDIENCE,
		issuer: ISSUER,
		channel: "web",
	});
}

type Sent = { status: number; body: unknown };

async function send(
	env: object,
	method: string,
	path: string,
	options: { as?: string; orgId?: string; token?: string | null; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Sent> {
	const headers = new Headers(options.headers);
	const token = options.token === undefined ? await identity(options.as ?? "owner", options.orgId) : options.token;
	if (token) headers.set("x-everyapp-identity", token);
	if (options.body !== undefined) headers.set("content-type", "application/json");
	const response = await worker.fetch(
		new Request(`https://agentic-inbox.acme.example${path}`, {
			method,
			headers,
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
		}),
		env as never,
		ctx,
	);
	const text = await response.text();
	let body: unknown = text;
	try {
		body = JSON.parse(text);
	} catch {
		// Not JSON.
	}
	return { status: response.status, body };
}

async function seedMailbox(bucket: ReturnType<typeof fakeBucket>, email: string) {
	await bucket.put(`mailboxes/${email}.json`, JSON.stringify({ fromName: "Team" }));
}

describe("the organization pin", () => {
	it("refuses an identity from another organization on the organization's own copy", async () => {
		const { env } = makeEnv();
		const res = await send(env, "GET", "/api/v1/mailboxes", { orgId: "org_other" });
		expect(res).toEqual({
			status: 401,
			body: { error: "unauthenticated", message: "this app belongs to another organization" },
		});
	});

	it("lets any organization's member in when the copy isn't pinned (the shared shape)", async () => {
		const { env } = makeEnv({ EVERY_APP_ORG_ID: undefined });
		expect((await send(env, "GET", "/api/v1/mailboxes", { orgId: "org_other", as: "member" })).status).toBe(200);
	});

	it("refuses a request the gateway didn't sign", async () => {
		const { env } = makeEnv();
		expect((await send(env, "GET", "/api/v1/mailboxes", { token: null })).status).toBe(401);
		expect((await send(env, "GET", "/api/v1/mailboxes", { token: "forged" })).status).toBe(401);
	});

	it("requireOrganization refuses no person and no organization", () => {
		expect(requireOrganization({ EVERY_APP_ORG_ID: ORG }, null)?.status).toBe(401);
		const user = { id: "u", email: "u@x", orgId: "", orgRole: "owner" } as never;
		expect(requireOrganization({}, user)?.status).toBe(401);
		const member = { id: "u", email: "u@x", orgId: ORG, orgRole: "member" } as never;
		expect(requireOrganization({ EVERY_APP_ORG_ID: ORG }, member)).toBeNull();
	});
});

describe("roles", () => {
	it("owners and admins are themselves; every other role is a member", () => {
		expect(roleOf({ orgRole: "owner" })).toBe("owner");
		expect(roleOf({ orgRole: "admin" })).toBe("admin");
		expect(roleOf({ orgRole: "member" })).toBe("member");
		expect(roleOf({ orgRole: "guest" })).toBe("member");
		expect(roleOf({ orgRole: "" })).toBe("member");
	});

	it("a member can't create a mailbox; an owner and an admin can", async () => {
		const { env, bucket } = makeEnv();
		const forbidden = await send(env, "POST", "/api/v1/mailboxes", {
			as: "member",
			body: { name: "Team", email: "team@example.com" },
		});
		expect(forbidden.status).toBe(403);
		expect(forbidden.body).toMatchObject({ error: "forbidden", code: "admin_required" });
		expect(bucket.objects.has("mailboxes/team@example.com.json")).toBe(false);

		const created = await send(env, "POST", "/api/v1/mailboxes", {
			as: "owner",
			body: { name: "Team", email: "team@example.com" },
		});
		expect(created.status).toBe(201);
		expect(created.body).toMatchObject({ id: "team@example.com", email: "team@example.com", name: "Team" });
		expect(bucket.objects.has("mailboxes/team@example.com.json")).toBe(true);

		const byAdmin = await send(env, "POST", "/api/v1/mailboxes", {
			as: "admin",
			body: { name: "Sales", email: "sales@example.com" },
		});
		expect(byAdmin.status).toBe(201);
	});

	it("a member can't edit a mailbox's settings (the agent prompt among them) or delete it; an owner can", async () => {
		const { env, bucket } = makeEnv();
		await seedMailbox(bucket, "team@example.com");
		const settings = { settings: { fromName: "Team", agentSystemPrompt: "Be terse." } };

		for (const [method, body] of [
			["PUT", settings],
			["DELETE", undefined],
		] as const) {
			const res = await send(env, method, "/api/v1/mailboxes/team@example.com", { as: "member", body });
			expect(res.status).toBe(403);
			expect(res.body).toMatchObject({ error: "forbidden", code: "admin_required" });
		}
		expect(JSON.parse(bucket.objects.get("mailboxes/team@example.com.json")!)).toEqual({ fromName: "Team" });

		expect((await send(env, "PUT", "/api/v1/mailboxes/team@example.com", { as: "owner", body: settings })).status).toBe(200);
		expect(JSON.parse(bucket.objects.get("mailboxes/team@example.com.json")!)).toEqual(settings.settings);
		expect((await send(env, "DELETE", "/api/v1/mailboxes/team@example.com", { as: "admin" })).status).toBe(204);
		expect(bucket.objects.has("mailboxes/team@example.com.json")).toBe(false);
	});

	it("a member uses the organization's mailboxes", async () => {
		const { env, bucket } = makeEnv();
		await seedMailbox(bucket, "team@example.com");
		const list = await send(env, "GET", "/api/v1/mailboxes", { as: "member" });
		expect(list).toEqual({ status: 200, body: [{ id: "team@example.com", email: "team@example.com", name: "team@example.com" }] });
		const one = await send(env, "GET", "/api/v1/mailboxes/team@example.com", { as: "member" });
		expect(one.status).toBe(200);
		const folders = await send(env, "GET", "/api/v1/mailboxes/team@example.com/folders", { as: "member" });
		expect(folders).toEqual({ status: 200, body: FOLDERS });
	});
});

describe("GET /api/v1/me", () => {
	it("echoes the person, their organization and role, and the gateway's origin", async () => {
		const { env } = makeEnv();
		expect(await send(env, "GET", "/api/v1/me", { as: "admin" })).toEqual({
			status: 200,
			body: {
				id: "user_admin",
				email: "admin@acme.example",
				orgId: ORG,
				role: "admin",
				gatewayUrl: ISSUER,
			},
		});
		expect((await send(env, "GET", "/api/v1/me", { as: "member" })).body).toMatchObject({ role: "member" });
		expect((await send(env, "GET", "/api/v1/me", { as: "owner" })).body).toMatchObject({ role: "owner" });
		expect((await send(env, "GET", "/api/v1/me", { as: "guest" })).body).toMatchObject({ role: "member" });
	});

	it("falls back to the identity issuer's origin where GATEWAY_URL isn't set (everyapp dev)", () => {
		expect(gatewayUrlOf({ GATEWAY_URL: "https://apps.example.com/x" })).toBe("https://apps.example.com");
		expect(gatewayUrlOf({ EVERYAPP_IDENTITY_ISSUER: "https://gateway.dev.localhost" })).toBe(
			"https://gateway.dev.localhost",
		);
		expect(gatewayUrlOf({ GATEWAY_URL: "not a url", EVERYAPP_IDENTITY_ISSUER: "javascript:alert(1)" })).toBeNull();
		expect(gatewayUrlOf({})).toBeNull();
	});
});

describe("/agents/* guard", () => {
	it("only the chat agent is addressable, over HTTP and WebSocket", async () => {
		const { env, bucket, agentCalls } = makeEnv();
		await seedMailbox(bucket, "x");
		for (const path of ["/agents/mailbox/x", "/agents/email-mcp/x"]) {
			expect(await send(env, "GET", path, { as: "member" })).toEqual({ status: 404, body: "Agent not found" });
			const upgrade = await send(env, "GET", path, { as: "member", headers: { upgrade: "websocket" } });
			expect(upgrade).toEqual({ status: 404, body: "Agent not found" });
		}
		expect(agentCalls).toEqual([]);
	});

	it("refuses the agent's internal inbound-mail entry from outside", async () => {
		const { env, bucket, agentCalls } = makeEnv();
		await seedMailbox(bucket, "x");
		for (const path of ["/agents/email-agent/x/onNewEmail", "/agents/email-agent/x/onNewEmail/"]) {
			expect(await send(env, "POST", path, { as: "owner", body: {} })).toEqual({ status: 404, body: "Agent not found" });
		}
		expect(agentCalls).toEqual([]);
	});

	it("reaches the chat agent of an existing mailbox only", async () => {
		const { env, bucket, agentCalls } = makeEnv();
		await seedMailbox(bucket, "team@example.com");
		const history = await send(env, "GET", "/agents/email-agent/team@example.com/get-messages", { as: "member" });
		expect(history).toEqual({ status: 200, body: { agent: "team@example.com" } });
		const socket = await send(env, "GET", "/agents/email-agent/team@example.com", {
			as: "member",
			headers: { upgrade: "websocket" },
		});
		expect(socket.status).toBe(200);
		expect(await send(env, "GET", "/agents/email-agent/gone@example.com/get-messages", { as: "member" })).toEqual({
			status: 404,
			body: "Agent not found",
		});
		expect(agentCalls).toEqual([
			"team@example.com /agents/email-agent/team@example.com/get-messages",
			"team@example.com /agents/email-agent/team@example.com",
		]);
	});

	it("checks the organization before the agent: another organization's socket never reaches it", async () => {
		const { env, bucket, agentCalls } = makeEnv();
		await seedMailbox(bucket, "team@example.com");
		const res = await send(env, "GET", "/agents/email-agent/team@example.com", {
			orgId: "org_other",
			headers: { upgrade: "websocket" },
		});
		expect(res.status).toBe(401);
		expect(agentCalls).toEqual([]);
	});
});

describe("the chat agent's socket lifetime", () => {
	type TestAgent = EmailAgent & {
		schedules: { id: string; time: number; callback: string; payload: unknown }[];
		connections: Map<string, { close(code?: number, reason?: string): void }>;
	};
	const newAgent = () => new (EmailAgent as unknown as new () => TestAgent)();
	const connect = (agent: TestAgent, id: string) =>
		agent.onConnect({ id } as never, { request: new Request("https://x/agents/email-agent/dev@example.com") } as never);

	it("schedules each socket's close 15 minutes after it connects", async () => {
		const agent = newAgent();
		await connect(agent, "c1");
		expect(SOCKET_LIFETIME_SECONDS).toBe(900);
		expect(agent.schedules).toEqual([{ id: "s1", time: 900, callback: "closeExpiredSocket", payload: "c1" }]);
	});

	it("keeps one pending close per socket: a reconnect with the same id replaces it", async () => {
		const agent = newAgent();
		await connect(agent, "c1");
		await connect(agent, "c2");
		await connect(agent, "c1");
		expect(agent.schedules.map((s) => s.payload).sort()).toEqual(["c1", "c2"]);
		expect(agent.schedules.find((s) => s.payload === "c1")!.id).toBe("s3");
	});

	it("closes the socket with a code the client reconnects after, through the gateway", () => {
		const agent = newAgent();
		const close = vi.fn();
		agent.connections.set("c1", { close });
		agent.closeExpiredSocket("c1");
		expect(close).toHaveBeenCalledWith(1000, SOCKET_LIFETIME_CLOSE.reason);
		// The agents client stops retrying on 1008 and 4000-4999.
		expect(SOCKET_LIFETIME_CLOSE.code).toBe(1000);
	});

	it("does nothing for a socket that has gone, or is closing", () => {
		const agent = newAgent();
		expect(() => agent.closeExpiredSocket("gone")).not.toThrow();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		agent.connections.set("c1", {
			close() {
				throw new Error("already closing");
			},
		});
		expect(() => agent.closeExpiredSocket("c1")).not.toThrow();
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});
