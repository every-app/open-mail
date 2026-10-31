// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useQueryClient } from "@tanstack/react-query";
import { Archive, File, Folder, FolderX, Inbox, OctagonAlert, Send, Tag, Trash2 } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { Link } from "react-router";
import { Folders, getFolderDisplayName, SYSTEM_FOLDER_IDS } from "shared/folders";
import EmailPanel from "~/components/EmailPanel";
import { LabelDot } from "~/components/labels/LabelChip";
import { ListEmpty } from "~/components/list/ListEmpty";
import { MailList } from "~/components/list/MailList";
import { usePageParam } from "~/components/list/usePageParam";
import { Button } from "~/components/ui/button";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { useMailRoute } from "~/hooks/useMailRoute";
import { folderPath } from "~/lib/mail-paths";
import { mailboxDisplayName } from "~/lib/utils";
import { useEmails } from "~/queries/emails";
import { useFolders } from "~/queries/folders";
import { queryKeys } from "~/queries/keys";
import { useLabels } from "~/queries/labels";
import { useMailbox } from "~/queries/mailboxes";
import type { Email } from "~/types";

const PAGE_SIZE = 25;
const NO_EMAILS: Email[] = [];

/** What fills each folder; a description may name the mailbox's address. */
const FOLDER_EMPTY_STATES: Record<
	string,
	{
		icon: ReactNode;
		title: string;
		description: string | ((address: string) => string);
		showCompose?: boolean;
	}
> = {
	[Folders.INBOX]: {
		icon: <Inbox />,
		title: "Inbox is empty",
		description: (address) =>
			`Mail sent to ${address} lands here, and the agent drafts a reply for you in Drafts.`,
		showCompose: true,
	},
	[Folders.SENT]: {
		icon: <Send />,
		title: "No sent emails",
		description: "Emails you send will show up here.",
		showCompose: true,
	},
	[Folders.DRAFT]: {
		icon: <File />,
		title: "No drafts yet",
		description:
			"When mail arrives, the agent drafts a reply here for you to review and send. Anything you save from Compose lands here too.",
		showCompose: true,
	},
	[Folders.ARCHIVE]: {
		icon: <Archive />,
		title: "Archive is empty",
		description: "Move emails here to keep your inbox clean without deleting them.",
	},
	[Folders.TRASH]: {
		icon: <Trash2 />,
		title: "Trash is empty",
		description: "Move emails here to set them aside. Delete removes them for good.",
	},
	[Folders.SPAM]: {
		icon: <OctagonAlert />,
		title: "No spam",
		description: "Mail flagged as spam lands here.",
	},
};

function FolderEmpty({ folder, address }: { folder: string; address: string }) {
	const config = FOLDER_EMPTY_STATES[folder] ?? {
		icon: <Folder />,
		title: "No emails",
		description: "This folder is empty.",
	};
	return (
		<ListEmpty
			icon={config.icon}
			title={config.title}
			description={typeof config.description === "function" ? config.description(address) : config.description}
			showCompose={config.showCompose}
		/>
	);
}

/**
 * A folder's or a label's conversations (docs/UI.md "List"), or, with
 * `:emailId` in the URL, that conversation over the whole pane. The list
 * stays mounted (hidden) under an open conversation, so its selection and
 * focus are still there on the way back.
 */
export default function EmailListRoute() {
	const { mailboxId, folder, labelId, emailId } = useMailRoute();
	const [page, setPage] = usePageParam();
	const queryClient = useQueryClient();
	const { data: mailbox } = useMailbox(mailboxId);
	const { data: folders = [], isSuccess: foldersLoaded } = useFolders(mailboxId);
	const { data: labels, isLoading: labelsLoading } = useLabels(labelId ? mailboxId : undefined);

	const params = useMemo(
		() => ({
			...(labelId ? { label: labelId } : { folder: folder || Folders.INBOX }),
			page: String(page),
			limit: String(PAGE_SIZE),
		}),
		[folder, labelId, page],
	);
	const { data, isLoading, error, isFetching, refetch } = useEmails(mailboxId, params, { refetchInterval: 30_000 });

	const label = labelId ? labels?.find((l) => l.id === labelId) : undefined;
	const viewName = labelId
		? (label?.name ?? (labelsLoading ? "" : "Label"))
		: (folders.find((f) => f.id === folder)?.name ?? getFolderDisplayName(folder || Folders.INBOX));
	useDocumentTitle(viewName || undefined, mailboxDisplayName(mailbox, mailboxId));

	if (!mailboxId) return null;
	const address = mailbox?.email ?? mailboxId;

	const refresh = () => {
		void refetch();
		void queryClient.invalidateQueries({ queryKey: queryKeys.folders.list(mailboxId) });
		if (labelId) void queryClient.invalidateQueries({ queryKey: queryKeys.labels.list(mailboxId) });
	};

	const title = label ? (
		<>
			<LabelDot color={label.color} className="bg-current!" />
			<span className="truncate">{label.name}</span>
		</>
	) : (
		<span className="truncate">{viewName}</span>
	);

	// A folder slug that names no folder (a stale or mistyped link); system folders always exist.
	const unknownFolder =
		!labelId &&
		!!folder &&
		foldersLoaded &&
		!(SYSTEM_FOLDER_IDS as readonly string[]).includes(folder) &&
		!folders.some((f) => f.id === folder);

	const empty = unknownFolder ? (
		<ListEmpty icon={<FolderX />} title="This folder doesn't exist" description="It may have been deleted, or the link is wrong.">
			<Button variant="outline" render={<Link to={folderPath(mailboxId, Folders.INBOX)} />} nativeButton={false}>
				Back to Inbox
			</Button>
		</ListEmpty>
	) : labelId ? (
		label || labelsLoading ? (
			<ListEmpty
				icon={<Tag />}
				title="No conversations with this label"
				description='Select conversations in any folder and use "Label as" (or press l) to add it.'
			/>
		) : (
			<ListEmpty icon={<Tag />} title="This label doesn't exist" description="It may have been renamed or deleted." />
		)
	) : (
		<FolderEmpty folder={folder || Folders.INBOX} address={address} />
	);

	return (
		<>
			<MailList
				mailboxId={mailboxId}
				title={title}
				emails={data?.emails ?? NO_EMAILS}
				total={data?.totalCount ?? 0}
				page={page}
				pageSize={PAGE_SIZE}
				onPageChange={setPage}
				isLoading={isLoading}
				error={error}
				isFetching={isFetching}
				onRefresh={refresh}
				empty={empty}
				folder={labelId ? undefined : folder || Folders.INBOX}
				labelId={labelId}
				selfAddress={address}
				hidden={!!emailId}
			/>
			{emailId && <EmailPanel emailId={emailId} />}
		</>
	);
}
