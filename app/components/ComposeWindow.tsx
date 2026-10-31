// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Baseline, CircleAlert, Maximize2, Minimize2, Minus, Send, Trash2, X } from "lucide-react";
import { type KeyboardEvent, type ReactElement, type ReactNode, type RefObject, useId, useRef, useState } from "react";
import { useParams } from "react-router";
import { AGENT_BAR_WIDTH, AGENT_WINDOW_WIDTH } from "~/components/AgentWindow";
import RichTextEditor from "~/components/RichTextEditor";
import SendingOffBanner from "~/components/SendingOffBanner";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { Toggle } from "~/components/ui/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { useMediaQuery } from "~/hooks/use-media-query";
import { useComposeForm } from "~/hooks/useComposeForm";
import { type ComposeOptions, useUIStore } from "~/hooks/useUIStore";
import { cn } from "~/lib/cn";

/** Gmail saves a draft a couple of seconds after you stop typing. */
const AUTOSAVE_MS = 2000;

function IconTooltip({ label, children, side = "top" }: { label: string; children: ReactElement; side?: "top" | "bottom" }) {
	return (
		<Tooltip>
			<TooltipTrigger render={children} />
			<TooltipContent side={side}>{label}</TooltipContent>
		</Tooltip>
	);
}

function HeaderButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
	return (
		<IconTooltip label={label} side="bottom">
			<Button
				type="button"
				variant="ghost"
				size="icon-sm"
				aria-label={label}
				className="text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
				onClick={(e) => {
					e.stopPropagation();
					onClick();
				}}
			>
				{children}
			</Button>
		</IconTooltip>
	);
}

/** One line of the header fields (From, To, Cc, Bcc, Subject), ruled like Gmail's. */
function FieldRow({ label, htmlFor, children }: { label?: string; htmlFor?: string; children: ReactNode }) {
	return (
		<div className="flex min-h-10 items-center gap-2 border-b border-border focus-within:border-primary/60">
			{label && (
				<label htmlFor={htmlFor} className="w-10 shrink-0 text-sm text-muted-foreground">
					{label}
				</label>
			)}
			{children}
		</div>
	);
}

/** The compose window's width, and the gap between the floating windows and the edge. */
const COMPOSE_WIDTH = 560;
const GAP = 16;

/**
 * How far from the right the window docks: left of the agent window (open or
 * minimized) when both fit side by side, else at the edge over it.
 */
function useDockRight(): number {
	const agent = useUIStore((s) => s.agent);
	const agentWidth = !agent.open || agent.maximized ? 0 : agent.minimized ? AGENT_BAR_WIDTH : AGENT_WINDOW_WIDTH;
	const right = agentWidth ? GAP + agentWidth + GAP : GAP;
	const fits = useMediaQuery(`(min-width: ${right + COMPOSE_WIDTH + GAP}px)`) === true;
	return fits ? right : GAP;
}

const FIELD_INPUT = "h-9 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground";

function optionsKey(options: ComposeOptions) {
	return `${options.mode}:${options.originalEmail?.id ?? ""}:${options.draftEmail?.id ?? ""}`;
}

/**
 * The floating compose window (docs/UI.md "Compose"), docked bottom-right:
 * minimizes to its header bar, expands to a centered dialog, and is a
 * full-screen sheet on mobile. Driven by `useUIStore().compose`.
 */
export default function ComposeWindow() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const compose = useUIStore((s) => s.compose);
	if (!compose.open || !mailboxId) return null;
	return (
		<ComposeWindowFrame
			key={optionsKey(compose.options)}
			mailboxId={mailboxId}
			options={compose.options}
			minimized={compose.minimized}
			maximized={compose.maximized}
		/>
	);
}

