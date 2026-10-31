import {
	Archive,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	EllipsisVertical,
	FolderInput,
	Inbox,
	Mail,
	MailOpen,
	OctagonAlert,
	RotateCw,
	ShieldCheck,
	Tag,
	Trash2,
} from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { type LabelTarget, LabelPicker } from "~/components/labels/LabelPicker";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Separator } from "~/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/cn";
import type { Folder } from "~/types";

export type SelectFilter = "all" | "none" | "read" | "unread" | "starred" | "unstarred";

const SELECT_ITEMS: { filter: SelectFilter; label: string }[] = [
	{ filter: "all", label: "All" },
	{ filter: "none", label: "None" },
	{ filter: "read", label: "Read" },
	{ filter: "unread", label: "Unread" },
	{ filter: "starred", label: "Starred" },
	{ filter: "unstarred", label: "Unstarred" },
];

/** An icon button with a tooltip; `render` lets a menu or popover trigger wrap it. */
function ToolButton({
	label,
	onClick,
	children,
	disabled,
	className,
}: {
	label: string;
	onClick?: () => void;
	children: ReactNode;
	disabled?: boolean;
	className?: string;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={label}
						onClick={onClick}
						disabled={disabled}
						className={cn("text-muted-foreground hover:text-foreground", className)}
					>
						{children}
					</Button>
				}
			/>
			<TooltipContent side="bottom">{label}</TooltipContent>
		</Tooltip>
	);
}

/** A menu trigger with a tooltip: Base UI composes the two `render`s. */
function MenuToolButton({ label, children, trigger }: { label: string; children: ReactNode; trigger: (button: ReactElement) => ReactElement }) {
	const button = (
		<Button variant="ghost" size="icon-sm" aria-label={label} className="text-muted-foreground hover:text-foreground">
			{children}
		</Button>
	);
	return (
		<Tooltip>
			<TooltipTrigger render={trigger(button)} />
			<TooltipContent side="bottom">{label}</TooltipContent>
		</Tooltip>
	);
}

export interface BulkActions {
	count: number;
	onArchive?: () => void;
	/** "Report spam", or "Not spam" in Spam. */
	spam?: { label: string; onClick: () => void };
	/** Delete (to Trash) or Delete forever (Trash, Spam). */
	onDelete: () => void;
	deleteForever: boolean;
	onMoveToInbox?: () => void;
	/** Mark read when any selected conversation is unread, else mark unread. */
	anyUnread: boolean;
	onMarkRead: () => void;
	onMarkUnread: () => void;
	moveTargets: Folder[];
	onMoveTo: (folder: Folder) => void;
	mailboxId: string;
	labelTargets: LabelTarget[];
	labelPickerOpen: boolean;
	onLabelPickerOpenChange: (open: boolean) => void;
}

/**
 * The list's toolbar (docs/UI.md "List"): the select-all checkbox and its
 * menu, then refresh and more, or, with a selection, the bulk actions;
 * "1–25 of N" with newer/older on the right.
 */
