/**
 * Whom a gateway call is for when the code names nobody.
 *
 * Since @every-app/sdk 0.3.0-rc.9 a call with no `for`, made outside a
 * request everyApp() serves and outside withOrganization(), is refused as
 * nobody's (RequestContextError). Every request path here passes the
 * request; what passes nothing is background work: the agent's model calls
 * on a Worker without EVERY_APP_ORG_ID (`everyapp dev`), the email status
 * read. Those are the app's own background work, which the gateway
 * attributes to the app's organization: `{ background: true }`, what an
 * absent `for` meant before rc.9. A shared app's Worker still has to name
 * the organization (the SDK refuses this there).
 */
import type { GatewayCallFor } from "@every-app/sdk/server";

export const APP_BACKGROUND_WORK = { background: true } as const satisfies GatewayCallFor;

export function callFor(target: GatewayCallFor | undefined): GatewayCallFor {
	return target ?? APP_BACKGROUND_WORK;
}
