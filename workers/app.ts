// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { everyApp } from "@every-app/sdk/server";
import { routeAgentRequest } from "agents";
import { Hono } from "hono";
import { createRequestHandler } from "react-router";
import { withGateway } from "./everyapp/gateway";
import { agentGuard, requireOrganization, users } from "./everyapp/identity";
import { withNamedAgents } from "./everyapp/inbound";
import { app as apiApp, receiveEmail } from "./index";
import { EmailMCP } from "./mcp";
import type { Env } from "./types";

export { MailboxDO } from "./durableObject";
export { EmailAgent } from "./agent";
export { EmailMCP } from "./mcp";

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

// MCP server endpoint — used by AI coding tools (ProtoAgent, Claude Code, Cursor, etc.)
// Must be before API routes and React Router catch-all
const mcpHandler = EmailMCP.serve("/mcp", { binding: "EMAIL_MCP" });
app.all("/mcp", async (c) => {
	return mcpHandler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext);
});
app.all("/mcp/*", async (c) => {
	return mcpHandler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext);
});

// Mount the API routes
app.route("/", apiApp);

// Agent WebSocket routing - must be before React Router catch-all.
// partyserver makes every Durable Object binding addressable by URL; the
// guard lets only the chat agent through.
app.all("/agents/*", async (c) => {
	const response = await routeAgentRequest(c.req.raw, c.env, {
		onBeforeConnect: agentGuard,
		onBeforeRequest: agentGuard,
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
// gateway, attributed to the request's person). The email handler sits
// beside it, fed by an Email Routing rule that names this Worker.
export default {
	...everyApp<Cloudflare.Env>(async (request, env, ctx, user) => {
		const refused = requireOrganization(env, user);
		if (refused) return refused;
		users.set(request, user);
		return app.fetch(request, withGateway(env, request), ctx as ExecutionContext);
	}),
	async email(
		event: { raw: ReadableStream; rawSize: number },
		env: Env,
		ctx: ExecutionContext,
	) {
		try {
			// TODO(integration): lane L2 (inbound): withNamedAgents() lets the
			// auto-draft reach a mailbox's agent before its chat panel was ever
			// opened (workers/everyapp/inbound.ts).
			await receiveEmail(event, withNamedAgents(env), ctx);
		} catch (e) {
			console.error("Failed to process incoming email:", (e as Error).message, (e as Error).stack);
			// Re-throw so Cloudflare's email routing can retry delivery or bounce the message.
			// Swallowing the error would silently drop the email.
			throw e;
		}
	},
};
