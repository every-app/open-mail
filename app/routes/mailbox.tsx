// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { MailX, Pencil } from "lucide-react";
import { useEffect, useRef } from "react";
import { Link, Outlet, useNavigate, useParams } from "react-router";
import { Folders } from "shared/folders";
import AgentWindow from "~/components/AgentWindow";
import ComposeWindow from "~/components/ComposeWindow";
import ShortcutsDialog from "~/components/ShortcutsDialog";
import Sidebar from "~/components/Sidebar";
import TopBar from "~/components/TopBar";
// Gmail (docs/GMAIL.md): the sync poll and its status line (and background drafting), for a Gmail mailbox.
import GmailSync from "~/components/gmail/GmailSync";
import { Button } from "~/components/ui/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "~/components/ui/empty";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "~/components/ui/sheet";
import { useHotkeys } from "~/hooks/useHotkeys";
import { MailRouteSync, useMailRoute } from "~/hooks/useMailRoute";
import { useUIStore } from "~/hooks/useUIStore";
import { cn } from "~/lib/cn";
import { folderPath } from "~/lib/mail-paths";
import { useMailbox } from "~/queries/mailboxes";
import { ApiError } from "~/services/api";

/** The shell's global shortcuts (docs/UI.md "Keyboard"); `/` lives in the top bar's search field. */
function GlobalHotkeys({ mailboxId }: { mailboxId: string }) {
	const navigate = useNavigate();
	const startCompose = useUIStore((s) => s.startCompose);
	const setShortcutsOpen = useUIStore((s) => s.setShortcutsOpen);
	const go = (folder: string) => () => navigate(folderPath(mailboxId, folder));

	useHotkeys({
		c: () => startCompose(),
		"g i": go(Folders.INBOX),
		"g s": go(Folders.SENT),
		"g d": go(Folders.DRAFT),
		"g t": go(Folders.TRASH),
		"g a": go(Folders.ARCHIVE),
		"?": () => setShortcutsOpen(true),
	});
	return null;
}

/**
 * Gmail's mobile Compose: a floating button over the list (below md, where
 * the sidebar and its Compose are a sheet away). Hidden in a conversation, on
 * other pages and while the compose window is open.
 */
function MobileComposeButton() {
	const { emailId, folder, labelId, listPath } = useMailRoute();
	const composeOpen = useUIStore((s) => s.compose.open);
	const isSearch = /\/search(\?|$)/.test(listPath);
	if (composeOpen || emailId || !(folder || labelId || isSearch)) return null;
	return (
		<Button
			size="lg"
			className="fixed right-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-30 rounded-2xl px-5 shadow-lg md:hidden"
			onClick={() => useUIStore.getState().openCompose()}
		>
			<Pencil className="size-5" />
			Compose
		</Button>
	);
}

function MissingMailbox() {
	return (
		<div className="flex min-h-screen items-center justify-center p-8">
			<Empty>
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<MailX />
					</EmptyMedia>
					<EmptyTitle>This mailbox doesn't exist</EmptyTitle>
					<EmptyDescription>
						It may have been deleted, or the address in this link is wrong.
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button render={<Link to="/" />} nativeButton={false}>
						Back to mailboxes
					</Button>
				</EmptyContent>
			</Empty>
		</div>
	);
}

/**
 * Gmail's frame (docs/UI.md "Layout"): the top bar full width; under it the
 * sidebar (an icon rail when collapsed, a sheet on mobile) and the main pane.
 * The agent and compose float over it, bottom-right.
 */
export default function MailboxRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	// Prefetch mailbox data for child components. A 404 means there is no such
	// mailbox (deleted, or a wrong address in the link): say so instead of
	// rendering an inbox, Compose and an agent for data that isn't there.
	const { error } = useMailbox(mailboxId);
	const missing = error instanceof ApiError && error.status === 404;
	const prevMailboxIdRef = useRef<string | undefined>(undefined);
	const isSidebarOpen = useUIStore((s) => s.isSidebarOpen);
	const isSidebarCollapsed = useUIStore((s) => s.isSidebarCollapsed);
	const setSidebarOpen = (open: boolean) =>
		open ? useUIStore.getState().openSidebar() : useUIStore.getState().closeSidebar();

	// The rail and agent window preferences live in localStorage; read them
	// after the first render so it matches the server's.
	useEffect(() => {
		useUIStore.persist.rehydrate();
	}, []);

	useEffect(() => {
		if (prevMailboxIdRef.current && mailboxId && prevMailboxIdRef.current !== mailboxId) {
			// The conversation closes with the URL; drop the rest of the old mailbox's state.
			useUIStore.setState({ isComposing: false, _previousEmailId: null });
			useUIStore.getState().closeComposeModal();
			useUIStore.getState().closeComposeWindow();
			useUIStore.getState().closeSidebar();
		}
		prevMailboxIdRef.current = mailboxId;
	}, [mailboxId]);

	if (missing) return <MissingMailbox />;
	if (!mailboxId) return null;

	const closeSheet = () => setSidebarOpen(false);

	return (
		<div className="flex h-dvh flex-col overflow-hidden bg-background">
			<MailRouteSync />
			<GlobalHotkeys mailboxId={mailboxId} />
			<TopBar />
			<GmailSync mailboxId={mailboxId} />

			<div className="flex min-h-0 flex-1">
				{/* Sidebar: full or icon rail on desktop */}
				<aside
					className={cn(
						"hidden shrink-0 transition-[width] duration-200 ease-in-out md:block",
						isSidebarCollapsed ? "w-[72px]" : "w-64",
					)}
				>
					<Sidebar mailboxId={mailboxId} collapsed={isSidebarCollapsed} />
				</aside>

				{/* Sidebar: a sheet on mobile */}
				<Sheet open={isSidebarOpen} onOpenChange={setSidebarOpen}>
					<SheetContent side="left" showCloseButton={false} className="w-72 gap-0 bg-background p-0 pt-3 md:hidden">
						<SheetHeader className="sr-only">
							<SheetTitle>Mail navigation</SheetTitle>
							<SheetDescription>Folders and labels</SheetDescription>
						</SheetHeader>
						<Sidebar mailboxId={mailboxId} onNavigate={closeSheet} />
					</SheetContent>
				</Sheet>

				{/* Main pane */}
				<main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-card md:mr-2 md:mb-2 md:rounded-xl md:border md:border-border">
					<Outlet />
				</main>
			</div>

			{/* The agent's floating window (docs/UI.md "Agent"), rightmost. */}
			<AgentWindow />

			{/*
			 * COMPOSE HOST: the floating compose window (docs/UI.md "Compose"),
			 * driven by useUIStore().compose / openCompose (startCompose too).
			 */}
			<ComposeWindow />
			<MobileComposeButton />
			<ShortcutsDialog />
		</div>
	);
}
