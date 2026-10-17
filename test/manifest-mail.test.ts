// The manifest's mail settings agree with each other: the inbound addresses
// Email Routing hands to the Worker (`email.inbound`, routes `everyapp
// deploy` creates) are on the domains mailboxes can be created on (DOMAINS,
// from `capabilities.email.senders`), and both lists are what the CLI's
// strict schema takes (lowercase "*@<domain>" or "<local>@<domain>").
// `pnpm check:deploy` runs the CLI's own schema; this is the fast loop.
import { describe, expect, it } from "vitest";
import manifest from "../everyapp.config";

const ADDRESS = /^(\*|[a-z0-9!#$%&'*+/=?^_`{|}~.-]+)@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1);
const senders: readonly string[] = manifest.capabilities.email.senders;
const inbound: readonly string[] = manifest.email.inbound;

describe("manifest mail settings", () => {
	it("routes inbound mail to the Worker only on domains mailboxes can be created on", () => {
		expect(inbound.length).toBeGreaterThan(0);
		const senderDomains = new Set(senders.map(domainOf));
		expect(inbound.filter((address) => !senderDomains.has(domainOf(address)))).toEqual([]);
	});

	it("writes every sender and inbound address the way the CLI's schema takes it", () => {
		for (const address of [...senders, ...inbound]) expect(address).toMatch(ADDRESS);
		expect(new Set(inbound).size).toBe(inbound.length);
	});
});
