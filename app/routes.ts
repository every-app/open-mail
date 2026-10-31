// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	index,
	type RouteConfig,
	route,
} from "@react-router/dev/routes";

// The open conversation is in the URL (docs/UI.md): `:emailId?` on each list.
// Build these paths with useMailRoute() (app/hooks/useMailRoute.ts).
export default [
	index("routes/home.tsx"),
	route("mailbox/:mailboxId", "routes/mailbox.tsx", [
		index("routes/mailbox-index.tsx"),
		route("emails/:folder/:emailId?", "routes/email-list.tsx", { id: "folder-list" }),
		route("labels/:labelId/:emailId?", "routes/email-list.tsx", { id: "label-list" }),
		route("settings", "routes/settings.tsx"),
		route("search/:emailId?", "routes/search-results.tsx"),
	]),
	route("*", "routes/not-found.tsx"),
] satisfies RouteConfig;
