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
 */
export function withNamedAgents<E extends { EMAIL_AGENT: DurableObjectNamespace<any> }>(env: E): E {
	const namespace = env.EMAIL_AGENT;
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
						return (input: RequestInfo | URL, init?: RequestInit) => {
							const request = new Request(input, init);
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
