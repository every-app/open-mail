// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { ChevronDown, Code, Forward, MoreVertical, Paperclip, Reply, ReplyAll, Star, Trash2 } from "lucide-react";
import { useState } from "react";
import EmailAttachmentList from "~/components/EmailAttachmentList";
import EmailIframe from "~/components/EmailIframe";
import { IconTooltip } from "~/components/conversation/IconTooltip";
import { isSelf, parsePerson, relativeTime, shortRecipients } from "~/components/conversation/people";
import { SenderAvatar } from "~/components/conversation/SenderAvatar";
import { Button } from "~/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/cn";
import { formatDetailDate, formatListDate, getNonInlineAttachments, stripHtml, useInlineImages } from "~/lib/utils";
import type { Email } from "~/types";

export interface ThreadMessageActions {
	onReply: () => void;
	onReplyAll: () => void;
	onForward: () => void;
	onShowOriginal: () => void;
	onDelete: () => void;
	onToggleStar: () => void;
	onPreviewImage: (url: string, filename: string) => void;
}

interface ThreadMessageProps extends ThreadMessageActions {
	email: Email;
	mailboxId?: string;
	/** The mailbox's own address, for "me" and "to me". */
	selfAddress?: string;
	/** What the mailbox is called, for the messages it sent. */
	selfName?: string;
	expanded: boolean;
	/** False for a conversation's only message: it stays open. */
	canCollapse: boolean;
	onToggleExpand: () => void;
}

/** The expanded message body, its inline images fetched by the page (see `useInlineImages`). */
function MessageBody({ email, mailboxId }: { email: Email; mailboxId?: string }) {
	// A plain-text body (no tags) keeps its line breaks.
	const raw = email.body || "";
	const html = /<[a-z!/][^>]*>/i.test(raw) ? raw : raw.replace(/\r?\n/g, "<br>");
	const body = useInlineImages(html, mailboxId, email.id, email.attachments);
	// Mail is written for a white page: in dark mode it keeps one, inset.
	return (
		<div className="dark:rounded-lg dark:bg-white dark:p-4">
			<EmailIframe body={body} autoSize />
		</div>
	);
}

function senderLabel(email: Email, selfAddress?: string, selfName?: string) {
	const person = parsePerson(email.sender);
	if (isSelf(email.sender, selfAddress)) return { ...person, name: selfName || person.name, hasName: Boolean(selfName) };
	return person;
}

function snippetOf(email: Email): string {
	// From the body when there is one: block ends become spaces ("welcome! Riley", not "welcome!Riley").
	const text = email.body ? stripHtml(email.body.replace(/<br\s*\/?>|<\/(p|div|li|h\d)>/gi, " ")) : email.snippet || "";
	return text.replace(/\s+/g, " ").trim();
}

/** A date with its relative time ("3 days ago") in a tooltip. */
function MessageDate({ date, short }: { date: string; short?: boolean }) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={<span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground" />}
			>
				{short ? formatListDate(date) : formatDetailDate(date)}
			</TooltipTrigger>
			<TooltipContent side="bottom">{relativeTime(date)}</TooltipContent>
		</Tooltip>
	);
}

function DetailRow({ label, value }: { label: string; value?: string | null }) {
	if (!value) return null;
	return (
		<>
			<dt className="text-right text-muted-foreground">{label}:</dt>
			<dd className="min-w-0 break-words text-foreground">{value}</dd>
		</>
	);
}

/**
 * One message of a conversation, Gmail's way: a one-line row when collapsed
 * (avatar, sender, snippet, date), the full header, body and attachments when
 * expanded. Clicking the header toggles it.
 */
