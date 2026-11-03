/**
 * The Gmail routes (docs/GMAIL.md, "API"), mounted ahead of upstream's API
 * in workers/app.ts. Every Gmail call is the signed-in person's: the
 * request is the target (`for: request`), so a person only ever reaches
 * their own Google connection.
 *
 *   GET  /api/v1/gmail/status                                any member
 *   POST /api/v1/gmail/mailboxes                             any member
 *   POST /api/v1/mailboxes/:id/gmail/sync                    the owner
 *   GET  /api/v1/mailboxes/:id/gmail/drafting                the owner
 *   GET  /api/v1/mailboxes/:id/emails/:emailId/gmail-link    the owner
 *
 * Labels have no Gmail routes: a Gmail mailbox's labels are OpenMail's own
 * (../labels.ts), kept in step with Gmail's by the sync (./label-sync.ts).
 *
 * A Gmail refusal answers 409 with `reconnect: true` and `connectUrl` when
 * the person has to connect (or connect again), 403 when the Gateway or
 * Google refuses the call, 503 when Gmail can't be reached at all (no
 * gateway; in `everyapp dev`, no GOOGLE_WORKSPACE_ACCESS_TOKEN), 502
 * otherwise.
 */
import { ConfigurationError, connectUrl, integrationStatus } from "@every-app/sdk/server";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import type { Env } from "../../types";
import { users } from "../identity";
import { canUseMailbox, mailboxKey, readMailboxSettings, type PortMailboxSettings } from "../mailbox-settings";
import { GOOGLE_PROVIDER, gmailClient } from "./client";
import { forwardTarget, gmailSyncOf, knownFailure, type GmailErrorInfo } from "./target";

type GmailContext = { Bindings: Env; Variables: { mailboxId: string } };

export const gmailRoutes = new Hono<GmailContext>();

/** Where the Gateway sends the person back after connecting: `?returnTo=` on this origin, else the app's root. */
function returnToOf(c: Context<GmailContext>): string {
	const origin = new URL(c.req.url).origin;
	const asked = c.req.query("returnTo");
	if (asked) {
		try {
			const url = new URL(asked, origin);
			if (url.origin === origin) return url.toString();
		} catch {
			// Not a URL: the root.
		}
	}
	return `${origin}/`;
}

/**
 * Connect Gmail (and connect again): Google's consent for the manifest's
 * scopes, then back to OpenMail. The only step; the alarm's background sync
 * needs nothing more.
 */
function connectUrlOf(env: Env, returnTo: string): string | null {
	try {
		return connectUrl({ env, provider: GOOGLE_PROVIDER, returnTo });
	} catch (error) {
		if (error instanceof ConfigurationError) return null;
		throw error;
	}
}

/** A Gmail refusal as the routes answer it. */
export function gmailErrorResponse(c: Context<GmailContext>, error: GmailErrorInfo): Response {
	const body = { error: error.code, message: error.message };
	if (error.reconnect || error.code === "integration_not_connected") {
		return c.json({ ...body, reconnect: true, connectUrl: connectUrlOf(c.env, returnToOf(c)) }, 409);
	}
	if (error.code === "gmail_not_configured") return c.json(body, 503);
	if (error.status === 403 || error.code.startsWith("integration_")) return c.json(body, 403);
	return c.json(body, 502);
}

gmailRoutes.get("/api/v1/gmail/status", async (c) => {
	let status: Awaited<ReturnType<typeof integrationStatus<typeof GOOGLE_PROVIDER>>> | null = null;
	try {
		status = await integrationStatus({ env: c.env, provider: GOOGLE_PROVIDER, for: c.req.raw });
	} catch (error) {
		if (!(error instanceof ConfigurationError)) {
			console.error("[gmail] reading the Google status failed:", (error as Error).message);
		}
	}
	const connection = status?.connection;
	return c.json({
		configured: Boolean(status?.configured),
		connection: connection
			? {
					label: connection.label,
					ready: connection.ready,
					reconnect: Boolean(connection.reconnect),
				}
			: null,
		// Connect Gmail, and Reconnect: the same link.
		connectUrl: connectUrlOf(c.env, returnToOf(c)),
	});
});

