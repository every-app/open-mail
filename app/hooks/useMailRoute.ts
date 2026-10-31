import { useCallback, useEffect, useMemo } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { useUIStore } from "~/hooks/useUIStore";
import { type MailView, mailPaths } from "~/lib/mail-paths";

export interface MailRoute {
	mailboxId: string | undefined;
	/** The folder in `/emails/:folder`, else undefined. */
	folder: string | undefined;
	/** The label in `/labels/:labelId`, else undefined. */
	labelId: string | undefined;
	/** The open conversation (`:emailId`), else undefined: the list is showing. */
	emailId: string | undefined;
	/** The current view's list (keeps `?q=` / `?page=`). Inbox from Settings and the like. */
	listPath: string;
	/** The URL of a conversation in the current view. */
	conversationPath: (emailId: string) => string;
	openConversation: (emailId: string) => void;
	backToList: () => void;
}

function useMailView(): MailView {
	const { folder, labelId } = useParams();
	const { pathname } = useLocation();
	return useMemo<MailView>(() => {
		if (folder) return { kind: "folder", folder };
		if (labelId) return { kind: "label", labelId };
		if (/^\/mailbox\/[^/]+\/search(\/|$)/.test(pathname)) return { kind: "search" };
		return { kind: "other" };
	}, [folder, labelId, pathname]);
}

/** Where the person is in the mail app, and how to build its URLs. Use it instead of hand-built paths. */
export function useMailRoute(): MailRoute {
	const { mailboxId, folder, labelId, emailId } = useParams();
	const { search } = useLocation();
	const navigate = useNavigate();
	const view = useMailView();

	const paths = useMemo(
		() => (mailboxId ? mailPaths(mailboxId, view, search) : null),
		[mailboxId, view, search],
	);
	const listPath = paths?.listPath ?? "/";
	const conversationPath = useCallback(
		(id: string) => (paths ? paths.conversationPath(id) : "/"),
		[paths],
	);
	const openConversation = useCallback(
		(id: string) => navigate(conversationPath(id)),
		[navigate, conversationPath],
	);
	const backToList = useCallback(() => navigate(listPath), [navigate, listPath]);

	return {
		mailboxId,
		folder,
		labelId,
		emailId,
		listPath,
		conversationPath,
		openConversation,
		backToList,
	};
}

/**
 * Mounted once by the mailbox shell: keeps `useUIStore().selectedEmailId`
 * equal to the URL's `:emailId` and makes the store's legacy `selectEmail` /
 * `closePanel` navigate, so components not yet moved to `useMailRoute` keep
 * working.
 */
export function MailRouteSync() {
	const { emailId, openConversation, backToList } = useMailRoute();
	const syncSelectedEmailId = useUIStore((s) => s._syncSelectedEmailId);
	const setMailNavigator = useUIStore((s) => s._setMailNavigator);

	useEffect(() => {
		syncSelectedEmailId(emailId ?? null);
	}, [emailId, syncSelectedEmailId]);

	useEffect(() => {
		setMailNavigator((id) => (id ? openConversation(id) : backToList()));
		return () => setMailNavigator(null);
	}, [openConversation, backToList, setMailNavigator]);

	return null;
}
