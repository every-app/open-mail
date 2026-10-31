import { useEffect, useRef } from "react";
import {
	isEditableTarget,
	isOverlayOpen,
	keyName,
	type PendingSequence,
	resolveHotkey,
} from "~/lib/hotkeys";

/** Binding name (see app/lib/hotkeys.ts) → handler. */
export type HotkeyMap = Record<string, (event: KeyboardEvent) => void>;

// One window listener for every mounted useHotkeys: they share the pending
// `g` sequence, and the most recently mounted map wins a key bound twice
// (a conversation's `j` over the list's).
const registry = new Set<{ current: HotkeyMap }>();
let pending: PendingSequence | null = null;
let listening = false;

function onKeyDown(event: KeyboardEvent) {
	if (event.defaultPrevented || event.repeat || isEditableTarget(event.target)) return;
	// A dialog or menu on top handles its own keys; nothing behind it acts.
	if (isOverlayOpen(document)) {
		pending = null;
		return;
	}
	const key = keyName(event);
	if (!key) return;

	const maps = [...registry].reverse().map((ref) => ref.current);
	const bound = new Set(maps.flatMap((map) => Object.keys(map)));
	const resolution = resolveHotkey(bound, key, pending, event.timeStamp || Date.now());
	pending = resolution.pending;
	if (resolution.pending) {
		event.preventDefault();
		return;
	}
	if (!resolution.match) return;
	const handler = maps.find((map) => resolution.match! in map)?.[resolution.match];
	if (!handler) return;
	event.preventDefault();
	handler(event);
}

/**
 * Registers keyboard shortcuts while the component is mounted:
 *
 *   useHotkeys({ c: compose, "g i": goInbox, "shift+i": markRead, "#": trash, "?": help });
 *
 * Handlers always see the latest render (no deps needed). Ignored while
 * typing (inputs, textareas, selects, contenteditable), with Meta, Ctrl or
 * Alt held, and while a modal dialog, alert dialog or menu is open. A matched key's default is prevented (so `/` doesn't type into
 * the field it focuses). Pass `{ enabled: false }` to turn the map off.
 */
export function useHotkeys(bindings: HotkeyMap, options: { enabled?: boolean } = {}) {
	const { enabled = true } = options;
	const ref = useRef(bindings);
	ref.current = bindings;

	useEffect(() => {
		if (!enabled) return;
		registry.add(ref);
		if (!listening) {
			window.addEventListener("keydown", onKeyDown);
			listening = true;
		}
		return () => {
			registry.delete(ref);
			if (registry.size === 0 && listening) {
				window.removeEventListener("keydown", onKeyDown);
				listening = false;
				pending = null;
			}
		};
	}, [enabled]);
}
