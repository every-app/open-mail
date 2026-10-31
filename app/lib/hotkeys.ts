/**
 * Gmail-style keyboard shortcuts, the pure part (unit tested in
 * test/hotkeys.test.ts); the React side is app/hooks/useHotkeys.ts.
 *
 * A binding is a key name as `keyName()` produces it:
 *   - a single key: "c", "j", "enter", "escape"
 *   - Shift + a letter: "shift+i"
 *   - a symbol as typed (Shift implied): "#", "!", "/", "?"
 *   - a two-key sequence, space-separated: "g i" (second key within 1s)
 */

export const SEQUENCE_TIMEOUT_MS = 1000;

export interface HotkeyKeyEvent {
	key: string;
	shiftKey: boolean;
	metaKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
}

/** The binding name of a key press, or null for presses that never trigger (modifiers held, bare modifier keys). */
export function keyName(event: HotkeyKeyEvent): string | null {
	if (event.metaKey || event.ctrlKey || event.altKey) return null;
	const { key } = event;
	if (!key || key === "Shift" || key === "Dead" || key === "Unidentified") return null;
	if (key.length === 1) {
		if (/[a-z]/i.test(key)) {
			const letter = key.toLowerCase();
			return event.shiftKey ? `shift+${letter}` : letter;
		}
		return key === " " ? "space" : key;
	}
	return key.toLowerCase();
}

interface EditableLike {
	tagName?: string;
	isContentEditable?: boolean;
	closest?: (selector: string) => unknown;
}

/** Whether a key press comes from somewhere the person types: inputs, textareas, selects, the editor. */
export function isEditableTarget(target: unknown): boolean {
	if (!target || typeof target !== "object") return false;
	const el = target as EditableLike;
	const tag = el.tagName?.toUpperCase();
	if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
	if (el.isContentEditable) return true;
	if (typeof el.closest === "function") {
		return Boolean(el.closest('[contenteditable=""], [contenteditable="true"], [role="textbox"]'));
	}
	return false;
}

/**
 * What owns the keyboard while it's open: a modal dialog, an alert dialog, a
 * menu. Base UI's modal dialogs set no aria-modal (they make the rest of the
 * page inert instead), so the kit's dialog, sheet, alert dialog and menu
 * popups are named by their `data-slot` too.
 */
export const OVERLAY_SELECTOR = [
	'[role="dialog"][aria-modal="true"]',
	'[data-slot="dialog-content"]',
	'[data-slot="sheet-content"]',
	'[role="alertdialog"]',
	'[data-slot="alert-dialog-content"]',
	'[role="menu"]',
	'[data-slot="dropdown-menu-content"]',
].join(", ");

interface QueryRoot {
	querySelectorAll: (selector: string) => ArrayLike<{ hidden?: boolean; closest?: (selector: string) => unknown }>;
}

/**
 * Whether a modal dialog, alert dialog or menu is open: the page's shortcuts
 * stand down so a key goes to it (Escape, Enter, a menu's letters) and not to
 * the list or conversation behind it. A non-modal popup (the docked compose
 * window, a popover) doesn't count; a hidden or closing one neither.
 */
export function isOverlayOpen(root: QueryRoot | null | undefined): boolean {
	if (!root) return false;
	return Array.from(root.querySelectorAll(OVERLAY_SELECTOR)).some(
		// A popup closing (exit animation) carries data-closed.
		(el) => !el.hidden && !(typeof el.closest === "function" && el.closest("[hidden], [inert], [data-closed]")),
	);
}

export interface PendingSequence {
	key: string;
	at: number;
}

export interface HotkeyResolution {
	/** The binding to run, if any. */
	match: string | null;
	/** The sequence started by this press (or still open), else null. */
	pending: PendingSequence | null;
}

/**
 * Resolves one key press against the bound names. A press that completes a
 * started sequence wins; a press that starts a sequence ("g") waits for the
 * next key instead of running a binding of its own.
 */
export function resolveHotkey(
	bound: ReadonlySet<string>,
	key: string,
	pending: PendingSequence | null,
	now: number,
): HotkeyResolution {
	if (pending && now - pending.at <= SEQUENCE_TIMEOUT_MS) {
		const sequence = `${pending.key} ${key}`;
		if (bound.has(sequence)) return { match: sequence, pending: null };
	}
	for (const name of bound) {
		if (name.startsWith(`${key} `)) return { match: null, pending: { key, at: now } };
	}
	return { match: bound.has(key) ? key : null, pending: null };
}
