/**
 * The inbox's MCP tools, as a `defineTools()` catalog the Every App gateway
 * serves.
 *
 * The app never speaks MCP. The gateway snapshots this catalog at deploy and
 * serves it on its own `/mcp` (one connector for every app, names prefixed
 * `openmail_`) and on the app's host `/mcp`. It signs the caller in
 * (OAuth or a personal access token), applies the connection's read-only or
 * read-write choice, hides `destructive` tools until approvals exist, and
 * calls a tool here over the internal tools contract with an identity minted
 * for that one call (`chan: "mcp"`), which everyApp() verifies before any
 * handler runs. Tool calls get 30 seconds.
 *
 * Thirteen tools are upstream's (the deleted `EmailMCP` server), over the
 * same lib/tools.ts functions the chat agent uses, which stay as upstream
 * wrote them; three are the port's own labels (list_labels, create_label and
 * label_conversation, over the labels in workers/everyapp/mailbox.ts, which
 * on a Gmail mailbox are Gmail's labels too: withGateway()'s MAILBOX carries
 * the changes to Gmail), and two are the port's for Gmail mailboxes
 * (archive, sync; docs/GMAIL.md). Each call runs with the caller's identity:
 * withGateway(env, request) attributes its model calls (the draft verifier)
 * and its sends to the person behind the MCP client, and a call reaches only
 * the mailboxes the caller may use (their own and the shared ones). The send
 * tools never send from a Gmail mailbox: a person sends Gmail mail with
 * OpenMail's own Send button.
 *
 * Schemas are zod's, from `zod/v4` (inside the zod 3.25 the app pins for
 * @cloudflare/kumo), handed to the SDK as `{ jsonSchema, validate }`: that
 * zod's Standard Schema has no JSON Schema converter, so the SDK can't derive
 * the JSON Schema itself. Upgrade to zod >= 4.2 and the schemas can go to
 * defineTools() as they are.
 */
import {
	ToolError,
	defineTools,
	type PlainToolSchema,
	type ToolContext,
} from "@every-app/sdk/server";
import { z } from "zod/v4";
import { FOLDER_TOOL_DESCRIPTION, Folders, MOVE_FOLDER_TOOL_DESCRIPTION } from "../../shared/folders";
import {
	toolDeleteEmail,
	toolDraftEmail,
	toolDraftReply,
	toolGetEmail,
	toolGetThread,
	toolListEmails,
	toolMarkEmailRead,
	toolMoveEmail,
	toolSearchEmails,
	toolSendEmail,
	toolSendReply,
	toolUpdateDraft,
} from "../lib/tools";
import type { Env } from "../types";
import { withGateway } from "./gateway";
import { gmailOps } from "./gmail-tools-port";
import { requireOrganization } from "./identity";
import {
	type PortMailboxSettings,
	asSettings,
	canUseMailbox,
	listUsableMailboxes,
	readMailboxSettings,
} from "./mailbox-settings";
import { LABEL_COLORS, LABEL_NAME_MAX, type Label, labeledMailbox } from "./label-model";

/** Guidance for the model across the tools (the gateway allows 2 KB; kept under 1 KB). */
export const INSTRUCTIONS =
	"Mailbox ids are email addresses: call list_mailboxes first and pass one as mailboxId. " +
	"Folders are inbox, sent, draft, archive and trash. " +
	"draft_reply, create_draft and update_draft only save drafts, which a person reviews and sends from the inbox. " +
	"send_reply and send_email send immediately, from the mailbox's own address, except from a Gmail mailbox (they refuse: save a draft instead); call them only after the person has confirmed the recipient and the text. " +
	"Labels tag conversations (several each, names may nest with /); folders say where a message is. On a Gmail mailbox they are its Gmail labels. " +
	"sync_mailbox works on Gmail mailboxes. " +
	"Bodies are HTML. Every call acts as the person who connected this client.";

/**
 * A zod object schema as the SDK's `{ jsonSchema, validate }`. The JSON
 * Schema describes what a client sends (zod's input side: a field with a
 * default is optional); `validate` is zod's own Standard Schema check, which
 * also fills the defaults in.
 */
