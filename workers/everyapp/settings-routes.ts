/**
 * The middleware that keeps what the port adds to a mailbox's settings
 * (`ownerId`, `provider`) out of a client's hands on upstream's create and
 * edit routes, whose handlers stay as upstream wrote them.
 *
 * The middleware hands upstream's handler a rewritten body through Hono's
 * body cache (replaceJsonBody()): the handler's `c.req.json()` parses the
 * cached text, not the request.
 */
import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../types";
import { routeMailboxId, users } from "./identity";
import { asSettings, readMailboxSettings } from "./mailbox-settings";

type AppContext = Context<{ Bindings: Env }>;

/**
 * What upstream's handler reads with `c.req.json()` from here on: Hono 4
 * parses `bodyCache.text`, which holds a promise at runtime (its declared
 * type says the value).
 */
function replaceJsonBody(c: AppContext, body: unknown): void {
	c.req.bodyCache = { text: Promise.resolve(JSON.stringify(body)) } as unknown as typeof c.req.bodyCache;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Ahead of upstream's `POST /api/v1/mailboxes` (after requireAdmin): the new
 * native mailbox belongs to its creator. A client can't name another owner
 * or a provider. A body that isn't JSON goes on to upstream's own refusal.
 */
export const stampMailboxOwner: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
	const user = users.get(c.req.raw);
	if (!user) return c.json({ error: "unauthenticated" }, 401);
	const body = await c.req.json().catch(() => undefined);
	if (isObject(body)) {
		const { provider: _provider, ...settings } = isObject(body.settings) ? body.settings : {};
		replaceJsonBody(c, { ...body, settings: { ...settings, ownerId: user.id } });
	}
	await next();
};

/**
 * Ahead of upstream's `PUT /api/v1/mailboxes/:mailboxId` (after the access
 * and manager checks): upstream writes the body's settings as they are, so
 * the stored `ownerId` and `provider` are put back over whatever the client
 * sent (or left out). Settings that aren't an object are refused: written as they are, they
 * would drop the owner.
 */
export const guardMailboxSettings: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
	const body = await c.req.json().catch(() => null);
	if (!isObject(body) || !isObject(body.settings)) {
		return c.json({ error: "invalid_settings", message: "Send { settings: { … } }." }, 400);
	}
	const stored = await readMailboxSettings(c.env.BUCKET, routeMailboxId(c.req.param("mailboxId")) ?? "");
	if (stored === null) {
		// Upstream answers 404.
		await next();
		return;
	}
	const { ownerId, provider } = asSettings(stored);
	const { ownerId: _ownerId, provider: _provider, ...settings } = body.settings;
	replaceJsonBody(c, {
		...body,
		settings: { ...settings, ...(ownerId ? { ownerId } : {}), ...(provider ? { provider } : {}) },
	});
	await next();
};
