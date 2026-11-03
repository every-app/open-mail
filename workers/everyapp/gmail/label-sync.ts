/**
 * Gmail's user labels and OpenMail's own labels (MailboxDO's, ../mailbox.ts)
 * as one label system on a Gmail mailbox (docs/GMAIL.md, "Labels"). Each
 * OpenMail label is linked to one Gmail user label (GmailStore's
 * label_links); Gmail's system labels (INBOX, UNREAD, STARRED, CATEGORY_…)
 * stay folders and flags (./labels.ts).
 *
 * Gmail to OpenMail, on every sync (syncLabels): a new Gmail label links to
 * the OpenMail label of the same name or makes one, a renamed or recolored
 * one renames or recolors its OpenMail label, one gone from Gmail takes its
 * OpenMail label with it, and an OpenMail label with no Gmail label yet is
 * made in Gmail. Per message (setLocalLabelsOf): an email's OpenMail labels
 * among the linked ones are its Gmail labels'.
 *
 * OpenMail to Gmail: the wrapped env.MAILBOX (./namespace.ts) queues label
 * changes in the outbox, and the engine (./engine.ts) makes them here.
 *
 * Writes into MailboxDO go to the raw stub, as all of the engine's do, so a
 * change that came from Gmail is never queued back to Gmail.
 */
import { LABEL_COLORS, colorForName, normalizeLabelName, type Label, type LabelColor, type LabelResult } from "../label-model";
import { GmailError, type GmailClient, type GmailLabel, type GmailLabelColor } from "./client";
import { isSystemLabel } from "./labels";
import type { GmailStore } from "./store";

/** The MailboxDO label methods the label sync uses (the raw stub satisfies it). */
export interface LabelMailbox {
	listLabels(): Promise<Label[]>;
	getLabel(id: string): Promise<Label | null>;
	createLabel(name: string, color?: string): Promise<LabelResult>;
	updateLabel(id: string, changes: { name?: string; color?: string }): Promise<LabelResult>;
	deleteLabel(id: string): Promise<boolean>;
	setEmailLabels(emailId: string, labelIds: string[], scope: string[]): Promise<boolean>;
}

export interface LabelSyncDeps {
	store: GmailStore;
	gmail: GmailClient;
	mailbox: LabelMailbox;
}

// ── colors ─────────────────────────────────────────────────────────

/**
 * Each OpenMail color as a pair from Gmail's fixed label palette (Gmail
 * refuses any other value with a 400).
 */
export const GMAIL_COLORS: Record<LabelColor, Required<GmailLabelColor>> = {
	slate: { backgroundColor: "#999999", textColor: "#ffffff" },
	rose: { backgroundColor: "#fb4c2f", textColor: "#ffffff" },
	amber: { backgroundColor: "#ffad47", textColor: "#000000" },
	lime: { backgroundColor: "#43d692", textColor: "#000000" },
	emerald: { backgroundColor: "#16a766", textColor: "#ffffff" },
	sky: { backgroundColor: "#4a86e8", textColor: "#ffffff" },
	violet: { backgroundColor: "#a479e2", textColor: "#ffffff" },
	fuchsia: { backgroundColor: "#f691b3", textColor: "#000000" },
};

/** The OpenMail colors as the UI draws them (app/index.css's tag chips). */
const SWATCHES: Record<LabelColor, string> = {
	slate: "#64748b",
	rose: "#f43f5e",
	amber: "#f59e0b",
	lime: "#84cc16",
	emerald: "#10b981",
	sky: "#0ea5e9",
	violet: "#8b5cf6",
	fuchsia: "#d946ef",
};

export function gmailColorOf(color: LabelColor): Required<GmailLabelColor> {
	return GMAIL_COLORS[color];
}

/**
 * The OpenMail color for a Gmail label's color: the one it maps to, else
 * the nearest swatch by RGB distance. Null when the label has no color.
 */
