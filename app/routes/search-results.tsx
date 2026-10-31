// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useQueryClient } from "@tanstack/react-query";
import { Search, Star } from "lucide-react";
import { useSearchParams } from "react-router";
import EmailPanel from "~/components/EmailPanel";
import { ListEmpty } from "~/components/list/ListEmpty";
import { MailList } from "~/components/list/MailList";
import { usePageParam } from "~/components/list/usePageParam";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { useMailRoute } from "~/hooks/useMailRoute";
import { mailboxDisplayName } from "~/lib/utils";
import { useMailbox } from "~/queries/mailboxes";
import { SEARCH_PAGE_SIZE, useSearchEmails } from "~/queries/search";
import type { Email } from "~/types";

/** The sidebar's Starred is this search (app/components/Sidebar.tsx). */
const STARRED_QUERY = "is:starred";
const NO_EMAILS: Email[] = [];
const OPERATOR = /\b(?:from|to|subject|in|is|has|label|before|after):(?:"[^"]*"|\S+)/gi;

/** Marks the query's free text (not its operators) in a row's text. */
function highlighter(query: string) {
	const freeText = query.replace(OPERATOR, "").trim();
	if (!freeText) return undefined;
	const escaped = freeText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const regex = new RegExp(`(${escaped})`, "gi");
	const lower = freeText.toLowerCase();
	return (text: string) => {
		const parts = text.split(regex);
		if (parts.length === 1) return text;
		return parts.map((part, i) =>
			part.toLowerCase() === lower ? (
				<mark key={i} className="rounded-sm bg-warning/25 px-0.5 text-foreground">
					{part}
				</mark>
			) : (
				part
			),
		);
	};
}

/** Search results (and Starred) in the list's rows; a result opens at `search/:emailId?q=…`. */
export default function SearchResultsRoute() {
	const { mailboxId, emailId } = useMailRoute();
	const [searchParams] = useSearchParams();
	const [page, setPage] = usePageParam();
	const queryClient = useQueryClient();
	const query = (searchParams.get("q") ?? "").trim();
	const isStarred = query === STARRED_QUERY;
	const { data: mailbox } = useMailbox(mailboxId);
	const { data, isLoading, error, isFetching, refetch } = useSearchEmails(mailboxId, query, page);
	useDocumentTitle(isStarred ? "Starred" : query ? `Search: ${query}` : "Search", mailboxDisplayName(mailbox, mailboxId));

	if (!mailboxId) return null;

	const title = isStarred ? (
		"Starred"
	) : (
		<span className="truncate">
			Search results{query && <span className="font-normal text-muted-foreground"> for “{query}”</span>}
		</span>
	);

	const empty = isStarred ? (
		<ListEmpty
			icon={<Star />}
			title="No starred conversations"
			description="Star a conversation (or press s on it) to find it here."
		/>
	) : !query ? (
		<ListEmpty icon={<Search />} title="Search your mail" description="Type in the search box above and press Enter." />
	) : (
		<ListEmpty
			icon={<Search />}
			title="No results"
			description={
				<>
					Nothing matches “{query}”. Try <code className="rounded bg-muted px-1 text-xs">from:name</code>,{" "}
					<code className="rounded bg-muted px-1 text-xs">is:unread</code>,{" "}
					<code className="rounded bg-muted px-1 text-xs">has:attachment</code>,{" "}
					<code className="rounded bg-muted px-1 text-xs">label:name</code> or{" "}
					<code className="rounded bg-muted px-1 text-xs">before:2025-01-01</code>.
				</>
			}
		/>
	);

	return (
		<>
			<MailList
				mailboxId={mailboxId}
				title={title}
				emails={data?.results ?? NO_EMAILS}
				total={data?.totalCount ?? 0}
				page={page}
				pageSize={SEARCH_PAGE_SIZE}
				onPageChange={setPage}
				isLoading={isLoading}
				error={error}
				isFetching={isFetching}
				onRefresh={() => {
					void refetch();
					void queryClient.invalidateQueries({ queryKey: ["search", mailboxId] });
				}}
				empty={empty}
				selfAddress={mailbox?.email ?? mailboxId}
				showFolder={!isStarred}
				highlight={highlighter(query)}
				hidden={!!emailId}
			/>
			{emailId && <EmailPanel emailId={emailId} />}
		</>
	);
}
