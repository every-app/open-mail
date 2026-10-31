// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { Info, RotateCcw } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { PageHeader } from "~/components/PageHeader";
import { ThemePreferenceRadio } from "~/components/ThemePreferenceMenuItems";
import { Alert, AlertDescription } from "~/components/ui/alert";
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
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { cn } from "~/lib/cn";
import { mailboxDisplayName } from "~/lib/utils";
import { queryKeys } from "~/queries/keys";
import { useDeleteMailbox, useMailbox, useUpdateMailbox } from "~/queries/mailboxes";
import api, { meQuery } from "~/services/api";
import type { Mailbox } from "~/types";

// An example shown in the empty textarea. The default instructions live in
// workers/agent/index.ts (DEFAULT_SYSTEM_PROMPT).
const PROMPT_PLACEHOLDER = "Reply as the Acme support team. Keep it to three sentences. Never quote prices.";

/** What the page edits; everything else in the mailbox's settings is kept as it is. */
interface Form {
	fromName: string;
	signatureEnabled: boolean;
	signatureText: string;
	agentPrompt: string;
}

function formOf(mailbox: Mailbox): Form {
	return {
		fromName: mailbox.settings?.fromName || mailbox.name || "",
		signatureEnabled: mailbox.settings?.signature?.enabled ?? false,
		signatureText: mailbox.settings?.signature?.text ?? "",
		agentPrompt: mailbox.settings?.agentSystemPrompt || "",
	};
}

function sameForm(a: Form, b: Form) {
	return (
		a.fromName === b.fromName &&
		a.signatureEnabled === b.signatureEnabled &&
		a.signatureText === b.signatureText &&
		a.agentPrompt === b.agentPrompt
	);
}

