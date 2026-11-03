/**
 * "Open in Gmail" for a draft (or a thread) in a Gmail mailbox: asks for its
 * Gmail link (`GET …/emails/:emailId/gmail-link`) and opens it in a new tab.
 * For finishing a draft in Gmail itself (docs/GMAIL.md).
 */
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import gmailApi from "~/services/gmail-api";

const NOT_IN_GMAIL_YET = "This draft isn't in Gmail yet. Try again in a few seconds.";

/**
 * Opens what `getUrl` resolves to in a new tab. The tab opens first, during
 * the click, so a popup blocker lets it through; it closes again if there is
 * no link. Throws what `getUrl` throws.
 */
export async function openInNewTab(getUrl: () => Promise<string | undefined>): Promise<void> {
	const tab = window.open("about:blank", "_blank");
	try {
		const url = await getUrl();
		if (!url) throw new Error(NOT_IN_GMAIL_YET);
		if (tab) {
			tab.opener = null;
			tab.location.href = url;
		} else {
			window.open(url, "_blank", "noopener");
		}
	} catch (err) {
		tab?.close();
		throw err;
	}
}

/** Opens a message's Gmail link; the toast says why when there is none. */
export function useOpenInGmail(mailboxId: string | undefined) {
	const [opening, setOpening] = useState(false);
	const open = async (getEmailId: () => Promise<string | undefined> | string | undefined) => {
		if (!mailboxId || opening) return;
		setOpening(true);
		try {
			await openInNewTab(async () => {
				const emailId = await getEmailId();
				if (!emailId) return undefined;
				return (await gmailApi.getGmailLink(mailboxId, emailId)).url;
			});
		} catch (err) {
			const status = (err as { status?: number }).status;
			toast.error(
				status === 404 || status === 409
					? NOT_IN_GMAIL_YET
					: (err instanceof Error && err.message) || NOT_IN_GMAIL_YET,
			);
		} finally {
			setOpening(false);
		}
	};
	return { open, opening };
}

export default function OpenInGmailButton({
	mailboxId,
	emailId,
	variant = "outline",
}: {
	mailboxId: string | undefined;
	emailId: string;
	variant?: "default" | "outline" | "ghost";
}) {
	const { open, opening } = useOpenInGmail(mailboxId);
	return (
		<Button type="button" variant={variant} size="sm" pending={opening} onClick={() => open(() => emailId)}>
			{!opening && <ExternalLink data-icon="inline-start" />}
			Open in Gmail
		</Button>
	);
}
