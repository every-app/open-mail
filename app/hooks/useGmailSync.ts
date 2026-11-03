/**
 * Keeps a Gmail mailbox in sync while it is open (docs/GMAIL.md, "Background
 * sync"): `POST …/gmail/sync` on mount, every 30 s while the tab is visible,
 * and on focus, never two at once (createSyncLoop). Each answer seeds the
 * drafting jobs; one that pulled, pushed or relabeled mail refreshes the
 * lists, counts and labels. Mount it once per mailbox (GmailSync in the mailbox route).
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { createSyncLoop, isReconnectError, type SyncLoop, syncChangedMail } from "~/lib/gmail";
import { gmailKeys } from "~/queries/gmail";
import { queryKeys } from "~/queries/keys";
import gmailApi from "~/services/gmail-api";

export interface GmailSyncState {
	syncing: boolean;
	/** When the last sync succeeded (epoch ms). */
	lastSyncedAt: number | null;
	/** Why the last sync failed, or what it reported (`error` in its answer). */
	error: string | null;
	/** Google needs reconnecting (409 `reconnect: true`). */
	reconnect: boolean;
}

const IDLE: GmailSyncState = { syncing: false, lastSyncedAt: null, error: null, reconnect: false };

export function useGmailSync(mailboxId: string | undefined, enabled: boolean) {
	const qc = useQueryClient();
	const [state, setState] = useState<GmailSyncState>(IDLE);
	const loopRef = useRef<SyncLoop | null>(null);

	useEffect(() => {
		setState(IDLE);
		if (!mailboxId || !enabled) return;
		let active = true;
		const update = (patch: Partial<GmailSyncState>) => {
			if (active) setState((prev) => ({ ...prev, ...patch }));
		};

		const loop = createSyncLoop({
			isVisible: () => document.visibilityState === "visible",
			run: async () => {
				update({ syncing: true });
				try {
					const result = await gmailApi.sync(mailboxId);
					if (Array.isArray(result.drafting)) {
						qc.setQueryData(gmailKeys.drafting(mailboxId), result.drafting);
					}
					if (syncChangedMail(result)) {
						qc.invalidateQueries({ queryKey: ["emails", mailboxId] });
						qc.invalidateQueries({ queryKey: queryKeys.folders.list(mailboxId) });
						qc.invalidateQueries({ queryKey: queryKeys.labels.list(mailboxId) });
						qc.invalidateQueries({ queryKey: ["search", mailboxId] });
					}
					update({ syncing: false, lastSyncedAt: Date.now(), error: result.error ?? null, reconnect: false });
				} catch (err) {
					const reconnect = isReconnectError(err);
					if (reconnect) qc.invalidateQueries({ queryKey: gmailKeys.status });
					update({
						syncing: false,
						reconnect,
						error: reconnect ? null : (err instanceof Error && err.message) || "Couldn't sync with Gmail.",
					});
				}
			},
		});
		loopRef.current = loop;
		void loop.syncNow();

		const wake = () => {
			if (document.visibilityState === "visible") void loop.wake();
		};
		window.addEventListener("focus", wake);
		document.addEventListener("visibilitychange", wake);
		return () => {
			active = false;
			loop.stop();
			loopRef.current = null;
			window.removeEventListener("focus", wake);
			document.removeEventListener("visibilitychange", wake);
		};
	}, [mailboxId, enabled, qc]);

	const syncNow = useCallback(() => {
		void loopRef.current?.syncNow();
	}, []);

	return { ...state, syncNow };
}
