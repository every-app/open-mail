// On the Gateway's default model (AI_PROVIDER empty) every id upstream's
// code names is sent as "default", the operator's model. On a pin, every
// model id the app can send is one the manifest lets the gateway accept
// (`ai.models`; anything else is refused with model_not_allowed). Upstream's
// code names Workers AI models in string literals (lib/ai.ts), so the
// source is scanned: a model upstream adds fails here, not at the first
// live call.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "../everyapp.config";
import { agentModelId, mapModel, PROVIDERS } from "../workers/everyapp/gateway";

const allowed: readonly string[] = manifest.ai.models;
const ROOT = path.resolve(import.meta.dirname, "..");

/** Every "@cf/…" string literal in the Worker's source. */
function workersAiLiterals(): string[] {
	const found = new Set<string>();
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const file = path.join(dir, name);
			if (statSync(file).isDirectory()) walk(file);
			else if (/\.tsx?$/.test(name)) {
				for (const m of readFileSync(file, "utf8").matchAll(/["'`](@cf\/[^"'`\s]+)["'`]/g)) found.add(m[1]!);
			}
		}
	};
	walk(path.join(ROOT, "workers"));
	return [...found].sort();
}

const env = (AI_PROVIDER: string, AGENT_MODEL = "") => ({ AI_PROVIDER, AGENT_MODEL }) as Cloudflare.Env;

describe("model ids", () => {
	it("finds upstream's scanner and verifier models in lib/ai.ts", () => {
		const literals = workersAiLiterals();
		expect(literals).toContain("@cf/meta/llama-3.1-8b-instruct-fast");
		expect(literals).toContain("@cf/meta/llama-4-scout-17b-16e-instruct");
	});

	it("the default (AI_PROVIDER empty): every Workers AI id the code names, and the default agent model, is sent as \"default\"", () => {
		for (const model of workersAiLiterals()) expect(mapModel(env(""), model)).toBe("default");
		const p = PROVIDERS.default;
		expect([p.scanner, p.verifier, p.agent, agentModelId(env(""))]).toEqual(["default", "default", "default", "default"]);
		expect(p.base).toBe("http://every-app-gateway.internal/api/ai/default/v1");
		expect(p.settings).toEqual([]);
	});

	for (const provider of ["workers-ai", "openrouter"]) {
		it(`AI_PROVIDER=${provider}: every id the code names, as sent, is in ai.models`, () => {
			const sent = workersAiLiterals().map((model) => mapModel(env(provider), model));
			for (const model of sent) expect(allowed, model).toContain(model);
		});

		it(`AI_PROVIDER=${provider}: the provider's scanner, verifier and default agent model are in ai.models`, () => {
			const p = PROVIDERS[provider as keyof typeof PROVIDERS];
			for (const model of [p.scanner, p.verifier, p.agent, agentModelId(env(provider))]) {
				expect(allowed, model).toContain(model);
			}
		});
	}

	it("under OpenRouter no Workers AI id is sent (OpenRouter has no @cf/ models)", () => {
		for (const model of workersAiLiterals()) expect(mapModel(env("openrouter"), model)).not.toMatch(/^@cf\//);
	});

	it("the documented AGENT_MODEL alternative, kimi-k2.6, is accepted under both pins; the deprecated k2.5 id is sent as k2.6", () => {
		for (const provider of ["workers-ai", "openrouter"]) {
			for (const model of ["@cf/moonshotai/kimi-k2.6", "@cf/moonshotai/kimi-k2.5"]) {
				const sent = agentModelId(env(provider, model));
				expect(sent).toMatch(/kimi-k2\.6$/);
				expect(allowed, sent).toContain(sent);
			}
		}
	});

	it("the default agent model is llama-4-scout on Workers AI (function calling, 300 requests a minute) and claude-haiku-5.5 on OpenRouter", () => {
		expect(agentModelId(env("workers-ai"))).toBe("@cf/meta/llama-4-scout-17b-16e-instruct");
		expect(agentModelId(env("openrouter"))).toBe("anthropic/claude-haiku-5.5");
	});

	it("ai.models is exactly the seven ids the pins use, unique and within the manifest's limits", () => {
		expect([...allowed].sort()).toEqual(
			[
				"@cf/meta/llama-3.1-8b-instruct-fast",
				"@cf/meta/llama-4-scout-17b-16e-instruct",
				"@cf/moonshotai/kimi-k2.6",
				"anthropic/claude-haiku-5.5",
				"meta-llama/llama-3.1-8b-instruct",
				"meta-llama/llama-4-scout",
				"moonshotai/kimi-k2.6",
			].sort(),
		);
		expect(new Set(allowed).size).toBe(allowed.length);
		for (const model of allowed) {
			expect(model.length).toBeGreaterThan(0);
			expect(model.length).toBeLessThanOrEqual(200);
		}
	});

	it("the manifest asks for the Gateway's default model (ai.chat) and lists both pins as optional", () => {
		expect(manifest.ai.chat).toEqual({
			why: "The inbox agent's model, with the prompt-injection scanner and the draft verifier.",
		});
		// Every pin the code knows is declared, optional: nobody sets either for the default.
		expect(manifest.providers.map((p) => [p.id, p.optional])).toEqual([
			["openrouter", true],
			["workers-ai", true],
		]);
		expect([...manifest.providers.map((p) => p.id), "default"].sort()).toEqual(Object.keys(PROVIDERS).sort());
	});
});
