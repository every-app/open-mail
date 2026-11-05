// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, LogOut, Mail, Plus, Trash2, TriangleAlert } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link as RouterLink } from "react-router";
import { Folders } from "shared/folders";
import { toast } from "sonner";
import { PageHeader } from "~/components/PageHeader";
import { ThemePreferenceMenuItems } from "~/components/ThemePreferenceMenuItems";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "~/components/ui/empty";
import { Field, FieldError, FieldGroup, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Skeleton } from "~/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { mailboxDisplayName } from "~/lib/utils";
// Gmail (docs/GMAIL.md): the connect card and the rows' Gmail tag.
import ConnectGmailCard, { GmailMailboxBadge } from "~/components/gmail/ConnectGmailCard";
import GmailOnly from "~/components/gmail/GmailOnly";
import { useFolders } from "~/queries/folders";
import { queryKeys } from "~/queries/keys";
import { useCreateMailbox, useDeleteMailbox, useMailboxes } from "~/queries/mailboxes";
import api, { meQuery } from "~/services/api";

export function meta() {
	return [{ title: "Mailboxes · OpenMail" }];
}

export default function HomeRoute() {
	useDocumentTitle("Mailboxes");
	const { data: mailboxes = [], refetch: refetchMailboxes, isFetched: mailboxesFetched } = useMailboxes();
	const createMailbox = useCreateMailbox();
	const deleteMailbox = useDeleteMailbox();

	const { data: configData } = useQuery({
		queryKey: queryKeys.config,
		queryFn: () => api.getConfig(),
		staleTime: Infinity, // config rarely changes
	});

	const domains = configData?.domains ?? [];
	const emailAddresses = configData?.emailAddresses ?? [];

	// Every App: the signed-in person and their role in the organization
	// (GET /api/v1/me). Owners and admins create and delete mailboxes;
	// members use them. The Worker enforces this (workers/everyapp/identity.ts);
	// the page only hides what it would refuse.
	const { data: me } = useQuery(meQuery);
	const isAdmin = me?.role === "owner" || me?.role === "admin";

	const [isCreateOpen, setIsCreateOpen] = useState(false);
	const [newPrefix, setNewPrefix] = useState("");
	const [selectedDomain, setSelectedDomain] = useState("");
	const [newName, setNewName] = useState("");
	const [createError, setCreateError] = useState<string | null>(null);
	const [mailboxToDelete, setMailboxToDelete] = useState<{ id: string; email: string } | null>(null);

	// Set default domain when config loads
	useEffect(() => {
		if (domains.length > 0 && !selectedDomain) {
			setSelectedDomain(domains[0]);
		}
	}, [domains, selectedDomain]);

	// Auto-create mailboxes from config (run once when both data sources are ready)
	const autoCreateDone = useRef(false);
	useEffect(() => {
		if (autoCreateDone.current) return;
		if (emailAddresses.length === 0 || !mailboxesFetched) return;
		const existingEmails = new Set(mailboxes.map((m) => m.email.toLowerCase()));
		const toCreate = emailAddresses.filter((addr) => !existingEmails.has(addr.toLowerCase()));
		if (toCreate.length === 0) {
			autoCreateDone.current = true;
			return;
		}
		autoCreateDone.current = true;
		let cancelled = false;
		Promise.all(
			toCreate.map((addr) => {
				const localPart = addr.split("@")[0] || addr;
				return api.createMailbox(addr, localPart).catch(() => {});
			}),
		).then(() => {
			if (!cancelled) refetchMailboxes();
		});
		return () => {
			cancelled = true;
		};
	}, [emailAddresses, mailboxes, refetchMailboxes]);

	const openCreate = () => {
		setCreateError(null);
		setIsCreateOpen(true);
	};

	const handleCreate = async (e: FormEvent) => {
		e.preventDefault();
		setCreateError(null);
		if (!newPrefix || !selectedDomain) {
			setCreateError("Please fill in all fields");
			return;
		}
		const email = `${newPrefix}@${selectedDomain}`;
		const name = newName || newPrefix;
		try {
			await createMailbox.mutateAsync({ email, name });
			toast.success("Mailbox created");
			setIsCreateOpen(false);
			setNewPrefix("");
			setNewName("");
		} catch (err: unknown) {
			const message = (err instanceof Error ? err.message : null) || "Failed to create mailbox";
			setCreateError(message);
		}
	};

	const handleDelete = async () => {
		if (!mailboxToDelete) return;
		try {
			await deleteMailbox.mutateAsync(mailboxToDelete.id);
			toast.success("Mailbox deleted");
			setMailboxToDelete(null);
		} catch {
			toast.error("Failed to delete mailbox");
		}
	};

	const isConfigured = emailAddresses.length > 0;
	const canManage = isAdmin && !isConfigured;
	// Two setup states the page can't get past on its own: the gateway allows
	// no sender for this app yet (`domains` is empty, so there is nothing to
	// create a mailbox on), or it has no sender of its own (`ready` is false:
	// mail arrives and drafts save, sends are refused). SetupBanner says which.
	const noDomain = !!configData && domains.length === 0 && !isConfigured;
	const sendingOff = configData?.ready === false && domains.length > 0;
	const canCreate = canManage && !noDomain;
	const accounts = isConfigured
		? emailAddresses.map((addr) => ({
				id: addr,
				email: addr,
				name: addr.split("@")[0] || addr,
			}))
		: mailboxes;

	const isLoading = !configData;

	const newMailboxButton = (
		<Button onClick={openCreate}>
			<Plus data-icon="inline-start" />
			New mailbox
		</Button>
	);

	return (
		<div className="flex min-h-dvh flex-col bg-background">
			<HomeHeader />

			<main className="flex-1 px-4 pt-4 pb-16 md:px-6 md:pt-8">
				<div className="mx-auto w-full max-w-3xl space-y-6">
					<PageHeader
						title="Mailboxes"
						description="Shared with everyone in your organization"
						actions={canCreate && accounts.length > 0 ? newMailboxButton : undefined}
						backLink={
							// The way back up, first on the page as in every Every App app's sidebar.
							me?.gatewayUrl ? (
								<a
									href={me.gatewayUrl}
									aria-label="Back to Every App"
									className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
								>
									<ChevronLeft className="size-4" aria-hidden />
									Every App
								</a>
							) : undefined
						}
					/>

					<SetupBanner noDomain={noDomain} sendingOff={sendingOff} isAdmin={isAdmin} />
					<GmailOnly>
						<ConnectGmailCard />
					</GmailOnly>

					{isLoading ? (
						<MailboxListSkeleton />
					) : accounts.length > 0 ? (
						<ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card shadow-xs">
							{accounts.map((account) => (
								<MailboxRow
									key={account.id}
									id={account.id}
									email={account.email}
									name={account.name}
									badge={
										<GmailOnly>
											<GmailMailboxBadge mailbox={account} />
										</GmailOnly>
									}
									onDelete={
										canManage
											? () => setMailboxToDelete({ id: account.id, email: account.email })
											: undefined
									}
								/>
							))}
						</ul>
					) : (
						<Empty variant="dashed" className="py-14">
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<Mail aria-hidden />
								</EmptyMedia>
								<EmptyTitle>No mailboxes yet</EmptyTitle>
								<EmptyDescription>
									{isConfigured
										? "Your email routing is configured but no mailboxes have been created yet. They will appear here automatically."
										: noDomain
											? isAdmin
												? "Allow a mail domain first (above), then create a mailbox on it."
												: "Ask an owner or admin to finish email setup."
											: isAdmin
												? "Create a mailbox to start sending and receiving emails with your domain."
												: "Ask an owner or admin to create a mailbox."}
								</EmptyDescription>
							</EmptyHeader>
							{canCreate && <EmptyContent>{newMailboxButton}</EmptyContent>}
						</Empty>
					)}
				</div>
			</main>

			<Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
				<DialogContent className="sm:max-w-md">
					<form onSubmit={handleCreate} className="grid gap-4">
						<DialogHeader>
							<DialogTitle>New mailbox</DialogTitle>
							<DialogDescription>Everyone in your organization can use it.</DialogDescription>
						</DialogHeader>
						<FieldGroup className="gap-4">
							<Field>
								<FieldLabel htmlFor="mailbox-prefix">Address</FieldLabel>
								<div className="flex items-center gap-2">
									<Input
										id="mailbox-prefix"
										aria-label="Address prefix"
										placeholder="info"
										autoComplete="off"
										value={newPrefix}
										onChange={(e) => setNewPrefix(e.target.value)}
										required
										autoFocus
										className="min-w-0 flex-1"
									/>
									<span className="text-sm text-muted-foreground">@</span>
									{domains.length > 1 ? (
										<Select
											value={selectedDomain}
											onValueChange={(value) => {
												if (value) setSelectedDomain(value as string);
											}}
										>
											<SelectTrigger aria-label="Domain" className="min-w-0 flex-1">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												{domains.map((d) => (
													<SelectItem key={d} value={d}>
														{d}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									) : (
										<span className="min-w-0 truncate text-sm text-muted-foreground">
											{selectedDomain || "no domain yet"}
										</span>
									)}
								</div>
							</Field>
							<Field>
								<FieldLabel htmlFor="mailbox-name">Sender name (optional)</FieldLabel>
								<Input
									id="mailbox-name"
									placeholder="Info"
									value={newName}
									onChange={(e) => setNewName(e.target.value)}
								/>
							</Field>
							{createError && <FieldError>{createError}</FieldError>}
						</FieldGroup>
						<DialogFooter>
							<DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
							<Button type="submit" pending={createMailbox.isPending} disabled={!selectedDomain}>
								Create
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>

			<AlertDialog
				open={mailboxToDelete !== null}
				onOpenChange={(open) => {
					if (!open) setMailboxToDelete(null);
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete mailbox</AlertDialogTitle>
						<AlertDialogDescription>
							Delete <strong className="font-medium text-foreground">{mailboxToDelete?.email}</strong>?
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<Button variant="destructive" pending={deleteMailbox.isPending} onClick={handleDelete}>
							Delete
						</Button>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}

/** Home sits outside the mail frame: the product name, then the person's menu. */
function HomeHeader() {
	return (
		<header className="flex h-14 shrink-0 items-center gap-2 px-4 md:px-6">
			<RouterLink to="/" className="flex items-center gap-2 rounded-lg text-base font-semibold tracking-tight outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
				<span className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
					<Mail className="size-4" aria-hidden />
				</span>
				OpenMail
			</RouterLink>
			<div className="ml-auto">
				<AccountMenu />
			</div>
		</header>
	);
}

/** The person (from /api/v1/me): theme and Sign out (the gateway). */
function AccountMenu() {
	const { data: me } = useQuery({ ...meQuery, retry: false });
	const initial = (me?.email?.[0] ?? "?").toUpperCase();

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						variant="ghost"
						size="icon"
						className="rounded-full"
						aria-label={me ? `Account: ${me.email}` : "Account"}
					/>
				}
			>
				<span className="flex size-8 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
					{initial}
				</span>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-64">
				<DropdownMenuGroup>
					<DropdownMenuLabel className="flex items-center gap-3 py-2">
						<span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
							{initial}
						</span>
						<span className="min-w-0">
							<span className="block truncate text-sm font-medium text-foreground">
								{me?.email ?? "Loading…"}
							</span>
							{me && <span className="block text-xs capitalize">{me.role}</span>}
						</span>
					</DropdownMenuLabel>
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				<ThemePreferenceMenuItems />
				{me?.gatewayUrl && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem render={<a href={me.gatewayUrl} />}>
							<LogOut />
							Sign out
						</DropdownMenuItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/**
 * One mailbox: avatar, name and address from the list alone (the name the
 * API lists: the display name given at creation, else the local part of the
 * address; the sender name set later in Settings travels with the mailbox,
 * not the list). When the name would be the address itself, the address
 * shows once. The Inbox's unread count comes from the folders the sidebar
 * loads anyway. The whole row opens the mailbox; Delete sits above the link.
 */
function MailboxRow({
	id,
	email,
	name,
	badge,
	onDelete,
}: {
	id: string;
	email: string;
	name: string;
	badge?: React.ReactNode;
	onDelete?: () => void;
}) {
	const { data: folders } = useFolders(id);
	const unread = folders?.find((f) => f.id === Folders.INBOX)?.unreadCount ?? 0;
	const displayName = mailboxDisplayName({ email, name }, id);
	const sameAsAddress = displayName === email;

	return (
		<li className="group relative flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50 has-[a:focus-visible]:bg-muted/50">
			<span
				aria-hidden
				className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary"
			>
				{displayName.charAt(0).toUpperCase()}
			</span>
			<div className="min-w-0 flex-1">
				<RouterLink
					to={`/mailbox/${id}`}
					className="block truncate text-sm font-medium outline-none after:absolute after:inset-0"
				>
					{sameAsAddress ? email : displayName}
				</RouterLink>
				{!sameAsAddress && <div className="truncate text-sm text-muted-foreground">{email}</div>}
			</div>
			{badge}
			{unread > 0 && (
				<Badge variant="soft" aria-label={`${unread} unread`}>
					{unread}
				</Badge>
			)}
			{onDelete && (
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={`Delete mailbox ${email}`}
								onClick={onDelete}
								className="relative z-10 text-muted-foreground opacity-100 hover:text-destructive md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
							/>
						}
					>
						<Trash2 />
					</TooltipTrigger>
					<TooltipContent>Delete mailbox</TooltipContent>
				</Tooltip>
			)}
			<ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
		</li>
	);
}

function MailboxListSkeleton() {
	return (
		<div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card shadow-xs" aria-busy>
			{[0, 1, 2].map((i) => (
				<div key={i} className="flex items-center gap-3 px-4 py-3">
					<Skeleton className="size-9 rounded-full" />
					<div className="flex-1 space-y-2">
						<Skeleton className="h-3.5 w-32" />
						<Skeleton className="h-3 w-48" />
					</div>
				</div>
			))}
		</div>
	);
}

/**
 * What `GET /api/v1/config` says is missing before the first send works:
 * no domain (the gateway allows no sender for this app yet, `everyapp email
 * set --sender`), or sending off (`ready: false` with domains present: the
 * gateway has no sender of its own, `EMAIL_FROM`). Owners and admins get the
 * command; members are told whom to ask. Nothing while both are fine.
 */
function SetupBanner({
	noDomain,
	sendingOff,
	isAdmin,
}: {
	noDomain: boolean;
	sendingOff: boolean;
	isAdmin: boolean;
}) {
	if (!noDomain && !sendingOff) return null;
	const title = noDomain
		? "No mail domain yet"
		: isAdmin
			? "Sending is off until the gateway's email sender is set"
			: "Sending is off until an owner or admin finishes email setup";
	const description = noDomain ? (
		isAdmin ? (
			<>
				Mailboxes live on a domain this app may send from, and none is allowed yet. In the app's
				directory run <Command>pnpm everyapp email set --sender '*@your-domain.com'</Command>, then
				reload this page.
			</>
		) : (
			"Ask an owner or admin to finish email setup. Mailboxes can be created once a domain is allowed."
		)
	) : isAdmin ? (
		<>
			Mail still arrives and drafts save. Set it with{" "}
			<Command>pnpm everyapp secret set EMAIL_FROM EMAIL_FROM_NAME</Command>.
		</>
	) : (
		"Mail still arrives and drafts save."
	);
	return (
		<Alert variant="warning">
			<TriangleAlert />
			<AlertTitle>{title}</AlertTitle>
			<AlertDescription>{description}</AlertDescription>
		</Alert>
	);
}

/** A command to paste, inline in a sentence; wraps inside a word only when it must. */
function Command({ children }: { children: React.ReactNode }) {
	return (
		<code className="rounded bg-foreground/[0.06] px-1 py-0.5 font-mono text-[0.8125rem] text-foreground [overflow-wrap:anywhere]">
			{children}
		</code>
	);
}
