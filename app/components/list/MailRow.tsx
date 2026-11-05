import { Archive, Mail, MailOpen, Star, Trash2 } from "lucide-react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { formatListDate } from "shared/dates";
import { getFolderDisplayName } from "shared/folders";
import { LabelChip } from "~/components/labels/LabelChip";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/cn";
import { getSnippetText } from "~/lib/utils";
import type { Email } from "~/types";
import { avatarInitial, isUnread, participantsLabel } from "./participants";
// Gmail (docs/GMAIL.md): "Drafting reply… 0:42" on a conversation's row.
import { DraftingRowStatus } from "~/components/gmail/DraftingStatus";
import GmailOnly from "~/components/gmail/GmailOnly";

/** Label chips shown before the subject; the rest fold into a "+N" chip. */
const MAX_CHIPS_DESKTOP = 2;
const MAX_CHIPS_MOBILE = 1;

export interface RowActions {
	/** Absent where Archive doesn't apply (in Archive). */
	onArchive?: () => void;
	onDelete: () => void;
	/** "Delete forever" (Trash, Spam) instead of "Delete". */
	deleteForever: boolean;
	onToggleRead: () => void;
}

function IconAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={label}
						onClick={(e) => {
							e.stopPropagation();
							onClick();
						}}
						className="text-muted-foreground hover:text-foreground"
					>
						{children}
					</Button>
				}
			/>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}

/**
 * One conversation in the list (docs/UI.md "List"): a dense single line on
 * md+, two lines with an avatar on mobile. Hover (or keyboard focus) swaps
 * the date for Archive, Delete and Mark read/unread.
 */
