// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Banner } from "@cloudflare/kumo";
import { WarningIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { queryKeys } from "~/queries/keys";
import api, { meQuery } from "~/services/api";

/**
 * Says before the person writes that the mail can't go out. `GET
 * /api/v1/config` reports `ready: false` while the gateway allows no sender
 * for this app (no domain: `everyapp email set --sender`) or has no sender of
 * its own (`EMAIL_FROM`). Owners and admins get the command, with this
 * mailbox's domain (the address in the route) filled in; members are told
 * whom to ask. Send stays enabled: the server decides, and its refusal lands
 * in the composer's error slot above this one.
 */
export default function SendingOffBanner() {
	const { data: config } = useQuery({
		queryKey: queryKeys.config,
		queryFn: () => api.getConfig(),
		staleTime: Infinity,
	});
	const { data: me } = useQuery(meQuery);
	const { mailboxId } = useParams<{ mailboxId: string }>();
	if (config?.ready !== false) return null;

	const isAdmin = me?.role === "owner" || me?.role === "admin";
	const noDomain = config.domains.length === 0;
	const domain = mailboxId?.split("@")[1] || "your-domain.com";
	const description = !isAdmin ? (
		"This mail can't go out until an owner or admin finishes email setup. You can still save it as a draft."
	) : noDomain ? (
		<>
			This mail can't go out until a mail domain is allowed. In the app's
			directory run{" "}
			<code className="font-mono [overflow-wrap:anywhere]">
				{`pnpm everyapp email set --sender '*@${domain}'`}
			</code>
			. You can still save it as a draft.
		</>
	) : (
		<>
			This mail can't go out until the gateway's email sender is set:{" "}
			<code className="font-mono [overflow-wrap:anywhere]">
				pnpm everyapp secret set EMAIL_FROM EMAIL_FROM_NAME
			</code>
			. You can still save it as a draft.
		</>
	);

	return (
		<Banner
			variant="alert"
			icon={<WarningIcon size={18} weight="fill" />}
			title="Sending is off"
			description={description}
		/>
	);
}
