import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { Folders } from "shared/folders";
import { toast } from "sonner";
import { queryKeys } from "~/queries/keys";
import api from "~/services/api";
import type { Email } from "~/types";

/** A conversation as the list (or the open conversation) knows it. */
export type ConversationRef = Pick<Email, "id" | "thread_id" | "thread_count">;

type Moved = { id: string; from: string };

const MOVE_VERB: Record<string, string> = {
	[Folders.ARCHIVE]: "archived",
	[Folders.TRASH]: "moved to Trash",
	[Folders.SPAM]: "marked as spam",
	[Folders.INBOX]: "moved to Inbox",
};

function noun(n: number) {
	return n === 1 ? "Conversation" : `${n} conversations`;
}

/** Folders a conversation move never takes mail out of, unless it's the folder on screen. */
const STAYS_PUT = new Set<string>([Folders.SENT, Folders.DRAFT]);
/** Left out of moves from label and search views (as a label's listing leaves them out). */
const HIDDEN_FROM_VIEWS = new Set<string>([Folders.TRASH, Folders.SPAM]);

/**
 * Whether a message in `folderId` moves with its conversation when it goes
 * to `to`. With a folder (`from`), only that folder's messages, except from
 * Sent, which acts on the whole conversation as Gmail does: Delete takes
 * every message but drafts to Trash, anything else moves the received mail
 * and leaves the Sent copies. With no folder (labels, search), every message
 * but drafts, Sent copies and what's in Trash or Spam.
 */
export function movesWith(folderId: string | null | undefined, from?: string, to?: string): boolean {
	const f = folderId ?? Folders.INBOX;
	if (from === Folders.SENT) {
		if (f === Folders.DRAFT || HIDDEN_FROM_VIEWS.has(f)) return false;
		return to === Folders.TRASH || f !== Folders.SENT;
	}
	if (from) return f === from;
	return !STAYS_PUT.has(f) && !HIDDEN_FROM_VIEWS.has(f);
}

/**
 * Gmail's conversation actions, shared by the list (one row or a selection)
 * and the open conversation. A conversation moves as a whole: the messages
 * `movesWith()` picks, so never its drafts or Sent copies unless the move is
 * out of Drafts or Sent. Moves act at once and toast with Undo, which puts
 * each message that moved back where it was.
 */
export function useConversationActions(mailboxId: string | undefined) {
	const qc = useQueryClient();

	const invalidate = useCallback(() => {
		if (!mailboxId) return;
		qc.invalidateQueries({ queryKey: ["emails", mailboxId] });
		qc.invalidateQueries({ queryKey: ["search", mailboxId] });
		qc.invalidateQueries({ queryKey: queryKeys.folders.list(mailboxId) });
		qc.invalidateQueries({ queryKey: queryKeys.labels.list(mailboxId) });
	}, [qc, mailboxId]);

	/** The messages of each conversation, with the folder each is in now. */
	const messagesOf = useCallback(
		async (refs: ConversationRef[], from?: string, to?: string): Promise<Moved[]> => {
			if (!mailboxId) return [];
			const lists = await Promise.all(
				refs.map(async (ref) => {
					// A row's thread_count can be missing (search) or not loaded yet (an open
					// conversation): any thread id means the whole thread.
					const messages = ref.thread_id
						? await api.getThread(mailboxId, ref.thread_id)
						: [await api.getEmail(mailboxId, ref.id)];
					return messages
						.filter((m) => movesWith(m.folder_id, from, to))
						.map((m) => ({ id: m.id, from: m.folder_id ?? Folders.INBOX }));
				}),
			);
			// Two selected rows of one conversation (search) move its messages once.
			const seen = new Set<string>();
			return lists.flat().filter((m) => !seen.has(m.id) && !!seen.add(m.id));
		},
		[mailboxId],
	);

	/** Move conversations to `folderId`, with an Undo toast. Resolves when moved. */
	const moveTo = useCallback(
		async (refs: ConversationRef[], folderId: string, opts: { from?: string; folderName?: string } = {}) => {
			if (!mailboxId || refs.length === 0) return;
			try {
				const messages = (await messagesOf(refs, opts.from, folderId)).filter((m) => m.from !== folderId);
				if (messages.length === 0) {
					invalidate();
					toast("Nothing to move: sent mail and drafts stay where they are.");
					return;
				}
				await Promise.all(messages.map((m) => api.moveEmail(mailboxId, m.id, folderId)));
				invalidate();
				const verb = MOVE_VERB[folderId] ?? `moved to ${opts.folderName ?? folderId}`;
				toast(`${noun(refs.length)} ${verb}.`, {
					action: {
						label: "Undo",
						onClick: async () => {
							await Promise.all(messages.map((m) => api.moveEmail(mailboxId, m.id, m.from)));
							invalidate();
							toast("Action undone.");
						},
					},
				});
			} catch {
				invalidate();
				toast.error("Couldn't move that. Try again.");
			}
		},
		[mailboxId, messagesOf, invalidate],
	);

	/** Delete forever (Trash and Spam only): the caller confirms first. */
	const deleteForever = useCallback(
		async (refs: ConversationRef[], from: string) => {
			if (!mailboxId || refs.length === 0) return;
			try {
				const messages = await messagesOf(refs, from);
				await Promise.all(messages.map((m) => api.deleteEmail(mailboxId, m.id)));
				invalidate();
				toast(`${noun(refs.length)} deleted forever.`);
			} catch {
				invalidate();
				toast.error("Couldn't delete that. Try again.");
			}
		},
		[mailboxId, messagesOf, invalidate],
	);

	/** Mark whole conversations read or unread. */
	const setRead = useCallback(
		async (refs: ConversationRef[], read: boolean) => {
			if (!mailboxId || refs.length === 0) return;
			try {
				await Promise.all(
					refs.map((ref) =>
						// Unread marks the latest message unread, which makes the conversation unread.
						read && ref.thread_id
							? api.markThreadRead(mailboxId, ref.thread_id)
							: api.updateEmail(mailboxId, ref.id, { read }),
					),
				);
			} finally {
				invalidate();
			}
		},
		[mailboxId, invalidate],
	);

	/** Star or unstar the message the row stands for. */
	const setStarred = useCallback(
		async (ref: ConversationRef, starred: boolean) => {
			if (!mailboxId) return;
			try {
				await api.updateEmail(mailboxId, ref.id, { starred });
			} finally {
				invalidate();
			}
		},
		[mailboxId, invalidate],
	);

	return {
		archive: (refs: ConversationRef[], from?: string) => moveTo(refs, Folders.ARCHIVE, { from }),
		trash: (refs: ConversationRef[], from?: string) => moveTo(refs, Folders.TRASH, { from }),
		spam: (refs: ConversationRef[], from?: string) => moveTo(refs, Folders.SPAM, { from }),
		notSpam: (refs: ConversationRef[]) => moveTo(refs, Folders.INBOX, { from: Folders.SPAM }),
		moveToInbox: (refs: ConversationRef[], from?: string) => moveTo(refs, Folders.INBOX, { from }),
		moveTo,
		deleteForever,
		setRead,
		setStarred,
	};
}