export function localColorOf(color: GmailLabelColor | undefined): LabelColor | null {
	const rgb = color?.backgroundColor ? rgbOf(color.backgroundColor) : null;
	if (!rgb) return null;
	const hex = color!.backgroundColor!.toLowerCase();
	const exact = LABEL_COLORS.find((c) => GMAIL_COLORS[c].backgroundColor === hex);
	if (exact) return exact;
	let best: LabelColor = LABEL_COLORS[0];
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const c of LABEL_COLORS) {
		const [r, g, b] = rgbOf(SWATCHES[c])!;
		const distance = (r - rgb[0]) ** 2 + (g - rgb[1]) ** 2 + (b - rgb[2]) ** 2;
		if (distance < bestDistance) {
			best = c;
			bestDistance = distance;
		}
	}
	return best;
}

function rgbOf(hex: string): [number, number, number] | null {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) return null;
	const n = Number.parseInt(m[1], 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ── Gmail to OpenMail ──────────────────────────────────────────────

/** A Gmail label the person made, as opposed to one Gmail owns. */
function isUserLabel(label: GmailLabel): boolean {
	return label.type ? label.type === "user" : !isSystemLabel(label.id);
}

/**
 * Bring OpenMail's labels in step with Gmail's: one labels.list, then the
 * links (see the header). Runs after the outbox is flushed, so OpenMail's
 * own changes are in Gmail already; one still queued (a flush that failed)
 * wins until it is made. Returns how many OpenMail labels changed.
 */
export async function syncLabels(deps: LabelSyncDeps): Promise<number> {
	const { store, gmail, mailbox } = deps;
	const all = await gmail.listLabels();
	store.replaceLabels(all.map((l) => ({ id: l.id, name: l.name, type: l.type })));
	const inGmail = new Map(all.filter(isUserLabel).map((l) => [l.id, l]));
	const local = new Map((await mailbox.listLabels()).map((l) => [l.id, { id: l.id, name: l.name, color: l.color }]));
	const deleting = new Set(
		store.pending().flatMap(({ op }) => (op.kind === "label_delete" && op.gmailId ? [op.gmailId] : [])),
	);
	let changed = 0;

	// Gone from Gmail: the OpenMail label goes too.
	for (const link of store.labelLinks()) {
		if (inGmail.has(link.gmailId)) continue;
		store.unlinkLabel(link.localId);
		if (local.has(link.localId) && (await mailbox.deleteLabel(link.localId))) changed++;
		local.delete(link.localId);
	}

	for (const label of inGmail.values()) {
		const color = localColorOf(label.color);
		const name = normalizeLabelName(label.name);
		const localId = store.localLabelOf(label.id);
		if (localId) {
			const current = local.get(localId);
			if (current) {
				// A rename or recolor made in OpenMail and not in Gmail yet wins.
				if (!name || store.hasPending("label_update", localId)) continue;
				const next = { name, color: color ?? current.color };
				if (next.name === current.name && next.color === current.color) continue;
				const result = await mailbox.updateLabel(localId, next);
				if (result.ok) {
					local.set(localId, result.label);
					changed++;
				} else {
					console.warn(`[gmail] couldn't rename label ${current.name} to ${name}: ${result.error}`);
				}
				continue;
			}
			// Deleted in OpenMail: its deletion is queued (or made, and Gmail's list is older).
			if (deleting.has(label.id) || store.hasPending("label_delete", localId)) continue;
			// Gone from OpenMail with no deletion queued: Gmail's label stays, and is linked afresh.
			store.unlinkLabel(localId);
		}
		if (deleting.has(label.id) || !name) continue;

		// Not linked: the OpenMail label of the same name, else a new one.
		const lower = name.toLowerCase();
		const same = [...local.values()].find((l) => l.name.toLowerCase() === lower && !store.gmailLabelOf(l.id));
		if (same) {
			store.linkLabel(same.id, label.id);
			if (color && color !== same.color) {
				const result = await mailbox.updateLabel(same.id, { color });
				if (result.ok) {
					local.set(same.id, result.label);
					changed++;
				}
			}
			continue;
		}
		const created = await mailbox.createLabel(name, color ?? colorForName(name));
		if (created.ok) {
			store.linkLabel(created.label.id, label.id);
			local.set(created.label.id, created.label);
			changed++;
		} else {
			console.warn(`[gmail] couldn't add Gmail's label ${name} to OpenMail: ${created.error}`);
		}
	}

	// OpenMail's labels with no Gmail label: made before this sync linked
	// labels, or whose creation is still queued (then the flush makes it).
	const refused = store.get<Record<string, string>>("labelsRefused") ?? {};
	for (const label of local.values()) {
		if (store.gmailLabelOf(label.id) || store.hasPending("label_create", label.id)) continue;
		if (refused[label.id] === label.name) continue;
		try {
			await ensureGmailLabel(deps, label.id, label);
		} catch (error) {
			if (!(error instanceof GmailError) || error.reconnect || error.status !== 400) throw error;
			// A name Gmail won't take (one of its own, say): not again until it is renamed.
			console.warn(`[gmail] Gmail refused the label ${label.name}: ${error.message}`);
			store.set("labelsRefused", { ...refused, [label.id]: label.name });
		}
	}
	return changed;
}

/**
 * Set one email's OpenMail labels from its Gmail labels, through the
 * links. Only linked labels are touched: one made in OpenMail and not yet
 * in Gmail stays. Returns whether anything changed.
 */
export async function setLocalLabelsOf(deps: LabelSyncDeps, emailId: string, gmailLabelIds: readonly string[]): Promise<boolean> {
	const links = deps.store.labelLinks();
	if (links.length === 0) return false;
	const byGmail = new Map(links.map((l) => [l.gmailId, l.localId]));
	const ids = gmailLabelIds.flatMap((id) => byGmail.get(id) ?? []);
	return deps.mailbox.setEmailLabels(emailId, ids, links.map((l) => l.localId));
}

// ── OpenMail to Gmail ──────────────────────────────────────────────

/**
 * The Gmail label of an OpenMail label, linked first if need be: a Gmail
 * user label of the same name that isn't linked yet, else a new one
 * (labels.create). Undefined when the OpenMail label is gone.
 */
export async function ensureGmailLabel(
	deps: LabelSyncDeps,
	localId: string,
	known?: Pick<Label, "name" | "color">,
): Promise<string | undefined> {
	const { store, gmail, mailbox } = deps;
	const linked = store.gmailLabelOf(localId);
	if (linked) return linked;
	const label = known ?? (await mailbox.getLabel(localId));
	if (!label) return undefined;
	const lower = label.name.toLowerCase();
	const free = store.labels().find((l) => l.type === "user" && l.name.toLowerCase() === lower && !store.localLabelOf(l.id));
	const gmailId = free?.id ?? (await createGmailLabel(gmail, label.name, label.color)).id;
	if (!free) store.putLabel({ id: gmailId, name: label.name, type: "user" });
	store.linkLabel(localId, gmailId);
	return gmailId;
}

/**
 * labels.create with the color's Gmail pair; a refused color (400) is
 * tried again without one, and a name Gmail has already (409) is that label.
 */
export async function createGmailLabel(gmail: GmailClient, name: string, color: LabelColor): Promise<GmailLabel> {
	try {
		return await gmail.createLabel(name, gmailColorOf(color));
	} catch (error) {
		if (!(error instanceof GmailError)) throw error;
		if (error.status === 400) return gmail.createLabel(name);
		if (error.status === 409) {
			const lower = name.toLowerCase();
			const existing = (await gmail.listLabels()).find((l) => l.name.toLowerCase() === lower);
			if (existing) return existing;
		}
		throw error;
	}
}

/**
 * labels.patch to the OpenMail label's name and color; a refused color
 * (400) is tried again with the name only. False when the Gmail label is gone.
 */
export async function patchGmailLabel(gmail: GmailClient, gmailId: string, name: string, color: LabelColor): Promise<boolean> {
	try {
		try {
			await gmail.patchLabel(gmailId, { name, color: gmailColorOf(color) });
		} catch (error) {
			if (!(error instanceof GmailError && error.status === 400)) throw error;
			await gmail.patchLabel(gmailId, { name });
		}
		return true;
	} catch (error) {
		if (error instanceof GmailError && error.status === 404) return false;
		throw error;
	}
}

/** labels.delete. A label already gone is fine. */
export async function deleteGmailLabel(gmail: GmailClient, gmailId: string): Promise<void> {
	try {
		await gmail.deleteLabel(gmailId);
	} catch (error) {
		if (!(error instanceof GmailError && error.status === 404)) throw error;
	}
}
