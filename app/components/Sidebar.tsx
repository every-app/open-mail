// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	Archive,
	ChevronRight,
	File,
	Folder as FolderIcon,
	Inbox,
	OctagonAlert,
	Pencil,
	Plus,
	Send,
	Star,
	Trash2,
} from "lucide-react";
import { type ComponentType, type FormEvent, useMemo, useState } from "react";
import { NavLink, useLocation, useSearchParams } from "react-router";
import { Folders, SYSTEM_FOLDER_IDS } from "shared/folders";
import SidebarLabels from "~/components/SidebarLabels";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/components/ui/collapsible";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { useUIStore } from "~/hooks/useUIStore";
import { cn } from "~/lib/cn";
import { folderPath, mailboxPath } from "~/lib/mail-paths";
import { useEmails } from "~/queries/emails";
import { useCreateFolder, useFolders } from "~/queries/folders";

type Icon = ComponentType<{ className?: string }>;

const STARRED_QUERY = "is:starred";

const SYSTEM_ITEMS: { id: string; label: string; icon: Icon }[] = [
	{ id: Folders.INBOX, label: "Inbox", icon: Inbox },
	{ id: "starred", label: "Starred", icon: Star },
	{ id: Folders.SENT, label: "Sent", icon: Send },
	{ id: Folders.DRAFT, label: "Drafts", icon: File },
	{ id: Folders.ARCHIVE, label: "Archive", icon: Archive },
	{ id: Folders.SPAM, label: "Spam", icon: OctagonAlert },
	{ id: Folders.TRASH, label: "Trash", icon: Trash2 },
];

interface NavItemProps {
	to: string;
	icon: Icon;
	label: string;
	count?: number;
	/** Bold label and count (unread mail), as Gmail does; Drafts' total isn't. */
	emphasize?: boolean;
	collapsed: boolean;
	/** Overrides NavLink's own path match (Starred is a search). */
	active?: boolean;
	onNavigate?: () => void;
}

function NavItem({ to, icon: Icon, label, count, emphasize = true, collapsed, active, onNavigate }: NavItemProps) {
	const hasCount = count != null && count > 0;
	const link = (
		<NavLink
			to={to}
			onClick={onNavigate}
			aria-label={collapsed ? (hasCount ? `${label}, ${count}` : label) : undefined}
			className={({ isActive }) => {
				const on = active ?? isActive;
				return cn(
					"relative flex h-8 items-center rounded-full text-sm text-sidebar-foreground/80 transition-colors outline-none hover:bg-sidebar-accent/60 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring",
					collapsed ? "mx-auto w-12 justify-center" : "gap-3 pr-3 pl-4",
					on && "bg-sidebar-accent font-semibold text-sidebar-accent-foreground hover:bg-sidebar-accent",
					hasCount && emphasize && "font-semibold text-sidebar-foreground",
				);
			}}
		>
			<Icon className="size-4 shrink-0" />
			{collapsed ? (
				hasCount &&
				emphasize && <span className="absolute top-1.5 right-3 size-2 rounded-full bg-primary" aria-hidden />
			) : (
				<>
					<span className="flex-1 truncate">{label}</span>
					{hasCount && <span className={cn("text-xs tabular-nums", !emphasize && "font-normal")}>{count}</span>}
				</>
			)}
		</NavLink>
	);

	if (!collapsed) return link;
	return (
		<Tooltip>
			<TooltipTrigger render={link} />
			<TooltipContent side="right">
				{label}
				{hasCount ? ` (${count})` : ""}
			</TooltipContent>
		</Tooltip>
	);
}