export function plainSchema<T extends z.ZodObject>(schema: T): PlainToolSchema<z.output<T>> {
	return {
		jsonSchema: z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>,
		validate: (value) => schema["~standard"].validate(value),
	};
}

const mailboxId = z.string().min(1).describe("The mailbox's email address (its id, from list_mailboxes)");
const emailId = z.string().min(1).describe("The email's id");
const labelName = z.string().trim().min(1).max(LABEL_NAME_MAX);

/**
 * Label names or ids to label ids. Unknown names are created when `create`
 * is set (with their default color), else they are the ToolError.
 */
async function resolveLabels(
	stub: ReturnType<typeof labeledMailbox>,
	refs: string[],
	create: boolean,
): Promise<Label[]> {
	const labels: Label[] = [];
	const missing: string[] = [];
	for (const ref of refs) {
		const found = await stub.findLabel(ref);
		if (found) {
			labels.push(found);
			continue;
		}
		if (!create) {
			missing.push(ref);
			continue;
		}
		const created = await stub.createLabel(ref);
		if (created.ok) labels.push(created.label);
		else if (created.error === "invalid_name") throw new ToolError(`"${ref}" is not a valid label name (1 to ${LABEL_NAME_MAX} characters).`);
		else {
			const raced = await stub.findLabel(ref);
			if (!raced) throw new ToolError(`Couldn't create the label "${ref}".`);
			labels.push(raced);
		}
	}
	if (missing.length > 0) {
		throw new ToolError(
			`No label named ${missing.map((m) => `"${m}"`).join(", ")}. Call list_labels for the mailbox's labels, or set createMissing to create them.`,
		);
	}
	return labels;
}

/**
 * The longest answer a model call inside a tool may give. lib/ai.ts asks the
 * draft verifier for up to 4,096 tokens; a call has 30 seconds for the
 * verifier and the send together.
 */
export const TOOL_MODEL_MAX_TOKENS = 1024;

/**
 * The verifier answers with the whole draft, so a draft longer than the cap
 * would come back cut short, and lib/ai.ts would keep the cut version (it only
 * refuses answers under half the length). Such a draft skips the verifier and
 * stays as written, which is what lib/ai.ts does with an empty answer. The
 * estimate counts a token per 3 ASCII characters and 2 per other character,
 * over-counting both, and leaves headroom under the cap.
 */
const MAX_VERIFIED_TOKENS = 900;

export function estimatedTokens(text: string): number {
	let ascii = 0;
	let other = 0;
	for (const char of text) {
		if (char.charCodeAt(0) < 0x80) ascii++;
		else other++;
	}
	return Math.ceil(ascii / 3) + other * 2;
}

interface RunInputs {
	messages?: { role?: string; content?: unknown }[];
	max_tokens?: number;
	[key: string]: unknown;
}

/** `env.AI` for a tool call: every model call capped at TOOL_MODEL_MAX_TOKENS. */
export function withinCallBudget(ai: Ai): Ai {
	return {
		async run(model: string, inputs: RunInputs) {
			const asked = inputs.messages?.filter((m) => m.role === "user").map((m) => String(m.content ?? "")).join("\n") ?? "";
			if (estimatedTokens(asked) > MAX_VERIFIED_TOKENS) {
				console.warn(
					`[openmail] tool call: ${model} skipped, the text is too long to check within a tool call's time (${asked.length} characters)`,
				);
				return { response: "" };
			}
			return ai.run(model as never, {
				...inputs,
				max_tokens: Math.min(inputs.max_tokens ?? TOOL_MODEL_MAX_TOKENS, TOOL_MODEL_MAX_TOKENS),
			} as never);
		},
	} as unknown as Ai;
}

/**
 * The env a tool runs with, for this call's caller. everyApp() answers the
 * tools contract before the entry's handler, so the organization pin the
 * entry applies to every request (identity.ts) is applied here too. AI and
 * EMAIL are the gateway's, attributed to the caller.
 */
