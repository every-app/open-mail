import { Pencil, Send, Trash2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { formatListDate, htmlToPlainText } from "~/lib/utils";
import type { Email } from "~/types";
import { IconTooltip } from "./IconTooltip";
import { shortRecipients } from "./people";

/** The text a draft would send, without the quoted message under it. */
function draftText(body: string | null | undefined): string {
	const html = body || "";
	const quote = html.search(/<blockquote/i);
	return htmlToPlainText(quote >= 0 ? html.slice(0, quote) : html).trim();
}

/**
 * A draft in the conversation (usually the agent's reply): "Draft" in the
 * destructive tone like Gmail, who it goes to, its text, and Edit, Send,
 * Discard.
 */
export function DraftCard({
	draft,
	selfAddress,
	isSending,
	onEdit,
	onSend,
	onDiscard,
}: {
	draft: Email;
	selfAddress?: string;
	isSending: boolean;
	onEdit: () => void;
	onSend: () => void;
	onDiscard: () => void;
}) {
	const text = draftText(draft.body);
	const recipients = shortRecipients(draft.recipient, draft.cc, selfAddress);
	return (
		<article
			className="mx-4 my-3 rounded-lg border border-dashed border-destructive/40 bg-card md:mx-6"
			aria-label="Draft reply"
		>
			<div className="flex items-center gap-2 px-4 pt-3 text-sm">
				<span className="font-semibold text-destructive">Draft</span>
				{recipients && <span className="min-w-0 truncate text-xs text-muted-foreground">{recipients}</span>}
				<span className="ml-auto shrink-0 text-xs text-muted-foreground">{formatListDate(draft.date)}</span>
			</div>
			<button
				type="button"
				onClick={onEdit}
				className="block w-full px-4 py-2 text-left text-sm whitespace-pre-line text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
				aria-label="Edit draft"
			>
				<span className="line-clamp-8">{text || <span className="text-muted-foreground italic">(empty draft)</span>}</span>
			</button>
			<div className="flex items-center gap-2 px-4 pb-3">
				<Button size="sm" onClick={onSend} disabled={isSending}>
					{isSending ? <Spinner /> : <Send />}
					{isSending ? "Sending…" : "Send"}
				</Button>
				<Button size="sm" variant="outline" onClick={onEdit} disabled={isSending}>
					<Pencil />
					Edit
				</Button>
				<IconTooltip label="Discard draft">
					<Button size="icon-sm" variant="ghost" onClick={onDiscard} disabled={isSending} aria-label="Discard draft" className="ml-auto">
						<Trash2 />
					</Button>
				</IconTooltip>
			</div>
		</article>
	);
}
