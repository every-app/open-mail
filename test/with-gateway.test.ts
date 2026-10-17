// withGateway(): the env upstream's code expects, brokered by the gateway.
import { describe, expect, it } from "vitest";
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

function env(extra: Record<string, unknown> = {}) {
	return { AI_PROVIDER: "workers-ai", AGENT_MODEL: "", ...extra } as unknown as Cloudflare.Env;
}

describe("withGateway", () => {
	it("keeps the env and adds AI and EMAIL without needing a gateway or a key until a model is called", () => {
		const base = env({ DOMAINS: "example.com" });
		const wrapped = withGateway(base);
		expect(wrapped.DOMAINS).toBe("example.com");
		expect(typeof wrapped.AI.run).toBe("function");
		expect(typeof wrapped.EMAIL.send).toBe("function");
	});

	it("AI.run() posts an OpenAI-compatible chat completion to the gateway's workers-ai path, attributed to the request", async () => {
		const gateway = fakeGateway({ body: { choices: [{ message: { content: "NO" } }] } });
		const request = new Request("https://agentic-inbox.example.com/api/v1/x", {
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

	it("AI.run() without a gateway or a dev key fails the call, not the request", async () => {
		const { AI } = withGateway(env({ EVERYAPP_DEV: "1" }));
		await expect(AI.run("@cf/meta/llama-3.1-8b-instruct-fast" as never, { messages: [] } as never)).rejects.toThrow(
			/AI gateway unavailable/,
		);
	});

	it("EMAIL.send() is a logging stand-in in dev and refuses on a deployed Worker until the gateway capability is wired", async () => {
		const message = { from: "dev@example.com", to: "a@example.org", subject: "hi", text: "x" };
		const dev = withGateway(env({ EVERYAPP_DEV: "1" }));
		const sent = await dev.EMAIL.send(message as never);
		expect(sent.messageId).toMatch(/^dev-/);
		const deployed = withGateway(env());
		await expect(deployed.EMAIL.send(message as never)).rejects.toMatchObject({ code: "email_not_configured" });
	});

	it("maps model ids and picks the agent model", () => {
		expect(mapModel(env(), "@cf/meta/llama-3.1-8b-instruct-fast")).toBe("@cf/meta/llama-3.1-8b-instruct-fast");
		expect(mapModel(env({ AI_PROVIDER: "openrouter" }), "@cf/meta/llama-3.1-8b-instruct-fast")).toBe(
			"meta-llama/llama-3.1-8b-instruct",
		);
		expect(agentModelId(env())).toBe("@cf/meta/llama-4-scout-17b-16e-instruct");
		expect(agentModelId(env({ AI_PROVIDER: "openrouter" }))).toBe("meta-llama/llama-4-scout");
		expect(agentModelId(env({ AGENT_MODEL: " @cf/moonshotai/kimi-k2.6 " }))).toBe("@cf/moonshotai/kimi-k2.6");
	});
});
