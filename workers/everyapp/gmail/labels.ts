/**
 * Gmail labels ↔ OpenMail folders and flags (docs/GMAIL.md, "Folders ↔
 * labels"). Upstream's MailboxDO gives each email one folder and two flags;
 * Gmail gives each message any number of labels. The folder is derived from
 * the system labels, `read` and `starred` from UNREAD and STARRED, and the
 * rest (the person's own labels) stay in GmailSync's map.
 */
import { Folders, type FolderId } from "../../../shared/folders";

export const SYSTEM_LABELS = new Set([
	"INBOX",
	"SENT",
	"DRAFT",
	"TRASH",
	"SPAM",
	"STARRED",
	"UNREAD",
	"IMPORTANT",
	"CHAT",
]);

/** A label Gmail owns (INBOX, CATEGORY_UPDATES, …), as opposed to one the person made. */
export function isSystemLabel(id: string): boolean {
	return SYSTEM_LABELS.has(id) || id.startsWith("CATEGORY_");
}

/** The folder a message with these labels sits in: TRASH and SPAM win, then DRAFT, INBOX, SENT; anything else is archived. */
export function folderOf(labelIds: readonly string[]): FolderId {
	const has = (id: string) => labelIds.includes(id);
	if (has("TRASH")) return Folders.TRASH;
	if (has("SPAM")) return Folders.SPAM;
	if (has("DRAFT")) return Folders.DRAFT;
	if (has("INBOX")) return Folders.INBOX;
	if (has("SENT")) return Folders.SENT;
	return Folders.ARCHIVE;
}

/** read, starred and folder as MailboxDO stores them. */
export function stateOf(labelIds: readonly string[]): { folder: FolderId; read: boolean; starred: boolean } {
	return { folder: folderOf(labelIds), read: !labelIds.includes("UNREAD"), starred: labelIds.includes("STARRED") };
}

/** The person's own labels among `labelIds`. */
export function userLabelsOf(labelIds: readonly string[]): string[] {
	return labelIds.filter((id) => !isSystemLabel(id));
}

/** `labels` after adding and removing, order kept, no duplicates. */
export function applyLabelChange(labels: readonly string[], add: readonly string[] = [], remove: readonly string[] = []): string[] {
	const out = labels.filter((id) => !remove.includes(id));
	for (const id of add) if (!out.includes(id) && !remove.includes(id)) out.push(id);
	return out;
}

/** What Gmail does when an email moves from one folder to another in OpenMail. */
export interface MoveChange {
	/** Call messages.untrash first (leaving Trash). */
	untrash?: boolean;
	/** Call messages.trash (entering Trash); nothing else is needed. */
	trash?: boolean;
	add: string[];
	remove: string[];
}

/**
 * The Gmail side of `moveEmail(from → to)`: archive removes INBOX, inbox adds
 * it, spam adds SPAM, trash is messages.trash. Moving into Sent, Drafts or a
 * folder of the person's own has no Gmail meaning: null (local only).
 */
export function moveChange(from: string | null | undefined, to: string): MoveChange | null {
	if (from === to) return null;
	if (to === Folders.TRASH) return { trash: true, add: [], remove: [] };
	const untrash = from === Folders.TRASH ? { untrash: true } : {};
	switch (to) {
		case Folders.INBOX:
			return { ...untrash, add: ["INBOX"], remove: ["SPAM"] };
		case Folders.ARCHIVE:
			return { ...untrash, add: [], remove: ["INBOX", "SPAM"] };
		case Folders.SPAM:
			return { ...untrash, add: ["SPAM"], remove: ["INBOX"] };
		default:
			return null;
	}
}

/** The label changes `updateEmail(id, { read, starred })` means. */
export function flagChange({ read, starred }: { read?: boolean; starred?: boolean }): { add: string[]; remove: string[] } {
	const add: string[] = [];
	const remove: string[] = [];
	if (read !== undefined) (read ? remove : add).push("UNREAD");
	if (starred !== undefined) (starred ? add : remove).push("STARRED");
	return { add, remove };
}
