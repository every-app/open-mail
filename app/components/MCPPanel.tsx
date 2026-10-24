// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Tooltip } from "@cloudflare/kumo";
import {
	CheckIcon,
	CopyIcon,
	PlugsIcon,
	WrenchIcon,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { meQuery } from "~/services/api";

function CopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			// Clipboard API unavailable or permission denied — ignore silently
		}
	};

	return (
		<Tooltip content={copied ? "Copied" : "Copy"} asChild>
			<Button
				variant="ghost"
				shape="square"
				size="sm"
				icon={
					copied ? (
						<CheckIcon size={12} weight="bold" className="text-kumo-success" />
					) : (
						<CopyIcon size={12} />
					)
				}
				onClick={handleCopy}
				aria-label="Copy to clipboard"
			/>
		</Tooltip>
	);
}

/**
 * The tools MCP clients see: a static copy of the names in the app's tool
 * catalog (workers/everyapp/tools.ts), less `delete_email`, which the gateway
 * hides from AI clients until it has approvals. test/tools.test.ts keeps this
 * list in step with the catalog.
 */
export const MCP_TOOLS = [
	{ name: "list_mailboxes", desc: "List mailboxes" },
	{ name: "list_emails", desc: "List emails in a folder" },
	{ name: "get_email", desc: "Read a full email with body" },
	{ name: "get_thread", desc: "Load a conversation thread" },
	{ name: "search_emails", desc: "Search emails by query" },
	{ name: "draft_reply", desc: "Draft a reply to an email" },
	{ name: "create_draft", desc: "Create a new draft" },
	{ name: "update_draft", desc: "Edit a draft" },
	{ name: "send_reply", desc: "Send a reply" },
	{ name: "send_email", desc: "Send a new email" },
	{ name: "mark_email_read", desc: "Mark email as read/unread" },
	{ name: "move_email", desc: "Move email to a folder" },
] as const;

function UrlField({ label, url }: { label: string; url: string }) {
	return (
		<div className="space-y-1.5">
			<label className="text-xs font-medium text-kumo-strong block">
				{label}
			</label>
			<div className="relative group">
				<div className="absolute right-1.5 top-1/2 -translate-y-1/2">
					<CopyButton text={url} />
				</div>
				<div className="bg-kumo-recessed text-kumo-default font-mono text-[11px] px-3 py-2.5 pr-10 rounded-lg border border-kumo-line [overflow-wrap:anywhere] leading-relaxed">
					{url}
				</div>
			</div>
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
	const appOrigin =
		typeof window !== "undefined" ? window.location.origin : "https://agentic-inbox.your-gateway.example";
	const gatewayOrigin = me?.gatewayUrl?.replace(/\/+$/, "");
	const gatewayMcpUrl = gatewayOrigin ? `${gatewayOrigin}/mcp` : null;
	const appMcpUrl = `${appOrigin}/mcp`;

	return (
		<div className="flex flex-col h-full">
			{/* Content */}
			<div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
				{/* Intro */}
				<div className="space-y-2">
					<div className="flex items-center gap-2">
						<div className="flex h-10 w-10 items-center justify-center rounded-xl bg-kumo-brand/10">
							<PlugsIcon
								size={20}
								weight="duotone"
								className="text-kumo-brand"
							/>
						</div>
						<div>
							<h3 className="text-sm font-semibold text-kumo-default">
								Connect an AI client
							</h3>
						</div>
					</div>
					<p className="text-xs text-kumo-subtle leading-relaxed">
						A connected assistant can read, search, draft and send from
						this organization's mailboxes, as you.
					</p>
				</div>

				{/* MCP URLs */}
				{gatewayMcpUrl && (
					<div className="space-y-1">
						<UrlField label="Every App connector" url={gatewayMcpUrl} />
						<p className="text-[11px] text-kumo-subtle leading-relaxed px-0.5">
							One address for all your apps.
						</p>
					</div>
				)}
				{gatewayMcpUrl && (
					<div className="space-y-1">
						<UrlField
							label="Claude Code"
							url={`claude mcp add --transport http everyapp ${gatewayMcpUrl}`}
						/>
						<p className="text-[11px] text-kumo-subtle leading-relaxed px-0.5">
							Then in Claude Code: /mcp → everyapp → Authenticate.
						</p>
						<p className="text-[11px] text-kumo-subtle leading-relaxed px-0.5">
							claude.ai, ChatGPT and Cursor: add the connector URL as
							a custom connector or MCP server and sign in when asked.
						</p>
					</div>
				)}
				<details className="space-y-1">
					<summary className="text-xs font-medium text-kumo-strong cursor-pointer">
						Using a personal access token instead
					</summary>
					<div className="space-y-1 pt-1">
						<UrlField label="This app only" url={appMcpUrl} />
						<p className="text-[11px] text-kumo-subtle leading-relaxed px-0.5">
							Connect with a personal access token from the gateway,
							sent as <code className="font-mono">Authorization: Bearer epat_…</code>.
							{gatewayOrigin ? (
								<>
									{" "}Create one on the gateway under{" "}
									<a
										href={`${gatewayOrigin}/admin/tokens`}
										target="_blank"
										rel="noopener noreferrer"
										className="text-kumo-link hover:text-kumo-link-hover"
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

				{/* Available tools */}
				<div className="space-y-2">
					<h4 className="text-xs uppercase tracking-wider font-semibold text-kumo-subtle px-0.5">
						Available Tools
					</h4>
					<div className="border border-kumo-line rounded-lg divide-y divide-kumo-line">
						{MCP_TOOLS.map((tool) => (
							<div
								key={tool.name}
								className="flex items-center gap-2.5 px-3 py-2"
							>
								<WrenchIcon
									size={12}
									weight="bold"
									className="text-kumo-brand shrink-0"
								/>
								<div className="min-w-0 flex-1">
									<span className="text-xs font-mono font-medium text-kumo-default">
										{tool.name}
									</span>
								</div>
								<span className="text-[11px] text-kumo-subtle shrink-0">
									{tool.desc}
								</span>
							</div>
						))}
					</div>
					<p className="text-[11px] text-kumo-subtle leading-relaxed px-0.5">
						Draft tools never send. Send tools send at once, as you. No
						tool deletes email.
					</p>
				</div>
			</div>
		</div>
	);
}
