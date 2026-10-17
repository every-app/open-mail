/**
 * The app's side of the gateway identity. everyApp() (workers/app.ts) has
 * verified the identity token on every request before this code runs; the
 * organization is the authorization boundary.
 *
 * L0 stub: lane L3 owns this file and completes it (roles, requireAdmin,
 * /api/v1/me, the full agent guard).
 */
import type { EveryAppUser } from "@every-app/sdk/server";

/** The verified user of each request, set by the entry for the routes. */
export const users = new WeakMap<Request, EveryAppUser | null>();

/**
 * Refuse a request without a person, or (on an organization's own copy of
 * the app, where EVERY_APP_ORG_ID is set) one from another organization.
 * Returns the refusal, or null to go on.
 */
export function requireOrganization(
	env: Pick<Cloudflare.Env, "EVERY_APP_ORG_ID">,
	user: EveryAppUser | null,
): Response | null {
	if (!user) {
		return Response.json({ error: "unauthenticated" }, { status: 401 });
	}
	const pinned = env.EVERY_APP_ORG_ID;
	if (pinned && user.orgId !== pinned) {
		return Response.json(
			{ error: "unauthenticated", message: "this app belongs to another organization" },
			{ status: 401 },
		);
	}
	return null;
}

/**
 * The routeAgentRequest() guard (onBeforeConnect and onBeforeRequest).
 * partyserver makes every Durable Object binding addressable as
 * /agents/<kebab-case binding>/<name>; only the chat agent may be, so the
 * mailbox and MCP objects stay internal. `lobby.className` is the env
 * binding's name (partyserver 0.3.3 maps the URL segment back to the key it
 * found in env), so the check is against EMAIL_AGENT.
 */
export function agentGuard(
	_request: Request,
	lobby: { className: string; name: string },
): Response | undefined {
	if (lobby.className !== "EMAIL_AGENT") {
		return new Response("Agent not found", { status: 404 });
	}
	return undefined;
}
