// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Ellipsis, Mail, Plus, Settings, Trash2, TriangleAlert } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link as RouterLink } from "react-router";
import { Folders } from "shared/folders";
import { toast } from "sonner";
import { PageHeader } from "~/components/PageHeader";
import { AccountMenu } from "~/components/AccountMenu";
import { SenderAvatar } from "~/components/conversation/SenderAvatar";
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
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "~/components/ui/empty";
import { Field, FieldError, FieldGroup, FieldLabel } from "~/components/ui/field";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Skeleton } from "~/components/ui/skeleton";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { cn } from "~/lib/cn";
import { formatListDate, mailboxDisplayName } from "~/lib/utils";
// Gmail (docs/GMAIL.md): the connect card and the rows' Gmail tag.
import ConnectGmailCard, { GmailMailboxBadge } from "~/components/gmail/ConnectGmailCard";
import GmailOnly from "~/components/gmail/GmailOnly";
import { useFolders } from "~/queries/folders";
import { queryKeys } from "~/queries/keys";
import { useEmails } from "~/queries/emails";
import { useCreateMailbox, useDeleteMailbox, useMailbox, useMailboxes } from "~/queries/mailboxes";
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
				// No sender name until someone sets one in Settings: sending waits for it.
				return api.createMailbox(addr, addr, { fromName: "" }).catch(() => {});
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
		const name = newName.trim();
		if (!newPrefix || !selectedDomain || !name) {
			setCreateError("Please fill in all fields");
			return;
		}
		const email = `${newPrefix}@${selectedDomain}`;
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
		<div className="flex h-dvh flex-col overflow-hidden bg-background">
			<HomeHeader />

			{/* The mail frame's main pane, so the picker and a mailbox read as one app. */}
			<main className="min-h-0 flex-1 overflow-y-auto bg-card md:mx-2 md:mb-2 md:rounded-xl md:border md:border-border">
				<div className="mx-auto w-full max-w-4xl space-y-8 px-4 pt-6 pb-16 sm:px-6 md:px-10 md:pt-10">
					<PageHeader
						title="Mailboxes"
						description="Shared with everyone in your organization. Pick one to open its inbox."
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
						<ul className="grid gap-4 sm:grid-cols-2">
							{accounts.map((account) => (
								<MailboxCard
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
								<FieldLabel htmlFor="mailbox-name">Sender name</FieldLabel>
								<Input
									id="mailbox-name"
									placeholder="Ben from OpenSEO"
									value={newName}
									onChange={(e) => setNewName(e.target.value)}
									required
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
						<AlertDialogTitle>Delete this mailbox?</AlertDialogTitle>
						<AlertDialogDescription>
							<strong className="font-medium text-foreground">{mailboxToDelete?.email}</strong> disappears for
							everyone in your organization, with its settings, and mail sent to it stops arriving here.
							This can't be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<Button variant="destructive" pending={deleteMailbox.isPending} onClick={handleDelete}>
							Delete mailbox
						</Button>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}

/** Home's top bar: the product where the mail frame has its mailbox, then the person's menu. */
function HomeHeader() {
	return (
		<header className="flex h-14 shrink-0 items-center gap-2 px-3 md:px-4">
			<RouterLink
				to="/"
				className="flex items-center gap-2.5 rounded-lg px-1 text-base font-semibold tracking-tight outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
			>
				<span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-xs">
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

/**
 * One mailbox as a card: its name as the mail frame shows it (the sender
 * name from its settings, else the name it was created with, else a name
 * made from the address), the address, the newest conversation in its Inbox,
 * and what waits in it (unread mail, drafts to review). The whole card opens
 * the mailbox. Settings and Delete, rare and (for Delete) destructive, live
 * in the card's "More" menu, the same on every card, never beside the link.
 */
function MailboxCard({
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
	const { data: detail } = useMailbox(id);
	const { data: drafts } = useEmails(id, { folder: Folders.DRAFT, page: "1", limit: "1" });
	const { data: latestPage } = useEmails(id, { folder: Folders.INBOX, page: "1", limit: "1" });
	const latest = latestPage?.emails?.[0];
	const unread = folders?.find((f) => f.id === Folders.INBOX)?.unreadCount ?? 0;
	const draftCount = drafts?.totalCount ?? 0;
	const displayName = mailboxDisplayName(detail ?? { email, name }, id);

	return (
		<li className="group relative flex flex-col rounded-xl border border-border bg-card shadow-xs transition-[border-color,box-shadow] hover:border-primary/40 hover:shadow-md has-[a:focus-visible]:border-primary has-[a:focus-visible]:ring-3 has-[a:focus-visible]:ring-ring/30">
			<div className="flex items-start gap-3 p-5 pb-4">
				<SenderAvatar sender={email} name={displayName} className="size-11 rounded-xl text-base" />
				<div className="min-w-0 flex-1 pt-0.5">
					<RouterLink
						to={`/mailbox/${id}`}
						className="block truncate text-base leading-6 font-semibold text-foreground outline-none after:absolute after:inset-0 after:rounded-xl"
					>
						{displayName}
					</RouterLink>
					<div className="truncate text-sm text-muted-foreground">{email}</div>
				</div>
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={`More for ${displayName}`}
								className="relative z-10 -mt-1 -mr-2 text-muted-foreground"
							/>
						}
					>
						<Ellipsis />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-48">
						<DropdownMenuItem render={<RouterLink to={`/mailbox/${id}/settings`} />}>
							<Settings />
							Mailbox settings
						</DropdownMenuItem>
						{onDelete && (
							<>
								<DropdownMenuSeparator />
								<DropdownMenuItem variant="destructive" onClick={onDelete}>
									<Trash2 />
									Delete mailbox…
								</DropdownMenuItem>
							</>
						)}
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			<div className="min-h-11 px-5 pb-4 pl-[4.75rem] text-sm">
				{latest ? (
					<div className="flex min-w-0 items-baseline gap-2">
						<span className={cn("min-w-0 truncate", latest.read ? "text-muted-foreground" : "font-medium text-foreground")}>
							{latest.subject || "(no subject)"}
						</span>
						<span className="shrink-0 text-xs text-muted-foreground">{formatListDate(latest.date)}</span>
					</div>
				) : latestPage ? (
					<span className="text-muted-foreground">No mail yet</span>
				) : null}
			</div>
			<div className="mt-auto flex items-center gap-2 border-t border-border px-5 py-3 text-sm">
				{unread > 0 ? (
					<span className="inline-flex items-center gap-1.5 font-medium text-foreground">
						<span className="size-1.5 rounded-full bg-primary" aria-hidden />
						{unread} unread
					</span>
				) : (
					<span className="text-muted-foreground">All read</span>
				)}
				{draftCount > 0 && (
					<>
						<span className="text-muted-foreground/50" aria-hidden>
							·
						</span>
						<span className="text-muted-foreground">
							{draftCount} {draftCount === 1 ? "draft" : "drafts"} to review
						</span>
					</>
				)}
				{badge}
				<span className="ml-auto inline-flex items-center gap-0.5 text-sm font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100 pointer-coarse:opacity-100">
					Open
					<ChevronRight className="size-4" aria-hidden />
				</span>
			</div>
		</li>
	);
}

function MailboxListSkeleton() {
	return (
		<div className="grid gap-4 sm:grid-cols-2" aria-busy>
			{[0, 1].map((i) => (
				<div key={i} className="rounded-xl border border-border bg-card shadow-xs">
					<div className="flex items-start gap-3 p-5 pb-4">
						<Skeleton className="size-11 rounded-xl" />
						<div className="flex-1 space-y-2 pt-1">
							<Skeleton className="h-4 w-28" />
							<Skeleton className="h-3 w-40" />
						</div>
					</div>
					<div className="border-t border-border px-5 py-3">
						<Skeleton className="h-3.5 w-20" />
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
