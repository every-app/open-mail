/**
 * The experimental Gmail integration's switch: the `gmail` feature's
 * EXPERIMENTAL_GMAIL setting (everyapp.config.ts). Off unless it is
 * `true`; `everyapp configure openmail` sets it on an installation, and
 * `.dev.vars` in `everyapp dev`.
 *
 * Off, the Gmail routes answer 404, `sync_mailbox` refuses, GmailSync's
 * alarm stops, and `/api/v1/me` says `gmail: false`, so the UI shows
 * nothing of Gmail (no Connect Gmail card, settings, sync strip or draft
 * status). A Gmail mailbox made while it was on stays readable as a plain
 * mailbox; it doesn't sync until the switch is on again.
 */
export const GMAIL_FLAG = "EXPERIMENTAL_GMAIL";

/** Whether the Gmail integration is on for this env. */
export function gmailEnabled(env: object): boolean {
	const value = (env as Record<string, unknown>)[GMAIL_FLAG];
	if (value === true) return true;
	return typeof value === "string" && ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
}

/** The refusal while it is off, for tools and the alarm. */
export const GMAIL_DISABLED_MESSAGE =
	"The Gmail integration is experimental and off for this installation (EXPERIMENTAL_GMAIL isn't true).";
