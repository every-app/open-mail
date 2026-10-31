// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Bot, Maximize2, Minimize2, Minus, X } from "lucide-react";
import { type ComponentType, type ReactNode, useEffect, useState } from "react";
import { useParams } from "react-router";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { useMediaQuery } from "~/hooks/use-media-query";
import { useUIStore } from "~/hooks/useUIStore";
import { cn } from "~/lib/cn";
import MCPPanel from "./MCPPanel";

/** What the chat renders into: the header's action slot (Clear chat lives there). */
export type AgentPanelProps = { headerSlot: HTMLElement | null };

/** The open window's width; the compose window docks left of it (app/components/ComposeWindow.tsx). */
export const AGENT_WINDOW_WIDTH = 720;
/** The minimized bar's width. */
export const AGENT_BAR_WIDTH = 280;

function LazyAgentPanel(props: AgentPanelProps) {
	const [AgentChat, setAgentChat] = useState<ComponentType<AgentPanelProps> | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		import("~/components/AgentPanel")
			.then((mod) => {
				setAgentChat(() => mod.default);
			})
			.catch((err) => {
				console.error("Failed to load AgentPanel:", err);
				setLoadError("Failed to load agent panel");
			});
	}, []);

	if (loadError) {
		return (
			<div className="flex h-full items-center justify-center px-4 text-center">
				<span className="text-sm text-destructive">{loadError}</span>
			</div>
		);
	}
	if (!AgentChat) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
				<Spinner />
				<span className="text-xs">Loading agent…</span>
			</div>
		);
	}
	return <AgentChat {...props} />;
}

function HeaderButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
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
					/>
				}
			>
				{children}
			</TooltipTrigger>
			<TooltipContent side="bottom">{label}</TooltipContent>
		</Tooltip>
	);
}

/**
 * The mailbox's agent as a floating window (docs/UI.md "Agent"), docked
 * bottom-right like the compose window but larger: tabs for the chat and for
 * connecting AI clients over MCP, the chat's actions, minimize, expand and
 * close. Clicking the header minimizes or restores it. Full screen on mobile,
 * where minimizing hides it. Driven by `useUIStore().agent`.
 */
export default function AgentWindow() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const agent = useUIStore((s) => s.agent);
	const setAgentMinimized = useUIStore((s) => s.setAgentMinimized);
	const setAgentMaximized = useUIStore((s) => s.setAgentMaximized);
	const closeAgent = useUIStore((s) => s.closeAgent);
	const isMobile = useMediaQuery("(max-width: 767px)") === true;
	const [activeTab, setActiveTab] = useState<"agent" | "mcp">("agent");
	const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);

	if (!agent.open || !mailboxId) return null;
	// On a phone there's no room for a bar: minimized is hidden (the top bar's button brings it back).
	if (isMobile && agent.minimized) return null;

	const isMinimized = agent.minimized && !isMobile;
	const isMaximized = agent.maximized && !isMobile;
	const toggleMinimized = () => setAgentMinimized(!agent.minimized);

	return (
		<>
			{isMaximized && (
				<div
					aria-hidden
					className="fixed inset-0 z-30 bg-black/40 supports-backdrop-filter:backdrop-blur-xs"
					onClick={() => setAgentMaximized(false)}
				/>
			)}
			<section
				role="dialog"
				aria-label="Agent"
				aria-modal={isMaximized || isMobile ? true : undefined}
				onKeyDown={(e) => {
					if (e.key === "Escape" && isMaximized) {
						e.stopPropagation();
						setAgentMaximized(false);
					}
				}}
				className={cn(
					"fixed z-30 flex flex-col overflow-hidden border border-border bg-card text-card-foreground shadow-xl",
					isMobile && "inset-0 z-50 border-0",
					!isMobile && isMaximized && "top-1/2 left-1/2 h-[85vh] w-[min(1100px,85vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg",
					!isMobile && !isMaximized && "right-4 bottom-0 rounded-t-lg border-b-0",
					!isMobile && !isMaximized && !isMinimized &&
						"h-[min(860px,calc(100dvh-4.5rem))] w-[720px] max-w-[calc(100vw-2rem)]",
					isMinimized && "w-[280px]",
				)}
			>
				<Tabs
					value={activeTab}
					onValueChange={(value) => setActiveTab(value as "agent" | "mcp")}
					className="flex min-h-0 flex-1 flex-col gap-0"
				>
					{/* Header: click empty space to minimize or restore (desktop) */}
					<div
						className={cn(
							"flex shrink-0 items-center gap-1 bg-background pr-1.5 pl-3",
							isMinimized ? "h-10" : "h-12 border-b border-border",
							!isMobile && "cursor-pointer select-none",
						)}
						onClick={isMobile ? undefined : toggleMinimized}
					>
						{isMinimized ? (
							<h2 className="flex min-w-0 flex-1 items-center gap-2 truncate text-sm font-medium">
								<Bot className="size-4 shrink-0 text-primary" aria-hidden />
								Agent
							</h2>
						) : (
							<TabsList aria-label="Agent window" onClick={(e) => e.stopPropagation()}>
								<TabsTrigger value="agent" className="px-2.5">
									Agent
								</TabsTrigger>
								<TabsTrigger value="mcp" className="px-2.5">
									AI clients
								</TabsTrigger>
							</TabsList>
						)}
						<div
							ref={setHeaderSlot}
							onClick={(e) => e.stopPropagation()}
							className={activeTab === "agent" && !isMinimized ? "ml-auto flex items-center gap-0.5" : "hidden"}
						/>
						<div className={cn("flex items-center gap-0.5", (activeTab !== "agent" || isMinimized) && "ml-auto")}>
							{!isMobile && (
								<>
									<HeaderButton label={isMinimized ? "Restore" : "Minimize"} onClick={toggleMinimized}>
										<Minus />
									</HeaderButton>
									<HeaderButton
										label={isMaximized ? "Exit full screen" : "Full screen"}
										onClick={() => setAgentMaximized(!agent.maximized)}
									>
										{isMaximized ? <Minimize2 /> : <Maximize2 />}
									</HeaderButton>
								</>
							)}
							<HeaderButton label="Close agent" onClick={closeAgent}>
								<X />
							</HeaderButton>
						</div>
					</div>

					{/* The chat stays mounted while minimized and on the other tab, so nothing is lost. */}
					<TabsContent value="agent" keepMounted className={cn("min-h-0", isMinimized && "hidden")}>
						<LazyAgentPanel headerSlot={headerSlot} />
					</TabsContent>
					<TabsContent value="mcp" className={cn("min-h-0 overflow-y-auto", isMinimized && "hidden")}>
						<MCPPanel />
					</TabsContent>
				</Tabs>
			</section>
		</>
	);
}
