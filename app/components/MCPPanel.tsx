// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { Check, ChevronRight, Copy, Plug } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { meQuery } from "~/services/api";

/** An icon button that copies `value`, with a toast and a check mark for two seconds (OpenCRM's CopyButton). */
function CopyButton({ value, label }: { value: string; label: string }) {
	const [copied, setCopied] = useState(false);
	const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(value);
		} catch {
			toast.error("Could not copy.");
			return;
		}
		toast.success("Copied to clipboard");
		setCopied(true);
		clearTimeout(resetTimer.current);
		resetTimer.current = setTimeout(() => setCopied(false), 2000);
	};

	return (
		<Tooltip>
			<TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label={label} onClick={copy} />}>
				{copied ? <Check className="text-success" /> : <Copy />}
			</TooltipTrigger>
			<TooltipContent>{copied ? "Copied" : "Copy"}</TooltipContent>
		</Tooltip>
	);
}

/**
 * The tools MCP clients see: a static copy of the names in the app's tool
 * catalog (workers/everyapp/tools.ts). test/tools.test.ts keeps this
 * list in step with the catalog. `risk` is the catalog's.
 */
export const MCP_TOOLS = [
	{ name: "list_mailboxes", desc: "List mailboxes", risk: "read" },
	{ name: "list_emails", desc: "List emails in a folder", risk: "read" },
	{ name: "get_email", desc: "Read a full email with body", risk: "read" },
	{ name: "get_thread", desc: "Load a conversation thread", risk: "read" },
	{ name: "search_emails", desc: "Search emails by query", risk: "read" },
	{ name: "draft_reply", desc: "Draft a reply to an email", risk: "write" },
	{ name: "create_draft", desc: "Create a new draft", risk: "write" },
	{ name: "update_draft", desc: "Edit a draft", risk: "write" },
	{ name: "send_reply", desc: "Send a reply", risk: "write" },
	{ name: "send_email", desc: "Send a new email", risk: "write" },
	{ name: "mark_email_read", desc: "Mark email as read/unread", risk: "write" },
	{ name: "move_email", desc: "Move email to a folder", risk: "write" },
	{ name: "delete_email", desc: "Permanently delete an email", risk: "write" },
	{ name: "list_labels", desc: "List labels", risk: "read" },
	{ name: "create_label", desc: "Create a label", risk: "write" },
	{ name: "label_conversation", desc: "Add or remove a conversation's labels", risk: "write" },
	// Gmail (docs/GMAIL.md): the port's Gmail tools.
	{ name: "archive_email", desc: "Archive an email", risk: "write" },
	{ name: "sync_mailbox", desc: "Sync a Gmail mailbox now", risk: "write", gmail: true },
] as const;

/** A titled card with a value to paste and its copy button, and notes under it. */
function CopyCard({ title, value, children }: { title: string; value: string; children?: ReactNode }) {
	return (
		<div className="rounded-xl border border-border bg-card p-3 shadow-xs">
			<div className="mb-2 text-xs font-medium">{title}</div>
			<div className="flex items-start gap-1 rounded-lg bg-muted py-1.5 pr-1 pl-2.5">
				<code className="min-w-0 flex-1 self-center py-0.5 font-mono text-[11px] leading-relaxed [overflow-wrap:anywhere]">
					{value}
				</code>
				<CopyButton value={value} label={`Copy ${title}`} />
			</div>
			{children ? <div className="mt-2 space-y-1 text-xs text-muted-foreground">{children}</div> : null}
		</div>
	);
}

/**
 * How to reach this inbox's tools over MCP on Every App. The gateway serves
 * them twice: its own /mcp, one connector for every app the person uses
 * (OAuth sign-in from the client, or a personal access token), and this
 * app's host /mcp, for this app alone (a personal access token). The
 * connector comes first, with the Claude Code command to paste
 * (landing-page/content/agent/mcp.md's form); the token path is behind a
 * disclosure. The gateway's origin comes from /api/v1/me; until that
 * answers, only the app host's URL shows.
 */
