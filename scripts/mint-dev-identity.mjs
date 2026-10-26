// Prints an identity token signed with `everyapp dev`'s well-known dev key,
// for requests sent straight to the app's internal Vite port as someone
// other than the gateway-lite's seeded owner (a member, an admin, another
// organization). Dev only: a deployed Worker trusts only its gateway's keys.
//
//   node scripts/mint-dev-identity.mjs <owner|admin|member> [organization id, default dev-org]
//   curl -H "x-everyapp-identity: $(node scripts/mint-dev-identity.mjs member)" http://127.0.0.1:<vite port>/api/v1/me
import { DEV_ISSUER, DEV_PRIVATE_KEY_PEM, IDENTITY_DEV_KEY_ID } from "@every-app/sdk/dev";
import { mintIdentityJwt } from "@every-app/sdk/internal";

const [role = "member", orgId = "dev-org"] = process.argv.slice(2);
const token = await mintIdentityJwt(DEV_PRIVATE_KEY_PEM, {
	subject: { sub: `dev-${role}`, email: `${role}@everyapp.localhost`, orgId, orgRole: role },
	// Under `everyapp dev` the Worker's audience is the app id (everyapp.config.ts).
	audience: "openmail",
	issuer: DEV_ISSUER,
	channel: "web",
	keyId: IDENTITY_DEV_KEY_ID,
});
process.stdout.write(token);
