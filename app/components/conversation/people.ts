import { splitEmailList } from "~/lib/utils";
import type { LabelColor } from "~/types";

/** A mail address as headers carry it: `Name <addr>` or a bare `addr`. */
export interface Person {
	/** The display name, or the address when there is none. */
	name: string;
	address: string;
	/** Whether `name` is a real display name (not the address again). */
	hasName: boolean;
}

export function parsePerson(raw: string): Person {
	const trimmed = raw.trim();
	const match = trimmed.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
	if (match) {
		const name = match[1].trim();
		const address = match[2].trim();
		return { name: name || address, address, hasName: Boolean(name) };
	}
	return { name: trimmed, address: trimmed, hasName: false };
}

export function isSelf(raw: string, selfAddress?: string): boolean {
	if (!selfAddress) return false;
	return parsePerson(raw).address.toLowerCase() === selfAddress.toLowerCase();
}

/** "to me", "to me, Sam", "to sam@x.com": Gmail's short recipient line. */
export function shortRecipients(recipient: string | undefined, cc: string | undefined, selfAddress?: string): string {
	const all = [...splitEmailList(recipient), ...splitEmailList(cc)];
	if (all.length === 0) return "";
	const names = all.map((raw) => (isSelf(raw, selfAddress) ? "me" : shortName(raw)));
	// "me" first, like Gmail.
	names.sort((a, b) => (a === "me" ? -1 : b === "me" ? 1 : 0));
	return `to ${names.join(", ")}`;
}

/** A first name for a display name, the local part for a bare address. */
function shortName(raw: string): string {
	const person = parsePerson(raw);
	if (person.hasName) return person.name.split(/\s+/)[0];
	return person.address.split("@")[0] || person.address;
}

const AVATAR_COLORS: LabelColor[] = ["sky", "violet", "emerald", "amber", "rose", "fuchsia", "lime", "slate"];

/** A stable tag-chip tone for an address, so a sender keeps one color across the thread. */
export function avatarColor(address: string): LabelColor {
	let hash = 0;
	for (const ch of address.toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
	return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function initialOf(person: Person): string {
	const source = person.hasName ? person.name : person.address;
	return (source.match(/[a-z0-9]/i)?.[0] ?? "?").toUpperCase();
}

/** "2 hours ago", "3 days ago": the date tooltip. */
export function relativeTime(dateStr: string, now = Date.now()): string {
	const then = new Date(dateStr).getTime();
	if (Number.isNaN(then)) return "";
	const seconds = Math.round((then - now) / 1000);
	const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
	const units: [Intl.RelativeTimeFormatUnit, number][] = [
		["year", 31_536_000],
		["month", 2_592_000],
		["week", 604_800],
		["day", 86_400],
		["hour", 3_600],
		["minute", 60],
	];
	for (const [unit, size] of units) {
		if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
	}
	return "just now";
}