export async function toolEnv({ user, env, request }: Pick<ToolContext, "user" | "env" | "request">): Promise<Env> {
	const refused = requireOrganization(env, user);
	if (refused) {
		const body = (await refused.json().catch(() => ({}))) as { message?: string };
		throw new ToolError(`Not allowed: ${body.message ?? "this app belongs to another organization"}.`);
	}
	const brokered = withGateway(env, request);
	return { ...brokered, AI: withinCallBudget(brokered.AI) };
}

/**
 * The mailbox a tool acts on, as the REST routes find it (`requireMailbox`,
 * `requireMailboxAccess`): one whose settings are in the bucket and that the
 * caller may use. Someone else's mailbox reads as a missing one. Ids are
 * stored lowercase.
 */
export async function findToolMailbox(
	env: Pick<Env, "BUCKET">,
	id: string,
	user: Pick<ToolContext["user"], "id"> | null | undefined,
): Promise<{ mailbox: string; settings: PortMailboxSettings }> {
	const mailbox = id.trim().toLowerCase();
	const stored = mailbox ? await readMailboxSettings(env.BUCKET, mailbox) : null;
	const settings = asSettings(stored);
	if (stored === null || !user || !canUseMailbox(settings, user.id)) {
		throw new ToolError(`Mailbox "${id}" not found. Call list_mailboxes for the mailboxes you can use.`);
	}
	return { mailbox, settings };
}

/** findToolMailbox(), for the tools that need only the id. */
export async function requireToolMailbox(
	env: Pick<Env, "BUCKET">,
	id: string,
	user: Pick<ToolContext["user"], "id"> | null | undefined,
): Promise<string> {
	return (await findToolMailbox(env, id, user)).mailbox;
}

export const GMAIL_SEND_REFUSED =
	"AI clients can't send from a Gmail mailbox. Save a draft instead (draft_reply or create_draft): the person reviews it and sends it from OpenMail or Gmail.";

/** The mailbox a send tool sends from: one the caller may use, never a Gmail one. */
async function requireSendingMailbox(env: Pick<Env, "BUCKET">, id: string, user: ToolContext["user"]): Promise<string> {
	const { mailbox, settings } = await findToolMailbox(env, id, user);
	if (settings.provider === "gmail") throw new ToolError(GMAIL_SEND_REFUSED);
	return mailbox;
}

/** The Gmail mailbox a Gmail-only tool acts on. */
async function requireGmailMailbox(env: Pick<Env, "BUCKET">, id: string, user: ToolContext["user"], tool: string): Promise<string> {
	const { mailbox, settings } = await findToolMailbox(env, id, user);
	if (settings.provider !== "gmail") {
		throw new ToolError(`${tool}: this tool works on Gmail mailboxes, and "${mailbox}" is an OpenMail mailbox.`);
	}
	return mailbox;
}

/** A lib/tools.ts result, or its `error` as the model-readable ToolError. */
function unwrap<T extends object>(result: T | { error: string }): T {
	if ("error" in result && typeof result.error === "string") throw new ToolError(result.error);
	return result as T;
}

