import { CircleAlert, Ellipsis, Forward, Maximize2, Reply, ReplyAll, Send, Trash2 } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import RichTextEditor from "~/components/RichTextEditor";
import SendingOffBanner from "~/components/SendingOffBanner";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { useComposeForm } from "~/hooks/useComposeForm";
import { type ComposeOptions, useUIStore } from "~/hooks/useUIStore";
import type { Email } from "~/types";
import { IconTooltip } from "./IconTooltip";

const MODE_ICON = { reply: Reply, "reply-all": ReplyAll, forward: Forward, new: Reply } as const;
const MODE_LABEL = { reply: "Reply", "reply-all": "Reply all", forward: "Forward", new: "Reply" } as const;

function AddressRow({
	label,
	value,
	onChange,
	inputRef,
	children,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	inputRef?: React.Ref<HTMLInputElement>;
	children?: React.ReactNode;
}) {
	const id = `inline-reply-${label.toLowerCase()}`;
	return (
		<div className="flex min-h-9 items-center gap-2 border-b border-border px-3">
			<label htmlFor={id} className="w-7 shrink-0 text-sm text-muted-foreground">
				{label}
			</label>
			<input
				id={id}
				ref={inputRef}
				type="text"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={label === "To" ? "Recipients" : undefined}
				className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
				autoComplete="off"
			/>
			{children}
		</div>
	);
}

/**
 * Gmail's inline reply: opens in place at the bottom of the conversation.
 * Recipients prefilled for the mode, the editor with the quoted message
 * folded behind "…", Send, discard, and pop out to the compose window. Drafts
 * autosave through useComposeForm, which also sends.
 */