function ComposeWindowFrame({
	mailboxId,
	options,
	minimized,
	maximized,
}: {
	mailboxId: string;
	options: ComposeOptions;
	minimized: boolean;
	maximized: boolean;
}) {
	const closeComposeWindow = useUIStore((s) => s.closeComposeWindow);
	const setComposeMinimized = useUIStore((s) => s.setComposeMinimized);
	const setComposeMaximized = useUIStore((s) => s.setComposeMaximized);
	const dockRight = useDockRight();
	const isMobile = useMediaQuery("(max-width: 767px)") === true;
	const form = useComposeForm(mailboxId, undefined, { options, autosaveMs: AUTOSAVE_MS });
	const {
		to, setTo, cc, setCc, bcc, setBcc, subject, setSubject, body, setBody,
		error, isSending, isSavingDraft, saveStatus, fromAddress,
	} = form;

	const [showCc, setShowCc] = useState(Boolean(options.draftEmail?.cc));
	const [showBcc, setShowBcc] = useState(Boolean(options.draftEmail?.bcc));
	const [showFormatting, setShowFormatting] = useState(true);
	const formRef = useRef<HTMLFormElement>(null);
	const ccRef = useRef<HTMLInputElement>(null);
	const bccRef = useRef<HTMLInputElement>(null);
	const ids = useId();
	const isReply = options.mode === "reply" || options.mode === "reply-all";

	// Reply-all fills Cc; show the row whenever it has addresses.
	const ccVisible = showCc || cc !== "";
	const bccVisible = showBcc || bcc !== "";
	const title = subject.trim() || "New message";
	const isMinimized = minimized && !isMobile;
	const isMaximized = maximized && !isMobile;

	// The row appears on the next render; focus it then.
	const reveal = (show: (v: boolean) => void, ref: RefObject<HTMLInputElement | null>) => {
		show(true);
		requestAnimationFrame(() => ref.current?.focus());
	};

	const close = () => void form.closeWithDraft(closeComposeWindow);
	const discard = () => void form.discardDraft(closeComposeWindow);
	const toggleMinimized = () => setComposeMinimized(!minimized);

	const onKeyDownCapture = (e: KeyboardEvent<HTMLFormElement>) => {
		// ⌘/Ctrl+Enter sends; caught before the editor turns it into a line break.
		if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			e.stopPropagation();
			formRef.current?.requestSubmit();
		}
	};

	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		if (e.key === "Escape" && isMaximized) {
			e.stopPropagation();
			setComposeMaximized(false);
		}
	};

	const statusText = isSavingDraft || saveStatus === "saving"
		? "Saving…"
		: saveStatus === "saved"
			? "Saved"
			: saveStatus === "error"
				? "Couldn't save draft"
				: null;

	return (
		<>
			{isMaximized && (
				<div
					aria-hidden
					className="fixed inset-0 z-40 bg-black/40 supports-backdrop-filter:backdrop-blur-xs"
					onClick={() => setComposeMaximized(false)}
				/>
			)}
			<section
				role="dialog"
				aria-label={title}
				aria-modal={isMaximized || isMobile ? true : undefined}
				onKeyDown={onKeyDown}
				style={!isMobile && !isMaximized ? { right: dockRight } : undefined}
				className={cn(
					"fixed z-40 flex flex-col overflow-hidden border border-border bg-card text-card-foreground shadow-xl",
					isMobile && "inset-0 z-50 border-0",
					!isMobile && isMaximized && "top-1/2 left-1/2 h-[80vh] w-[80vw] -translate-x-1/2 -translate-y-1/2 rounded-lg",
					!isMobile && !isMaximized && "bottom-0 rounded-t-lg border-b-0",
					!isMobile && !isMaximized && !isMinimized && "h-[600px] max-h-[calc(100dvh-4.5rem)] w-[560px] max-w-[calc(100vw-2rem)]",
					isMinimized && "w-[280px]",
				)}
			>
				{/* Header: click to minimize or restore (desktop) */}
				<div
					className={cn(
						"flex h-10 shrink-0 items-center gap-0.5 bg-background pr-1.5 pl-3",
						!isMobile && "cursor-pointer select-none",
						isMobile && "h-12 border-b border-border bg-card",
					)}
					onClick={isMobile ? undefined : toggleMinimized}
				>
					<h2 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h2>
					{!isMobile && (
						<>
							<HeaderButton label={isMinimized ? "Restore" : "Minimize"} onClick={toggleMinimized}>
								<Minus />
							</HeaderButton>
							<HeaderButton
								label={isMaximized ? "Exit full screen" : "Full screen"}
								onClick={() => setComposeMaximized(!maximized)}
							>
								{isMaximized ? <Minimize2 /> : <Maximize2 />}
							</HeaderButton>
						</>
					)}
					<HeaderButton label="Save & close" onClick={close}>
						<X />
					</HeaderButton>
				</div>

				<form
					ref={formRef}
					onSubmit={(e) => form.handleSend(e, closeComposeWindow)}
					onKeyDownCapture={onKeyDownCapture}
					className={cn("flex min-h-0 flex-1 flex-col", isMinimized && "hidden")}
				>
					<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
						{error && (
							<Alert variant="destructive" className="mx-3 mt-3 w-auto">
								<CircleAlert />
								<AlertDescription className="text-xs text-foreground">{error}</AlertDescription>
							</Alert>
						)}
						<SendingOffBanner className="mx-3 mt-3 w-auto" />

						<div className="px-3">
							<FieldRow label="From">
								<span className="truncate text-sm text-muted-foreground">{fromAddress}</span>
							</FieldRow>
							<FieldRow label="To" htmlFor={`${ids}-to`}>
								<input
									id={`${ids}-to`}
									type="text"
									autoComplete="off"
									className={FIELD_INPUT}
									value={to}
									onChange={(e) => setTo(e.target.value)}
									autoFocus={!isReply}
									required
								/>
								<div className="flex shrink-0 items-center">
									{!ccVisible && (
										<Button type="button" variant="ghost" size="xs" className="text-muted-foreground" onClick={() => reveal(setShowCc, ccRef)}>
											Cc
										</Button>
									)}
									{!bccVisible && (
										<Button type="button" variant="ghost" size="xs" className="text-muted-foreground" onClick={() => reveal(setShowBcc, bccRef)}>
											Bcc
										</Button>
									)}
								</div>
							</FieldRow>
							{ccVisible && (
								<FieldRow label="Cc" htmlFor={`${ids}-cc`}>
									<input
										ref={ccRef}
										id={`${ids}-cc`}
										type="text"
										autoComplete="off"
										className={FIELD_INPUT}
										value={cc}
										onChange={(e) => setCc(e.target.value)}
									/>
								</FieldRow>
							)}
							{bccVisible && (
								<FieldRow label="Bcc" htmlFor={`${ids}-bcc`}>
									<input
										ref={bccRef}
										id={`${ids}-bcc`}
										type="text"
										autoComplete="off"
										className={FIELD_INPUT}
										value={bcc}
										onChange={(e) => setBcc(e.target.value)}
									/>
								</FieldRow>
							)}
							<FieldRow>
								<input
									type="text"
									aria-label="Subject"
									placeholder="Subject"
									className={FIELD_INPUT}
									value={subject}
									onChange={(e) => setSubject(e.target.value)}
									required
								/>
							</FieldRow>
						</div>

						<RichTextEditor
							value={body}
							onChange={setBody}
							bordered={false}
							showToolbar={showFormatting}
							toolbarPosition="bottom"
							focusOnReplace={isReply}
							className="min-h-[200px] flex-1 [&_.ProseMirror]:px-3"
						/>
					</div>

					{/* Bottom bar */}
					<div className="flex shrink-0 items-center gap-1 px-3 pt-1 pb-3">
						<IconTooltip label="Send (⌘/Ctrl+Enter)">
							<Button type="submit" className="h-9 gap-1.5 px-5" disabled={isSending}>
								{isSending ? <Spinner /> : <Send />}
								{isSending ? "Sending…" : "Send"}
							</Button>
						</IconTooltip>
						<IconTooltip label={showFormatting ? "Hide formatting options" : "Formatting options"}>
							<Toggle
								aria-label="Formatting options"
								className="ml-1 size-9 min-w-9 px-0"
								pressed={showFormatting}
								onPressedChange={setShowFormatting}
							>
								<Baseline className="size-4.5" />
							</Toggle>
						</IconTooltip>
						<span
							aria-live="polite"
							className={cn(
								"ml-2 min-w-0 truncate text-xs text-muted-foreground",
								saveStatus === "error" && !isSavingDraft && "text-destructive",
							)}
						>
							{statusText}
						</span>
						<div className="flex-1" />
						<IconTooltip label="Discard draft">
							<Button
								type="button"
								variant="ghost"
								size="icon"
								className="size-9 text-muted-foreground"
								aria-label="Discard draft"
								onClick={discard}
								disabled={isSending}
							>
								<Trash2 />
							</Button>
						</IconTooltip>
					</div>
				</form>
			</section>
		</>
	);
}