export const tools = defineTools(
	{
		list_mailboxes: {
			title: "List mailboxes",
			description:
				"List the mailboxes you can use: your own and the organization's shared ones. A mailbox's id is its email address.",
			risk: "read",
			input: plainSchema(z.object({})),
			handler: async (_input, context) => listUsableMailboxes((await toolEnv(context)).BUCKET, context.user.id),
		},

		list_emails: {
			title: "List emails",
			description:
				"List emails in a mailbox folder, newest first. Returns email metadata (id, subject, sender, recipient, date, read/starred status, thread_id), not bodies: call get_email for one email's body.",
			risk: "read",
			input: plainSchema(
				z.object({
					mailboxId,
					folder: z.string().default(Folders.INBOX).describe(FOLDER_TOOL_DESCRIPTION),
					limit: z.number().int().min(1).max(100).default(20).describe("Maximum number of emails to return (at most 100)"),
					page: z.number().int().min(1).default(1).describe("Page number for pagination, from 1"),
				}),
			),
			handler: async ({ mailboxId, folder, limit, page }, context) => {
				const env = await toolEnv(context);
				return toolListEmails(env, await requireToolMailbox(env, mailboxId, context.user), { folder, limit, page });
			},
		},

		get_email: {
			title: "Read an email",
			description: "Get a single email with its full body content. Use this to read the actual content of an email.",
			risk: "read",
			input: plainSchema(z.object({ mailboxId, emailId: emailId.describe("The email ID to retrieve") })),
			handler: async ({ mailboxId, emailId }, context) => {
				const env = await toolEnv(context);
				return unwrap(await toolGetEmail(env, await requireToolMailbox(env, mailboxId, context.user), emailId));
			},
		},

		get_thread: {
			title: "Read a thread",
			description: "Get all emails in a conversation thread, sorted chronologically.",
			risk: "read",
			input: plainSchema(
				z.object({ mailboxId, threadId: z.string().min(1).describe("The thread_id to retrieve all messages for") }),
			),
			handler: async ({ mailboxId, threadId }, context) => {
				const env = await toolEnv(context);
				return toolGetThread(env, await requireToolMailbox(env, mailboxId, context.user), threadId);
			},
		},

		search_emails: {
			title: "Search emails",
			description: "Search for emails matching a query across subject and body fields.",
			risk: "read",
			input: plainSchema(
				z.object({
					mailboxId,
					query: z.string().min(1).describe("Search query to match against subject and body"),
					folder: z.string().optional().describe("Optional folder to restrict the search to"),
				}),
			),
			handler: async ({ mailboxId, query, folder }, context) => {
				const env = await toolEnv(context);
				return toolSearchEmails(env, await requireToolMailbox(env, mailboxId, context.user), { query, folder });
			},
		},

		draft_reply: {
			title: "Draft a reply",
			description:
				"Draft a reply to an email and save it to the Drafts folder, quoting the original. Does NOT send: a person reviews the draft and sends it from the inbox.",
			risk: "write",
			input: plainSchema(
				z.object({
					mailboxId,
					originalEmailId: z.string().min(1).describe("The ID of the email being replied to"),
					to: z.email().describe("Recipient email address"),
					subject: z.string().describe("Subject line (usually 'Re: ...')"),
					bodyHtml: z.string().describe("The HTML body of the reply"),
				}),
			),
			handler: async ({ mailboxId, originalEmailId, to, subject, bodyHtml }, context) => {
				const env = await toolEnv(context);
				return unwrap(
					await toolDraftReply(env, await requireToolMailbox(env, mailboxId, context.user), {
						originalEmailId,
						to,
						subject,
						body: bodyHtml,
						isPlainText: false,
						runVerifyDraft: true,
					}),
				);
			},
		},

		create_draft: {
			title: "Create a draft",
			description: "Create a new draft email in the Drafts folder: a new email, or a reply when in_reply_to is set. Does NOT send.",
			risk: "write",
			input: plainSchema(
				z.object({
					mailboxId,
					to: z.string().optional().describe("Recipient email address (optional for early drafts)"),
					subject: z.string().describe("Subject line"),
					bodyHtml: z.string().describe("The HTML body of the draft"),
					in_reply_to: z.string().optional().describe("The ID of the email this draft is replying to (optional)"),
					thread_id: z.string().optional().describe("Thread ID to attach this draft to (optional)"),
				}),
			),
			handler: async ({ mailboxId, to, subject, bodyHtml, in_reply_to, thread_id }, context) => {
				const env = await toolEnv(context);
				const result = unwrap(
					await toolDraftEmail(env, await requireToolMailbox(env, mailboxId, context.user), {
						to: to || "",
						subject,
						body: bodyHtml,
						isPlainText: false,
						runVerifyDraft: true,
						in_reply_to,
						thread_id,
					}),
				);
				// Upstream's create_draft answer.
				return {
					status: "draft_created",
					draftId: result.draftId,
					threadId: result.threadId,
					message: "Draft created in Drafts folder.",
				};
			},
		},

		update_draft: {
			title: "Update a draft",
			description: "Update an existing draft email's recipient, subject or body. The draft gets a new id, which the answer names.",
			risk: "write",
			input: plainSchema(
				z.object({
					mailboxId,
					draftId: z.string().min(1).describe("The ID of the draft to update"),
					to: z.string().optional().describe("Updated recipient email address"),
					subject: z.string().optional().describe("Updated subject line"),
					bodyHtml: z.string().optional().describe("Updated HTML body"),
				}),
			),
			handler: async ({ mailboxId, draftId, to, subject, bodyHtml }, context) => {
				const env = await toolEnv(context);
				return unwrap(
					await toolUpdateDraft(env, await requireToolMailbox(env, mailboxId, context.user), { draftId, to, subject, bodyHtml }),
				);
			},
		},

		delete_email: {
			title: "Delete an email",
			description: "Permanently delete an email by ID.",
			// Hidden from AI clients until the gateway has approvals.
			risk: "destructive",
			input: plainSchema(z.object({ mailboxId, emailId: emailId.describe("The email ID to delete") })),
			handler: async ({ mailboxId, emailId }, context) => {
				const env = await toolEnv(context);
				return unwrap(await toolDeleteEmail(env, await requireToolMailbox(env, mailboxId, context.user), emailId));
			},
		},

		send_reply: {
			title: "Send a reply",
			description:
				"Send a reply to an email immediately, from the mailbox's own address, quoting the original and threaded with it. Refuses on a Gmail mailbox: draft_reply saves the reply for the person to send. Only call after drafting and getting the person's confirmation.",
			risk: "write",
			openWorld: true,
			input: plainSchema(
				z.object({
					mailboxId: mailboxId.describe("The mailbox email address to send from"),
					originalEmailId: z.string().min(1).describe("The ID of the email being replied to"),
					to: z.email().describe("Recipient email address"),
					subject: z.string().describe("Subject line"),
					bodyHtml: z.string().describe("The HTML body of the reply"),
				}),
			),
			handler: async ({ mailboxId, originalEmailId, to, subject, bodyHtml }, context) => {
				const env = await toolEnv(context);
				return unwrap(
					await toolSendReply(env, await requireSendingMailbox(env, mailboxId, context.user), { originalEmailId, to, subject, bodyHtml }),
				);
			},
		},

		send_email: {
			title: "Send an email",
			description:
				"Send a new email (not a reply) immediately, from the mailbox's own address. Refuses on a Gmail mailbox: create_draft saves the email for the person to send. Only call after getting the person's confirmation.",
			risk: "write",
			openWorld: true,
			input: plainSchema(
				z.object({
					mailboxId: mailboxId.describe("The mailbox email address to send from"),
					to: z.email().describe("Recipient email address"),
					subject: z.string().describe("Subject line"),
					bodyHtml: z.string().describe("The HTML body of the email"),
				}),
			),
			handler: async ({ mailboxId, to, subject, bodyHtml }, context) => {
				const env = await toolEnv(context);
				return unwrap(await toolSendEmail(env, await requireSendingMailbox(env, mailboxId, context.user), { to, subject, bodyHtml }));
			},
		},

		mark_email_read: {
			title: "Mark read or unread",
			description: "Mark an email as read or unread.",
			risk: "write",
			idempotent: true,
			input: plainSchema(
				z.object({ mailboxId, emailId, read: z.boolean().describe("true to mark as read, false for unread") }),
			),
			handler: async ({ mailboxId, emailId, read }, context) => {
				const env = await toolEnv(context);
				return toolMarkEmailRead(env, await requireToolMailbox(env, mailboxId, context.user), emailId, read);
			},
		},

		move_email: {
			title: "Move an email",
			description: "Move an email to a different folder (inbox, sent, draft, archive, trash).",
			risk: "write",
			idempotent: true,
			input: plainSchema(z.object({ mailboxId, emailId, folderId: z.string().min(1).describe(MOVE_FOLDER_TOOL_DESCRIPTION) })),
			handler: async ({ mailboxId, emailId, folderId }, context) => {
				const env = await toolEnv(context);
				return unwrap(await toolMoveEmail(env, await requireToolMailbox(env, mailboxId, context.user), emailId, folderId));
			},
		},

		archive_email: {
			title: "Archive an email",
			description: "Move an email out of the inbox into the archive. On a Gmail mailbox it leaves Gmail's inbox too.",
			risk: "write",
			idempotent: true,
			input: plainSchema(z.object({ mailboxId, emailId })),
			handler: async ({ mailboxId, emailId }, context) => {
				const env = await toolEnv(context);
				// A move, as move_email's: withGateway()'s MAILBOX carries it to Gmail.
				unwrap(await toolMoveEmail(env, await requireToolMailbox(env, mailboxId, context.user), emailId, Folders.ARCHIVE));
				return { status: "archived", emailId };
			},
		},

		sync_mailbox: {
			title: "Sync with Gmail",
			description:
				"Sync a Gmail mailbox now: send OpenMail's pending changes (drafts, labels, moves) to Gmail and pull new mail. This tool works on Gmail mailboxes.",
			risk: "write",
			input: plainSchema(z.object({ mailboxId })),
			handler: async ({ mailboxId }, context) => {
				const env = await toolEnv(context);
				const mailbox = await requireGmailMailbox(env, mailboxId, context.user, "sync_mailbox");
				return gmailOps.sync(env, mailbox, context.request);
			},
		},

		list_labels: {
			title: "List labels",
			description:
				"List a mailbox's labels (id, name, color) with how many labeled conversations have unread mail. Labels tag conversations; a name with / is nested (Work/Reports). On a Gmail mailbox these are its Gmail labels.",
			risk: "read",
			input: plainSchema(z.object({ mailboxId })),
			handler: async ({ mailboxId }, context) => {
				const env = await toolEnv(context);
				return labeledMailbox(env, await requireToolMailbox(env, mailboxId, context.user)).listLabels();
			},
		},

		create_label: {
			title: "Create a label",
			description:
				"Create a label in a mailbox. Names are unique regardless of case; use / to nest (Work/Reports). On a Gmail mailbox it is created in Gmail too.",
			risk: "write",
			input: plainSchema(
				z.object({
					mailboxId,
					name: labelName.describe(`The label's name, 1 to ${LABEL_NAME_MAX} characters`),
					color: z.enum(LABEL_COLORS).optional().describe("The label's color (picked from the name when omitted)"),
				}),
			),
			handler: async ({ mailboxId, name, color }, context) => {
				const env = await toolEnv(context);
				const result = await labeledMailbox(env, await requireToolMailbox(env, mailboxId, context.user)).createLabel(name, color);
				if (result.ok) return result.label;
				throw new ToolError(
					result.error === "duplicate" ? `A label named "${name}" already exists.` : `"${name}" is not a valid label name.`,
				);
			},
		},

		label_conversation: {
			title: "Label a conversation",
			description:
				"Add labels to and remove labels from a whole conversation (every message in it). Name labels by name or id; returns the conversation's labels. On a Gmail mailbox the change is made in Gmail too.",
			risk: "write",
			idempotent: true,
			input: plainSchema(
				z.object({
					mailboxId,
					threadId: z.string().min(1).describe("The conversation's thread_id, or the id of any email in it"),
					add: z.array(labelName).max(100).default([]).describe("Labels to add, by name or id"),
					remove: z.array(labelName).max(100).default([]).describe("Labels to remove, by name or id"),
					createMissing: z.boolean().default(false).describe("Create labels in `add` that don't exist yet"),
				}),
			),
			handler: async ({ mailboxId, threadId, add, remove, createMissing }, context) => {
				const env = await toolEnv(context);
				const stub = labeledMailbox(env, await requireToolMailbox(env, mailboxId, context.user));
				const notFound = `No conversation or email "${threadId}" in this mailbox.`;
				// Before createMissing makes labels for a conversation that isn't there.
				if (!(await stub.findConversation(threadId))) throw new ToolError(notFound);
				const removing = await resolveLabels(stub, remove, false);
				const adding = await resolveLabels(stub, add, createMissing);
				const result = await stub.labelThread(
					threadId,
					adding.map((l) => l.id),
					removing.map((l) => l.id),
				);
				if (result.ok) return { threadId: result.threadKey, labels: result.labels };
				throw new ToolError(
					result.error === "not_found"
						? notFound
						: `Unknown label: ${result.ids.join(", ")}.`,
				);
			},
		},
	},
	{ instructions: INSTRUCTIONS },
);
