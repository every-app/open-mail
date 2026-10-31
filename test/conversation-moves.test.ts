// Which messages of a conversation move with it (app/hooks/useConversationActions.ts).
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import { movesWith } from "../app/hooks/useConversationActions";

const { INBOX, SENT, DRAFT, ARCHIVE, TRASH, SPAM } = Folders;

function moving(from: string | undefined, to: string) {
	return [INBOX, SENT, DRAFT, ARCHIVE, TRASH, SPAM].filter((f) => movesWith(f, from, to));
}

describe("movesWith", () => {
	it("moves only the folder's own messages from a folder", () => {
		expect(moving(INBOX, ARCHIVE)).toEqual([INBOX]);
		expect(moving(DRAFT, TRASH)).toEqual([DRAFT]);
	});

	it("deletes the whole conversation from Sent but its drafts, as Gmail does", () => {
		expect(moving(SENT, TRASH)).toEqual([INBOX, SENT, ARCHIVE]);
	});

	it("leaves the Sent copies when archiving or moving from Sent", () => {
		expect(moving(SENT, ARCHIVE)).toEqual([INBOX, ARCHIVE]);
	});

	it("moves everything but drafts, Sent copies, Trash and Spam from a label or search", () => {
		expect(moving(undefined, ARCHIVE)).toEqual([INBOX, ARCHIVE]);
	});
});