export default function MCPPanel() {
	const { data: me } = useQuery({ ...meQuery, retry: false });
	const appOrigin = typeof window !== "undefined" ? window.location.origin : "https://openmail.your-gateway.example";
	const gatewayOrigin = me?.gatewayUrl?.replace(/\/+$/, "");
	const gatewayMcpUrl = gatewayOrigin ? `${gatewayOrigin}/mcp` : null;
	const appMcpUrl = `${appOrigin}/mcp`;
	// The Gmail tool stays in the catalog but refuses while the experimental integration is off: not listed then.
	const shownTools = MCP_TOOLS.filter((tool) => !("gmail" in tool) || me?.gmail === true);

	return (
		<div className="h-full space-y-4 overflow-y-auto px-3 py-4">
			<div className="flex gap-3">
				<div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
					<Plug className="size-4" aria-hidden />
				</div>
				<div className="min-w-0 space-y-0.5">
					<h3 className="text-sm font-semibold">Connect an AI client</h3>
					<p className="text-xs text-muted-foreground">
						A connected assistant can read, search, draft and send from this organization's mailboxes, as you.
					</p>
				</div>
			</div>

			{gatewayMcpUrl && (
				<CopyCard title="Every App connector" value={gatewayMcpUrl}>
					<p>One address for all your apps.</p>
				</CopyCard>
			)}
			{gatewayMcpUrl && (
				<CopyCard title="Claude Code" value={`claude mcp add --transport http everyapp ${gatewayMcpUrl}`}>
					<p>Then in Claude Code: /mcp → everyapp → Authenticate.</p>
					<p>
						claude.ai, ChatGPT and Cursor: add the connector URL as a custom connector or MCP server and sign in when
						asked.
					</p>
				</CopyCard>
			)}

			<details className="group rounded-xl border border-border bg-card shadow-xs">
				<summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-xl px-3 py-2.5 text-xs font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
					<ChevronRight className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden />
					Using a personal access token instead
				</summary>
				<div className="space-y-2 px-3 pb-3">
					<div className="flex items-start gap-1 rounded-lg bg-muted py-1.5 pr-1 pl-2.5">
						<code className="min-w-0 flex-1 self-center py-0.5 font-mono text-[11px] leading-relaxed [overflow-wrap:anywhere]">
							{appMcpUrl}
						</code>
						<CopyButton value={appMcpUrl} label="Copy this app's MCP URL" />
					</div>
					<p className="text-xs text-muted-foreground">
						This app only. Connect with a personal access token from the gateway, sent as{" "}
						<code className="font-mono text-foreground">Authorization: Bearer epat_…</code>.
						{gatewayOrigin ? (
							<>
								{" "}
								Create one on the gateway under{" "}
								<a
									href={`${gatewayOrigin}/admin/tokens`}
									target="_blank"
									rel="noopener noreferrer"
									className="text-primary underline-offset-2 hover:underline"
								>
									Tokens
								</a>
								.
							</>
						) : (
							" Create one on your gateway under Tokens."
						)}
					</p>
				</div>
			</details>

			<section className="space-y-2">
				<h4 className="px-0.5 text-xs font-medium text-muted-foreground">Available tools</h4>
				<div className="overflow-hidden rounded-xl border border-border bg-card shadow-xs">
					<table className="w-full text-xs">
						<tbody className="divide-y divide-border">
							{shownTools.map((tool) => (
								<tr key={tool.name}>
									<td className="py-1.5 pr-2 pl-3 align-top">
										<div className="font-mono font-medium">{tool.name}</div>
										<div className="text-muted-foreground">{tool.desc}</div>
									</td>
									<td className="py-1.5 pr-3 text-right align-top">
										<Badge variant={tool.risk === "read" ? "secondary" : "warning"} size="sm" className="uppercase">
											{tool.risk}
										</Badge>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
				<p className="px-0.5 text-xs text-muted-foreground">
					Draft tools never send. Send tools send at once, as you. No tool deletes email.
				</p>
			</section>
		</div>
	);
}
