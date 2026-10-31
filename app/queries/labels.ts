import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import type { Email, Label, LabelColor, LabelWithCount } from "~/types";
import { queryKeys } from "./keys";

// ---------- Queries ----------

/** The mailbox's labels, by name, each with its conversations that have unread mail. */
export function useLabels(mailboxId: string | undefined) {
	return useQuery<LabelWithCount[]>({
		queryKey: mailboxId ? queryKeys.labels.list(mailboxId) : ["labels", "_disabled"],
		queryFn: () => api.listLabels(mailboxId!),
		enabled: !!mailboxId,
	});
}

// ---------- Mutations ----------

/** Labels show on list rows, search results and threads: refetch all of them. */
function invalidateLabelData(qc: QueryClient, mailboxId: string) {
	qc.invalidateQueries({ queryKey: queryKeys.labels.list(mailboxId) });
	qc.invalidateQueries({ queryKey: ["emails", mailboxId] });
	qc.invalidateQueries({ queryKey: ["search", mailboxId] });
}

export function useCreateLabel() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ mailboxId, name, color }: { mailboxId: string; name: string; color?: LabelColor }) =>
			api.createLabel(mailboxId, { name, color }),
		onSuccess: (_label, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: queryKeys.labels.list(mailboxId) });
		},
	});
}

export function useUpdateLabel() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			labelId,
			name,
			color,
		}: { mailboxId: string; labelId: string; name?: string; color?: LabelColor }) =>
			api.updateLabel(mailboxId, labelId, { name, color }),
		// A rename or recolor shows on every chip.
		onSuccess: (_label, { mailboxId }) => invalidateLabelData(qc, mailboxId),
	});
}

export function useDeleteLabel() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ mailboxId, labelId }: { mailboxId: string; labelId: string }) =>
			api.deleteLabel(mailboxId, labelId),
		onSuccess: (_data, { mailboxId }) => invalidateLabelData(qc, mailboxId),
	});
}

type EmailListCache = { emails: Email[]; totalCount: number };
type ThreadCache = Email[];

/** The conversation key of a row, as the server groups labels: its thread, or the email itself. */
function conversationOf(email: Pick<Email, "id" | "thread_id">): string {
	return email.thread_id || email.id;
}

function applyChanges(current: Label[] | undefined, add: Label[], remove: string[]): Label[] {
	const kept = (current ?? []).filter((l) => !remove.includes(l.id) || add.some((a) => a.id === l.id));
	for (const label of add) if (!kept.some((l) => l.id === label.id)) kept.push(label);
	return kept.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/**
 * Add and remove labels (ids) on a conversation. `threadKey` is the
 * conversation's thread id (or, for an email without one, its id). Cached
 * email lists, search results, thread and detail caches show the change at
 * once; it rolls back on failure, and labels and emails refetch after.
 */
export function useSetThreadLabels() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			threadKey,
			add = [],
			remove = [],
		}: { mailboxId: string; threadKey: string; add?: string[]; remove?: string[] }) =>
			api.setThreadLabels(mailboxId, threadKey, { add, remove }),
		onMutate: async ({ mailboxId, threadKey, add = [], remove = [] }) => {
			const known = qc.getQueryData<LabelWithCount[]>(queryKeys.labels.list(mailboxId)) ?? [];
			const adding = add
				.map((id) => known.find((l) => l.id === id))
				.filter((l): l is LabelWithCount => !!l)
				.map(({ id, name, color }) => ({ id, name, color }));
			const patch = (email: Email): Email =>
				conversationOf(email) === threadKey || email.id === threadKey
					? { ...email, labels: applyChanges(email.labels, adding, remove) }
					: email;

			const touches = (query: { queryKey: readonly unknown[] }) =>
				(query.queryKey[0] === "emails" || query.queryKey[0] === "search") && query.queryKey[1] === mailboxId;
			await qc.cancelQueries({ predicate: touches });
			const snapshot = qc.getQueriesData<EmailListCache | ThreadCache | Email>({ predicate: touches });

			for (const [key, cached] of snapshot) {
				if (!cached) continue;
				if (Array.isArray(cached)) {
					qc.setQueryData(key, cached.map(patch));
				} else if ("emails" in cached && Array.isArray(cached.emails)) {
					qc.setQueryData(key, { ...cached, emails: cached.emails.map(patch) });
				} else if ("results" in cached && Array.isArray((cached as { results?: unknown }).results)) {
					const results = (cached as unknown as { results: Email[] }).results;
					qc.setQueryData(key, { ...cached, results: results.map(patch) });
				} else if ("id" in cached && typeof cached.id === "string") {
					qc.setQueryData(key, patch(cached as Email));
				}
			}
			return { snapshot };
		},
		onError: (_err, _vars, context) => {
			for (const [key, cached] of context?.snapshot ?? []) qc.setQueryData(key, cached);
		},
		onSettled: (_data, _err, { mailboxId }) => invalidateLabelData(qc, mailboxId),
	});
}
