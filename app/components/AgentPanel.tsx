// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { UIMessage } from "ai";
import {
	ArrowUp,
	Bot,
	Check,
	ChevronRight,
	Eye,
	FolderInput,
	Mail,
	MailCheck,
	MessagesSquare,
	Pencil,
	Search,
	Send,
	Square,
	Trash2,
	TriangleAlert,
	Wrench,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Markdown from "react-markdown";
import { useParams } from "react-router";
import remarkGfm from "remark-gfm";
import type { AgentPanelProps } from "~/components/AgentWindow";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { useUIStore } from "~/hooks/useUIStore";
import { cn } from "~/lib/cn";

const TOOL_LABELS: Record<string, { label: string; icon: ReactNode }> = {
	list_emails: { label: "Fetching emails", icon: <Mail /> },
	get_email: { label: "Reading email", icon: <Eye /> },
	get_thread: { label: "Loading thread", icon: <MessagesSquare /> },
	search_emails: { label: "Searching", icon: <Search /> },
	draft_email: { label: "Drafting email", icon: <Send /> },
	draft_reply: { label: "Drafting reply", icon: <Send /> },
	discard_draft: { label: "Discarding draft", icon: <Trash2 /> },
	mark_email_read: { label: "Updating status", icon: <MailCheck /> },
	move_email: { label: "Moving email", icon: <FolderInput /> },
};

const SUGGESTED_PROMPTS = [
	"Show me the latest inbox emails",
	"Any unread emails?",
	"Draft a reply to the latest email",
];

/**
 * What workers/everyapp/agent-ai.ts answers when no model can be reached
 * ("AI isn't set up on this gateway …"), on its own in reply to a chat turn
 * or as the reason in a skipped auto-draft's note ("⚠️ No draft for this
 * email: …"). The chat shows the sentence once, as an alert above the
 * composer, instead of once per attempt.
 */
const NOT_SET_UP_PREFIX = "AI isn't set up";
const SKIP_NOTE_PREFIX = "⚠️ No draft for this email: ";
const EMAIL_TRIGGER_PREFIX = "New email from ";

/** A message's text when it is one text part and nothing else (no tool calls). */
function onlyText(message: UIMessage): string | null {
	const texts = message.parts.filter((p) => p.type === "text" && p.text.trim()) as { text: string }[];
	const textOnly = message.parts.every((p) => p.type === "text" || p.type === "step-start");
	if (texts.length !== 1 || !textOnly) return null;
	return texts[0].text.trim();
}

/** The agent's note that it skipped a new email's draft: its reason. */
function skipNoteReason(message: UIMessage): string | null {
	const text = message.role === "assistant" ? onlyText(message) : null;
	return text?.startsWith(SKIP_NOTE_PREFIX) ? text.slice(SKIP_NOTE_PREFIX.length) : null;
}

/** The "AI isn't set up" sentence a message carries, alone or as a skip note's reason. */
function notSetUpText(message: UIMessage): string | null {
	if (message.role !== "assistant") return null;
	const text = (skipNoteReason(message) ?? onlyText(message))?.replace(/^⚠️\s*/, "");
	return text?.startsWith(NOT_SET_UP_PREFIX) ? text : null;
}

/** The line the agent writes for itself when a new email arrives (workers/agent/index.ts). */
function isEmailTrigger(message: UIMessage): boolean {
	return message.role === "user" && (onlyText(message)?.startsWith(EMAIL_TRIGGER_PREFIX) ?? false);
}

/** A line the agent writes on its own for inbound mail: "New email from …" or a skipped draft's note. */
function isAutoNotice(message: UIMessage): boolean {
	return isEmailTrigger(message) || skipNoteReason(message) !== null;
}

/** One automatic notice as its own line. */
function AutoNoticeRow({ message }: { message: UIMessage }) {
	if (isEmailTrigger(message)) return <NoticeRow icon={<Mail />}>{onlyText(message)}</NoticeRow>;
	const reason = skipNoteReason(message) ?? "";
	return (
		<NoticeRow icon={<TriangleAlert className="text-warning" />}>
			{notSetUpText(message) ? "No draft for this email: AI isn't set up." : `No draft for this email: ${reason}`}
		</NoticeRow>
	);
}

/** What a run of automatic notices says, in one line: "12 new emails · no drafts: AI isn't set up". */
function noticeSummary(run: UIMessage[]): string {
	const emails = run.filter(isEmailTrigger).length;
	const skips = run.filter((m) => skipNoteReason(m) !== null);
	const parts: string[] = [];
	if (emails > 0) parts.push(`${emails} new ${emails === 1 ? "email" : "emails"}`);
	if (skips.length > 0) {
		const notSetUp = skips.every((m) => notSetUpText(m));
		if (notSetUp) parts.push(`${skips.length === 1 ? "no draft" : "no drafts"}: AI isn't set up`);
		else parts.push(`${skips.length} not drafted`);
	}
	return parts.join(" · ");
}

/** A run of automatic notices folded into one compact row; the chevron lists them. */
function NoticeGroup({ run }: { run: UIMessage[] }) {
	const [open, setOpen] = useState(false);
	const anySkipped = run.some((m) => skipNoteReason(m) !== null);
	return (
		<div className="flex flex-col gap-1.5">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				aria-expanded={open}
				className="-mx-1 flex items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-xs text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 [&_svg]:size-3.5 [&_svg]:shrink-0"
			>
				{anySkipped ? <TriangleAlert className="text-warning" /> : <Mail />}
				<span className="min-w-0 flex-1 truncate">{noticeSummary(run)}</span>
				<ChevronRight className={cn("transition-transform", open && "rotate-90")} aria-hidden />
			</button>
			{open && (
				<div className="flex flex-col gap-1.5 border-l border-border pl-3">
					{run.map((m) => (
						<AutoNoticeRow key={m.id} message={m} />
					))}
				</div>
			)}
		</div>
	);
}

/** A compact, muted line for a notice rather than an answer: a new email, a skipped or blocked draft, a failure. */
function NoticeRow({ icon, children }: { icon: ReactNode; children: ReactNode }) {
	return (
		<div className="flex items-start gap-1.5 text-xs text-muted-foreground [&_svg]:mt-px [&_svg]:size-3.5 [&_svg]:shrink-0">
			{icon}
			<span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
		</div>
	);
}

function ToolCallRow({ toolName, state }: { toolName: string; state: string }) {
	const info = TOOL_LABELS[toolName] || { label: toolName, icon: <Wrench /> };
	const isDone = state === "output-available" || state === "result" || state === "output-error";

	return (
		<div className="flex items-center gap-1.5 text-xs text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0">
			{info.icon}
			<span>{info.label}</span>
			{isDone ? <Check className="text-success" aria-label="Done" /> : <Spinner className="size-3" />}
		</div>
	);
}

function getToolNameFromPart(part: UIMessage["parts"][number]): string | null {
	if (part.type === "dynamic-tool") return (part as any).toolName ?? null;
	if (part.type.startsWith("tool-")) return part.type.replace("tool-", "");
	return null;
}

function hasDraftReplyTool(message: UIMessage): boolean {
	return message.parts.some((part) => {
		const toolName = getToolNameFromPart(part);
		return toolName === "draft_reply";
	});
}

const markdownComponents: React.ComponentProps<typeof Markdown>["components"] = {
	a: ({ href, children }) => (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			className="text-primary underline underline-offset-2 hover:no-underline"
		>
			{children}
		</a>
	),
	p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
	strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
	ul: ({ children }) => <ul className="mb-2 list-disc space-y-0.5 pl-4 last:mb-0">{children}</ul>,
	ol: ({ children }) => <ol className="mb-2 list-decimal space-y-0.5 pl-4 last:mb-0">{children}</ol>,
	li: ({ children }) => <li>{children}</li>,
	h1: ({ children }) => <h3 className="mb-1 text-sm font-semibold">{children}</h3>,
	h2: ({ children }) => <h4 className="mb-1 text-[13px] font-semibold">{children}</h4>,
	h3: ({ children }) => <h5 className="mb-0.5 text-[13px] font-semibold">{children}</h5>,
	code: ({ children }) => <code className="rounded bg-foreground/[0.07] px-1 py-0.5 font-mono text-[12px]">{children}</code>,
	table: ({ children }) => (
		<div className="my-2 overflow-x-auto">
			<table className="w-full border-collapse text-xs">{children}</table>
		</div>
	),
	thead: ({ children }) => <thead className="border-b border-border">{children}</thead>,
	th: ({ children }) => <th className="px-2 py-1 text-left font-semibold">{children}</th>,
	td: ({ children }) => <td className="border-b border-border/60 px-2 py-1">{children}</td>,
};

function MessageBubble({
	message,
	onAction,
	isStreaming,
}: {
	message: UIMessage;
	onAction?: (action: string) => void;
	isStreaming: boolean;
}) {
	const isUser = message.role === "user";

	return (
		<div className={cn("flex min-w-0 flex-col gap-1.5", isUser ? "items-end pl-12" : "items-start pr-8")}>
			{message.parts.map((part, i) => {
				const key = `${message.id}-part-${i}`;
				if (part.type === "text" && part.text.trim()) {
					return (
						<div
							key={key}
							className={cn(
								"max-w-full overflow-hidden rounded-2xl px-3 py-2 text-[13px] leading-relaxed [overflow-wrap:anywhere]",
								isUser
									? "rounded-br-md bg-primary whitespace-pre-wrap text-primary-foreground"
									: "rounded-bl-md bg-muted text-foreground",
							)}
						>
							{isUser ? (
								part.text
							) : (
								<Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
									{part.text}
								</Markdown>
							)}
						</div>
					);
				}
				const toolName = getToolNameFromPart(part);
				if (toolName) {
					return <ToolCallRow key={key} toolName={toolName} state={(part as any).state ?? "running"} />;
				}
				return null;
			})}
			{/* Show action buttons for draft replies */}
			{!isUser && hasDraftReplyTool(message) && onAction && (
				<Button variant="outline" size="sm" onClick={() => onAction("edit")} disabled={isStreaming}>
					<Pencil data-icon="inline-start" />
					Edit and send
				</Button>
			)}
		</div>
	);
}

function AgentChatConnected({
	mailboxId,
	headerSlot,
	useAgent,
	useAgentChat,
}: {
	mailboxId: string;
	headerSlot: HTMLElement | null;
	useAgent: typeof import("agents/react").useAgent;
	useAgentChat: typeof import("@cloudflare/ai-chat/react").useAgentChat;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const [inputValue, setInputValue] = useState("");
	const [isClearOpen, setIsClearOpen] = useState(false);
	const startCompose = useUIStore((s) => s.startCompose);

	// Every App: partysocket picks wss for every host but
	// localhost:/127.0.0.1:/private ranges, so under
	// `everyapp dev` (http://openmail.localhost:<port>) the socket and
	// useAgentChat's get-messages fetch went to wss/https and the mailbox page
	// fell into the error boundary. Follow the page's own protocol.
	const agent = useAgent({
		agent: "EmailAgent",
		name: mailboxId,
		protocol: typeof window !== "undefined" && window.location.protocol === "http:" ? "ws" : "wss",
	});
	const { messages, sendMessage, status, clearHistory, stop } = useAgentChat({ agent });
	const isStreaming = status === "streaming" || status === "submitted";

	// "AI isn't set up" shows once, as the alert, while the latest answer
	// carries it; the chat answers it was are left out, and skip notes stay
	// (folded with the "New email from …" lines around them).
	const visibleMessages = messages.filter((m) => !notSetUpText(m) || skipNoteReason(m) !== null);
	const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
	const setupNotice = lastAssistant ? notSetUpText(lastAssistant) : null;
	// Only automatic notices so far: the suggestions stay.
	const hasConversation = visibleMessages.some((m) => !isAutoNotice(m));

	// Consecutive automatic notices become one group.
	const items: ({ kind: "message"; message: UIMessage } | { kind: "notices"; run: UIMessage[] })[] = [];
	for (const message of visibleMessages) {
		const last = items[items.length - 1];
		if (!isAutoNotice(message)) items.push({ kind: "message", message });
		else if (last?.kind === "notices") last.run.push(message);
		else items.push({ kind: "notices", run: [message] });
	}

	// The newest message stays in view, also when the alert above the composer takes room.
	useEffect(() => {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [messages, setupNotice, isStreaming]);

	const handleSend = () => {
		const text = inputValue.trim();
		if (!text || isStreaming) return;
		setInputValue("");
		sendMessage({ text });
		if (inputRef.current) inputRef.current.style.height = "auto";
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
	};

	const handleEdit = (msg: UIMessage) => {
		// Extract draft data from the draft_reply tool result
		let draftData: {
			to?: string;
			subject?: string;
			body?: string;
			id?: string;
		} | null = null;
		for (const part of msg.parts) {
			if ((part as any).toolName === "draft_reply" && (part as any).result) {
				draftData = (part as any).result;
				break;
			}
		}
		if (draftData) {
			const draftEmail = {
				id: draftData.id || "",
				subject: draftData.subject || "",
				sender: mailboxId,
				recipient: draftData.to || "",
				date: new Date().toISOString(),
				read: true,
				starred: false,
				body: draftData.body || "",
			};
			startCompose({
				mode: "reply",
				originalEmail: null,
				draftEmail,
			});
		} else {
			sendMessage({
				text: "Let me edit this draft first. Show me what you have so I can modify it.",
			});
		}
	};

	const headerActions = (
		<>
			{isStreaming && <Spinner className="mx-1.5 text-muted-foreground" aria-label="Agent is working" />}
			{messages.length > 0 && (
				<Tooltip>
					<TooltipTrigger
						render={
							<Button variant="ghost" size="icon-sm" aria-label="Clear chat" onClick={() => setIsClearOpen(true)} />
						}
					>
						<Trash2 />
					</TooltipTrigger>
					<TooltipContent>Clear chat</TooltipContent>
				</Tooltip>
			)}
		</>
	);

	return (
		<div className="flex h-full flex-col">
			{headerSlot && createPortal(headerActions, headerSlot)}

			{/* Messages */}
			<div ref={scrollRef} className="flex flex-1 flex-col overflow-y-auto px-4 py-4">
				{items.length > 0 && (
					<div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
						{items.map((item) => {
							if (item.kind === "notices") {
								return item.run.length === 1 ? (
									<AutoNoticeRow key={item.run[0]!.id} message={item.run[0]!} />
								) : (
									<NoticeGroup key={item.run[0]!.id} run={item.run} />
								);
							}
							const msg = item.message;
							const warning = msg.role === "assistant" ? onlyText(msg) : null;
							if (warning?.startsWith("⚠️")) {
								return (
									<NoticeRow key={msg.id} icon={<TriangleAlert className="text-warning" />}>
										{warning.replace(/^⚠️\s*/, "")}
									</NoticeRow>
								);
							}
							return (
								<MessageBubble
									key={msg.id}
									message={msg}
									isStreaming={isStreaming}
									onAction={(action) => {
										if (action === "edit") handleEdit(msg);
									}}
								/>
							);
						})}
						{isStreaming && (
							<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
								<Spinner className="size-3" />
								Thinking…
							</div>
						)}
					</div>
				)}
				{!hasConversation && !isStreaming && (
					<div className="flex flex-1 flex-col items-center justify-center gap-4 px-2 py-6 text-center">
						<div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
							<Bot className="size-5" aria-hidden />
						</div>
						<p className="max-w-80 text-sm text-muted-foreground">
							I draft a reply to each new email in Drafts. Ask me to read, search, or draft anything else.
						</p>
						<div className="flex flex-wrap justify-center gap-1.5">
							{SUGGESTED_PROMPTS.map((prompt) => (
								<Button
									key={prompt}
									variant="outline"
									size="sm"
									className="rounded-full font-normal"
									onClick={() => sendMessage({ text: prompt })}
								>
									{prompt}
								</Button>
							))}
						</div>
					</div>
				)}
			</div>

			{/* Composer */}
			<div className="mx-auto w-full max-w-3xl shrink-0 space-y-2 px-4 pb-4">
				{setupNotice && !isStreaming && (
					<Alert variant="warning">
						<TriangleAlert />
						<AlertTitle>AI isn't set up</AlertTitle>
						<AlertDescription className="text-xs [overflow-wrap:anywhere]">{setupNotice}</AlertDescription>
					</Alert>
				)}
				{isStreaming ? (
					<div className="flex justify-center">
						<Button variant="outline" size="sm" onClick={() => stop()}>
							<Square data-icon="inline-start" className="fill-current" />
							Stop
						</Button>
					</div>
				) : (
					<div className="flex items-end gap-1.5 rounded-xl border border-input bg-background p-1.5 pl-3 transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
						<textarea
							ref={inputRef}
							id="agent-chat-input"
							name="agent-chat-input"
							value={inputValue}
							onChange={(e) => setInputValue(e.target.value)}
							onKeyDown={handleKeyDown}
							placeholder="Ask the agent"
							rows={1}
							aria-label="Chat message input"
							className="max-h-[120px] min-h-7 flex-1 resize-none self-center bg-transparent py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground"
							style={{ height: "auto", overflow: "hidden" }}
							onInput={(e) => {
								const t = e.target as HTMLTextAreaElement;
								t.style.height = "auto";
								t.style.height = `${Math.min(t.scrollHeight, 120)}px`;
								t.style.overflow = t.scrollHeight > 120 ? "auto" : "hidden";
							}}
						/>
						<Button size="icon-sm" disabled={!inputValue.trim()} onClick={handleSend} aria-label="Send message">
							<ArrowUp />
						</Button>
					</div>
				)}
			</div>

			<AlertDialog open={isClearOpen} onOpenChange={setIsClearOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Clear the chat for everyone?</AlertDialogTitle>
						<AlertDialogDescription>
							The conversation with this mailbox's agent is shared by everyone who uses the mailbox.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<Button
							variant="destructive"
							onClick={() => {
								// Clears the agent's stored history too, not just this page's copy.
								clearHistory();
								setIsClearOpen(false);
							}}
						>
							Clear chat
						</Button>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}

export default function AgentPanel({ headerSlot = null }: Partial<AgentPanelProps>) {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const [hooks, setHooks] = useState<{
		useAgent: typeof import("agents/react").useAgent;
		useAgentChat: typeof import("@cloudflare/ai-chat/react").useAgentChat;
	} | null>(null);

	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		Promise.all([import("agents/react"), import("@cloudflare/ai-chat/react")])
			.then(([a, c]) =>
				setHooks({
					useAgent: a.useAgent,
					useAgentChat: c.useAgentChat,
				}),
			)
			.catch((err) => {
				console.error("Failed to load agent modules:", err);
				setLoadError("Failed to connect to agent. Reload to retry.");
			});
	}, []);

	if (loadError) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
				<span className="text-sm text-destructive">{loadError}</span>
			</div>
		);
	}

	if (!hooks) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
				<Spinner />
				<span className="text-xs">Connecting…</span>
			</div>
		);
	}

	return (
		<AgentChatConnected
			mailboxId={mailboxId ?? "default"}
			headerSlot={headerSlot}
			useAgent={hooks.useAgent}
			useAgentChat={hooks.useAgentChat}
		/>
	);
}
