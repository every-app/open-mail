// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { Email } from "~/types";

export type ComposeMode = "new" | "reply" | "reply-all" | "forward";

export interface ComposeOptions {
	mode: ComposeMode;
	originalEmail?: Email | null;
	/** When editing a draft, this holds the draft email to pre-fill the composer */
	draftEmail?: Email | null;
}

/** The floating compose window (docs/UI.md "Compose"), docked bottom-right. */
export interface ComposeWindowState {
	open: boolean;
	/** Collapsed to its header bar. */
	minimized: boolean;
	/** Expanded to a centered, dialog-sized window. */
	maximized: boolean;
	options: ComposeOptions;
}

/**
 * The agent's floating window (docs/UI.md "Agent"), docked bottom-right like
 * compose but larger: minimizes to its header bar, expands to a centered
 * window, and is full screen on mobile (where minimized means hidden).
 */
export interface AgentWindowState {
	open: boolean;
	minimized: boolean;
	maximized: boolean;
}

/** First visit: the agent waits as a bar bottom-right, one click from open. */
const AGENT_DEFAULT: AgentWindowState = { open: true, minimized: true, maximized: false };

const NEW_COMPOSE: ComposeOptions = { mode: "new", originalEmail: null };
const CLOSED_WINDOW: ComposeWindowState = {
	open: false,
	minimized: false,
	maximized: false,
	options: NEW_COMPOSE,
};

/**
 * Opens a conversation (an id) or goes back to the list (null) by URL. The
 * mailbox shell registers one (`MailRouteSync` in app/hooks/useMailRoute.ts)
 * so the legacy `selectEmail` / `closePanel` navigate instead of setting state.
 */
export type MailNavigator = (emailId: string | null) => void;

interface UIState {
	/**
	 * The open conversation: mirrors `:emailId` in the URL (the shell syncs it).
	 * Prefer `useMailRoute().emailId` in new code.
	 */
	selectedEmailId: string | null;
	isComposing: boolean;
	_previousEmailId: string | null;
	/** Navigates to the conversation (or the list for null) when a shell is mounted. */
	selectEmail: (id: string | null) => void;
	/** Legacy: opens the floating compose window (same as openCompose). */
	startCompose: (options?: ComposeOptions) => void;
	/** Closes the conversation (back to the list) and the legacy compose panel. */
	closePanel: () => void;
	closeCompose: () => void;

	/** Set by the shell; not for direct use. */
	_mailNavigator: MailNavigator | null;
	_setMailNavigator: (navigator: MailNavigator | null) => void;
	/** Set by the shell from the URL; not for direct use. */
	_syncSelectedEmailId: (id: string | null) => void;

	// Compose options (legacy split-panel composer)
	composeOptions: ComposeOptions;

	// Floating compose window
	compose: ComposeWindowState;
	openCompose: (options?: ComposeOptions) => void;
	closeComposeWindow: () => void;
	setComposeMinimized: (minimized: boolean) => void;
	setComposeMaximized: (maximized: boolean) => void;

	// Mobile sidebar (a sheet)
	isSidebarOpen: boolean;
	openSidebar: () => void;
	closeSidebar: () => void;
	toggleSidebar: () => void;

	// Desktop sidebar: full width or the icon rail (persisted)
	isSidebarCollapsed: boolean;
	setSidebarCollapsed: (collapsed: boolean) => void;
	toggleSidebarCollapsed: () => void;

	// Agent window (floating; open and minimized are persisted)
	agent: AgentWindowState;
	/** Opens the agent window, restored from minimized. */
	openAgent: () => void;
	closeAgent: () => void;
	setAgentMinimized: (minimized: boolean) => void;
	setAgentMaximized: (maximized: boolean) => void;
	/** The top bar's button: open it when it's closed or minimized, else minimize it. */
	toggleAgent: () => void;

	/**
	 * The list on screen, in order: the list route sets it, the conversation
	 * view reads it for "3 of 25" and older/newer (and `j`/`k`). `ids` are the
	 * rows' email ids as the list links them; `total` is the whole folder's.
	 */
	listContext: ListContext | null;
	setListContext: (context: ListContext | null) => void;

	// Keyboard shortcuts sheet (`?`)
	isShortcutsOpen: boolean;
	setShortcutsOpen: (open: boolean) => void;

	// Legacy dialog support (kept for non-split views)
	isComposeModalOpen: boolean;
	openComposeModal: (options?: ComposeOptions) => void;
	closeComposeModal: () => void;
}

export interface ListContext {
	/** The list's path (folder, label or search, with its query string). */
	listPath: string;
	ids: string[];
	page: number;
	pageSize: number;
	total: number;
}

