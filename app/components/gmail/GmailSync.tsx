/**
 * Mounted once in the mailbox frame, under the top bar: runs the sync poll
 * for a Gmail mailbox (useGmailSync) and shows a one-line status ("Synced
 * 12 s ago", "Syncing…"), or a banner with a Reconnect link when Google needs
 * it. Nothing for a native mailbox.
 */
import { Mail, RefreshCw, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { useGmailSync } from "~/hooks/useGmailSync";
import { useNow } from "~/hooks/useNow";
import { cn } from "~/lib/cn";
import { formatSyncedAgo } from "~/lib/gmail";
import { useGmailStatus, useIsGmailMailbox } from "~/queries/gmail";

export default function GmailSync({ mailboxId }: { mailboxId: string | undefined }) {
	const isGmail = useIsGmailMailbox(mailboxId);
	const sync = useGmailSync(mailboxId, isGmail);
	const now = useNow(5_000, isGmail && sync.lastSyncedAt !== null);
	const { data: status } = useGmailStatus();
	if (!isGmail) return null;

	if (sync.reconnect) {
		return (
			<Alert variant="warning" banner>
				<TriangleAlert />
				<AlertTitle>Reconnect Gmail to keep this inbox in sync</AlertTitle>
				<AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
					<span>Google stopped letting OpenMail reach your Gmail. Your mail here is kept.</span>
					{status?.connectUrl && (
						<Button size="xs" variant="outline" render={<a href={status.connectUrl} />} nativeButton={false}>
							Reconnect
						</Button>
					)}
				</AlertDescription>
			</Alert>
		);
	}

	const label = sync.syncing
		? "Syncing…"
		: sync.error
			? "Couldn't sync with Gmail"
			: sync.lastSyncedAt !== null
				? formatSyncedAgo(sync.lastSyncedAt, now)
				: "Syncing…";
	return (
		<div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 px-4 pb-1.5 text-xs text-muted-foreground md:px-5">
			<Mail className="size-3" aria-hidden />
			<span>Gmail</span>
			<span aria-hidden>·</span>
			<button
				type="button"
				onClick={sync.syncNow}
				disabled={sync.syncing}
				title={sync.error ?? "Sync now"}
				className={cn(
					"inline-flex items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
					sync.error && !sync.syncing && "text-warning",
				)}
				aria-live="polite"
			>
				<RefreshCw className={cn("size-3", sync.syncing && "animate-spin")} aria-hidden />
				{label}
			</button>
		</div>
	);
}