export default function SettingsRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const navigate = useNavigate();
	const { data: mailbox } = useMailbox(mailboxId);
	const updateMailbox = useUpdateMailbox();
	const deleteMailbox = useDeleteMailbox();

	// Only owners and admins may change a mailbox; the Worker enforces it
	// (workers/everyapp/identity.ts). The page hides what it would refuse,
	// as the home page does, once the role is known.
	const { data: me } = useQuery(meQuery);
	const isAdmin = me?.role === "owner" || me?.role === "admin";
	const readOnly = me !== undefined && !isAdmin;
	useDocumentTitle("Settings", mailboxDisplayName(mailbox, mailboxId));

	// Mailboxes listed in the config are the gateway's to keep: as on the
	// home page, they can't be deleted from here.
	const { data: config } = useQuery({
		queryKey: queryKeys.config,
		queryFn: () => api.getConfig(),
		staleTime: Infinity,
	});
	const canDelete = isAdmin && !!config && config.emailAddresses.length === 0;

	// The saved values come from the mailbox; `draft` holds the edits until
	// they are saved or discarded, so a refetch never overwrites typing.
	const [draft, setDraft] = useState<Form | null>(null);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [isDeleteOpen, setIsDeleteOpen] = useState(false);

	if (!mailbox || !mailboxId) return <SettingsSkeleton />;

	const saved = formOf(mailbox);
	const form = draft ?? saved;
	const isDirty = draft !== null && !sameForm(draft, saved);
	const update = (patch: Partial<Form>) => {
		setSaveError(null);
		setDraft({ ...form, ...patch });
	};

	const handleSave = async () => {
		setSaveError(null);
		const previous = mailbox.settings?.signature;
		const settings = {
			...mailbox.settings,
			fromName: form.fromName,
			signature: {
				...previous,
				enabled: form.signatureEnabled,
				text: form.signatureText,
				// An HTML signature (set over the API) wins over the text in
				// compose; editing the text here replaces it.
				html: form.signatureText === (previous?.text ?? "") ? previous?.html : undefined,
			},
			agentSystemPrompt: form.agentPrompt.trim() || undefined,
		};
		try {
			await updateMailbox.mutateAsync({ mailboxId, settings });
			setDraft(null);
			toast.success("Settings saved");
		} catch (err: unknown) {
			setSaveError((err instanceof Error ? err.message : null) || "Failed to save settings");
		}
	};

	const handleDelete = async () => {
		try {
			await deleteMailbox.mutateAsync(mailboxId);
			toast.success("Mailbox deleted");
			navigate("/");
		} catch {
			toast.error("Failed to delete mailbox");
		}
	};

	const isCustomPrompt = form.agentPrompt.trim().length > 0;

	return (
		<div className="flex h-full flex-col overflow-y-auto">
			<div className="flex-1 px-4 pt-5 pb-10 md:px-8 md:pt-8">
				<div className="mx-auto max-w-3xl space-y-8">
					<PageHeader title="Settings" description={mailbox.email} />

					{readOnly && (
						<Alert variant="info">
							<Info />
							<AlertDescription className="text-foreground">
								Only owners and admins can change a mailbox's settings.
							</AlertDescription>
						</Alert>
					)}

					<SettingsSection title="General" description="How this mailbox signs the mail it sends.">
						<SettingsCard>
							<SettingsRow label="Sender name" description="Shown as the From name." htmlFor="sender-name">
								<Input
									id="sender-name"
									value={form.fromName}
									onChange={(e) => update({ fromName: e.target.value })}
									disabled={readOnly}
									className="sm:w-72"
								/>
							</SettingsRow>
							<SettingsRow label="Address" description="Set when the mailbox was created." htmlFor="mailbox-address">
								<Input id="mailbox-address" type="email" value={mailbox.email} disabled className="sm:w-72" />
							</SettingsRow>
						</SettingsCard>
					</SettingsSection>

					<SettingsSection title="Signature" description="Added under new messages, replies and forwards.">
						<SettingsCard>
							<SettingsRow label="Use a signature" htmlFor="signature-enabled">
								<Switch
									id="signature-enabled"
									checked={form.signatureEnabled}
									onCheckedChange={(checked) => update({ signatureEnabled: checked })}
									disabled={readOnly}
								/>
							</SettingsRow>
							<SettingsRow label="Signature" htmlFor="signature-text" stacked>
								<Textarea
									id="signature-text"
									value={form.signatureText}
									onChange={(e) => update({ signatureText: e.target.value })}
									placeholder={"Ada Lovelace\nAcme support"}
									rows={4}
									disabled={readOnly || !form.signatureEnabled}
									className="min-h-24"
								/>
							</SettingsRow>
						</SettingsCard>
					</SettingsSection>

					<SettingsSection
						title="Agent"
						description="How the agent writes and behaves for this mailbox. Leave empty for the default."
						action={
							isCustomPrompt && !readOnly ? (
								<Button variant="ghost" size="sm" onClick={() => update({ agentPrompt: "" })}>
									<RotateCcw data-icon="inline-start" />
									Reset to default
								</Button>
							) : undefined
						}
					>
						<SettingsCard>
							<SettingsRow
								label={
									<span className="flex items-center gap-2">
										Agent instructions
										{isCustomPrompt ? <Badge variant="soft">Custom</Badge> : <Badge variant="secondary">Default</Badge>}
									</span>
								}
								htmlFor="agent-prompt"
								stacked
							>
								<Textarea
									id="agent-prompt"
									value={form.agentPrompt}
									onChange={(e) => update({ agentPrompt: e.target.value })}
									placeholder={PROMPT_PLACEHOLDER}
									rows={10}
									disabled={readOnly}
									className="max-h-[28rem] min-h-40 font-mono text-xs leading-relaxed md:text-xs"
								/>
							</SettingsRow>
						</SettingsCard>
					</SettingsSection>

					<SettingsSection title="Appearance" description="Saved on this device, for every mailbox.">
						<SettingsCard>
							<SettingsRow label="Theme">
								<ThemePreferenceRadio />
							</SettingsRow>
						</SettingsCard>
					</SettingsSection>

					{canDelete && (
						<SettingsSection title="Danger zone">
							<SettingsCard className="border-destructive/30">
								<SettingsRow
									label="Delete mailbox"
									description="Removes the mailbox and all its mail for everyone. This can't be undone."
								>
									<Button variant="destructive" onClick={() => setIsDeleteOpen(true)}>
										Delete mailbox
									</Button>
								</SettingsRow>
							</SettingsCard>
						</SettingsSection>
					)}
				</div>
			</div>

			{!readOnly && (isDirty || saveError) && (
				<div className="sticky bottom-0 border-t border-border bg-card/95 px-4 py-3 backdrop-blur md:px-8">
					<div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3">
						<p role={saveError ? "alert" : undefined} className={cn("min-w-0 text-sm", saveError ? "text-destructive" : "text-muted-foreground")}>
							{saveError ?? "You have unsaved changes."}
						</p>
						<div className="flex shrink-0 items-center gap-2">
							<Button
								variant="outline"
								onClick={() => {
									setDraft(null);
									setSaveError(null);
								}}
								disabled={updateMailbox.isPending}
							>
								Discard
							</Button>
							<Button onClick={handleSave} pending={updateMailbox.isPending} disabled={!isDirty}>
								Save changes
							</Button>
						</div>
					</div>
				</div>
			)}

			<AlertDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete mailbox</AlertDialogTitle>
						<AlertDialogDescription>
							Delete <strong className="font-medium text-foreground">{mailbox.email}</strong>?
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

// OpenCRM's settings anatomy (SettingsSection.tsx): titled sections of
// cards, each card a stack of rows, the setting on the left and its control
// on the right (under it below `sm`, or always when `stacked`).

function SettingsSection({
	title,
	description,
	action,
	children,
}: {
	title: ReactNode;
	description?: ReactNode;
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section className="space-y-3">
			<div className={cn("flex justify-between gap-3", description ? "items-end" : "items-center")}>
				<div className="min-w-0 space-y-1">
					<h2 className="text-base font-semibold tracking-tight">{title}</h2>
					{description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
				</div>
				{action ? <div className="flex shrink-0 gap-2">{action}</div> : null}
			</div>
			{children}
		</section>
	);
}

function SettingsCard({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<div
			className={cn(
				"divide-y divide-border overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-xs",
				className,
			)}
		>
			{children}
		</div>
	);
}

function SettingsRow({
	label,
	description,
	htmlFor,
	children,
	stacked = false,
}: {
	label: ReactNode;
	description?: ReactNode;
	htmlFor?: string;
	children?: ReactNode;
	stacked?: boolean;
}) {
	const Label = htmlFor ? "label" : "div";
	return (
		<div
			className={cn(
				"flex flex-col gap-3 px-5 py-4",
				!stacked && "sm:flex-row sm:items-center sm:justify-between sm:gap-8",
			)}
		>
			<div className="min-w-0 space-y-0.5">
				<Label htmlFor={htmlFor} className="block text-sm font-medium">
					{label}
				</Label>
				{description ? <div className="text-sm text-muted-foreground">{description}</div> : null}
			</div>
			{children ? (
				<div className={cn("flex min-w-0 items-center gap-2", !stacked && "sm:shrink-0 sm:justify-end")}>
					{children}
				</div>
			) : null}
		</div>
	);
}

function SettingsSkeleton() {
	return (
		<div className="px-4 pt-5 md:px-8 md:pt-8">
			<div className="mx-auto max-w-3xl space-y-8" aria-busy>
				<div className="space-y-2">
					<Skeleton className="h-7 w-32" />
					<Skeleton className="h-4 w-56" />
				</div>
				{[0, 1].map((i) => (
					<div key={i} className="space-y-3">
						<Skeleton className="h-5 w-24" />
						<Skeleton className="h-32 w-full rounded-xl" />
					</div>
				))}
			</div>
		</div>
	);
}
