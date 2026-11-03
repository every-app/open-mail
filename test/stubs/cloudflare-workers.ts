// `cloudflare:workers` for the node test project (vitest.config.ts): just
// enough for a Durable Object class to be declared. Tests that need a real
// one run in the workers project.
export class DurableObject<Env = unknown> {
	constructor(
		readonly ctx: DurableObjectState,
		readonly env: Env,
	) {}
}