function CreateFolderDialog({
	mailboxId,
	open,
	onOpenChange,
}: {
	mailboxId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const createFolder = useCreateFolder();
	const [name, setName] = useState("");

	const handleSubmit = async (e: FormEvent) => {
		e.preventDefault();
		const trimmed = name.trim();
		if (!trimmed) return;
		try {
			await createFolder.mutateAsync({ mailboxId, name: trimmed });
			setName("");
			onOpenChange(false);
		} catch {
			// The mutation cache logs it; the dialog stays open to retry.
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<form onSubmit={handleSubmit} className="grid gap-4">
					<DialogHeader>
						<DialogTitle>New folder</DialogTitle>
					</DialogHeader>
					<div className="grid gap-2">
						<Label htmlFor="new-folder-name">Folder name</Label>
						<Input
							id="new-folder-name"
							placeholder="e.g. Projects"
							value={name}
							onChange={(e) => setName(e.target.value)}
							autoFocus
							required
						/>
						{createFolder.isError && (
							<p className="text-sm text-destructive">Couldn't create the folder. Try again.</p>
						)}
					</div>
					<DialogFooter>
						<DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
						<Button type="submit" disabled={!name.trim()} pending={createFolder.isPending}>
							Create
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Gmail's left navigation: Compose, the system folders with unread counts,
 * custom Folders, then Labels (SidebarLabels). `collapsed` is the desktop
 * icon rail.
 */
export default function Sidebar({
	mailboxId,
	collapsed = false,
	onNavigate,
}: {
	mailboxId: string;
	collapsed?: boolean;
	/** Called after a navigation (closes the mobile sheet). */
	onNavigate?: () => void;
}) {
	const { data: folders = [] } = useFolders(mailboxId);
	// Drafts shows its total, which the folder list doesn't carry.
	const { data: drafts } = useEmails(mailboxId, { folder: Folders.DRAFT, page: "1", limit: "1" });
	const startCompose = useUIStore((s) => s.startCompose);
	const location = useLocation();
	const [searchParams] = useSearchParams();
	const [isCreateFolderOpen, setIsCreateFolderOpen] = useState(false);
	const [foldersOpen, setFoldersOpen] = useState(true);

	const isStarredView =
		/\/search(\/|$)/.test(location.pathname) && searchParams.get("q")?.trim() === STARRED_QUERY;

	const customFolders = useMemo(
		// Upstream's SYSTEM_FOLDER_IDS leaves Spam out; it's a system folder here.
		() => folders.filter((f) => f.id !== Folders.SPAM && !(SYSTEM_FOLDER_IDS as readonly string[]).includes(f.id)),
		[folders],
	);
	const unread = (id: string) => folders.find((f) => f.id === id)?.unreadCount ?? 0;

	const compose = () => {
		startCompose();
		onNavigate?.();
	};

	return (
		<nav aria-label="Mail" className="flex h-full min-h-0 flex-col">
			<div className={cn("shrink-0 pt-1 pb-3", collapsed ? "px-2" : "pr-3 pl-2")}>
				{collapsed ? (
					<Tooltip>
						<TooltipTrigger
							render={
								<Button size="icon-lg" className="mx-auto flex rounded-2xl shadow-sm" aria-label="Compose" onClick={compose}>
									<Pencil className="size-5" />
								</Button>
							}
						/>
						<TooltipContent side="right">Compose (c)</TooltipContent>
					</Tooltip>
				) : (
					<Button size="lg" className="rounded-2xl px-5 shadow-sm" onClick={compose}>
						<Pencil className="size-5" />
						Compose
					</Button>
				)}
			</div>

			<div className={cn("min-h-0 flex-1 overflow-y-auto pb-4", collapsed ? "px-1" : "pr-3 pl-2")}>
				<div className="space-y-0.5">
					{SYSTEM_ITEMS.map((item) =>
						item.id === "starred" ? (
							<NavItem
								key={item.id}
								to={`${mailboxPath(mailboxId)}/search?q=${encodeURIComponent(STARRED_QUERY)}`}
								icon={item.icon}
								label={item.label}
								collapsed={collapsed}
								active={isStarredView}
								onNavigate={onNavigate}
							/>
						) : (
							<NavItem
								key={item.id}
								to={folderPath(mailboxId, item.id)}
								icon={item.icon}
								label={item.label}
								count={item.id === Folders.DRAFT ? drafts?.totalCount : unread(item.id)}
								emphasize={item.id !== Folders.DRAFT}
								collapsed={collapsed}
								onNavigate={onNavigate}
							/>
						),
					)}
				</div>

				{collapsed ? (
					customFolders.length > 0 && (
						<div className="mt-3 space-y-0.5 border-t border-sidebar-border pt-3">
							{customFolders.map((folder) => (
								<NavItem
									key={folder.id}
									to={folderPath(mailboxId, folder.id)}
									icon={FolderIcon}
									label={folder.name}
									count={folder.unreadCount}
									collapsed
									onNavigate={onNavigate}
								/>
							))}
						</div>
					)
				) : (
					<Collapsible open={foldersOpen} onOpenChange={setFoldersOpen} className="mt-4">
						<div className="flex h-8 items-center justify-between pr-1 pl-4">
							<CollapsibleTrigger className="group/folders flex items-center gap-1 text-sm font-medium text-sidebar-foreground outline-none focus-visible:underline">
								Folders
								<ChevronRight className="size-3.5 text-muted-foreground transition-transform group-data-[panel-open]/folders:rotate-90" />
							</CollapsibleTrigger>
							<Tooltip>
								<TooltipTrigger
									render={
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label="New folder"
											onClick={() => setIsCreateFolderOpen(true)}
										>
											<Plus />
										</Button>
									}
								/>
								<TooltipContent side="right">New folder</TooltipContent>
							</Tooltip>
						</div>
						<CollapsibleContent className="space-y-0.5">
							{customFolders.map((folder) => (
								<NavItem
									key={folder.id}
									to={folderPath(mailboxId, folder.id)}
									icon={FolderIcon}
									label={folder.name}
									count={folder.unreadCount}
									collapsed={false}
									onNavigate={onNavigate}
								/>
							))}
							{customFolders.length === 0 && (
								<p className="py-1 pl-4 text-xs text-muted-foreground">No folders yet</p>
							)}
						</CollapsibleContent>
					</Collapsible>
				)}

				<SidebarLabels mailboxId={mailboxId} collapsed={collapsed} onNavigate={onNavigate} />
			</div>

			<CreateFolderDialog mailboxId={mailboxId} open={isCreateFolderOpen} onOpenChange={setIsCreateFolderOpen} />
		</nav>
	);
}
