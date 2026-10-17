// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The env the app's code reads. `AI` and `EMAIL` are no bindings on Every App
 * (the deploy refuses both): withGateway() (workers/everyapp/gateway.ts)
 * supplies them, brokered by the gateway, so the upstream code that calls
 * `env.AI.run()` and `sendEmail(env.EMAIL, …)` runs unchanged.
 */
export interface Env extends Cloudflare.Env {
	/** Workers AI's `run()`, over the gateway's AI proxy. */
	AI: Ai;
	/** The gateway's email capability, shaped as a `send_email` binding. */
	EMAIL: SendEmail;
}
