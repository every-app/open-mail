/**
 * The Gmail side of the MCP tools (`GmailOps` in ../gmail-tools-port.ts):
 * each call goes to the mailbox's GmailSync, for the person behind the
 * tool call's request, as the routes' calls do (./routes.ts).
 */
import { ToolError } from "@every-app/sdk/server";
import type { GmailOps } from "../gmail-tools-port";
import { forwardTarget, gmailSyncOf, type GmailErrorInfo } from "./target";

function refused(error: GmailErrorInfo): never {
	const hint = error.reconnect ? " Reconnect Google from OpenMail's home page, then try again." : "";
	throw new ToolError(`Gmail refused: ${error.message}.${hint}`);
}

export const gatewayGmailOps: GmailOps = {
	async sync(env, mailboxId, request) {
		const result = await gmailSyncOf(env, mailboxId).sync(mailboxId, forwardTarget(request));
		if (result.error) {
			const { code, message, reconnect } = result.error;
			refused({ code, message, reconnect, status: 0 });
		}
		return result;
	},
};
