import { Folders } from "shared/folders";
import type { Email } from "~/types";

/** A list row's conversation: unread when any message in it is. */
export function isUnread(email: Email): boolean {
	if (email.thread_unread_count !== undefined) return email.thread_unread_count > 0;
	return !email.read;
}

/** Names by local part, the mailbox's own address as "me", without repeats. */
function names(addresses: string, selfAddress: string): string[] {
	return addresses
		.split(",")
		.map((p) => p.trim())
		.filter(Boolean)
		.map((p) => {
			const address = (p.match(/<([^>]+)>/)?.[1] ?? p).toLowerCase();
			return address === selfAddress ? "me" : address.split("@")[0];
		})
		.filter((name, i, all) => all.indexOf(name) === i);
}

function join(list: string[]): string {
	return list.length <= 3 ? list.join(", ") : `${list.slice(0, 2).join(", ")} +${list.length - 2}`;
}

/** Sent and Drafts rows name the recipients, as Gmail does: there the sender is always the mailbox. */
export function namesRecipients(email: Email): boolean {
	return email.folder_id === Folders.SENT || email.folder_id === Folders.DRAFT;
}

/**
 * The row's first column: who the conversation is with. "me" stands for the
 * mailbox's own address; Sent and Drafts show "To: …".
 */
export function participantsLabel(email: Email, selfAddress: string): string {
	const self = selfAddress.toLowerCase();
	if (namesRecipients(email)) {
		const to = names(email.recipient || "", self);
		if (to.length > 0) return `To: ${join(to)}`;
	}
	const from = names(email.participants || email.sender || "", self);
	return from.length > 0 ? join(from) : "(unknown sender)";
}

/** The letter in the mobile row's avatar. */
export function avatarInitial(email: Email, selfAddress: string): string {
	const label = participantsLabel(email, selfAddress).replace(/^To: /, "");
	return (label.match(/[a-z0-9]/i)?.[0] ?? "?").toUpperCase();
}
