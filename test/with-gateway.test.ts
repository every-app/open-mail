// withGateway(): the env upstream's code expects, brokered by the gateway.
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentModelId, mapModel, withGateway } from "../workers/everyapp/gateway";

type Call = { url: string; body: unknown; identity: string | null };

function fakeGateway(reply: { status?: number; body: unknown }) {
	const calls: Call[] = [];
	return {
		calls,
		binding: {
			async fetch(input: RequestInfo | URL, init?: RequestInit) {
				const request = new Request(input, init);
				calls.push({
					url: request.url,
					body: await request.json(),
					identity: request.headers.get("x-everyapp-identity"),
				});
				return Response.json(reply.body, { status: reply.status ?? 200 });
			},
		},
	};
}

afterEach(() => vi.restoreAllMocks());

function env(extra: Record<string, unknown> = {}) {
	return { AI_PROVIDER: "workers-ai", AGENT_MODEL: "", ...extra } as unknown as Cloudflare.Env;
}

describe("withGateway", () => {
	it("keeps the env and adds AI and EMAIL without needing a gateway or a key until a model is called", () => {
		const base = env({ AI_PROVIDER: "openrouter" });
		const wrapped = withGateway(base);
		expect(wrapped.AI_PROVIDER).toBe("openrouter");
		expect(typeof wrapped.AI.run).toBe("function");
		expect(typeof wrapped.EMAIL.send).toBe("function");
	});

	it("AI.run() posts an OpenAI-compatible chat completion to the gateway's workers-ai path, attributed to the request", async () => {
		const gateway = fakeGateway({ body: { choices: [{ message: { content: "NO" } }] } });
		const request = new Request("https://openmail.example.com/api/v1/x", {
			headers: { "x-everyapp-identity": "token-of-the-person" },
		});
		const { AI } = withGateway(env({ EVERY_APP_GATEWAY: gateway.binding }), request);
		const out = await AI.run("@cf/meta/llama-3.1-8b-instruct-fast" as never, {
			messages: [{ role: "user", content: "hi" }],
			max_tokens: 10,
			temperature: 0,
		} as never);
		expect(out).toEqual({ response: "NO" });
		expect(gateway.calls).toHaveLength(1);
		expect(gateway.calls[0]!.url).toBe("http://every-app-gateway.internal/api/ai/workers-ai/v1/chat/completions");
		expect(gateway.calls[0]!.body).toEqual({
			model: "@cf/meta/llama-3.1-8b-instruct-fast",
			messages: [{ role: "user", content: "hi" }],
			max_tokens: 10,
			temperature: 0,
		});
		expect(gateway.calls[0]!.identity).toBe("token-of-the-person");
	});

	it("AI.run() goes to OpenRouter with its model ids when AI_PROVIDER=openrouter, and throws on a refusal", async () => {
		const gateway = fakeGateway({ status: 502, body: { error: "provider_not_configured" } });
		const { AI } = withGateway(env({ AI_PROVIDER: "openrouter", EVERY_APP_GATEWAY: gateway.binding }));
		await expect(
			AI.run("@cf/meta/llama-4-scout-17b-16e-instruct" as never, { messages: [] } as never),
		).rejects.toThrow(/ai 502/);
		expect(gateway.calls[0]!.url).toBe("http://every-app-gateway.internal/api/ai/openrouter/api/v1/chat/completions");
		expect((gateway.calls[0]!.body as { model: string }).model).toBe("meta-llama/llama-4-scout");
	});

	it("AI.run() on a Worker built with no AI_PROVIDER goes to the Gateway's default route with model \"default\"", async () => {
		const gateway = fakeGateway({ body: { choices: [{ message: { content: "NO" } }] } });
		const { AI } = withGateway(env({ AI_PROVIDER: "", EVERY_APP_GATEWAY: gateway.binding }));
		expect(await AI.run("@cf/meta/llama-3.1-8b-instruct-fast" as never, { messages: [] } as never)).toEqual({ response: "NO" });
		expect(gateway.calls[0]!.url).toBe("http://every-app-gateway.internal/api/ai/default/v1/chat/completions");
		expect((gateway.calls[0]!.body as { model: string }).model).toBe("default");
	});

	it("AI.run() without a gateway or a dev key fails the call, not the request", async () => {
		const { AI } = withGateway(env({ EVERYAPP_DEV: "1" }));
		await expect(AI.run("@cf/meta/llama-3.1-8b-instruct-fast" as never, { messages: [] } as never)).rejects.toThrow(
			/AI gateway unavailable/,
		);
	});

	it("EMAIL.send() is the SDK's sendEmail: printed under everyapp dev, refused on a deployed Worker without the gateway", async () => {
		const message = { from: "dev@example.com", to: "a@example.org", subject: "hi", text: "x" };
		vi.spyOn(console, "info").mockImplementation(() => {});
		// everyAppWorker() passes the manifest's senders to the dev Worker.
		const dev = withGateway(env({ EVERYAPP_DEV: "1", EVERYAPP_EMAIL_SENDERS: JSON.stringify(["*@example.com"]) }));
		const sent = await dev.EMAIL.send(message as never);
		expect(sent.messageId).toMatch(/^dev-/);
		const deployed = withGateway(env());
		await expect(deployed.EMAIL.send(message as never)).rejects.toMatchObject({ code: "email_not_configured" });
	});

	it("EMAIL.send() posts to the gateway's email capability, attributed to the request", async () => {
		const gateway = fakeGateway({ body: { messageId: "<gw-1@example.com>", status: "delivered" } });
		const request = new Request("https://openmail.example.com/api/v1/x", {
			headers: { "x-everyapp-identity": "token-of-the-person" },
		});
		const { EMAIL } = withGateway(env({ EVERY_APP_GATEWAY: gateway.binding }), request);
		const sent = await EMAIL.send({ from: "dev@example.com", to: "a@example.org", subject: "hi", text: "x" } as never);
		expect(sent).toEqual({ messageId: "<gw-1@example.com>" });
		expect(gateway.calls[0]).toEqual({
			url: "http://every-app-gateway.internal/api/integrations/email/send",
			body: { to: "a@example.org", subject: "hi", text: "x", from: { address: "dev@example.com" } },
			identity: "token-of-the-person",
		});
	});

	it("maps model ids and picks the agent model", () => {
		expect(mapModel(env(), "@cf/meta/llama-3.1-8b-instruct-fast")).toBe("@cf/meta/llama-3.1-8b-instruct-fast");
		expect(mapModel(env({ AI_PROVIDER: "openrouter" }), "@cf/meta/llama-3.1-8b-instruct-fast")).toBe(
			"meta-llama/llama-3.1-8b-instruct",
		);
		expect(agentModelId(env())).toBe("@cf/meta/llama-4-scout-17b-16e-instruct");
		expect(agentModelId(env({ AI_PROVIDER: "openrouter" }))).toBe("anthropic/claude-haiku-5.5");
		expect(agentModelId(env({ AGENT_MODEL: " @cf/moonshotai/kimi-k2.6 " }))).toBe("@cf/moonshotai/kimi-k2.6");
	});
});
