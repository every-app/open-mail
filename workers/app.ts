// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { everyApp } from "@every-app/sdk/server";
import { routeAgentRequest } from "agents";
import { Hono } from "hono";
import { createRequestHandler } from "react-router";
import { withGateway } from "./everyapp/gateway";
import {
	agentGuard,
	me,
	requireAdmin,
	requireMailboxAccess,
	requireMailboxManager,
	requireOrganization,
	users,
} from "./everyapp/identity";
import { app as apiApp, receiveEmail } from "./index";
import { withNamedAgents } from "./everyapp/inbound";
import { guardMailboxSettings, stampMailboxOwner } from "./everyapp/settings-routes";
import { gmailRoutes } from "./everyapp/gmail/routes";
import { tools } from "./everyapp/tools";
import type { Env } from "./types";

import type { MailboxDO as UpstreamMailboxDO } from "./durableObject";
import { MailboxDO as LabeledMailboxDO } from "./everyapp/mailbox";

// The port's subclass, under upstream's class name, so the MAILBOX binding
// and its stored objects stay as they were: labels (workers/everyapp/mailbox.ts).
// Typed as upstream's class: `cf workers types` types env.MAILBOX from this
// export, and upstream's byte-identical helpers assign env.MAILBOX's stubs
// to DurableObjectStub<upstream MailboxDO>, which TypeScript can't compare
// against a subclass's stub (drizzle's `db` makes it "excessively deep").
// The port's code reaches the label methods through mailboxStub() there.
export const MailboxDO = LabeledMailboxDO as typeof UpstreamMailboxDO;
export { EmailAgent } from "./agent";
export { GmailSync } from "./everyapp/gmail/sync";

declare module "react-router" {
	export interface AppLoadContext {
		cloudflare: {
			env: Env;
			ctx: ExecutionContext;
		};
	}
}

const requestHandler = createRequestHandler(
	() => import("virtual:react-router/server-build"),
	import.meta.env.MODE,
);

// Main app that wraps the API and adds React Router fallback
const app = new Hono<{ Bindings: Env }>();

// Every App: who may do what (workers/everyapp/identity.ts). The
// organization is the boundary, checked at the entry for every request.
// Inside it a mailbox is its creator's alone (someone else's answers 404,
// here and under it); a shared, ownerless one is every member's, and only
// owners and admins edit or delete it. Owners and admins create native
// mailboxes, stamped with their owner. Registered before the API (and any
// other mailbox route) so the checks run ahead of every handler.
app.get("/api/v1/me", (c) => {
	const user = users.get(c.req.raw);
	if (!user) return c.json({ error: "unauthenticated" }, 401);
	return c.json(me(user, c.env));
});
app.post("/api/v1/mailboxes", requireAdmin, stampMailboxOwner);
// Hono's `/*` matches the mailbox's own path too.
app.use("/api/v1/mailboxes/:mailboxId/*", requireMailboxAccess);
app.on(["PUT", "DELETE"], "/api/v1/mailboxes/:mailboxId", requireMailboxManager);
app.put("/api/v1/mailboxes/:mailboxId", guardMailboxSettings);

// Gmail mailboxes (docs/GMAIL.md): status, connect, sync, drafting, labels.
app.route("/", gmailRoutes);

// Mount the API routes
app.route("/", apiApp);

// Agent WebSocket routing - must be before React Router catch-all.
// partyserver makes every Durable Object binding addressable by URL; the
// guard lets only the chat agent of an existing mailbox the caller may use
// through.
app.all("/agents/*", async (c) => {
	const user = users.get(c.req.raw);
	const guard = (request: Request, lobby: { className: string; name: string }) =>
		agentGuard(request, lobby, c.env, user);
	const response = await routeAgentRequest(c.req.raw, c.env, {
		onBeforeConnect: guard,
		onBeforeRequest: guard,
	});
	if (response) return response;
	return c.text("Agent not found", 404);
});

// React Router catch-all: serves the SPA for all non-API routes
app.all("*", (c) => {
	return requestHandler(c.req.raw, {
		cloudflare: { env: c.env, ctx: c.executionCtx as ExecutionContext },
	});
});

// The default export: everyApp() verifies the identity the gateway puts on
// every request before any app code runs (the gateway is the identity
// boundary; Cloudflare Access is gone), then the Hono app runs with the env
// upstream's code expects (withGateway(): AI and EMAIL brokered by the
// gateway, attributed to the request's person). everyApp() also answers the
// gateway's tools contract (`/__everyapp/tools/*`) from the MCP catalog
// (workers/everyapp/tools.ts): MCP clients reach the tools through the
// gateway's `/mcp`, which the app never serves itself. The email handler
// sits beside it, fed by an Email Routing rule that names this Worker.
export default {
	...everyApp<Cloudflare.Env>(
		async (request, env, ctx, user) => {
			const refused = requireOrganization(env, user);
			if (refused) return refused;
			users.set(request, user);
			return app.fetch(request, withGateway(env, request), ctx);
		},
		{ tools },
	),
	async email(
		event: { raw: ReadableStream; rawSize: number },
		env: Env,
		ctx: ExecutionContext,
	) {
		try {
			// withNamedAgents() lets the auto-draft reach a mailbox's agent
			// before its chat panel was ever opened (workers/everyapp/inbound.ts);
			// receiveEmail() itself is upstream's, byte-identical.
			await receiveEmail(event, withNamedAgents(env), ctx);
		} catch (e) {
			console.error("Failed to process incoming email:", (e as Error).message, (e as Error).stack);
			// Re-throw so Cloudflare's email routing can retry delivery or bounce the message.
			// Swallowing the error would silently drop the email.
			throw e;
		}
	},
};
