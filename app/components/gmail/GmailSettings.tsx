/**
 * The mailbox settings page's Gmail section (docs/GMAIL.md): the Google
 * account the inbox mirrors, and Reconnect. Nothing for a native inbox, or
 * for someone else's view of it.
 */
import type { ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { isGmailMailbox } from "~/lib/gmail";
import { useGmailStatus } from "~/queries/gmail";
import type { PortMailbox } from "~/services/gmail-api";

/** A Gateway page: a full-page navigation, which comes back to OpenMail. */
function GatewayLink({ href, children }: { href: string; children: ReactNode }) {
	return (
		<Button size="xs" variant="outline" render={<a href={href} />} nativeButton={false}>
			{children}
		</Button>
	);
}

function Row({ label, description, children }: { label: ReactNode; description: ReactNode; children?: ReactNode }) {
	return (
		<div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
			<div className="min-w-0 space-y-0.5">
				<div className="flex items-center gap-2 text-sm font-medium">{label}</div>
				<div className="text-sm text-muted-foreground">{description}</div>
			</div>
			{children && <div className="flex shrink-0 items-center">{children}</div>}
		</div>
	);
}

export default function GmailSettings({ mailbox }: { mailbox: PortMailbox }) {
	const { data: status } = useGmailStatus();
	if (!isGmailMailbox(mailbox) || !status?.connection) return null;

	return (
		<section className="space-y-3">
			<div className="min-w-0 space-y-1">
				<h2 className="text-base font-semibold tracking-tight">Gmail</h2>
				<p className="text-sm text-muted-foreground">
					Connected as {status.connection.label}. OpenMail keeps this inbox in sync and drafts replies in Gmail, also
					while it's closed. Send in OpenMail sends through your Gmail; AI clients only save drafts.
				</p>
			</div>
			<div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-xs">
				<Row label="Google connection" description="Reconnect if Google stops letting OpenMail reach your Gmail.">
					{status.connectUrl && <GatewayLink href={status.connectUrl}>Reconnect</GatewayLink>}
				</Row>
			</div>
		</section>
	);
}
