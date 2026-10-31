// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Forward, MailX, Reply, ReplyAll, Star } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Folders, getFolderDisplayName } from "shared/folders";
import { toast } from "sonner";
import { DraftCard } from "~/components/conversation/DraftCard";
import { IconTooltip } from "~/components/conversation/IconTooltip";
import { InlineReply } from "~/components/conversation/InlineReply";
import { isSelf } from "~/components/conversation/people";
import EmailPanelDialogs from "~/components/email-panel/EmailPanelDialogs";
import EmailPanelToolbar, { type ListPosition } from "~/components/email-panel/EmailPanelToolbar";
import ThreadMessage from "~/components/email-panel/ThreadMessage";
import { LabelChip } from "~/components/labels/LabelChip";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "~/components/ui/empty";
import { Skeleton } from "~/components/ui/skeleton";
import { type ConversationRef, useConversationActions } from "~/hooks/useConversationActions";
import { useHotkeys } from "~/hooks/useHotkeys";
import { useMailRoute } from "~/hooks/useMailRoute";
import { type ComposeMode, type ComposeOptions, useUIStore } from "~/hooks/useUIStore";
import { cn } from "~/lib/cn";
import { mailboxDisplayName, splitEmailList, toEmailListValue } from "~/lib/utils";
import { queryKeys } from "~/queries/keys";
import { useDeleteEmail, useEmail, useReplyToEmail, useSendEmail, useThreadReplies } from "~/queries/emails";
import { useFolders } from "~/queries/folders";
import { useSetThreadLabels } from "~/queries/labels";
import { useMailbox } from "~/queries/mailboxes";
import api from "~/services/api";
import type { Email, Folder, Mailbox } from "~/types";

/** Collapsed messages in the middle of a thread beyond this fold into "N older messages". */
const MAX_VISIBLE_COLLAPSED = 4;

function EmailPanelSkeleton() {
	return (
		<div className="flex h-full flex-col" aria-busy aria-label="Loading conversation">
			<div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
				{Array.from({ length: 6 }, (_, i) => (
					<Skeleton key={i} className="size-7 rounded-md" />
				))}
			</div>
			<div className="space-y-6 px-4 py-5 md:px-6">
				<Skeleton className="h-7 w-2/3 max-w-xl" />
				<div className="flex items-center gap-3">
					<Skeleton className="size-9 rounded-full" />
					<div className="flex-1 space-y-2">
						<Skeleton className="h-3.5 w-48" />
						<Skeleton className="h-3 w-28" />
					</div>
					<Skeleton className="h-3 w-24" />
				</div>
				<div className="space-y-2.5 md:pl-12">
					<Skeleton className="h-3 w-full" />
					<Skeleton className="h-3 w-11/12" />
					<Skeleton className="h-3 w-4/6" />
					<Skeleton className="h-3 w-3/4" />
				</div>
			</div>
		</div>
	);
}

function ConversationNotFound({ onBack }: { onBack: () => void }) {
	return (
		<Empty className="h-full">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<MailX />
				</EmptyMedia>
				<EmptyTitle>Conversation not found</EmptyTitle>
				<EmptyDescription>This conversation doesn't exist or was deleted.</EmptyDescription>
			</EmptyHeader>
			<EmptyContent>
				<Button variant="outline" onClick={onBack}>
					<ArrowLeft />
					Back to list
				</Button>
			</EmptyContent>
		</Empty>
	);
}

/** A row of the thread: a message, or the fold standing for several collapsed ones. */
type ThreadRow = { kind: "message"; email: Email } | { kind: "fold"; count: number };

/**
 * The open conversation (docs/UI.md "Conversation"), full-pane in place of
 * the list: toolbar, subject with folder and labels, messages oldest first
 * (collapsed except the newest and unread ones), the agent's drafts as draft
 * cards, and Reply / Reply all / Forward opening the inline composer.
 */
