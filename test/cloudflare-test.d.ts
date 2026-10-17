// Types for the workers Vitest project (vitest.config.ts): `cloudflare:test`
// and its `env`, which carries the bindings the project's miniflare options
// declare (the Worker's own, as cloudflare.config.ts describes them).
/// <reference types="@cloudflare/vitest-pool-workers" />

declare module "cloudflare:test" {
	interface ProvidedEnv extends Cloudflare.Env {}
}
