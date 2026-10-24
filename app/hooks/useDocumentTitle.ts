// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useEffect } from "react";

const APP_NAME = "Agentic Inbox";

/**
 * The browser tab: "Page · Mailbox · Agentic Inbox", the shape the other
 * Every App apps title theirs with, so two open mailboxes read as two tabs.
 * Empty parts are left out. The Layout's <title> is what shows before this
 * runs.
 */
export function useDocumentTitle(...parts: (string | undefined)[]) {
	const title = [...parts.filter(Boolean), APP_NAME].join(" · ");
	useEffect(() => {
		document.title = title;
	}, [title]);
}
