/**
 * What a Gmail mailbox adds under an open message: the drafting status of
 * the reply to it, and, on a draft, "Open in Gmail". Its labels are
 * OpenMail's own, shown and edited as on any mailbox. Mounted in
 * ThreadMessage; `GmailDraftButton` sits beside the agent draft's Send in
 * DraftCard. Nothing for a native mailbox.
 */
import { Folders } from "shared/folders";
import { cn } from "~/lib/cn";
import { useIsGmailMailbox } from "~/queries/gmail";
import type { Email } from "~/types";
import { DraftingNotice } from "./DraftingStatus";
import OpenInGmailButton from "./OpenInGmailButton";

export default function GmailMessageExtras({
	mailboxId,
	email,
	showOpenInGmail = email.folder_id === Folders.DRAFT,
	matchThread = false,
	className,
}: {
	mailboxId: string | undefined;
	email: Email;
	/** Show "Open in Gmail" (a draft; the draft card puts its own next to Send). */
	showOpenInGmail?: boolean;
	/** Show a drafting job for any message in the thread, not only this one. */
	matchThread?: boolean;
	className?: string;
}) {
	const isGmail = useIsGmailMailbox(mailboxId);
	if (!isGmail || !mailboxId) return null;
	const isDraft = email.folder_id === Folders.DRAFT;
	return (
		<div className={cn("space-y-2", className)}>
			{showOpenInGmail && (
				<div className="flex items-center gap-2">
					<OpenInGmailButton mailboxId={mailboxId} emailId={email.id} />
					<span className="text-xs text-muted-foreground">Review and send it from Gmail.</span>
				</div>
			)}
			{!isDraft && (
				<DraftingNotice
					mailboxId={mailboxId}
					emailId={email.id}
					threadId={matchThread ? email.thread_id : undefined}
				/>
			)}
		</div>
	);
}

/** "Open in Gmail" beside a draft's Send, for a Gmail mailbox only. */
export function GmailDraftButton({ mailboxId, emailId }: { mailboxId: string | undefined; emailId: string }) {
	const isGmail = useIsGmailMailbox(mailboxId);
	if (!isGmail) return null;
	return <OpenInGmailButton mailboxId={mailboxId} emailId={emailId} />;
}
