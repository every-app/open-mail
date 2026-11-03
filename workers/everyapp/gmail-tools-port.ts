/**
 * What the MCP tools (tools.ts) need from the Gmail side (docs/GMAIL.md,
 * lane A's GmailSync), and only that. Every call is for one Gmail mailbox
 * the caller owns (tools.ts checks), with the env withGateway() built for
 * the call and the call's request, whose person the Gmail calls go out for.
 *
 * Moves, archiving, read marks, drafts and labels need nothing here: they
 * go through `env.MAILBOX`, which withGateway() wraps for Gmail mailboxes.
 */
import type { Env } from "../types";
import { gatewayGmailOps } from "./gmail/ops";

export interface GmailOps {
	/** Flush the outbox and pull new mail now; the answer is the sync's summary. */
	sync(env: Env, mailboxId: string, request: Request): Promise<unknown>;
}

function notWired(): never {
	throw new Error("Gmail support is not wired yet");
}

/** Until the Gmail side is wired in: every call fails, which a tool reports as an internal error. */
export const notWiredGmailOps: GmailOps = {
	sync: async () => notWired(),
};

// The seam: the Gmail side, through each mailbox's GmailSync (./gmail/ops.ts).
export const gmailOps: GmailOps = gatewayGmailOps;
