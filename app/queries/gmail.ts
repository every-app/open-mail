/**
 * TanStack Query hooks for the Gmail routes (docs/GMAIL.md, "API"). The
 * port's own; keys live here, under "gmail", so they never collide with upstream's (app/queries/keys.ts).
 */
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { isGmailMailbox } from "~/lib/gmail";
import { queryKeys } from "~/queries/keys";
import { useMailbox } from "~/queries/mailboxes";
import api, { ApiError } from "~/services/api";
import gmailApi, { type DraftJob, type PortMailbox } from "~/services/gmail-api";

export const gmailKeys = {
	status: ["gmail", "status"] as const,
	drafting: (mailboxId: string) => ["gmail", mailboxId, "drafting"] as const,
};

/** A 404 means the route isn't there (a build without Gmail): don't retry it. */
const retryUnlessMissing = (failureCount: number, error: unknown) =>
	!(error instanceof ApiError && error.status < 500) && failureCount < 2;

export function useGmailStatus() {
	return useQuery({
		queryKey: gmailKeys.status,
		queryFn: () => gmailApi.getStatus(),
		staleTime: 60_000,
		retry: retryUnlessMissing,
	});
}

/** Whether the route's mailbox is a Gmail one (from the cached detail query). */
export function useIsGmailMailbox(mailboxId: string | undefined): boolean {
	const { data: mailbox } = useMailbox(mailboxId);
	return isGmailMailbox(mailbox);
}

/**
 * Which of these mailboxes are Gmail ones. The list route's items carry
 * `settings` once docs/GMAIL.md's "UI needs" lands; until then, each
 * mailbox without them is read from its detail route.
 */
export function useGmailMailboxIds(mailboxes: { id: string; settings?: unknown }[]): Set<string> {
	const missing = mailboxes.filter((m) => m.settings === undefined);
	const details = useQueries({
		queries: missing.map((m) => ({
			queryKey: queryKeys.mailboxes.detail(m.id),
			queryFn: () => api.getMailbox(m.id),
			staleTime: 60_000,
		})),
	});
	const ids = new Set<string>();
	for (const m of mailboxes) if (isGmailMailbox(m)) ids.add(m.id);
	for (const detail of details) if (detail.data && isGmailMailbox(detail.data)) ids.add(detail.data.id);
	return ids;
}

export function useCreateGmailMailbox() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: () => gmailApi.createMailbox(),
		onSettled: () => qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all }),
	});
}

/** The mailbox's drafting jobs: seeded by every sync (useGmailSync), read here. */
export function useDraftJobs(mailboxId: string | undefined, enabled: boolean) {
	return useQuery<DraftJob[]>({
		queryKey: mailboxId ? gmailKeys.drafting(mailboxId) : ["gmail", "_disabled", "drafting"],
		queryFn: () => gmailApi.getDrafting(mailboxId!),
		enabled: !!mailboxId && enabled,
		staleTime: 30_000,
		retry: retryUnlessMissing,
	});
}

/** Saves the mailbox's settings as they are on the server, with `patch` applied. */
export function useUpdatePortSettings(mailboxId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (patch: Partial<NonNullable<PortMailbox["settings"]>>) => {
			const current = await api.getMailbox(mailboxId);
			return api.updateMailbox(mailboxId, { ...current.settings, ...patch });
		},
		onSettled: () => {
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.detail(mailboxId) });
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
		},
	});
}
