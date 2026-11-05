// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface SignatureSettings {
	enabled: boolean;
	text: string;
	html?: string;
}

export interface MailboxSettings {
	fromName?: string;
	forwarding?: { enabled: boolean; email: string };
	signature?: SignatureSettings;
	autoReply?: { enabled: boolean; subject: string; message: string };
	agentSystemPrompt?: string;
	/** The agent drafts a reply to each new email on its own; off unless true (workers/everyapp/mailbox-settings.ts). */
	autoDraft?: boolean;
}

export interface Mailbox {
	id: string;
	email: string;
	name: string;
	settings?: MailboxSettings;
}

/** A label's colors: the eight tag-chip tones (workers/everyapp/mailbox.ts). */
export type LabelColor =
	| "slate"
	| "rose"
	| "amber"
	| "lime"
	| "emerald"
	| "sky"
	| "violet"
	| "fuchsia";

/** A Gmail-style label; names may nest with `/` (`Work/Reports`). */
export interface Label {
	id: string;
	name: string;
	color: LabelColor;
}

/** `GET …/labels`: a label with its conversations that have unread mail. */
export interface LabelWithCount extends Label {
	unreadCount: number;
}

export interface Email {
	id: string;
	thread_id?: string | null;
	folder_id?: string | null;
	subject: string;
	sender: string;
	recipient: string;
	cc?: string;
	bcc?: string;
	date: string;
	read: boolean;
	starred: boolean;
	body?: string | null;
	in_reply_to?: string | null;
	email_references?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
	attachments?: Attachment[];
	snippet?: string | null;
	// Thread aggregate fields (only present in threaded list view)
	thread_count?: number;
	thread_unread_count?: number;
	participants?: string;
	needs_reply?: boolean;
	has_draft?: boolean;
	/** The conversation's labels (list rows, search results, single email and thread reads). */
	labels?: Label[];
}

export interface Attachment {
	id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string;
	disposition?: string;
}

export interface Folder {
	id: string;
	name: string;
	unreadCount: number;
}
