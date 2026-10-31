/**
 * The mail URLs, in one place (docs/UI.md "Main": the URL names the
 * conversation). Pure, so it is unit tested; components use
 * `useMailRoute()` from app/hooks/useMailRoute.ts.
 *
 *   /mailbox/:mailboxId/emails/:folder[/:emailId]
 *   /mailbox/:mailboxId/labels/:labelId[/:emailId]
 *   /mailbox/:mailboxId/search[/:emailId]?q=...
 */

export type MailView =
	| { kind: "folder"; folder: string }
	| { kind: "label"; labelId: string }
	| { kind: "search" }
	| { kind: "other" };

export function mailboxPath(mailboxId: string): string {
	return `/mailbox/${mailboxId}`;
}

export function folderPath(mailboxId: string, folder: string): string {
	return `${mailboxPath(mailboxId)}/emails/${encodeURIComponent(folder)}`;
}

export function labelPath(mailboxId: string, labelId: string): string {
	return `${mailboxPath(mailboxId)}/labels/${encodeURIComponent(labelId)}`;
}

export function searchPath(mailboxId: string, query: string): string {
	return `${mailboxPath(mailboxId)}/search?q=${encodeURIComponent(query)}`;
}

/** The list's path (without query string) for a view; "other" views list the Inbox. */
function listBase(mailboxId: string, view: MailView): string {
	switch (view.kind) {
		case "folder":
			return folderPath(mailboxId, view.folder);
		case "label":
			return labelPath(mailboxId, view.labelId);
		case "search":
			return `${mailboxPath(mailboxId)}/search`;
		default:
			return folderPath(mailboxId, "inbox");
	}
}

/**
 * The list and conversation paths for the current view. `search` is the
 * current query string (`?q=...&page=2`), kept on both so a search, or a
 * page of a list, survives opening a conversation and coming back.
 */
export function mailPaths(mailboxId: string, view: MailView, search = "") {
	const base = listBase(mailboxId, view);
	const query = view.kind === "other" ? "" : search;
	return {
		listPath: `${base}${query}`,
		conversationPath: (emailId: string) => `${base}/${encodeURIComponent(emailId)}${query}`,
	};
}
