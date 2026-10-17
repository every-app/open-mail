/**
 * The inbox's MCP tools, as a `defineTools()` catalog the Every App gateway
 * serves.
 *
 * The app never speaks MCP. The gateway snapshots this catalog at deploy and
 * serves it on its own `/mcp` (one connector for every app, names prefixed
 * `agentic-inbox_`) and on the app's host `/mcp`. It signs the caller in
 * (OAuth or a personal access token), applies the connection's read-only or
 * read-write choice, hides `destructive` tools until approvals exist, and
 * calls a tool here over the internal tools contract with an identity minted
 * for that one call (`chan: "mcp"`), which everyApp() verifies before any
 * handler runs. Tool calls get 30 seconds.
 *
 * The tools are upstream's thirteen (the deleted `EmailMCP` server), over the
 * same lib/tools.ts functions the chat agent uses, which stay as upstream
 * wrote them. Each call runs with the caller's identity: withGateway(env,
 * request) attributes its model calls (the draft verifier) and its sends to
 * the person behind the MCP client.
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
	toolListMailboxes,
	toolMarkEmailRead,
	toolMoveEmail,
	toolSearchEmails,
	toolSendEmail,
	toolSendReply,
	toolUpdateDraft,
} from "../lib/tools";
import type { Env } from "../types";
import { withGateway } from "./gateway";
import { requireOrganization } from "./identity";

/** Guidance for the model across the tools (the gateway allows 2 KB; kept under 1 KB). */
export const INSTRUCTIONS =
	"Mailbox ids are email addresses: call list_mailboxes first and pass one as mailboxId. " +
	"Folders are inbox, sent, draft, archive and trash. " +
	"draft_reply, create_draft and update_draft only save drafts, which a person reviews and sends from the inbox. " +
	"send_reply and send_email send immediately, from the mailbox's own address: call them only after the person has confirmed the recipient and the text. " +
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
					`[agentic-inbox] tool call: ${model} skipped, the text is too long to check within a tool call's time (${asked.length} characters)`,
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
 * The mailbox a tool acts on, as the REST routes find it (`requireMailbox`):
 * one whose settings are in the bucket. On an organization's own copy every
 * mailbox is the organization's. Ids are stored lowercase.
 */
export async function requireToolMailbox(env: Pick<Env, "BUCKET">, id: string): Promise<string> {
	const mailbox = id.trim().toLowerCase();
	if (!mailbox || !(await env.BUCKET.head(`mailboxes/${mailbox}.json`))) {
		throw new ToolError(`Mailbox "${id}" not found. Call list_mailboxes for the mailboxes you can use.`);
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
			description: "List the organization's mailboxes. A mailbox's id is its email address.",
			risk: "read",
			input: plainSchema(z.object({})),
			handler: async (_input, context) => toolListMailboxes(await toolEnv(context)),
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
				return toolListEmails(env, await requireToolMailbox(env, mailboxId), { folder, limit, page });
			},
		},

		get_email: {
			title: "Read an email",
			description: "Get a single email with its full body content. Use this to read the actual content of an email.",
			risk: "read",
			input: plainSchema(z.object({ mailboxId, emailId: emailId.describe("The email ID to retrieve") })),
			handler: async ({ mailboxId, emailId }, context) => {
				const env = await toolEnv(context);
				return unwrap(await toolGetEmail(env, await requireToolMailbox(env, mailboxId), emailId));
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
				return toolGetThread(env, await requireToolMailbox(env, mailboxId), threadId);
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
				return toolSearchEmails(env, await requireToolMailbox(env, mailboxId), { query, folder });
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
					await toolDraftReply(env, await requireToolMailbox(env, mailboxId), {
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
					await toolDraftEmail(env, await requireToolMailbox(env, mailboxId), {
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
					await toolUpdateDraft(env, await requireToolMailbox(env, mailboxId), { draftId, to, subject, bodyHtml }),
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
				return unwrap(await toolDeleteEmail(env, await requireToolMailbox(env, mailboxId), emailId));
			},
		},

		send_reply: {
			title: "Send a reply",
			description:
				"Send a reply to an email immediately, from the mailbox's own address, quoting the original and threaded with it. Only call after drafting and getting the person's confirmation.",
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
					await toolSendReply(env, await requireToolMailbox(env, mailboxId), { originalEmailId, to, subject, bodyHtml }),
				);
			},
		},

		send_email: {
			title: "Send an email",
			description:
				"Send a new email (not a reply) immediately, from the mailbox's own address. Only call after getting the person's confirmation.",
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
				return unwrap(await toolSendEmail(env, await requireToolMailbox(env, mailboxId), { to, subject, bodyHtml }));
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
				return toolMarkEmailRead(env, await requireToolMailbox(env, mailboxId), emailId, read);
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
				return unwrap(await toolMoveEmail(env, await requireToolMailbox(env, mailboxId), emailId, folderId));
			},
		},
	},
	{ instructions: INSTRUCTIONS },
);