export function MailRow({
	email,
	selfAddress,
	selected,
	focused,
	tabbable,
	hideLabelId,
	showFolder,
	highlight = (text) => text,
	actions,
	onOpen,
	onToggleSelect,
	onToggleStar,
	onFocus,
}: {
	email: Email;
	selfAddress: string;
	/** Checked for bulk actions. */
	selected: boolean;
	/** The keyboard focus (j/k). */
	focused: boolean;
	/** The row Tab lands on (the focused one, else the first). */
	tabbable: boolean;
	/** The label being viewed: its chip is left out. */
	hideLabelId?: string;
	/** Search results name the folder each conversation is in. */
	showFolder?: boolean;
	highlight?: (text: string) => ReactNode;
	actions: RowActions;
	onOpen: (event: MouseEvent | KeyboardEvent) => void;
	onToggleSelect: () => void;
	onToggleStar: () => void;
	onFocus: () => void;
}) {
	const unread = isUnread(email);
	const who = participantsLabel(email, selfAddress);
	const count = email.thread_count ?? 1;
	const subject = email.subject?.trim() || "(no subject)";
	const snippet = getSnippetText(email.snippet, 160);
	const date = formatListDate(email.date);
	const labels = (email.labels ?? []).filter((l) => l.id !== hideLabelId);
	const folder = showFolder ? (email as Email & { folder_name?: string }).folder_name ?? email.folder_id : null;
	const readLabel = unread ? "Mark as read" : "Mark as unread";

	const star = (
		<button
			type="button"
			onClick={(e) => {
				e.stopPropagation();
				onToggleStar();
			}}
			aria-label={email.starred ? "Unstar" : "Star"}
			aria-pressed={email.starred}
			className="flex size-7 shrink-0 items-center justify-center rounded-md outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring/50"
		>
			<Star
				className={cn(
					"size-4",
					email.starred ? "fill-warning text-warning" : "text-muted-foreground/60 hover:text-muted-foreground",
				)}
			/>
		</button>
	);

	const sender = (
		<>
			<span className={cn("truncate", unread ? "font-semibold text-foreground" : "text-foreground/80")}>
				{highlight(who)}
			</span>
			{count > 1 && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{count}</span>}
			{email.has_draft && <span className="shrink-0 text-destructive">Draft</span>}
		</>
	);

	// The chips give way before the subject: capped, each one truncating, the rest behind "+N".
	const chips = (max: number) => {
		const rest = labels.slice(max);
		return (
			<>
				{folder && (
					<Badge variant="outline" className="h-5 shrink-0 rounded-md px-1.5 font-normal text-muted-foreground">
						{getFolderDisplayName(folder)}
					</Badge>
				)}
				{labels.slice(0, max).map((label) => (
					<LabelChip key={label.id} label={label} className="max-w-28 shrink lg:max-w-36" />
				))}
				{rest.length > 0 && (
					<Tooltip>
						<TooltipTrigger
							render={
								<span
									className="inline-flex h-5 shrink-0 items-center rounded-md bg-muted px-1.5 text-xs font-medium text-muted-foreground ring-1 ring-border ring-inset"
									aria-label={`${rest.length} more ${rest.length === 1 ? "label" : "labels"}: ${rest.map((l) => l.name).join(", ")}`}
								>
									+{rest.length}
								</span>
							}
						/>
						<TooltipContent>{rest.map((l) => l.name).join(", ")}</TooltipContent>
					</Tooltip>
				)}
			</>
		);
	};

	const subjectLine = (
		<span className="min-w-24 flex-1 truncate">
			<span className={cn(unread ? "font-semibold text-foreground" : "text-foreground/80")}>{highlight(subject)}</span>
			{snippet && <span className="text-muted-foreground"> - {highlight(snippet)}</span>}
		</span>
	);

	return (
		<div
			data-row-id={email.id}
			role="listitem"
			aria-label={`${who}, ${subject}${unread ? ", unread" : ""}${email.starred ? ", starred" : ""}`}
			aria-current={focused || undefined}
			tabIndex={tabbable ? 0 : -1}
			onClick={(e) => onOpen(e)}
			onFocus={(e) => {
				if (e.target === e.currentTarget) onFocus();
			}}
			onKeyDown={(e) => {
				if (e.target === e.currentTarget && e.key === "Enter") {
					e.preventDefault();
					onOpen(e);
				}
			}}
			className={cn(
				"group/row relative cursor-pointer border-b border-border/70 text-sm outline-none transition-colors",
				unread ? "bg-card" : "bg-muted/50",
				selected ? "bg-primary/10" : "hover:bg-accent/70 dark:hover:bg-accent/50",
				"focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/50",
			)}
		>
			{focused && <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-primary" />}

			{/* md+: one dense line */}
			<div className="hidden h-10 items-center gap-1 pr-2 pl-2 md:flex">
				<div
					className="flex size-8 shrink-0 items-center justify-center"
					onClick={(e) => e.stopPropagation()}
					onKeyDown={(e) => e.stopPropagation()}
				>
					<Checkbox checked={selected} onCheckedChange={onToggleSelect} aria-label={`Select "${subject}"`} />
				</div>
				{star}
				<div className="ml-1 flex w-40 shrink-0 items-center gap-1.5 lg:w-52">{sender}</div>
				<div className="flex min-w-0 flex-1 items-center gap-1.5 pl-2">
					<GmailOnly>
						<DraftingRowStatus email={email} />
					</GmailOnly>
					{chips(MAX_CHIPS_DESKTOP)}
					{subjectLine}
				</div>
				<div className="relative flex w-28 shrink-0 items-center justify-end">
					<span
						className={cn(
							"pr-1 text-xs tabular-nums group-hover/row:invisible group-focus-visible/row:invisible group-has-[:focus-visible]/row:invisible",
							unread ? "font-semibold text-foreground" : "text-muted-foreground",
						)}
					>
						{date}
					</span>
					<div className="absolute inset-y-0 right-0 hidden items-center group-hover/row:flex group-focus-visible/row:flex group-has-[:focus-visible]/row:flex">
						{actions.onArchive && (
							<IconAction label="Archive" onClick={actions.onArchive}>
								<Archive />
							</IconAction>
						)}
						<IconAction label={actions.deleteForever ? "Delete forever" : "Delete"} onClick={actions.onDelete}>
							<Trash2 />
						</IconAction>
						<IconAction label={readLabel} onClick={actions.onToggleRead}>
							{unread ? <MailOpen /> : <Mail />}
						</IconAction>
					</div>
				</div>
			</div>

			{/* Mobile: two lines and an avatar */}
			<div className="flex items-start gap-3 py-2.5 pr-2 pl-3 md:hidden">
				<span
					aria-hidden
					className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary"
				>
					{avatarInitial(email, selfAddress)}
				</span>
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-1.5">
						{sender}
						<span
							className={cn(
								"ml-auto shrink-0 pl-2 text-xs tabular-nums",
								unread ? "font-semibold text-foreground" : "text-muted-foreground",
							)}
						>
							{date}
						</span>
					</div>
					<div className="mt-0.5 flex items-center gap-1.5">
						<GmailOnly>
							<DraftingRowStatus email={email} />
						</GmailOnly>
						{chips(MAX_CHIPS_MOBILE)}
						{subjectLine}
						<span className="ml-auto -my-1 -mr-1">{star}</span>
					</div>
				</div>
			</div>
		</div>
	);
}
