/**
 * The auto-draft's progress (docs/GMAIL.md, "Drafting status"): "Drafting
 * reply… 0:42 (usually ~1:10)" with a live timer while the job is queued,
 * "Couldn't draft a reply" when it failed. The jobs come from the sync poll
 * (useGmailSync seeds them) or `GET …/gmail/drafting`.
 */
import { LoaderCircle, TriangleAlert } from "lucide-react";
import { useParams } from "react-router";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { useNow } from "~/hooks/useNow";
import { cn } from "~/lib/cn";
import { draftingStatus, findDraftJob } from "~/lib/gmail";
import { useDraftJobs, useIsGmailMailbox } from "~/queries/gmail";

function useDraftJob(mailboxId: string | undefined, target: { emailId?: string; threadId?: string | null }) {
	const isGmail = useIsGmailMailbox(mailboxId);
	const { data: jobs } = useDraftJobs(mailboxId, isGmail);
	const job = isGmail ? findDraftJob(jobs, target) : undefined;
	const now = useNow(1_000, job?.state === "queued");
	return draftingStatus(job, now);
}

/** On a list row, before the subject. The mailbox defaults to the route's. */
export function DraftingRowStatus({
	mailboxId,
	email,
}: {
	mailboxId?: string;
	email: { id: string; thread_id?: string | null };
}) {
	const params = useParams();
	const status = useDraftJob(mailboxId ?? params.mailboxId, { emailId: email.id, threadId: email.thread_id });
	if (!status) return null;
	if (status.state === "failed") {
		return (
			<Tooltip>
				<TooltipTrigger
					render={<span className="inline-flex shrink-0 items-center gap-1 text-xs text-warning" />}
				>
					<TriangleAlert className="size-3" aria-hidden />
					No draft
				</TooltipTrigger>
				<TooltipContent>Couldn't draft a reply. Ask the agent to draft one.</TooltipContent>
			</Tooltip>
		);
	}
	return (
		<span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground tabular-nums">
			<LoaderCircle className="size-3 animate-spin" aria-hidden />
			<span className="hidden lg:inline">Drafting reply…</span>
			<span className="lg:hidden">Drafting…</span> {status.elapsed}
		</span>
	);
}

/** Under an open message: the job for this email, or its thread. */
export function DraftingNotice({
	mailboxId,
	emailId,
	threadId,
	className,
}: {
	mailboxId: string | undefined;
	emailId: string;
	threadId?: string | null;
	className?: string;
}) {
	const status = useDraftJob(mailboxId, { emailId, threadId });
	if (!status) return null;
	if (status.state === "failed") {
		return (
			<div className={cn("flex items-center gap-2 text-sm text-warning", className)}>
				<TriangleAlert className="size-3.5 shrink-0" aria-hidden />
				<span>
					Couldn't draft a reply. <span className="text-muted-foreground">Ask the agent to draft one.</span>
				</span>
			</div>
		);
	}
	return (
		<div className={cn("flex items-center gap-2 text-sm text-muted-foreground tabular-nums", className)} aria-live="polite">
			<LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden />
			<span>
				Drafting reply… {status.elapsed}
				{status.estimate && ` (usually ${status.estimate})`}
			</span>
		</div>
	);
}
