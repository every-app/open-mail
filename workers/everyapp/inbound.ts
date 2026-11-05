import { mailboxAutoDraftOn } from "./mailbox-settings";

/** What the auto-draft trigger answers while the mailbox's auto-drafting is off. */
export const AUTO_DRAFT_OFF = "auto_draft_off";

/**
 * The env the `email()` handler gives upstream's receiveEmail().
 *
 * receiveEmail() (byte-identical to upstream) wakes the mailbox's chat agent
 * for an auto-draft with
 * `env.EMAIL_AGENT.get(env.EMAIL_AGENT.idFromName(mailboxId)).fetch(...)`.
 * partyserver 0.3.3 (under agents 0.7.6) refuses a request to an Agent that
 * has never been addressed by name ("Missing namespace or room headers when
 * connecting to EmailAgent"), and an Agent learns its name only from a
 * request routeAgentRequest() made. So mail to a mailbox whose chat panel was
 * never opened got no auto-draft. This env names the agent on that request
 * the way routeAgentRequest() does (the `x-partykit-room` header), which also
 * stores the name for later requests.
 *
 * It is also where auto-drafting is switched: the agent's `/onNewEmail`
 * (the auto-draft trigger, from receiveEmail() and from the Gmail sync) is
 * sent only when the mailbox's settings turn `autoDraft` on
 * (./mailbox-settings.ts); otherwise it answers `{ skipped: "auto_draft_off" }`
 * without waking the agent, and the mail is drafted for only when asked
 * (MCP's `draft_reply`, the agent's chat).
 */
export function withNamedAgents<E extends { EMAIL_AGENT: unknown; BUCKET: R2Bucket }>(env: E): E {
	// Untyped on purpose: the stub's RPC type is irrelevant here (and too deep
	// for tsc to instantiate generically).
	const namespace = env.EMAIL_AGENT as DurableObjectNamespace;
	const names = new Map<string, string>();
	const emailAgent = {
		idFromName(name: string): DurableObjectId {
			const id = namespace.idFromName(name);
			names.set(id.toString(), name);
			return id;
		},
		get(id: DurableObjectId, options?: DurableObjectNamespaceGetDurableObjectOptions) {
			const stub = namespace.get(id, options);
			const name = names.get(id.toString());
			if (!name) return stub;
			return new Proxy(stub, {
				get(target, property) {
					if (property === "fetch") {
						return async (input: RequestInfo | URL, init?: RequestInit) => {
							const request = new Request(input, init);
							if (new URL(request.url).pathname === "/onNewEmail" && !(await mailboxAutoDraftOn(env.BUCKET, name))) {
								await request.body?.cancel();
								return Response.json({ skipped: AUTO_DRAFT_OFF });
							}
							request.headers.set("x-partykit-room", name);
							return target.fetch(request);
						};
					}
					const value = Reflect.get(target, property);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		},
	};
	const named = new Proxy(namespace, {
		get(target, property) {
			if (property === "idFromName" || property === "get") return emailAgent[property];
			const value = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return { ...env, EMAIL_AGENT: named };
}
