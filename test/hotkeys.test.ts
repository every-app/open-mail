import { describe, expect, it } from "vitest";
import {
	isEditableTarget,
	isOverlayOpen,
	keyName,
	OVERLAY_SELECTOR,
	resolveHotkey,
	SEQUENCE_TIMEOUT_MS,
	type HotkeyKeyEvent,
} from "~/lib/hotkeys";
import { mailPaths } from "~/lib/mail-paths";

const press = (key: string, mods: Partial<HotkeyKeyEvent> = {}): HotkeyKeyEvent => ({
	key,
	shiftKey: false,
	metaKey: false,
	ctrlKey: false,
	altKey: false,
	...mods,
});

describe("keyName", () => {
	it("names letters lowercase, Shift+letter as shift+x", () => {
		expect(keyName(press("c"))).toBe("c");
		expect(keyName(press("I", { shiftKey: true }))).toBe("shift+i");
		expect(keyName(press("U", { shiftKey: true }))).toBe("shift+u");
	});

	it("names symbols as typed, Shift implied", () => {
		expect(keyName(press("#", { shiftKey: true }))).toBe("#");
		expect(keyName(press("!", { shiftKey: true }))).toBe("!");
		expect(keyName(press("?", { shiftKey: true }))).toBe("?");
		expect(keyName(press("/"))).toBe("/");
	});

	it("names named keys lowercase", () => {
		expect(keyName(press("Enter"))).toBe("enter");
		expect(keyName(press("Escape"))).toBe("escape");
	});

	it("ignores presses with Meta, Ctrl or Alt held, and bare Shift", () => {
		expect(keyName(press("c", { metaKey: true }))).toBeNull();
		expect(keyName(press("c", { ctrlKey: true }))).toBeNull();
		expect(keyName(press("c", { altKey: true }))).toBeNull();
		expect(keyName(press("Shift", { shiftKey: true }))).toBeNull();
	});
});

describe("isEditableTarget", () => {
	it("is true for inputs, textareas, selects and contenteditable", () => {
		expect(isEditableTarget({ tagName: "INPUT" })).toBe(true);
		expect(isEditableTarget({ tagName: "textarea" })).toBe(true);
		expect(isEditableTarget({ tagName: "SELECT" })).toBe(true);
		expect(isEditableTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
		expect(isEditableTarget({ tagName: "P", closest: () => ({}) })).toBe(true);
	});

	it("is false elsewhere", () => {
		expect(isEditableTarget({ tagName: "BODY", closest: () => null })).toBe(false);
		expect(isEditableTarget({ tagName: "BUTTON" })).toBe(false);
		expect(isEditableTarget(null)).toBe(false);
	});
});

describe("isOverlayOpen", () => {
	const root = (...els: { hidden?: boolean; closest?: (s: string) => unknown }[]) => ({
		querySelectorAll: (selector: string) => {
			expect(selector).toBe(OVERLAY_SELECTOR);
			return els;
		},
	});

	it("is true while a modal dialog, alert dialog or menu is showing", () => {
		expect(isOverlayOpen(root({ closest: () => null }))).toBe(true);
		expect(isOverlayOpen(root({}))).toBe(true);
	});

	it("is false with none, or only hidden or inert ones", () => {
		expect(isOverlayOpen(root())).toBe(false);
		expect(isOverlayOpen(root({ hidden: true }))).toBe(false);
		expect(isOverlayOpen(root({ closest: () => ({}) }))).toBe(false);
		expect(isOverlayOpen(null)).toBe(false);
	});

	it("names modal dialogs (Base UI's by data-slot) only, so the docked compose window doesn't count", () => {
		expect(OVERLAY_SELECTOR).toContain('[role="dialog"][aria-modal="true"]');
		expect(OVERLAY_SELECTOR).toContain('[data-slot="dialog-content"]');
		expect(OVERLAY_SELECTOR).toContain('[data-slot="sheet-content"]');
		expect(OVERLAY_SELECTOR).not.toContain('[role="dialog"],');
		expect(OVERLAY_SELECTOR).toContain('[role="alertdialog"]');
		expect(OVERLAY_SELECTOR).toContain('[role="menu"]');
	});
});

describe("resolveHotkey", () => {
	const bound = new Set(["c", "j", "g i", "g s", "shift+i", "#", "?"]);

	it("matches single keys", () => {
		expect(resolveHotkey(bound, "c", null, 0)).toEqual({ match: "c", pending: null });
		expect(resolveHotkey(bound, "#", null, 0)).toEqual({ match: "#", pending: null });
		expect(resolveHotkey(bound, "x", null, 0)).toEqual({ match: null, pending: null });
	});

	it("starts a sequence on its first key and completes it within the window", () => {
		const first = resolveHotkey(bound, "g", null, 1000);
		expect(first).toEqual({ match: null, pending: { key: "g", at: 1000 } });
		expect(resolveHotkey(bound, "i", first.pending, 1500)).toEqual({ match: "g i", pending: null });
	});

	it("drops a sequence after the window", () => {
		const first = resolveHotkey(bound, "g", null, 0);
		expect(resolveHotkey(bound, "i", first.pending, SEQUENCE_TIMEOUT_MS + 1)).toEqual({
			match: null,
			pending: null,
		});
	});

	it("runs a single key that doesn't complete the sequence", () => {
		const first = resolveHotkey(bound, "g", null, 0);
		expect(resolveHotkey(bound, "j", first.pending, 100)).toEqual({ match: "j", pending: null });
	});
});

describe("mailPaths", () => {
	it("builds folder, label and search paths, keeping the query string", () => {
		const folder = mailPaths("dev@example.com", { kind: "folder", folder: "inbox" }, "?page=2");
		expect(folder.listPath).toBe("/mailbox/dev@example.com/emails/inbox?page=2");
		expect(folder.conversationPath("abc")).toBe("/mailbox/dev@example.com/emails/inbox/abc?page=2");

		const label = mailPaths("m", { kind: "label", labelId: "l1" });
		expect(label.conversationPath("e1")).toBe("/mailbox/m/labels/l1/e1");

		const search = mailPaths("m", { kind: "search" }, "?q=is%3Astarred");
		expect(search.listPath).toBe("/mailbox/m/search?q=is%3Astarred");
		expect(search.conversationPath("e1")).toBe("/mailbox/m/search/e1?q=is%3Astarred");
	});

	it("goes to the Inbox from other pages", () => {
		const other = mailPaths("m", { kind: "other" }, "?x=1");
		expect(other.listPath).toBe("/mailbox/m/emails/inbox");
		expect(other.conversationPath("e1")).toBe("/mailbox/m/emails/inbox/e1");
	});
});
