/**
 * The app's side of the gateway identity: who may open this copy of the app,
 * who may manage its mailboxes, and how long a chat socket outlives the
 * identity it connected with.
 *
 * everyApp() (workers/app.ts) has verified the identity token the gateway
 * signs onto every request before any of this runs. The organization is the
 * authorization boundary: every member of the organization may open every
 * mailbox, read, search, draft, reply, forward, send, move and star; owners
 * and admins also create and delete mailboxes and edit their settings
 * (including the agent's system prompt). Nothing about members is stored:
 * the role comes from the signed token on each request, so when the gateway
 * removes someone it stops signing for them and nothing here still lets
 * them in.
 */
import type { EveryAppUser } from "@every-app/sdk/server";
import type { MiddlewareHandler } from "hono";

/** The verified user of each request, set by the entry for the routes. */
export const users = new WeakMap<Request, EveryAppUser | null>();

export type Role = "owner" | "admin" | "member";

/** The gateway's organization role, as this app knows it: anything else is a member. */
export function roleOf(user: Pick<EveryAppUser, "orgRole">): Role {
	return user.orgRole === "owner" || user.orgRole === "admin" ? user.orgRole : "member";
}

export function isAdmin(user: Pick<EveryAppUser, "orgRole">): boolean {
	return roleOf(user) !== "member";
}

function unauthenticated(message: string): Response {
	return Response.json({ error: "unauthenticated", message }, { status: 401 });
}

/**
 * Refuse a request without a person, or (on an organization's own copy of
 * the app, where the deploy sets EVERY_APP_ORG_ID) one from another
 * organization: the audience already names this Worker, this keeps another
 * organization's members out of it. Returns the refusal, or null to go on.
 */
export function requireOrganization(
	env: Pick<Cloudflare.Env, "EVERY_APP_ORG_ID">,
	user: EveryAppUser | null,
): Response | null {
	if (!user) return unauthenticated("this request has no signed-in person");
	// The gateway always names an organization; without one there is no
	// boundary to check against.
	if (!user.orgId) return unauthenticated("the identity names no organization");
	const pinned = env.EVERY_APP_ORG_ID;
	if (pinned && user.orgId !== pinned) {
		return unauthenticated("this app belongs to another organization");
	}
	return null;
}

/**
 * Hono middleware for the routes only owners and admins may use: creating
 * and deleting mailboxes and editing their settings.
 */
export const requireAdmin: MiddlewareHandler = async (c, next) => {
	const user = users.get(c.req.raw);
	if (!user) return c.json({ error: "unauthenticated" }, 401);
	if (!isAdmin(user)) {
		return c.json(
			{
				error: "forbidden",
				code: "admin_required",
				message: "Only owners and admins of the organization can manage mailboxes.",
			},
			403,
		);
	}
	await next();
};

/**
 * Where people sign out and manage their organization: the gateway's origin.
 * The deploy sets GATEWAY_URL; the identity tokens' issuer is the same
 * origin, so it stands in where GATEWAY_URL isn't set (`everyapp dev`).
 */
export function gatewayUrlOf(env: object): string | null {
	for (const name of ["GATEWAY_URL", "EVERYAPP_IDENTITY_ISSUER"]) {
		const value = (env as Record<string, unknown>)[name];
		if (typeof value !== "string" || !value) continue;
		try {
			const url = new URL(value);
			if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
		} catch {
			// Not a URL; try the next one.
		}
	}
	return null;
}

/** The body of `GET /api/v1/me`: the signed-in person, for the UI. */
export interface Me {
	id: string;
	email: string;
	orgId: string;
	role: Role;
	gatewayUrl: string | null;
}

export function me(user: EveryAppUser, env: object): Me {
	return {
		id: user.id,
		email: user.email,
		orgId: user.orgId,
		role: roleOf(user),
		gatewayUrl: gatewayUrlOf(env),
	};
}

/**
 * The routeAgentRequest() guard (onBeforeConnect and onBeforeRequest).
 *
 * partyserver makes every Durable Object binding addressable as
 * /agents/<kebab-case binding>/<name>; only the chat agent may be, so the
 * mailbox and MCP objects stay internal. `lobby.className` is the env
 * binding's name (partyserver 0.3.3 maps the URL segment back to the key it
 * found in env), so the check is against EMAIL_AGENT.
 *
 * The agent's name is the mailbox's address and its tools read and write
 * that mailbox, so it is reachable only for a mailbox that exists, as the
 * REST routes are (`requireMailbox`): a deleted mailbox's agent and data are
 * not reopened through the socket.
 *
 * `/onNewEmail` is the agent's internal entry for inbound mail
 * (`receiveEmail` calls it on the stub). It is already unreachable from
 * outside, because partyserver hands the object the full external path
 * (`/agents/email-agent/<name>/onNewEmail`); refused here regardless.
 */
export async function agentGuard(
	request: Request,
	lobby: { className: string; name: string },
	env: Pick<Cloudflare.Env, "BUCKET">,
): Promise<Response | undefined> {
	if (lobby.className !== "EMAIL_AGENT") return notFound();
	const path = new URL(request.url).pathname.replace(/\/+$/, "");
	if (path.endsWith("/onNewEmail")) return notFound();
	if (!(await env.BUCKET.head(`mailboxes/${lobby.name}.json`))) return notFound();
	return undefined;
}

function notFound(): Response {
	return new Response("Agent not found", { status: 404 });
}

/**
 * How long a chat socket stays open. The app checks the identity once, when
 * the socket connects; closing every socket this long after it connects
 * bounds how long someone the gateway has removed keeps an open chat: the
 * client reconnects through the gateway, which signs a fresh identity or
 * refuses them. A reconnect is invisible unless a reply is streaming, which
 * then resumes.
 */
export const SOCKET_LIFETIME_SECONDS = 15 * 60;

/** A normal close, which the agents client reconnects after (it stops on 1008 and 4000-4999). */
export const SOCKET_LIFETIME_CLOSE = {
	code: 1000,
	reason: "Reconnecting: chat sessions renew their sign-in every 15 minutes.",
} as const;

interface SchedulingAgent {
	schedule(when: number, callback: "closeExpiredSocket", payload: string): Promise<unknown>;
	getSchedules(): { id: string; callback?: string; payload?: unknown }[];
	cancelSchedule(id: string): Promise<boolean>;
}

/**
 * On connect: schedule the socket's close SOCKET_LIFETIME_SECONDS from now
 * (a Durable Object alarm, so it outlives hibernation; it calls the agent's
 * `closeExpiredSocket`). The client keeps its connection id across
 * reconnects, so an earlier close still pending for the same id is
 * replaced: one pending close per socket.
 */
export async function scheduleSocketClose(agent: SchedulingAgent, connectionId: string): Promise<void> {
	for (const pending of agent.getSchedules()) {
		if (pending.callback === "closeExpiredSocket" && pending.payload === connectionId) {
			await agent.cancelSchedule(pending.id);
		}
	}
	await agent.schedule(SOCKET_LIFETIME_SECONDS, "closeExpiredSocket", connectionId);
}

/** The scheduled close: a socket that has gone already needs nothing. */
export function closeAgentSocket(
	connection: { close(code?: number, reason?: string): void } | undefined,
): void {
	if (!connection) return;
	try {
		connection.close(SOCKET_LIFETIME_CLOSE.code, SOCKET_LIFETIME_CLOSE.reason);
	} catch (error) {
		// Already closing.
		console.warn("[agentic-inbox] closing an expired agent socket failed", error);
	}
}