gmailRoutes.post("/api/v1/gmail/mailboxes", async (c) => {
	const user = users.get(c.req.raw);
	if (!user) return c.json({ error: "unauthenticated" }, 401);
	let address: string;
	try {
		address = (await gmailClient(c.env, c.req.raw).profile()).emailAddress.trim().toLowerCase();
	} catch (error) {
		const failure = knownFailure(error);
		if (failure) return gmailErrorResponse(c, failure);
		throw error;
	}
	const allowed = ((c.env.EMAIL_ADDRESSES ?? []) as string[]).map((a) => a.toLowerCase());
	if (allowed.length > 0 && !allowed.includes(address)) {
		return c.json({ error: "Mailbox creation is restricted to configured EMAIL_ADDRESSES" }, 403);
	}
	const key = mailboxKey(address);
	if (await c.env.BUCKET.head(key)) return c.json({ error: "Mailbox already exists", id: address }, 409);
	// Upstream's defaults (POST /api/v1/mailboxes), plus the port's own.
	const settings: Record<string, unknown> & PortMailboxSettings = {
		fromName: address,
		forwarding: { enabled: false, email: "" },
		signature: { enabled: false, text: "" },
		autoReply: { enabled: false, subject: "", message: "" },
		provider: "gmail",
		ownerId: user.id,
	};
	await c.env.BUCKET.put(key, JSON.stringify(settings));
	await c.env.MAILBOX.get(c.env.MAILBOX.idFromName(address)).getFolders();
	const sync = await gmailSyncOf(c.env, address)
		.sync(address, forwardTarget(c.req.raw))
		.catch((error: Error) => ({ error: { code: "gmail_sync_failed", message: error.message, reconnect: false } }));
	return c.json({ id: address, email: address, name: address, settings, sync }, 201);
});

/** The per-mailbox Gmail routes: a Gmail mailbox the caller may use (its owner), else 404. */
const requireGmailMailbox: MiddlewareHandler<GmailContext> = async (c, next) => {
	const user = users.get(c.req.raw);
	if (!user) return c.json({ error: "unauthenticated" }, 401);
	const mailboxId = decodeURIComponent(c.req.param("mailboxId") ?? "").trim().toLowerCase();
	const settings = mailboxId ? await readMailboxSettings(c.env.BUCKET, mailboxId) : null;
	if (!settings || !canUseMailbox(settings, user.id)) return c.json({ error: "Not found" }, 404);
	if (settings.provider !== "gmail") {
		return c.json({ error: "not_gmail", message: `${mailboxId} isn't a Gmail mailbox.` }, 400);
	}
	c.set("mailboxId", mailboxId);
	await next();
};

gmailRoutes.use("/api/v1/mailboxes/:mailboxId/gmail/*", requireGmailMailbox);
gmailRoutes.use("/api/v1/mailboxes/:mailboxId/emails/:emailId/gmail-link", requireGmailMailbox);

gmailRoutes.post("/api/v1/mailboxes/:mailboxId/gmail/sync", async (c) => {
	const mailboxId = c.var.mailboxId;
	return c.json(await gmailSyncOf(c.env, mailboxId).sync(mailboxId, forwardTarget(c.req.raw)));
});

gmailRoutes.get("/api/v1/mailboxes/:mailboxId/gmail/drafting", async (c) => {
	const mailboxId = c.var.mailboxId;
	return c.json(await gmailSyncOf(c.env, mailboxId).drafting(mailboxId));
});

gmailRoutes.get("/api/v1/mailboxes/:mailboxId/emails/:emailId/gmail-link", async (c) => {
	const mailboxId = c.var.mailboxId;
	const result = await gmailSyncOf(c.env, mailboxId).gmailLink(mailboxId, forwardTarget(c.req.raw), c.req.param("emailId"));
	if (!result) return c.json({ error: "Email not found" }, 404);
	return result.ok ? c.json({ url: result.value }) : gmailErrorResponse(c, result.error);
});
