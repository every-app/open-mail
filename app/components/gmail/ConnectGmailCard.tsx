/**
 * The home page's Gmail card, from `GET /api/v1/gmail/status`: Google not
 * set up on the Gateway (an admin's job), "Connect Gmail" (a full-page trip
 * to Google's consent, which comes back here; the only step), "Reconnect"
 * when Google asks for it, and "Add your Gmail inbox" once connected
 * (`POST /api/v1/gmail/mailboxes`, then the new inbox). Before connecting,
 * it links to Every App's setup page for personal @gmail.com accounts.
 * Nothing on a build without the Gmail routes.
 */
import { Mail, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { isGmailMailbox, needsReconnect, PERSONAL_GMAIL_DOCS } from "~/lib/gmail";
import { useCreateGmailMailbox, useGmailMailboxIds, useGmailStatus } from "~/queries/gmail";
import { useMailbox, useMailboxes } from "~/queries/mailboxes";
import { ApiError } from "~/services/api";

/** A Gateway page: a full-page navigation, which comes back to OpenMail. */
function GatewayLink({ href, variant = "default", children }: { href: string; variant?: "default" | "outline" | "ghost"; children: ReactNode }) {
	return (
		<Button size="sm" variant={variant} render={<a href={href} />} nativeButton={false}>
			{children}
		</Button>
	);
}

export default function ConnectGmailCard() {
	const navigate = useNavigate();
	const { data: status, error } = useGmailStatus();
	const createMailbox = useCreateGmailMailbox();
	// The list holds only the caller's mailboxes and the shared ones, and a Gmail one is never shared.
	const { data: mailboxes = [] } = useMailboxes();
	const hasGmailMailbox = useGmailMailboxIds(mailboxes).size > 0;
	if (!status || error) return null;

	const connection = status.connection;
	const reconnect = needsReconnect(status);
	let description: ReactNode;
	let actions: ReactNode = null;

	const addInbox = () =>
		createMailbox.mutate(undefined, {
			onSuccess: (mailbox) => navigate(`/mailbox/${mailbox.id}`),
			onError: (err) => {
				if (err instanceof ApiError && err.status === 409) toast("Your Gmail inbox is already here.");
				else toast.error((err instanceof Error && err.message) || "Couldn't add your Gmail inbox.");
			},
		});

	const personalGmail = (
		<>
			{" "}
			<a
				href={PERSONAL_GMAIL_DOCS}
				target="_blank"
				rel="noreferrer"
				className="font-medium text-primary underline-offset-4 hover:underline"
			>
				Using a personal @gmail.com account?
			</a>
		</>
	);

	if (!status.configured) {
		description = (
			<>
				An admin needs to set up Google on the Gateway before you can connect Gmail.
				{personalGmail}
			</>
		);
	} else if (!connection) {
		description = (
			<>
				Connect once, here in OpenMail, to read and answer your Gmail. The agent drafts replies, even while OpenMail
				is closed, and you send them.
				{personalGmail}
			</>
		);
		actions = status.connectUrl && <GatewayLink href={status.connectUrl}>Connect Gmail</GatewayLink>;
	} else if (reconnect) {
		description = "Google needs you to reconnect before OpenMail can reach your Gmail again.";
		actions = status.connectUrl && <GatewayLink href={status.connectUrl}>Reconnect</GatewayLink>;
	} else if (!hasGmailMailbox) {
		description = `Connected as ${connection.label}. Add your Gmail inbox to start.`;
		actions = (
			<Button size="sm" pending={createMailbox.isPending} onClick={addInbox}>
				{!createMailbox.isPending && <Plus data-icon="inline-start" />}
				Add your Gmail inbox
			</Button>
		);
	} else {
		// Connected, with the inbox in the list: nothing to do here.
		return null;
	}

	return (
		<div className="flex flex-col gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-xs sm:flex-row sm:items-center">
			<div className="flex min-w-0 flex-1 items-center gap-3">
				<span
					aria-hidden
					className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-foreground"
				>
					<Mail className="size-4" />
				</span>
				<div className="min-w-0">
					<div className="text-sm font-medium">Gmail</div>
					<div className="text-sm text-muted-foreground">{description}</div>
				</div>
			</div>
			{actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
		</div>
	);
}

/**
 * The "Gmail" tag on a mailbox row: from the row's settings when the list
 * gives them, else from the mailbox's detail (docs/GMAIL.md, "UI needs").
 */
export function GmailMailboxBadge({ mailbox }: { mailbox: { id: string; settings?: unknown } }) {
	const listed = mailbox.settings !== undefined;
	const { data: detail } = useMailbox(listed ? undefined : mailbox.id);
	if (!isGmailMailbox(listed ? mailbox : detail)) return null;
	return (
		<Badge variant="secondary">
			<Mail data-icon="inline-start" />
			Gmail
		</Badge>
	);
}
