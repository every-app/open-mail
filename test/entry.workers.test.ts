// The production entry (workers/app.ts) inside workerd, with the real
// Durable Objects and a local R2 bucket (the workers project in
// vitest.config.ts). It proves the project's wiring as much as the entry:
// everyApp() fails closed without the gateway's key or identity, and with a
// minted identity the request reaches upstream's API, which writes the
// mailbox's settings to R2 and runs MailboxDO's migrations.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { mintIdentityJwt } from "@every-app/sdk/internal";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../workers/app";

const ISSUER = env.EVERYAPP_IDENTITY_ISSUER as string;
const AUDIENCE = env.EVERYAPP_AUDIENCE as string;
const ORIGIN = "https://openmail.gateway.example.com";

function pem(label: string, der: ArrayBuffer) {
	const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
	return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;
}

/** A throwaway gateway signing key: the entry gets its public half in env. */
async function gatewayKey() {
	const pair = (await crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	return {
		privateKeyPem: pem("PRIVATE KEY", (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer),
		publicKeyPem: pem("PUBLIC KEY", (await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer),
	};
}

async function call(request: Request, extraEnv: Record<string, unknown> = {}) {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, { ...env, ...extraEnv } as Cloudflare.Env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

describe("the production entry in workerd", () => {
	let key: Awaited<ReturnType<typeof gatewayKey>>;
	let keys: Record<string, string>;
	beforeAll(async () => {
		key = await gatewayKey();
		keys = { EVERYAPP_IDENTITY_PUBLIC_KEYS: JSON.stringify([key.publicKeyPem]) };
	});

	it("fails closed: no gateway key set is a 500, no identity on the request a 401", async () => {
		const misconfigured = await call(new Request(`${ORIGIN}/api/v1/config`));
		expect(misconfigured.status).toBe(500);
		expect(await misconfigured.json()).toMatchObject({ error: "misconfigured" });

		const anonymous = await call(new Request(`${ORIGIN}/api/v1/config`), keys);
		expect(anonymous.status).toBe(401);
		expect(await anonymous.json()).toMatchObject({ error: "unauthenticated" });
	});

	it("serves an owner's request: the mailbox lands in R2 and its Durable Object has the six folders", async () => {
		const identity = await mintIdentityJwt(key.privateKeyPem, {
			issuer: ISSUER,
			audience: AUDIENCE,
			subject: { sub: "user-1", email: "owner@example.com", orgId: "org-1", orgRole: "owner" },
		});
		const headers = { "x-everyapp-identity": identity, "content-type": "application/json" };

		// Storage is shared across the project's tests: a fresh address each run.
		const address = `team-${crypto.randomUUID().slice(0, 8)}@example.com`;

		const created = await call(
			new Request(`${ORIGIN}/api/v1/mailboxes`, {
				method: "POST",
				headers,
				body: JSON.stringify({ name: "Team", email: address.toUpperCase() }),
			}),
			keys,
		);
		expect(created.status).toBe(201);
		expect(await created.json()).toMatchObject({ id: address });

		expect(await env.BUCKET.head(`mailboxes/${address}.json`)).not.toBeNull();
		const folders = await env.MAILBOX.get(env.MAILBOX.idFromName(address)).getFolders();
		expect(folders.map((f: { id: string }) => f.id).sort()).toEqual(["archive", "draft", "inbox", "sent", "spam", "trash"]);

		const listed = await call(new Request(`${ORIGIN}/api/v1/mailboxes`, { headers }), keys);
		expect(listed.status).toBe(200);
		expect(await listed.json()).toContainEqual(expect.objectContaining({ id: address }));
	});

});