export const useUIStore = create<UIState>()(
	persist(
		(set, get) => ({
			selectedEmailId: null,
			isComposing: false,
			_previousEmailId: null,
			composeOptions: NEW_COMPOSE,
			compose: CLOSED_WINDOW,
			isComposeModalOpen: false,
			isSidebarOpen: false,
			isSidebarCollapsed: false,
			agent: AGENT_DEFAULT,
			isShortcutsOpen: false,
			listContext: null,
			_mailNavigator: null,

			selectEmail: (id) => {
				set({ isComposing: false });
				const navigate = get()._mailNavigator;
				if (navigate) navigate(id);
				else set({ selectedEmailId: id });
			},

			_setMailNavigator: (navigator) => set({ _mailNavigator: navigator }),
			_syncSelectedEmailId: (id) => set({ selectedEmailId: id }),

			// Legacy entry point: every compose (new, reply, forward, a draft)
			// now opens the floating window.
			startCompose: (options) => get().openCompose(options),

			closePanel: () => {
				set({
					isComposing: false,
					_previousEmailId: null,
					composeOptions: NEW_COMPOSE,
				});
				const navigate = get()._mailNavigator;
				if (navigate) navigate(null);
				else set({ selectedEmailId: null });
			},

			closeCompose: () =>
				set((state) => ({
					isComposing: false,
					selectedEmailId: state._previousEmailId,
					_previousEmailId: null,
					composeOptions: NEW_COMPOSE,
				})),

			openCompose: (options) =>
				set((state) => {
					// A plain new message while one is open brings that one back
					// instead of replacing what's being written.
					const isPlainNew = !options || (options.mode === "new" && !options.draftEmail && !options.originalEmail);
					if (isPlainNew && state.compose.open && state.compose.options.mode === "new") {
						return { compose: { ...state.compose, minimized: false }, isSidebarOpen: false };
					}
					return {
						compose: {
							open: true,
							minimized: false,
							maximized: false,
							options: options || NEW_COMPOSE,
						},
						isSidebarOpen: false,
					};
				}),
			closeComposeWindow: () => set({ compose: CLOSED_WINDOW }),
			setComposeMinimized: (minimized) =>
				set((state) => ({
					compose: { ...state.compose, minimized, maximized: minimized ? false : state.compose.maximized },
				})),
			setComposeMaximized: (maximized) =>
				set((state) => ({
					compose: { ...state.compose, maximized, minimized: maximized ? false : state.compose.minimized },
				})),

			openSidebar: () => set({ isSidebarOpen: true }),
			closeSidebar: () => set({ isSidebarOpen: false }),
			toggleSidebar: () => set({ isSidebarOpen: !get().isSidebarOpen }),

			setSidebarCollapsed: (collapsed) => set({ isSidebarCollapsed: collapsed }),
			toggleSidebarCollapsed: () => set({ isSidebarCollapsed: !get().isSidebarCollapsed }),

			openAgent: () => set((state) => ({ agent: { ...state.agent, open: true, minimized: false } })),
			closeAgent: () => set({ agent: { open: false, minimized: false, maximized: false } }),
			setAgentMinimized: (minimized) =>
				set((state) => ({
					agent: { ...state.agent, minimized, maximized: minimized ? false : state.agent.maximized },
				})),
			setAgentMaximized: (maximized) =>
				set((state) => ({
					agent: { ...state.agent, maximized, minimized: maximized ? false : state.agent.minimized },
				})),
			toggleAgent: () => {
				const { open, minimized } = get().agent;
				if (!open || minimized) get().openAgent();
				else get().setAgentMinimized(true);
			},

			setShortcutsOpen: (open) => set({ isShortcutsOpen: open }),

			setListContext: (listContext) => set({ listContext }),

			openComposeModal: (options) =>
				set({
					composeOptions: options || NEW_COMPOSE,
					isComposeModalOpen: true,
				}),

			closeComposeModal: () =>
				set({
					isComposeModalOpen: false,
					composeOptions: NEW_COMPOSE,
				}),
		}),
		{
			name: "openmail-ui",
			// 2: the agent side panel became a floating window; old preferences reset.
			version: 2,
			migrate: (persisted, version) => {
				const state = (persisted ?? {}) as { isSidebarCollapsed?: boolean };
				return version < 2 ? { isSidebarCollapsed: state.isSidebarCollapsed ?? false } : (persisted as never);
			},
			storage: createJSONStorage(() => localStorage),
			partialize: (state) => ({
				isSidebarCollapsed: state.isSidebarCollapsed,
				// Restores open or minimized, never expanded over the mail.
				agent: { open: state.agent.open, minimized: state.agent.minimized, maximized: false },
			}),
			// The server renders the defaults; the shell rehydrates after mount
			// (`useUIStore.persist.rehydrate()`) so the first client render matches.
			skipHydration: true,
		},
	),
);
