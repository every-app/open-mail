/**
 * The labels' model, without the Durable Object: names, colors, the shapes
 * the label methods return, and the typed stub. Node code (the MCP catalog,
 * its unit tests) imports this, never workers/everyapp/mailbox.ts, which
 * pulls in `cloudflare:workers`.
 */
import type { Env } from "../types";
import type { MailboxDO } from "./mailbox";

export const LABEL_COLORS = ["slate", "rose", "amber", "lime", "emerald", "sky", "violet", "fuchsia"] as const;
export type LabelColor = (typeof LABEL_COLORS)[number];

export const LABEL_NAME_MAX = 100;

export interface Label {
	id: string;
	name: string;
	color: LabelColor;
}

export interface LabelWithCounts extends Label {
	/** Conversations with this label and an unread message outside Trash and Spam. */
	unreadCount: number;
}

export type LabelResult =
	| { ok: true; label: Label }
	| { ok: false; error: "invalid_name" | "duplicate" | "not_found" };

export type LabelThreadResult =
	| { ok: true; threadKey: string; labels: Label[] }
	| { ok: false; error: "not_found" }
	| { ok: false; error: "unknown_labels"; ids: string[] };

/** A label name as stored: trimmed, 1 to 100 characters, or null. `/` nests. */
export function normalizeLabelName(name: unknown): string | null {
	if (typeof name !== "string") return null;
	const trimmed = name.trim().replace(/\s+/g, " ");
	if (!trimmed || trimmed.length > LABEL_NAME_MAX) return null;
	return trimmed;
}

export function isLabelColor(color: unknown): color is LabelColor {
	return typeof color === "string" && (LABEL_COLORS as readonly string[]).includes(color);
}

/** The default color for a name: the same name always gets the same one. */
export function colorForName(name: string): LabelColor {
	let hash = 5381;
	for (const char of name.toLowerCase()) hash = ((hash * 33) ^ char.charCodeAt(0)) >>> 0;
	return LABEL_COLORS[hash % LABEL_COLORS.length]!;
}

/** The conversation key of a row: its thread, or the email itself. */
export function conversationKey(row: { id: string; thread_id?: string | null }): string {
	return row.thread_id || row.id;
}

/**
 * A mailbox's stub with the label methods typed. env.MAILBOX is typed with
 * upstream's class (see workers/app.ts), so the port's code reaches the
 * subclass's methods through this.
 */
export function labeledMailbox(env: Pick<Env, "MAILBOX">, mailboxId: string): DurableObjectStub<MailboxDO> {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId)) as unknown as DurableObjectStub<MailboxDO>;
}
