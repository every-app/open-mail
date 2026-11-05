/**
 * The experimental Gmail integration's switch in the UI: `/api/v1/me`'s
 * `gmail` (EXPERIMENTAL_GMAIL on the Worker, workers/everyapp/gmail/flag.ts).
 * Every Gmail element mounts inside <GmailOnly>, so while it is off (or
 * `/api/v1/me` hasn't answered yet) nothing of Gmail renders or calls the
 * Gmail routes.
 */
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { meQuery } from "~/services/api";

export function useGmailEnabled(): boolean {
	const { data: me } = useQuery({ ...meQuery, retry: false });
	return me?.gmail === true;
}

export default function GmailOnly({ children }: { children: ReactNode }) {
	return useGmailEnabled() ? <>{children}</> : null;
}
