// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	Archive,
	ArrowLeft,
	ChevronLeft,
	ChevronRight,
	Code,
	FolderInput,
	Inbox,
	MailCheck,
	MailOpen,
	MoreVertical,
	OctagonAlert,
	Tag,
	Trash2,
} from "lucide-react";
import { Folders } from "shared/folders";
import { IconTooltip } from "~/components/conversation/IconTooltip";
import { LabelPicker, type LabelTarget } from "~/components/labels/LabelPicker";
import { Button } from "~/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import type { Folder } from "~/types";

/** "3 of 25" and the newer/older arrows, from the list the conversation was opened from. */
export interface ListPosition {
	position: number;
	total: number;
	onNewer?: () => void;
	onOlder?: () => void;
}

interface EmailPanelToolbarProps {
	mailboxId: string;
	/** The folder the conversation is in (the route's, else its message's). */
	folderId: string;
	moveToFolders: Folder[];
	labelTarget: LabelTarget;
	labelPickerOpen: boolean;
	onLabelPickerOpenChange: (open: boolean) => void;
	listPosition: ListPosition | null;
	onBack: () => void;
	onArchive: () => void;
	onMoveToInbox: () => void;
	onSpam: () => void;
	onNotSpam: () => void;
	onTrash: () => void;
	onDeleteForever: () => void;
	onMarkUnread: () => void;
	onMove: (folder: Folder) => void;
	onShowOriginal: () => void;
}

function Divider() {
	return <div className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden />;
}

/** The conversation's toolbar (docs/UI.md "Conversation"), sticky above the thread. */
export default function EmailPanelToolbar({
	mailboxId,
	folderId,
	moveToFolders,
	labelTarget,
	labelPickerOpen,
	onLabelPickerOpenChange,
	listPosition,
	onBack,
	onArchive,
	onMoveToInbox,
	onSpam,
	onNotSpam,
	onTrash,
	onDeleteForever,
	onMarkUnread,
	onMove,
	onShowOriginal,
}: EmailPanelToolbarProps) {
	const inTrash = folderId === Folders.TRASH;
	const inSpam = folderId === Folders.SPAM;
	const inArchive = folderId === Folders.ARCHIVE;
	// Sent copies and drafts aren't archived or reported (Gmail offers neither there).
	const ownMail = folderId === Folders.SENT || folderId === Folders.DRAFT;

	return (
		<div className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-0.5 border-b border-border bg-background/95 px-2 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:px-4">
			<IconTooltip label="Back to list (u)">
				<Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back to list">
					<ArrowLeft />
				</Button>
			</IconTooltip>
			<Divider />

			{inArchive || inTrash ? (
				<IconTooltip label="Move to Inbox">
					<Button variant="ghost" size="icon-sm" onClick={onMoveToInbox} aria-label="Move to Inbox">
						<Inbox />
					</Button>
				</IconTooltip>
			) : !inSpam && !ownMail ? (
				<IconTooltip label="Archive (e)">
					<Button variant="ghost" size="icon-sm" onClick={onArchive} aria-label="Archive">
						<Archive />
					</Button>
				</IconTooltip>
			) : null}

			{inSpam ? (
				<Button variant="ghost" size="sm" onClick={onNotSpam}>
					<MailCheck />
					Not spam
				</Button>
			) : !inTrash && !ownMail ? (
				<IconTooltip label="Report spam (!)">
					<Button variant="ghost" size="icon-sm" onClick={onSpam} aria-label="Report spam">
						<OctagonAlert />
					</Button>
				</IconTooltip>
			) : null}

			{inTrash || inSpam ? (
				<Button variant="ghost" size="sm" onClick={onDeleteForever}>
					<Trash2 />
					Delete forever
				</Button>
			) : (
				<IconTooltip label="Delete (#)">
					<Button variant="ghost" size="icon-sm" onClick={onTrash} aria-label="Delete">
						<Trash2 />
					</Button>
				</IconTooltip>
			)}

			<Divider />

			<IconTooltip label="Mark as unread (Shift+U)">
				<Button variant="ghost" size="icon-sm" onClick={onMarkUnread} aria-label="Mark as unread">
					<MailOpen />
				</Button>
			</IconTooltip>

			<DropdownMenu>
				<IconTooltip label="Move to">
					<DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Move to" />}>
						<FolderInput />
					</DropdownMenuTrigger>
				</IconTooltip>
				<DropdownMenuContent align="start" className="w-48">
					<DropdownMenuGroup>
						<DropdownMenuLabel>Move to</DropdownMenuLabel>
						{moveToFolders.map((f) => (
							<DropdownMenuItem key={f.id} onClick={() => onMove(f)}>
								{f.name}
							</DropdownMenuItem>
						))}
					</DropdownMenuGroup>
				</DropdownMenuContent>
			</DropdownMenu>

			<Tooltip>
				<LabelPicker
					mailboxId={mailboxId}
					targets={[labelTarget]}
					open={labelPickerOpen}
					onOpenChange={onLabelPickerOpenChange}
					trigger={
						<TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Label as" />}>
							<Tag />
						</TooltipTrigger>
					}
				/>
				<TooltipContent side="bottom">Label as (l)</TooltipContent>
			</Tooltip>

			<DropdownMenu>
				<IconTooltip label="More">
					<DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="More actions" />}>
						<MoreVertical />
					</DropdownMenuTrigger>
				</IconTooltip>
				<DropdownMenuContent align="start" className="w-48">
					<DropdownMenuItem onClick={onShowOriginal}>
						<Code />
						Show original
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>

			{listPosition && (
				<div className="ml-auto flex items-center gap-0.5">
					<span className="mr-1 hidden text-xs whitespace-nowrap text-muted-foreground tabular-nums sm:inline">
						{listPosition.position} of {listPosition.total}
					</span>
					<IconTooltip label="Newer (k)">
						<Button variant="ghost" size="icon-sm" onClick={listPosition.onNewer} disabled={!listPosition.onNewer} aria-label="Newer">
							<ChevronLeft />
						</Button>
					</IconTooltip>
					<IconTooltip label="Older (j)">
						<Button variant="ghost" size="icon-sm" onClick={listPosition.onOlder} disabled={!listPosition.onOlder} aria-label="Older">
							<ChevronRight />
						</Button>
					</IconTooltip>
				</div>
			)}
		</div>
	);
}