export function MailListToolbar({
	title,
	selectState,
	onSelect,
	onRefresh,
	isRefreshing,
	onMarkAllRead,
	canMarkAllRead,
	bulk,
	page,
	pageSize,
	total,
	onPageChange,
	selectable,
}: {
	title: ReactNode;
	selectState: "all" | "some" | "none";
	onSelect: (filter: SelectFilter) => void;
	onRefresh: () => void;
	isRefreshing: boolean;
	onMarkAllRead: () => void;
	canMarkAllRead: boolean;
	/** Present while rows are selected. */
	bulk: BulkActions | null;
	page: number;
	pageSize: number;
	total: number;
	onPageChange: (page: number) => void;
	/** False while there are no rows to select. */
	selectable: boolean;
}) {
	const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
	const last = Math.min(page * pageSize, total);
	const hasNewer = page > 1;
	const hasOlder = last < total;

	return (
		<div className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-2 md:px-3">
			<div className="hidden items-center md:flex">
				<div className="flex size-8 items-center justify-center">
					<Checkbox
						checked={selectState === "all"}
						indeterminate={selectState === "some"}
						disabled={!selectable}
						onCheckedChange={() => onSelect(selectState === "none" ? "all" : "none")}
						aria-label={selectState === "none" ? "Select all" : "Deselect all"}
					/>
				</div>
				<DropdownMenu>
					<MenuToolButton label="Select" trigger={(button) => <DropdownMenuTrigger disabled={!selectable} render={button} />}>
						<ChevronDown className="size-3.5" />
					</MenuToolButton>
					<DropdownMenuContent className="w-36">
						{SELECT_ITEMS.map((item) => (
							<DropdownMenuItem key={item.filter} onClick={() => onSelect(item.filter)}>
								{item.label}
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
			</div>

			{bulk ? (
				<div className="flex min-w-0 flex-1 items-center gap-0.5 md:ml-2">
					{bulk.onArchive && (
						<ToolButton label="Archive" onClick={bulk.onArchive}>
							<Archive />
						</ToolButton>
					)}
					{bulk.onMoveToInbox && (
						<ToolButton label="Move to Inbox" onClick={bulk.onMoveToInbox}>
							<Inbox />
						</ToolButton>
					)}
					{bulk.spam && (
						<ToolButton label={bulk.spam.label} onClick={bulk.spam.onClick}>
							{bulk.spam.label === "Not spam" ? <ShieldCheck /> : <OctagonAlert />}
						</ToolButton>
					)}
					<ToolButton label={bulk.deleteForever ? "Delete forever" : "Delete"} onClick={bulk.onDelete}>
						<Trash2 />
					</ToolButton>
					<Separator orientation="vertical" className="mx-1.5 h-5 self-center" />
					{bulk.anyUnread ? (
						<ToolButton label="Mark as read" onClick={bulk.onMarkRead}>
							<MailOpen />
						</ToolButton>
					) : (
						<ToolButton label="Mark as unread" onClick={bulk.onMarkUnread}>
							<Mail />
						</ToolButton>
					)}
					<DropdownMenu>
						<MenuToolButton label="Move to" trigger={(button) => <DropdownMenuTrigger render={button} />}>
							<FolderInput />
						</MenuToolButton>
						<DropdownMenuContent className="w-48">
							<DropdownMenuGroup>
								<DropdownMenuLabel>Move to:</DropdownMenuLabel>
								{bulk.moveTargets.map((folder) => (
									<DropdownMenuItem key={folder.id} onClick={() => bulk.onMoveTo(folder)}>
										{folder.name}
									</DropdownMenuItem>
								))}
							</DropdownMenuGroup>
						</DropdownMenuContent>
					</DropdownMenu>
					<Tooltip>
						<LabelPicker
							mailboxId={bulk.mailboxId}
							targets={bulk.labelTargets}
							open={bulk.labelPickerOpen}
							onOpenChange={bulk.onLabelPickerOpenChange}
							trigger={
								<TooltipTrigger
									render={
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label="Label as"
											className="text-muted-foreground hover:text-foreground"
										>
											<Tag />
										</Button>
									}
								/>
							}
						/>
						<TooltipContent side="bottom">Label as (l)</TooltipContent>
					</Tooltip>
					<span className="ml-2 truncate text-sm text-muted-foreground">{bulk.count} selected</span>
				</div>
			) : (
				<div className="flex min-w-0 flex-1 items-center gap-0.5">
					<div className="hidden items-center gap-0.5 md:flex">
						<ToolButton label={isRefreshing ? "Refreshing…" : "Refresh"} onClick={onRefresh}>
							<RotateCw className={cn(isRefreshing && "animate-spin")} />
						</ToolButton>
						<DropdownMenu>
							<MenuToolButton label="More" trigger={(button) => <DropdownMenuTrigger render={button} />}>
								<EllipsisVertical />
							</MenuToolButton>
							<DropdownMenuContent className="w-52">
								<DropdownMenuItem disabled={!canMarkAllRead} onClick={onMarkAllRead}>
									<MailOpen />
									Mark all as read
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
					<h1 className="ml-1 flex min-w-0 items-center gap-2 truncate text-base font-semibold md:ml-3 md:text-sm">
						{title}
					</h1>
				</div>
			)}

			<div className="flex shrink-0 items-center gap-0.5">
				{total > 0 && (
					<span className="mr-1 hidden text-xs text-muted-foreground tabular-nums sm:inline">
						{first}–{last} of {total}
					</span>
				)}
				<ToolButton label="Refresh" onClick={onRefresh} className="md:hidden">
					<RotateCw className={cn(isRefreshing && "animate-spin")} />
				</ToolButton>
				<ToolButton label="Newer" onClick={() => onPageChange(page - 1)} disabled={!hasNewer}>
					<ChevronLeft />
				</ToolButton>
				<ToolButton label="Older" onClick={() => onPageChange(page + 1)} disabled={!hasOlder}>
					<ChevronRight />
				</ToolButton>
			</div>
		</div>
	);
}