export default function EmailPanel({ emailId }: { emailId: string }) {
	const { mailboxId: routeMailboxId, folder, backToList, openConversation, conversationPath } = useMailRoute();
	const navigate = useNavigate();
	const mailboxId = routeMailboxId ?? "";
	const qc = useQueryClient();
	const { data: email, isError, isPending } = useEmail(mailboxId, emailId);
	const { data: threadRaw, isFetching: threadFetching } = useThreadReplies(mailboxId, email?.thread_id);
	const { data: folders = [] } = useFolders(mailboxId) as { data?: Folder[] };
	const { data: currentMailbox } = useMailbox(mailboxId) as { data?: Mailbox };
	const listContext = useUIStore((s) => s.listContext);
	const actions = useConversationActions(mailboxId);
	const setThreadLabels = useSetThreadLabels();
	const deleteEmailMut = useDeleteEmail();
	const sendEmailMut = useSendEmail();
	const replyMut = useReplyToEmail();

	const [sendingDraftId, setSendingDraftId] = useState<string | null>(null);
	const [sourceViewEmail, setSourceViewEmail] = useState<Email | null>(null);
	const [previewImage, setPreviewImage] = useState<{ url: string; filename: string } | null>(null);
	const [toggled, setToggled] = useState<Set<string>>(new Set());
	const [unfolded, setUnfolded] = useState(false);
	const [composer, setComposer] = useState<ComposeOptions | null>(null);
	const [composerDraftId, setComposerDraftId] = useState<string | null>(null);
	const windowDraftId = useUIStore((s) => (s.compose.open ? s.compose.options.draftEmail?.id || null : null));
	const [labelPickerOpen, setLabelPickerOpen] = useState(false);
	const [confirmDeleteForever, setConfirmDeleteForever] = useState(false);

	// A new conversation starts fresh: default expansion, no composer.
	useEffect(() => {
		setToggled(new Set());
		setUnfolded(false);
		setComposer(null);
		setComposerDraftId(null);
	}, [emailId]);

	// A conversation is never keyed on a draft: saving one replaces it under a
	// new id, and the page would 404 under the composer. A page opened at a
	// draft moves to the thread's latest message that isn't one; a page whose
	// draft is gone moves to what's left of the thread, else back to the list.
	const pageDraft = email && email.id === emailId && email.folder_id === Folders.DRAFT ? email : null;
	const draftAnchor = useMemo(() => {
		if (!pageDraft || !threadRaw) return null;
		const kept = threadRaw.filter((m) => m.folder_id !== Folders.DRAFT);
		const others = threadRaw.filter((m) => m.id !== pageDraft.id);
		const pick = kept.length > 0 ? kept : isError ? others : [];
		return pick.reduce<Email | null>((a, m) => (!a || new Date(m.date) > new Date(a.date) ? m : a), null);
	}, [pageDraft, threadRaw, isError]);
	const leavingDraft = Boolean(pageDraft && (draftAnchor || isError));
	useEffect(() => {
		if (!pageDraft || threadFetching) return;
		if (draftAnchor) navigate(conversationPath(draftAnchor.id), { replace: true });
		else if (isError) backToList();
	}, [pageDraft, draftAnchor, isError, threadFetching, navigate, conversationPath, backToList]);

	const selfAddress = currentMailbox?.email ?? mailboxId;
	const isDraftFolder = folder === Folders.DRAFT;

	// The whole conversation, oldest first.
	const allMessages = useMemo(() => {
		if (!email) return [];
		const others = (threadRaw ?? []).filter((m) => m.id !== email.id);
		return [email, ...others].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
	}, [email, threadRaw]);

	const isDraft = useCallback(
		(m: Email) => m.folder_id === Folders.DRAFT || (isDraftFolder && m.id === emailId && !m.folder_id),
		[isDraftFolder, emailId],
	);
	const messages = useMemo(() => allMessages.filter((m) => !isDraft(m)), [allMessages, isDraft]);
	const drafts = useMemo(() => allMessages.filter(isDraft), [allMessages, isDraft]);

	// The message a reply answers: the latest one someone else sent, else the latest.
	const lastReceived = useMemo(() => {
		const received = messages.filter((m) => !isSelf(m.sender, selfAddress));
		return received[received.length - 1] ?? messages[messages.length - 1] ?? email;
	}, [messages, selfAddress, email]);
	const latest = messages[messages.length - 1] ?? email;

	const isExpandedByDefault = useCallback(
		(m: Email, index: number) => index === messages.length - 1 || !m.read,
		[messages.length],
	);
	const isExpanded = (m: Email, index: number) => isExpandedByDefault(m, index) !== toggled.has(m.id);

	// Gmail's fold: the collapsed run after the first message, up to the first
	// expanded one (keeping the one just before the newest), when it's long.
	const rows = useMemo<ThreadRow[]>(() => {
		const all: ThreadRow[] = messages.map((m) => ({ kind: "message", email: m }));
		if (unfolded || messages.length < 2) return all;
		let end = messages.findIndex((m, i) => i > 0 && isExpandedByDefault(m, i));
		if (end < 0) end = messages.length - 1;
		end = Math.min(end, messages.length - 2);
		const hidden = end - 1;
		if (hidden <= MAX_VISIBLE_COLLAPSED) return all;
		return [all[0], { kind: "fold", count: hidden }, ...all.slice(end)];
	}, [messages, unfolded, isExpandedByDefault]);

	const folderId = folder ?? email?.folder_id ?? Folders.INBOX;
	const moveToFolders = useMemo(() => folders.filter((f) => f.id !== folderId && f.id !== Folders.DRAFT && f.id !== Folders.SENT), [folders, folderId]);
	const folderName = folders.find((f) => f.id === folderId)?.name ?? getFolderDisplayName(folderId);

	const ref: ConversationRef | null = email
		? { id: email.id, thread_id: email.thread_id, thread_count: Math.max(messages.length, 1) }
		: null;
	const refs = ref ? [ref] : [];
	// The folder actions move out of: the route's, or in label and search views a
	// Trash or Spam message's own (label and search moves leave those two alone).
	const from = folder ?? (folderId === Folders.TRASH || folderId === Folders.SPAM ? folderId : undefined);
	const ownMail = folderId === Folders.SENT || folderId === Folders.DRAFT;
	const threadKey = email ? email.thread_id || email.id : "";
	const labels = email?.labels ?? [];
	const conversationStarred = messages.some((m) => m.starred);

	// "3 of 25" from the list this conversation was opened from.
	const listPosition = useMemo<ListPosition | null>(() => {
		if (!listContext) return null;
		// The list's row may be another message of the conversation (a draft row opens at its thread's latest).
		let index = listContext.ids.indexOf(emailId);
		if (index < 0) index = listContext.ids.findIndex((id) => allMessages.some((m) => m.id === id));
		if (index < 0) return null;
		const newer = listContext.ids[index - 1];
		const older = listContext.ids[index + 1];
		return {
			position: (listContext.page - 1) * listContext.pageSize + index + 1,
			total: listContext.total,
			onNewer: newer ? () => openConversation(newer) : undefined,
			onOlder: older ? () => openConversation(older) : undefined,
		};
	}, [listContext, emailId, allMessages, openConversation]);

	// ---- Conversation actions (each goes back to the list, like Gmail) ----
	const leaveWith = (action: () => Promise<void> | void) => {
		void action();
		backToList();
	};
	const archive = () => leaveWith(() => actions.archive(refs, from));
	const moveToInbox = () => leaveWith(() => actions.moveToInbox(refs, from));
	const spam = () => leaveWith(() => actions.spam(refs, from));
	const notSpam = () => leaveWith(() => actions.notSpam(refs));
	const trash = () => leaveWith(() => actions.trash(refs, from));
	const moveTo = (f: Folder) => leaveWith(() => actions.moveTo(refs, f.id, { from, folderName: f.name }));
	const deleteForever = () => {
		setConfirmDeleteForever(false);
		leaveWith(() => actions.deleteForever(refs, folderId));
	};
	const markUnread = () => leaveWith(() => actions.setRead(refs, false));

	const toggleConversationStar = () => {
		if (conversationStarred) {
			for (const m of messages) if (m.starred) void actions.setStarred(m, false);
		} else if (latest) {
			void actions.setStarred(latest, true);
		}
	};

	// ---- Messages ----
	const toggleMessage = (id: string) =>
		setToggled((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});

	const deleteMessage = async (m: Email) => {
		if (messages.length <= 1) {
			trash();
			return;
		}
		try {
			await api.moveEmail(mailboxId, m.id, Folders.TRASH);
			toast("Message moved to Trash.");
		} catch {
			toast.error("Couldn't delete that message. Try again.");
		} finally {
			qc.invalidateQueries({ queryKey: ["emails", mailboxId] });
			qc.invalidateQueries({ queryKey: queryKeys.folders.list(mailboxId) });
		}
	};

	// ---- Composer ----
	const openComposer = (mode: ComposeMode, original?: Email) => {
		const target = original ?? (mode === "forward" ? latest : lastReceived);
		if (!target) return;
		setComposerDraftId(null);
		setComposer({ mode, originalEmail: target });
	};
	const closeComposer = useCallback(() => {
		setComposer(null);
		setComposerDraftId(null);
	}, []);

	// ---- Drafts (kept from the original panel: send as reply or new, then delete the draft) ----
	const editDraft = (draft: Email) => {
		const original = draft.in_reply_to ? allMessages.find((m) => m.id === draft.in_reply_to) : undefined;
		if (!original) {
			useUIStore.getState().openCompose({ mode: "new", originalEmail: null, draftEmail: draft });
			return;
		}
		setComposerDraftId(draft.id);
		setComposer({ mode: "reply", originalEmail: original, draftEmail: draft });
	};

	const discardDraft = async (draft: Email) => {
		try {
			await deleteEmailMut.mutateAsync({ mailboxId, id: draft.id });
			toast("Draft discarded.");
			if (draft.id === emailId) backToList();
		} catch {
			toast.error("Couldn't discard the draft. Try again.");
		}
	};

	const sendDraft = async (draft: Email) => {
		if (!mailboxId || !currentMailbox) return;
		let target = draft;
		setSendingDraftId(draft.id);
		try {
			if (!target.recipient || !target.subject) {
				try {
					const fresh = await api.getEmail(mailboxId, target.id);
					if (fresh) target = fresh;
				} catch {}
			}
			if (!target.recipient) {
				toast.error("Cannot send: no recipient set on this draft.");
				return;
			}
			const toRecipients = splitEmailList(target.recipient);
			if (toRecipients.length === 0) {
				toast.error("Cannot send: no valid recipient set on this draft.");
				return;
			}
			const fromName = currentMailbox.settings?.fromName || currentMailbox.name;
			const fromValue = fromName && fromName !== currentMailbox.email ? { email: currentMailbox.email, name: fromName } : currentMailbox.email;
			const original = target.in_reply_to ? allMessages.find((m) => m.id === target.in_reply_to) : undefined;
			const emailData = {
				to: toEmailListValue(toRecipients),
				cc: toEmailListValue(splitEmailList(target.cc)),
				bcc: toEmailListValue(splitEmailList(target.bcc)),
				from: fromValue,
				subject: target.subject || "(no subject)",
				html: target.body || "",
				text: target.body ? target.body.replace(/<[^>]*>/g, "").trim() : "",
			};
			if (original) await replyMut.mutateAsync({ mailboxId, emailId: original.id, email: emailData });
			else await sendEmailMut.mutateAsync({ mailboxId, email: emailData });
			await deleteEmailMut.mutateAsync({ mailboxId, id: target.id });
			toast("Message sent.");
			if (target.id === emailId) backToList();
		} catch (err) {
			toast.error((err instanceof Error ? err.message : null) || "Failed to send email.");
		} finally {
			setSendingDraftId(null);
		}
	};

	// ---- Keyboard (Gmail's, while a conversation is open) ----
	const dialogOpen = Boolean(sourceViewEmail || previewImage || confirmDeleteForever);
	useHotkeys(
		{
			u: backToList,
			j: () => listPosition?.onOlder?.(),
			k: () => listPosition?.onNewer?.(),
			e: () => (folderId === Folders.ARCHIVE || folderId === Folders.TRASH ? moveToInbox() : folderId !== Folders.SPAM && !ownMail && archive()),
			"#": () => (folderId === Folders.TRASH || folderId === Folders.SPAM ? setConfirmDeleteForever(true) : trash()),
			"!": () => (folderId === Folders.SPAM ? notSpam() : folderId !== Folders.TRASH && !ownMail && spam()),
			s: toggleConversationStar,
			r: () => openComposer("reply"),
			a: () => openComposer("reply-all"),
			f: () => openComposer("forward"),
			"shift+u": markUnread,
			l: () => setLabelPickerOpen(true),
		},
		{ enabled: Boolean(email) && !dialogOpen },
	);

	if (leavingDraft) return <EmailPanelSkeleton />;
	if (isError) return <ConversationNotFound onBack={backToList} />;
	if (isPending || !email) return <EmailPanelSkeleton />;

	const selfName = mailboxDisplayName(currentMailbox, mailboxId);
	const canReplyAll = lastReceived
		? [...splitEmailList(lastReceived.recipient), ...splitEmailList(lastReceived.cc)].filter((a) => !isSelf(a, selfAddress)).length > 0
		: false;
	// A draft open in the inline reply or the compose window (popped out) shows there, not as a card too.
	const shownDrafts = drafts.filter((d) => d.id !== composerDraftId && d.id !== windowDraftId);

	return (
		<div className="flex h-full min-h-0 flex-col bg-background">
			<EmailPanelToolbar
				mailboxId={mailboxId}
				folderId={folderId}
				moveToFolders={moveToFolders}
				labelTarget={{ threadKey, labels }}
				labelPickerOpen={labelPickerOpen}
				onLabelPickerOpenChange={setLabelPickerOpen}
				listPosition={listPosition}
				onBack={backToList}
				onArchive={archive}
				onMoveToInbox={moveToInbox}
				onSpam={spam}
				onNotSpam={notSpam}
				onTrash={trash}
				onDeleteForever={() => setConfirmDeleteForever(true)}
				onMarkUnread={markUnread}
				onMove={moveTo}
				onShowOriginal={() => setSourceViewEmail(latest ?? email)}
			/>

			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto max-w-5xl pb-16">
					<header className="flex items-start gap-3 px-4 pt-5 pb-3 md:px-6 md:pl-[4.25rem]">
						<div className="min-w-0 flex-1">
							<h1 className="inline text-xl leading-snug font-normal text-foreground [overflow-wrap:anywhere] md:text-[1.375rem]">
								{email.subject || "(no subject)"}
							</h1>
							<span className="ml-2 inline-flex translate-y-[-2px] flex-wrap items-center gap-1.5 align-middle">
								<Badge variant="secondary">{folderName}</Badge>
								{labels.map((label) => (
									<LabelChip
										key={label.id}
										label={label}
										onRemove={() =>
											setThreadLabels.mutate(
												{ mailboxId, threadKey, remove: [label.id] },
												{ onError: () => toast.error("Couldn't remove the label. Try again.") },
											)
										}
									/>
								))}
							</span>
						</div>
						<IconTooltip label={conversationStarred ? "Starred" : "Not starred"}>
							<Button
								variant="ghost"
								size="icon-sm"
								onClick={toggleConversationStar}
								aria-label={conversationStarred ? "Unstar conversation" : "Star conversation"}
								aria-pressed={conversationStarred}
								className="mt-0.5"
							>
								<Star className={cn(conversationStarred && "fill-warning text-warning")} />
							</Button>
						</IconTooltip>
					</header>

					<div className="divide-y divide-border border-y border-border bg-card">
						{rows.map((row) => {
							if (row.kind === "fold") {
								return (
									<div key="fold" className="relative flex h-9 items-center px-4 md:px-6">
										<div className="absolute inset-x-0 top-1/2 border-t border-dashed border-border" aria-hidden />
										<button
											type="button"
											onClick={() => setUnfolded(true)}
											className="relative ml-0.5 flex size-8 items-center justify-center rounded-full border border-border bg-card text-xs font-medium text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
											aria-label={`Show ${row.count} older messages`}
										>
											{row.count}
										</button>
										<span className="relative ml-2 bg-card px-1 text-xs text-muted-foreground">{row.count} older messages</span>
									</div>
								);
							}
							const m = row.email;
							const index = messages.indexOf(m);
							return (
								<ThreadMessage
									key={m.id}
									email={m}
									mailboxId={mailboxId}
									selfAddress={selfAddress}
									selfName={selfName}
									expanded={isExpanded(m, index)}
									canCollapse={messages.length > 1}
									onToggleExpand={() => toggleMessage(m.id)}
									onReply={() => openComposer("reply", m)}
									onReplyAll={() => openComposer("reply-all", m)}
									onForward={() => openComposer("forward", m)}
									onShowOriginal={() => setSourceViewEmail(m)}
									onDelete={() => void deleteMessage(m)}
									onToggleStar={() => void actions.setStarred(m, !m.starred)}
									onPreviewImage={(url, filename) => setPreviewImage({ url, filename })}
								/>
							);
						})}
					</div>

					{shownDrafts.map((draft) => (
						<DraftCard
							key={draft.id}
							draft={draft}
							selfAddress={selfAddress}
							isSending={sendingDraftId === draft.id}
							onEdit={() => editDraft(draft)}
							onSend={() => void sendDraft(draft)}
							onDiscard={() => void discardDraft(draft)}
						/>
					))}

					{composer ? (
						<InlineReply
							key={`${composer.mode}:${composer.originalEmail?.id ?? ""}:${composer.draftEmail?.id ?? ""}`}
							mailboxId={mailboxId}
							options={composer}
							onClose={closeComposer}
							onDraftIdChange={setComposerDraftId}
						/>
					) : (
						messages.length > 0 && (
							<div className="flex flex-wrap gap-2 px-4 pt-4 md:px-6 md:pl-[4.25rem]">
								<Button variant="outline" onClick={() => openComposer("reply")}>
									<Reply />
									Reply
								</Button>
								{canReplyAll && (
									<Button variant="outline" onClick={() => openComposer("reply-all")}>
										<ReplyAll />
										Reply all
									</Button>
								)}
								<Button variant="outline" onClick={() => openComposer("forward")}>
									<Forward />
									Forward
								</Button>
							</div>
						)
					)}
				</div>
			</div>

			<EmailPanelDialogs
				sourceViewEmail={sourceViewEmail}
				previewImage={previewImage}
				onCloseSource={() => setSourceViewEmail(null)}
				onClosePreview={() => setPreviewImage(null)}
			/>

			<AlertDialog open={confirmDeleteForever} onOpenChange={setConfirmDeleteForever}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete forever?</AlertDialogTitle>
						<AlertDialogDescription>
							This conversation will be deleted permanently. This can't be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction variant="destructive" onClick={deleteForever}>
							Delete forever
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
