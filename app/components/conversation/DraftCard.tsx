import { PenLine, Send, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { formatListDate, htmlToPlainText } from "~/lib/utils";
import type { Email } from "~/types";
import { IconTooltip } from "./IconTooltip";
import { shortRecipients } from "./people";
import { SenderAvatar } from "./SenderAvatar";

/** The text a draft would send, without the quoted message under it. */
function draftText(body: string | null | undefined): string {
	const html = body || "";
	const quote = html.search(/<blockquote/i);
	return htmlToPlainText(quote >= 0 ? html.slice(0, quote) : html).trim();
}

/**
 * A draft in the conversation (usually the agent's reply), waiting for a
 * person: an entry in the thread like a message, written as the mailbox
 * would send it (avatar, name, who it goes to, the text in reading type),
 * marked "Draft · needs review" in the primary tone (work to review, not an
 * error), on a faint primary wash, with Send, Edit and Discard under it.
 */
export function DraftCard({
	draft,
	selfAddress,
	selfName,
	isSending,
	onEdit,
	onSend,
	onDiscard,
	extraActions,
}: {
	draft: Email;
	selfAddress?: string;
	/** What the mailbox is called, the draft's sender. */
	selfName?: string;
	isSending: boolean;
	onEdit: () => void;
	onSend: () => void;
	onDiscard: () => void;
	/** More buttons after Edit (Gmail's "Open in Gmail", docs/GMAIL.md). */
	extraActions?: ReactNode;
}) {
	const text = draftText(draft.body);
	const recipients = shortRecipients(draft.recipient, draft.cc, selfAddress);
	return (
		<article className="bg-primary/[0.035] px-4 pt-4 pb-4 sm:px-5" aria-label="Draft reply">
			<div className="flex items-start gap-3">
				<SenderAvatar sender={draft.sender || selfAddress || ""} name={selfName} self className="size-9" />
				<div className="min-w-0 flex-1">
					<div className="flex min-w-0 items-center gap-2 pt-px">
						<span className="truncate text-[0.9375rem] leading-5 font-semibold text-foreground">{selfName || "Draft"}</span>
						<span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[0.6875rem] font-semibold text-primary">
							<PenLine className="size-3" aria-hidden />
							Draft · needs review
						</span>
						<span className="ml-auto shrink-0 text-xs text-muted-foreground">{formatListDate(draft.date)}</span>
					</div>
					{recipients && <div className="mt-0.5 truncate text-xs text-muted-foreground">{recipients}</div>}
					<button
						type="button"
						onClick={onEdit}
						className="-mx-2 mt-3 block w-[calc(100%+1rem)] rounded-lg px-2 py-1 text-left text-[0.9375rem] leading-[1.65] text-foreground outline-none transition-colors hover:bg-foreground/[0.04] focus-visible:ring-3 focus-visible:ring-ring/50"
						aria-label="Edit draft"
					>
						{text ? (
							<span className="line-clamp-[16] block">
								{text.split(/\n\s*\n+/).map((paragraph, i) => (
									<span key={i} className="mb-[0.85em] block whitespace-pre-line last:mb-0">
										{paragraph.trim()}
									</span>
								))}
							</span>
						) : (
							<span className="text-muted-foreground italic">(empty draft)</span>
						)}
					</button>
					<div className="mt-3 flex items-center gap-2">
						<Button onClick={onSend} disabled={isSending} className="rounded-full px-4">
							{isSending ? <Spinner /> : <Send />}
							{isSending ? "Sending…" : "Send"}
						</Button>
						<Button variant="outline" onClick={onEdit} disabled={isSending} className="rounded-full px-4">
							<PenLine />
							Edit
						</Button>
						{extraActions}
						<IconTooltip label="Discard draft">
							<Button
								size="icon"
								variant="ghost"
								onClick={onDiscard}
								disabled={isSending}
								aria-label="Discard draft"
								className="ml-auto text-muted-foreground hover:text-destructive"
							>
								<Trash2 />
							</Button>
						</IconTooltip>
					</div>
				</div>
			</div>
		</article>
	);
}
