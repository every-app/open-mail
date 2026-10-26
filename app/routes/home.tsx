// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	Banner,
	Button,
	Dialog,
	Empty,
	Input,
	Loader,
	Select,
	Text,
	useKumoToastManager,
} from "@cloudflare/kumo";
import { CaretLeftIcon, EnvelopeIcon, PlusIcon, TrashIcon, WarningIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link as RouterLink } from "react-router";
import api, { meQuery } from "~/services/api";
import {
	useCreateMailbox,
	useDeleteMailbox,
	useMailboxes,
} from "~/queries/mailboxes";
import { queryKeys } from "~/queries/keys";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { mailboxDisplayName } from "~/lib/utils";

export function meta() {
	return [{ title: "Mailboxes · OpenMail" }];
}

export default function HomeRoute() {
	const toastManager = useKumoToastManager();
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
	const [isCreating, setIsCreating] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);
	const [isDeleteOpen, setIsDeleteOpen] = useState(false);
	const [mailboxToDelete, setMailboxToDelete] = useState<{
		id: string;
		email: string;
	} | null>(null);
	const [isDeleting, setIsDeleting] = useState(false);

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
		const existingEmails = new Set(
			mailboxes.map((m) => m.email.toLowerCase()),
		);
		const toCreate = emailAddresses.filter(
			(addr) => !existingEmails.has(addr.toLowerCase()),
		);
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
		).then(() => { if (!cancelled) refetchMailboxes(); });
		return () => { cancelled = true; };
	}, [emailAddresses, mailboxes, refetchMailboxes]);

	const handleCreate = async (e: FormEvent) => {
		e.preventDefault();
		setCreateError(null);
		if (!newPrefix || !selectedDomain) {
			setCreateError("Please fill in all fields");
			return;
		}
		const email = `${newPrefix}@${selectedDomain}`;
		const name = newName || newPrefix;
		setIsCreating(true);
		try {
			await createMailbox.mutateAsync({ email, name });
			toastManager.add({ title: "Mailbox created" });
			setIsCreateOpen(false);
			setNewPrefix("");
			setNewName("");
		} catch (err: unknown) {
			const message = (err instanceof Error ? err.message : null) || "Failed to create mailbox";
			setCreateError(message);
		} finally {
			setIsCreating(false);
		}
	};

	const handleDelete = async () => {
		if (!mailboxToDelete) return;
		setIsDeleting(true);
		try {
			await deleteMailbox.mutateAsync(mailboxToDelete.id);
			toastManager.add({ title: "Mailbox deleted" });
			setIsDeleteOpen(false);
			setMailboxToDelete(null);
		} catch {
			toastManager.add({ title: "Failed to delete mailbox", variant: "error" });
		} finally {
			setIsDeleting(false);
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

	return (
		<div className="min-h-screen bg-kumo-recessed">
			<div className="mx-auto max-w-2xl px-4 py-8 md:px-6 md:py-16">
				<div className="mb-8">
					{/* The way back up, first on the page as in every Every App app's sidebar. */}
					{me?.gatewayUrl && (
						<a
							href={me.gatewayUrl}
							aria-label="Back to Every App"
							className="mb-2.5 inline-flex items-center gap-1.5 text-sm text-kumo-subtle transition-colors hover:text-kumo-default"
						>
							<CaretLeftIcon size={14} />
							<span>Every App</span>
						</a>
					)}
					<div className="flex items-center justify-between">
						<h1 className="text-2xl font-bold text-kumo-default">Mailboxes</h1>
						{canCreate && accounts.length > 0 && (
							<Button
								variant="primary"
								icon={<PlusIcon size={16} />}
								onClick={() => setIsCreateOpen(true)}
							>
								New mailbox
							</Button>
						)}
					</div>
					<p className="text-sm text-kumo-subtle mt-1">
						Shared with everyone in your organization
					</p>
				</div>

				<SetupBanner noDomain={noDomain} sendingOff={sendingOff} isAdmin={isAdmin} />

				{isLoading ? (
					<div className="flex justify-center py-20">
						<Loader size="lg" />
					</div>
				) : accounts.length > 0 ? (
					<div className="rounded-xl border border-kumo-line bg-kumo-base overflow-hidden">
						{accounts.map((account, idx) => (
							<RouterLink
								key={account.id}
								to={`/mailbox/${account.id}`}
								className={`group flex items-center gap-4 px-5 py-4 no-underline transition-colors hover:bg-kumo-tint ${
									idx > 0 ? "border-t border-kumo-line" : ""
								}`}
							>
								<MailboxIdentity id={account.id} email={account.email} name={account.name} />
								{canManage && (
									<Button
										variant="ghost"
										size="sm"
										shape="square"
										icon={<TrashIcon size={16} />}
										aria-label={`Delete mailbox ${account.email}`}
										onClick={(e) => {
											e.preventDefault();
											e.stopPropagation();
											setMailboxToDelete({
												id: account.id,
												email: account.email,
											});
											setIsDeleteOpen(true);
										}}
									/>
								)}
							</RouterLink>
						))}
					</div>
				) : (
					<div className="rounded-xl border border-kumo-line bg-kumo-base py-16 px-6">
						<div className="flex flex-col items-center text-center">
							<div className="mb-4">
								<EnvelopeIcon
									size={48}
									weight="thin"
									className="text-kumo-subtle"
								/>
							</div>
							<h3 className="text-base font-semibold text-kumo-default mb-1.5">
								No mailboxes yet
							</h3>
							<p className="text-sm text-kumo-subtle max-w-sm mb-5">
								{isConfigured
									? "Your email routing is configured but no mailboxes have been created yet. They will appear here automatically."
									: noDomain
										? isAdmin
											? "Allow a mail domain first (above), then create a mailbox on it."
											: "Ask an owner or admin to finish email setup."
										: isAdmin
											? "Create a mailbox to start sending and receiving emails with your domain."
											: "Ask an owner or admin to create a mailbox."}
							</p>
							{canCreate && (
								<Button
									variant="primary"
									icon={<PlusIcon size={16} />}
									onClick={() => setIsCreateOpen(true)}
								>
									New mailbox
								</Button>
							)}
						</div>
					</div>
				)}
			</div>

			{/* Create Dialog */}
			<Dialog.Root open={isCreateOpen} onOpenChange={setIsCreateOpen}>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-5">
						New mailbox
					</Dialog.Title>
					<form onSubmit={handleCreate} className="space-y-4">
						{createError && (
							<Text variant="error" size="sm">
								{createError}
							</Text>
						)}
						<div>
							<span className="text-sm font-medium text-kumo-default mb-1.5 block">
								Address
							</span>
							<div className="flex items-center gap-2">
								<div className="flex-1">
									<Input
										aria-label="Address prefix"
										placeholder="info"
										size="sm"
										value={newPrefix}
										onChange={(e) => setNewPrefix(e.target.value)}
										required
									/>
								</div>
								<span className="text-sm text-kumo-subtle">@</span>
								{domains.length > 1 ? (
									<div className="flex-1">
							<Select
								aria-label="Domain"
								value={selectedDomain}
								onValueChange={(value) => {
									if (value) setSelectedDomain(value);
								}}
							>
											{domains.map((d) => (
												<Select.Option key={d} value={d}>
													{d}
												</Select.Option>
											))}
										</Select>
									</div>
								) : (
									<span className="text-sm text-kumo-subtle">
										{selectedDomain || "no domain yet"}
									</span>
								)}
							</div>
						</div>
						<Input
							label="Sender name (optional)"
							placeholder="Info"
							size="sm"
							value={newName}
							onChange={(e) => setNewName(e.target.value)}
						/>
						<div className="flex justify-end gap-2 pt-2">
							<Dialog.Close
								render={(props) => (
									<Button {...props} variant="secondary" size="sm">
										Cancel
									</Button>
								)}
							/>
							<Button
								type="submit"
								variant="primary"
								size="sm"
								loading={isCreating}
								disabled={!selectedDomain}
							>
								Create
							</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>

			{/* Delete Dialog */}
			<Dialog.Root
				open={isDeleteOpen}
				onOpenChange={(open) => {
					setIsDeleteOpen(open);
					if (!open) setMailboxToDelete(null);
				}}
			>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-2">
						Delete mailbox
					</Dialog.Title>
					<Dialog.Description className="text-kumo-subtle text-sm mb-5">
						Delete{" "}
						<strong className="text-kumo-default">
							{mailboxToDelete?.email}
						</strong>
						?
					</Dialog.Description>
					<div className="flex justify-end gap-2">
						<Dialog.Close
							render={(props) => (
								<Button {...props} variant="secondary" size="sm">
									Cancel
								</Button>
							)}
						/>
						<Button
							variant="destructive"
							size="sm"
							loading={isDeleting}
							onClick={handleDelete}
						>
							Delete
						</Button>
					</div>
				</Dialog>
			</Dialog.Root>
		</div>
	);
}

/**
 * A row's avatar, name and address, from the list alone: the name the API
 * lists (the display name given at creation, else the local part of the
 * address). The sender name set later in Settings travels with the mailbox,
 * not the list, so it shows on the mailbox page. When the name would be the
 * address itself, the address shows once.
 */
function MailboxIdentity({ id, email, name }: { id: string; email: string; name: string }) {
	const displayName = mailboxDisplayName({ email, name }, id);
	const sameAsAddress = displayName === email;
	return (
		<>
			<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-kumo-fill text-sm font-bold text-kumo-default">
				{displayName.charAt(0).toUpperCase()}
			</div>
			<div className="min-w-0 flex-1">
				<div className="text-sm font-medium text-kumo-default truncate">
					{sameAsAddress ? email : displayName}
				</div>
				{!sameAsAddress && (
					<div className="text-sm text-kumo-subtle">{email}</div>
				)}
			</div>
		</>
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
				Mailboxes live on a domain this app may send from, and none is
				allowed yet. In the app's directory run{" "}
				<Command>
					pnpm everyapp email set --sender '*@your-domain.com'
				</Command>
				, then reload this page.
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
		<Banner
			variant="alert"
			className="mb-6"
			icon={<WarningIcon size={18} weight="fill" />}
			title={title}
			description={description}
		/>
	);
}

/** A command to paste, inline in a sentence; wraps inside a word only when it must. */
function Command({ children }: { children: React.ReactNode }) {
	return <code className="font-mono [overflow-wrap:anywhere]">{children}</code>;
}