export function InlineReply({
	mailboxId,
	options,
	onClose,
	onDraftIdChange,
}: {
	mailboxId: string;
	/** Memoized: a new object re-initializes the fields. */
	options: ComposeOptions;
	onClose: () => void;
	/** The draft this reply saves to, so the conversation can hide its card. */
	onDraftIdChange?: (draftId: string | null) => void;
}) {
	const form = useComposeForm(mailboxId, undefined, { options, autosaveMs: 2000 });
	const { to, setTo, cc, setCc, bcc, setBcc, showCcBcc, setShowCcBcc, subject, body, setBody, error, isSending, isDirty, saveStatus, draftId } = form;
	const rootRef = useRef<HTMLFormElement>(null);
	const toRef = useRef<HTMLInputElement>(null);
	// The quoted message, kept out of the editor until "…" is clicked; null until the fields load.
	const [quote, setQuote] = useState<string | null>(null);
	const Icon = MODE_ICON[options.mode];

	useEffect(() => {
		if (quote !== null || !body) return;
		const at = options.mode === "forward" ? -1 : body.search(/<blockquote/i);
		setQuote(at >= 0 ? body.slice(at) : "");
	}, [body, quote, options.mode]);

	useEffect(() => {
		onDraftIdChange?.(draftId ?? null);
	}, [draftId, onDraftIdChange]);

	// Bring the whole composer into view once the editor is in.
	const ready = quote !== null;
	useEffect(() => {
		if (!ready) return;
		// After the editor's own focus, which scrolls to the caret.
		const timer = setTimeout(() => rootRef.current?.scrollIntoView({ block: "end", behavior: "smooth" }), 120);
		return () => clearTimeout(timer);
	}, [ready]);

	useEffect(() => {
		// The editor focuses itself when its content loads; a forward starts at To.
		if (options.mode === "forward") {
			const timer = setTimeout(() => toRef.current?.focus(), 80);
			return () => clearTimeout(timer);
		}
	}, [options.mode]);

	const head = quote && body.endsWith(quote) ? body.slice(0, body.length - quote.length) : body;

	const popOut = async () => {
		const original = options.originalEmail ?? undefined;
		// Save first and hand the window the draft's id, so the two never save two drafts.
		let handedId: string | null;
		try {
			handedId = await form.handOffDraft();
		} catch (err) {
			form.setError((err instanceof Error ? err.message : null) || "Couldn't save the draft.");
			return;
		}
		const draftEmail: Email | undefined = handedId || options.draftEmail
			? {
				...(options.draftEmail ?? ({} as Email)),
				id: handedId ?? "",
				recipient: to,
				cc,
				bcc,
				subject,
				body,
				sender: options.draftEmail?.sender ?? "",
				date: options.draftEmail?.date ?? new Date().toISOString(),
				read: true,
				starred: false,
				in_reply_to: original?.id ?? options.draftEmail?.in_reply_to ?? null,
				thread_id: original?.thread_id ?? options.draftEmail?.thread_id ?? null,
			}
			: undefined;
		useUIStore.getState().openCompose({ mode: options.mode, originalEmail: original, draftEmail });
		onClose();
	};

	const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
		if (e.key === "Escape" && !isDirty && !isSending) {
			e.preventDefault();
			e.stopPropagation();
			// Nothing typed: closes without a draft (and drops one the autosave made before the text was erased).
			void form.closeWithDraft(onClose);
		}
	};

	return (
		<form
			ref={rootRef}
			onSubmit={(e) => form.handleSend(e, onClose)}
			onKeyDown={onKeyDown}
			className="mx-4 my-3 overflow-hidden rounded-xl border border-border bg-card shadow-md md:mx-6"
			aria-label={MODE_LABEL[options.mode]}
		>
			<SendingOffBanner />
			{error && (
				<Alert variant="destructive" className="rounded-none border-x-0 border-t-0">
					<CircleAlert />
					<AlertDescription className="[overflow-wrap:anywhere]">{error}</AlertDescription>
				</Alert>
			)}

			<div className="flex items-center border-b border-border pl-3">
				<Icon className="size-4 shrink-0 text-muted-foreground" aria-label={MODE_LABEL[options.mode]} />
				<div className="min-w-0 flex-1 [&>div]:border-b-0">
					<AddressRow label="To" value={to} onChange={setTo} inputRef={toRef}>
						{!showCcBcc && (
							<button
								type="button"
								onClick={() => setShowCcBcc(true)}
								className="shrink-0 rounded px-1 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
							>
								Cc Bcc
							</button>
						)}
					</AddressRow>
				</div>
			</div>
			{showCcBcc && (
				<>
					<AddressRow label="Cc" value={cc} onChange={setCc} />
					<AddressRow label="Bcc" value={bcc} onChange={setBcc} />
				</>
			)}

			<div className="p-2">
				{quote !== null && <RichTextEditor value={head} onChange={(html) => setBody(html + (quote ?? ""))} />}
				{quote && (
					<IconTooltip label="Show trimmed content" side="right">
						<button
							type="button"
							onClick={() => setQuote("")}
							className="mt-2 ml-1 flex h-4 items-center rounded-sm bg-muted px-1.5 text-muted-foreground outline-none hover:bg-foreground/10 focus-visible:ring-3 focus-visible:ring-ring/50"
							aria-label="Show trimmed content"
						>
							<Ellipsis className="size-4" />
						</button>
					</IconTooltip>
				)}
			</div>

			<div className="flex items-center gap-2 px-3 pb-3">
				<Button type="submit" disabled={isSending}>
					{isSending ? <Spinner /> : <Send />}
					{isSending ? "Sending…" : "Send"}
				</Button>
				<span className="text-xs text-muted-foreground" aria-live="polite">
					{saveStatus === "saving" ? "Saving…" : saveStatus === "saved" ? "Draft saved" : saveStatus === "error" ? "Couldn't save draft" : ""}
				</span>
				<div className="ml-auto flex items-center gap-0.5">
					<IconTooltip label="Pop out reply">
						<Button type="button" variant="ghost" size="icon-sm" onClick={() => void popOut()} disabled={isSending} aria-label="Pop out reply">
							<Maximize2 />
						</Button>
					</IconTooltip>
					<IconTooltip label="Discard draft">
						<Button type="button" variant="ghost" size="icon-sm" onClick={() => void form.discardDraft(onClose)} disabled={isSending} aria-label="Discard draft">
							<Trash2 />
						</Button>
					</IconTooltip>
				</div>
			</div>
		</form>
	);
}