export default function ThreadMessage({
	email,
	mailboxId,
	selfAddress,
	selfName,
	expanded,
	canCollapse,
	onToggleExpand,
	onReply,
	onReplyAll,
	onForward,
	onShowOriginal,
	onDelete,
	onToggleStar,
	onPreviewImage,
}: ThreadMessageProps) {
	const [showDetails, setShowDetails] = useState(false);
	const sender = senderLabel(email, selfAddress, selfName);
	const hasAttachments = getNonInlineAttachments(email.attachments).length > 0;

	if (!expanded) {
		return (
			<button
				type="button"
				onClick={onToggleExpand}
				className="flex w-full items-center gap-3 px-4 py-2.5 text-left outline-none hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset md:px-6"
				aria-expanded={false}
				aria-label={`Expand message from ${sender.name}`}
			>
				<SenderAvatar sender={email.sender} />
				{/* One line from sm up; sender over snippet on phones. */}
				<span className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-center sm:gap-3">
					<span className={cn("truncate text-sm sm:w-44 sm:shrink-0", !email.read ? "font-semibold" : "font-medium")}>
						{sender.name}
					</span>
					<span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{snippetOf(email)}</span>
				</span>
				{hasAttachments && <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-label="Has attachments" />}
				{email.starred && <Star className="size-3.5 shrink-0 fill-warning text-warning" aria-label="Starred" />}
				<MessageDate date={email.date} short />
			</button>
		);
	}

	const recipients = shortRecipients(email.recipient, email.cc, selfAddress);

	return (
		<article className="px-4 pt-3 pb-5 md:px-6" aria-label={`Message from ${sender.name}`}>
			<div className="flex items-start gap-3">
				<SenderAvatar sender={email.sender} className="mt-0.5 size-9" />
				<div className="min-w-0 flex-1">
					<div className="flex items-start gap-2">
						{/* The header toggles the message, like Gmail; the buttons on the right don't. */}
						<div
							className={cn("min-w-0 flex-1", canCollapse && "cursor-pointer")}
							onClick={canCollapse ? onToggleExpand : undefined}
						>
							<div className="flex min-w-0 items-baseline gap-1.5">
								<span className="truncate text-sm font-semibold text-foreground">{sender.name}</span>
								{sender.hasName && (
									<span className="truncate text-xs text-muted-foreground">&lt;{sender.address}&gt;</span>
								)}
							</div>
							{recipients && (
								<button
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										setShowDetails((v) => !v);
									}}
									className="-ml-1 flex max-w-full items-center gap-0.5 rounded px-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
									aria-expanded={showDetails}
									aria-label={showDetails ? "Hide details" : "Show details"}
								>
									<span className="truncate">{recipients}</span>
									<ChevronDown className={cn("size-3.5 shrink-0 transition-transform", showDetails && "rotate-180")} />
								</button>
							)}
						</div>
						<div className="flex shrink-0 items-center gap-0.5">
							<span className="mr-1 hidden sm:inline">
								<MessageDate date={email.date} />
							</span>
							<IconTooltip label={email.starred ? "Starred" : "Not starred"}>
								<Button variant="ghost" size="icon-sm" onClick={onToggleStar} aria-label={email.starred ? "Unstar message" : "Star message"} aria-pressed={email.starred}>
									<Star className={cn(email.starred && "fill-warning text-warning")} />
								</Button>
							</IconTooltip>
							<IconTooltip label="Reply">
								<Button variant="ghost" size="icon-sm" onClick={onReply} aria-label="Reply">
									<Reply />
								</Button>
							</IconTooltip>
							<DropdownMenu>
								<IconTooltip label="More">
									<DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="More message actions" />}>
										<MoreVertical />
									</DropdownMenuTrigger>
								</IconTooltip>
								<DropdownMenuContent align="end" className="w-48">
									<DropdownMenuItem onClick={onReply}>
										<Reply />
										Reply
									</DropdownMenuItem>
									<DropdownMenuItem onClick={onReplyAll}>
										<ReplyAll />
										Reply all
									</DropdownMenuItem>
									<DropdownMenuItem onClick={onForward}>
										<Forward />
										Forward
									</DropdownMenuItem>
									<DropdownMenuSeparator />
									<DropdownMenuItem onClick={onShowOriginal}>
										<Code />
										Show original
									</DropdownMenuItem>
									<DropdownMenuItem variant="destructive" onClick={onDelete}>
										<Trash2 />
										Delete this message
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						</div>
					</div>

					{showDetails && (
						<dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs">
							<DetailRow label="from" value={email.sender} />
							<DetailRow label="to" value={email.recipient} />
							<DetailRow label="cc" value={email.cc} />
							<DetailRow label="bcc" value={email.bcc} />
							<DetailRow label="date" value={formatDetailDate(email.date)} />
							<DetailRow label="subject" value={email.subject} />
						</dl>
					)}

					<div className="mt-3">
						<MessageBody email={email} mailboxId={mailboxId} />
					</div>

					<EmailAttachmentList
						mailboxId={mailboxId}
						emailId={email.id}
						attachments={email.attachments}
						onPreviewImage={onPreviewImage}
						className="mt-4 border-t border-border pt-3"
						showHeading
					/>
				</div>
			</div>
		</article>
	);
}
