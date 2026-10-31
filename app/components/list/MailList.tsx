import { AlertCircle } from "lucide-react";
import { type KeyboardEvent, type MouseEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { Folders } from "shared/folders";
import { toast } from "sonner";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "~/components/ui/empty";
import { Skeleton } from "~/components/ui/skeleton";
import { useConversationActions } from "~/hooks/useConversationActions";
import { useHotkeys } from "~/hooks/useHotkeys";
import { useMailRoute } from "~/hooks/useMailRoute";
import { useUIStore } from "~/hooks/useUIStore";
import { cn } from "~/lib/cn";
import { useFolders } from "~/queries/folders";
import api from "~/services/api";
import type { Email, Folder } from "~/types";
import { type BulkActions, MailListToolbar, type SelectFilter } from "./MailListToolbar";
import { MailRow } from "./MailRow";
import { isUnread } from "./participants";

/** Folders a conversation can't be moved into by hand. */
const NOT_MOVE_TARGETS = new Set<string>([Folders.SENT, Folders.DRAFT]);

type Overrides = Record<string, { read?: boolean; starred?: boolean }>;

function applyOverride(email: Email, o: Overrides[string] | undefined): Email {
	if (!o) return email;
	const next = { ...email, ...o };
	if (o.read !== undefined && email.thread_unread_count !== undefined) {
		next.thread_unread_count = o.read ? 0 : Math.max(1, email.thread_unread_count);
	}
	return next;
}

/** A draft that is a new message of its own (not a reply in a conversation) opens in Compose. */
function isStandaloneDraft(email: Email): boolean {
	return email.folder_id === Folders.DRAFT && (email.thread_count ?? 1) <= 1 && !email.in_reply_to;
}

/**
 * Where a reply draft's conversation opens: its latest message that isn't a
 * draft, or null when it has none. Never the draft's own id: every save
 * replaces a draft under a new id, which would leave the page on a 404.
 */
async function conversationAnchor(mailboxId: string, draft: Email): Promise<string | null> {
	if (draft.thread_id) {
		const kept = (await api.getThread(mailboxId, draft.thread_id))
			.filter((m) => m.folder_id !== Folders.DRAFT)
			.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
		if (kept.length > 0) return kept[kept.length - 1]!.id;
	}
	if (draft.in_reply_to) {
		const original = await api.getEmail(mailboxId, draft.in_reply_to).catch(() => null);
		if (original && original.folder_id !== Folders.DRAFT) return original.id;
	}
	return null;
}

function ListSkeleton() {
	return (
		<div aria-busy aria-label="Loading conversations">
			{Array.from({ length: 12 }).map((_, i) => (
				<div key={i} className="flex h-10 items-center gap-3 border-b border-border/70 px-4">
					<Skeleton className="size-4 rounded-[4px]" />
					<Skeleton className="size-4 rounded-full" />
					<Skeleton className="h-3 w-32 lg:w-44" />
					<Skeleton className="h-3 flex-1" style={{ maxWidth: `${50 + ((i * 17) % 40)}%` }} />
					<Skeleton className="ml-auto h-3 w-12" />
				</div>
			))}
		</div>
	);
}

function ListError({ message, onRetry }: { message: string; onRetry: () => void }) {
	return (
		<Empty className="py-20">
			<EmptyHeader>
				<EmptyMedia variant="icon" className="bg-destructive/10 text-destructive">
					<AlertCircle />
				</EmptyMedia>
				<EmptyTitle>Couldn't load your mail</EmptyTitle>
				<EmptyDescription>{message}</EmptyDescription>
			</EmptyHeader>
			<EmptyContent>
				<Button variant="outline" onClick={onRetry}>
					Retry
				</Button>
			</EmptyContent>
		</Empty>
	);
}

export interface MailListProps {
	mailboxId: string;
	/** The toolbar's title (folder, label with its dot, "Search results for …"). */
	title: ReactNode;
	emails: Email[];
	total: number;
	page: number;
	pageSize: number;
	onPageChange: (page: number) => void;
	isLoading: boolean;
	/** The query failed and there's nothing to show. */
	error: unknown;
	isFetching: boolean;
	onRefresh: () => void;
	/** Shown when the list is empty. */
	empty: ReactNode;
	/** The folder on screen (where actions move conversations out of); none for labels and search. */
	folder?: string;
	/** The label on screen: its chip is left out of the rows. */
	labelId?: string;
	selfAddress: string;
	/** Search results name each row's folder. */
	showFolder?: boolean;
	highlight?: (text: string) => ReactNode;
	/** A conversation is open over the list: keep state, hide, no shortcuts. */
	hidden?: boolean;
}

/**
 * The conversation list's body (docs/UI.md "List", "Keyboard"), shared by
 * folders, labels and search: toolbar, rows, selection, the row and bulk
 * actions, and the list's shortcuts. It sets `listContext` for the
 * conversation view's "3 of 25" and older/newer.
 */
export function MailList({
	mailboxId,
	title,
	emails: serverEmails,
	total,
	page,
	pageSize,
	onPageChange,
	isLoading,
	error,
	isFetching,
	onRefresh,
	empty,
	folder,
	labelId,
	selfAddress,
	showFolder,
	highlight,
	hidden = false,
}: MailListProps) {
	const { listPath, openConversation, conversationPath } = useMailRoute();
	const actions = useConversationActions(mailboxId);
	const { data: folders = [] } = useFolders(mailboxId);
	const setListContext = useUIStore((s) => s.setListContext);

	const [selected, setSelected] = useState<Set<string>>(() => new Set());
	const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
	const [overrides, setOverrides] = useState<Overrides>({});
	const [labelPickerOpen, setLabelPickerOpen] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState<Email[] | null>(null);

	const emails = useMemo(
		() => serverEmails.map((e) => applyOverride(e, overrides[e.id])),
		[serverEmails, overrides],
	);

	// Fresh data from the server replaces the optimistic star/read state.
	useEffect(() => setOverrides({}), [serverEmails]);

	// A new list (folder, label, search, page) starts without a selection or focus.
	useEffect(() => {
		setSelected(new Set());
		setFocusedIndex(null);
	}, [listPath]);

	// Rows that left the list (moved, deleted) leave the selection.
	useEffect(() => {
		setSelected((prev) => {
			const ids = new Set(serverEmails.map((e) => e.id));
			const kept = [...prev].filter((id) => ids.has(id));
			return kept.length === prev.size ? prev : new Set(kept);
		});
		setFocusedIndex((i) => (i === null || serverEmails.length === 0 ? null : Math.min(i, serverEmails.length - 1)));
	}, [serverEmails]);

	useEffect(() => {
		if (isLoading) return;
		setListContext({ listPath, ids: serverEmails.map((e) => e.id), page, pageSize, total });
	}, [setListContext, listPath, serverEmails, page, pageSize, total, isLoading]);

	const selectedEmails = emails.filter((e) => selected.has(e.id));
	const focused = focusedIndex !== null ? emails[focusedIndex] : undefined;
	/** What the shortcuts act on: the selection, else the focused row. */
	const targets = selectedEmails.length > 0 ? selectedEmails : focused ? [focused] : [];

	const deletesForever = folder === Folders.TRASH || folder === Folders.SPAM;
	// Sent copies and drafts aren't archived or reported as spam (Gmail offers neither there).
	const ownMail = folder === Folders.SENT || folder === Folders.DRAFT;
	const canArchive = folder !== Folders.ARCHIVE && !ownMail;

	const override = (ids: string[], change: Overrides[string]) =>
		setOverrides((prev) => {
			const next = { ...prev };
			for (const id of ids) next[id] = { ...next[id], ...change };
			return next;
		});

	const clearSelection = () => setSelected(new Set());

	const archive = (list: Email[]) => {
		if (!canArchive || list.length === 0) return;
		clearSelection();
		void actions.archive(list, folder);
	};
	const remove = (list: Email[]) => {
		if (list.length === 0) return;
		if (deletesForever) return setConfirmDelete(list);
		clearSelection();
		void actions.trash(list, folder);
	};
	const spam = (list: Email[]) => {
		if (ownMail || list.length === 0) return;
		clearSelection();
		void (folder === Folders.SPAM ? actions.notSpam(list) : actions.spam(list, folder));
	};
	const setRead = (list: Email[], read: boolean) => {
		if (list.length === 0) return;
		override(
			list.map((e) => e.id),
			{ read },
		);
		void actions.setRead(list, read).catch(() => toast.error("Couldn't update that. Try again."));
	};
	const toggleStar = (email: Email) => {
		override([email.id], { starred: !email.starred });
		void actions.setStarred(email, !email.starred).catch(() => toast.error("Couldn't star that. Try again."));
	};
	const toggleSelect = (id: string) =>
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});

	const selectWhere = (filter: SelectFilter) => {
		const match: Record<SelectFilter, (e: Email) => boolean> = {
			all: () => true,
			none: () => false,
			read: (e) => !isUnread(e),
			unread: (e) => isUnread(e),
			starred: (e) => e.starred,
			unstarred: (e) => !e.starred,
		};
		setSelected(new Set(emails.filter(match[filter]).map((e) => e.id)));
	};

	const open = async (email: Email, event?: MouseEvent | KeyboardEvent) => {
		let target = email.id;
		if (email.folder_id === Folders.DRAFT) {
			try {
				const anchor = isStandaloneDraft(email) ? null : await conversationAnchor(mailboxId, email);
				if (!anchor) {
					// A new message, or a reply whose conversation is gone: edit it in Compose.
					const draftEmail = email.body != null ? email : await api.getEmail(mailboxId, email.id);
					useUIStore.getState().openCompose({ mode: "new", draftEmail });
					return;
				}
				target = anchor;
			} catch {
				toast.error("Couldn't open that draft. Try again.");
				return;
			}
		}
		if (event && (event.metaKey || event.ctrlKey)) {
			window.open(conversationPath(target), "_blank");
			return;
		}
		if (isUnread(email)) setRead([email], true);
		openConversation(target);
	};

	const moveFocus = (delta: number) => {
		if (emails.length === 0) return;
		const next = focusedIndex === null ? 0 : Math.max(0, Math.min(emails.length - 1, focusedIndex + delta));
		setFocusedIndex(next);
		const row = document.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(emails[next].id)}"]`);
		row?.focus({ preventScroll: true });
		row?.scrollIntoView({ block: "nearest" });
	};

	/** Enter on a button inside a row (star, checkbox, a hover action) is that button's, not "open". */
	const fromControl = (event: KeyboardEvent | globalThis.KeyboardEvent) =>
		event.target instanceof Element && !!event.target.closest("button, a, [role=menuitem], [role=checkbox]");

	const ready = !hidden && !isLoading && !error;
	useHotkeys(
		{
			j: () => moveFocus(1),
			k: () => moveFocus(-1),
			o: () => focused && void open(focused),
			enter: (e) => {
				if (!fromControl(e) && focused) void open(focused);
			},
			x: () => focused && toggleSelect(focused.id),
			s: () => focused && toggleStar(focused),
			e: () => archive(targets),
			"#": () => remove(targets),
			"!": () => spam(targets),
			"shift+i": () => setRead(targets, true),
			"shift+u": () => setRead(targets, false),
			l: () => {
				if (selectedEmails.length === 0 && focused) setSelected(new Set([focused.id]));
				if (targets.length > 0) setLabelPickerOpen(true);
			},
			"* a": () => selectWhere("all"),
			"* n": () => selectWhere("none"),
		},
		{ enabled: ready },
	);

	const moveTargets: Folder[] = folders.filter((f) => f.id !== folder && !NOT_MOVE_TARGETS.has(f.id));

	const bulk: BulkActions | null =
		selectedEmails.length > 0
			? {
					count: selectedEmails.length,
					onArchive: canArchive ? () => archive(selectedEmails) : undefined,
					onMoveToInbox:
						folder === Folders.ARCHIVE || folder === Folders.TRASH
							? () => {
									clearSelection();
									void actions.moveToInbox(selectedEmails, folder);
								}
							: undefined,
					spam: ownMail ? undefined : { label: folder === Folders.SPAM ? "Not spam" : "Report spam", onClick: () => spam(selectedEmails) },
					onDelete: () => remove(selectedEmails),
					deleteForever: deletesForever,
					anyUnread: selectedEmails.some(isUnread),
					onMarkRead: () => setRead(selectedEmails, true),
					onMarkUnread: () => setRead(selectedEmails, false),
					moveTargets,
					onMoveTo: (target) => {
						clearSelection();
						void actions.moveTo(selectedEmails, target.id, { from: folder, folderName: target.name });
					},
					mailboxId,
					labelTargets: selectedEmails.map((e) => ({ threadKey: e.thread_id ?? e.id, labels: e.labels ?? [] })),
					labelPickerOpen,
					onLabelPickerOpenChange: setLabelPickerOpen,
				}
			: null;

	const selectState = selected.size === 0 ? "none" : selected.size >= emails.length ? "all" : "some";
	const errorMessage = error instanceof Error && error.message ? error.message : "Something went wrong. Try again.";

	return (
		<div className={cn("flex min-h-0 flex-1 flex-col", hidden && "hidden")}>
			<MailListToolbar
				title={title}
				selectState={selectState}
				onSelect={selectWhere}
				onRefresh={onRefresh}
				isRefreshing={isFetching}
				onMarkAllRead={() => setRead(emails.filter(isUnread), true)}
				canMarkAllRead={emails.some(isUnread)}
				bulk={bulk}
				page={page}
				pageSize={pageSize}
				total={total}
				onPageChange={onPageChange}
				selectable={emails.length > 0}
			/>

			{/* Mobile: room under the last row for the floating Compose button. */}
			<div className="min-h-0 flex-1 overflow-y-auto pb-20 md:pb-0">
				{isLoading ? (
					<ListSkeleton />
				) : error && emails.length === 0 ? (
					<ListError message={errorMessage} onRetry={onRefresh} />
				) : emails.length === 0 ? (
					empty
				) : (
					<div role="list" aria-label="Conversations">
						{emails.map((email, i) => (
							<MailRow
								key={email.id}
								email={email}
								selfAddress={selfAddress}
								selected={selected.has(email.id)}
								focused={focusedIndex === i}
								tabbable={(focusedIndex ?? 0) === i}
								hideLabelId={labelId}
								showFolder={showFolder}
								highlight={highlight}
								onOpen={(event) => void open(email, event)}
								onToggleSelect={() => toggleSelect(email.id)}
								onToggleStar={() => toggleStar(email)}
								onFocus={() => setFocusedIndex(i)}
								actions={{
									onArchive: canArchive ? () => archive([email]) : undefined,
									onDelete: () => remove([email]),
									deleteForever: deletesForever,
									onToggleRead: () => setRead([email], isUnread(email)),
								}}
							/>
						))}
					</div>
				)}
			</div>

			<AlertDialog open={confirmDelete !== null} onOpenChange={(next) => !next && setConfirmDelete(null)}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							Delete {confirmDelete && confirmDelete.length > 1 ? `${confirmDelete.length} conversations` : "this conversation"}{" "}
							forever?
						</AlertDialogTitle>
						<AlertDialogDescription>Its messages are removed for good. This can't be undone.</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => {
								const list = confirmDelete ?? [];
								setConfirmDelete(null);
								clearSelection();
								if (folder) void actions.deleteForever(list, folder);
							}}
						>
							Delete forever
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
