// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Folders } from "shared/folders";
import { toast } from "sonner";
import {
	buildQuotedReplyBlock,
	escapeHtml,
	formatComposeDate,
	getSignatureBlock,
	htmlToPlainText,
	splitEmailList,
	stripHtml,
	toEmailListValue,
} from "~/lib/utils";
import { useDeleteEmail, useForwardEmail, useReplyToEmail, useSaveDraft, useSendEmail } from "~/queries/emails";
import { useMailbox } from "~/queries/mailboxes";
import { type ComposeOptions, useUIStore } from "~/hooks/useUIStore";
import { folderPath } from "~/lib/mail-paths";
import { ApiError } from "~/services/api";

function appendUniqueAddress(
	addresses: string[],
	seen: Set<string>,
	address: string,
	exclude?: string,
) {
	const trimmed = address.trim();
	if (!trimmed) return;

	const normalized = trimmed.toLowerCase();
	if (normalized === exclude || seen.has(normalized)) return;

	seen.add(normalized);
	addresses.push(trimmed);
}

interface ComposeFormFields {
	to: string;
	cc: string;
	bcc: string;
	showCcBcc: boolean;
	subject: string;
	body: string;
}

const EMPTY_FIELDS: ComposeFormFields = {
	to: "",
	cc: "",
	bcc: "",
	showCcBcc: false,
	subject: "",
	body: "",
};

function getPrefixedSubject(subject: string, prefix: "Re" | "Fwd") {
	const expectedPrefix = `${prefix}: `;
	return subject.startsWith(expectedPrefix)
		? subject
		: `${expectedPrefix}${subject}`;
}

function buildForwardBody(
	original: NonNullable<ReturnType<typeof useUIStore.getState>["composeOptions"]["originalEmail"]>,
	sigBlock: string,
) {
	const safeSender = escapeHtml(original.sender);
	const safeSubject = escapeHtml(original.subject);
	const safeBody = escapeHtml(stripHtml(original.body || "")).replace(/\n/g, "<br>");

	return `<p><br></p>${sigBlock ? `${sigBlock}<br>` : ""}<div style="border: 1px solid #ddd; padding: 1em; background-color: #f9f9f9; margin: 1em 0;"><strong>Forwarded message:</strong><br><strong>From:</strong> ${safeSender}<br><strong>Date:</strong> ${formatComposeDate(original.date)}<br><strong>Subject:</strong> ${safeSubject}<br><br>${safeBody}</div>`;
}

function buildReplyAllFields(
	original: NonNullable<ReturnType<typeof useUIStore.getState>["composeOptions"]["originalEmail"]>,
	selfAddress?: string,
) {
	const toRecipients: string[] = [];
	const toSeen = new Set<string>();
	appendUniqueAddress(toRecipients, toSeen, original.sender, selfAddress);

	for (const recipient of splitEmailList(original.recipient)) {
		appendUniqueAddress(toRecipients, toSeen, recipient, selfAddress);
	}

	const ccRecipients: string[] = [];
	const ccSeen = new Set<string>();
	for (const recipient of splitEmailList(original.cc)) {
		const normalized = recipient.toLowerCase();
		if (
			normalized === selfAddress ||
			toSeen.has(normalized) ||
			ccSeen.has(normalized)
		) {
			continue;
		}
		ccSeen.add(normalized);
		ccRecipients.push(recipient);
	}

	return {
		to: toRecipients.join(", "),
		cc: ccRecipients.join(", "),
		showCcBcc: ccRecipients.length > 0,
	};
}

function buildInitialComposeFields(
	composeOptions: ReturnType<typeof useUIStore.getState>["composeOptions"],
	mailboxEmail: string | undefined,
	sigBlock: string,
): ComposeFormFields {
	const { draftEmail: draft, originalEmail: original, mode } = composeOptions;

	if (draft) {
		return {
			to: draft.recipient || "",
			cc: draft.cc || "",
			bcc: draft.bcc || "",
			showCcBcc: Boolean(draft.cc || draft.bcc),
			subject: draft.subject || "",
			body: draft.body || "",
		};
	}

	if (!original) {
		return {
			...EMPTY_FIELDS,
			body: sigBlock ? `<p><br></p>${sigBlock}` : "",
		};
	}

	if (mode === "reply") {
		return {
			...EMPTY_FIELDS,
			to: original.sender,
			subject: getPrefixedSubject(original.subject, "Re"),
			body: `<p><br></p>${sigBlock ? `${sigBlock}<br>` : ""}${buildQuotedReplyBlock(original.date, original.sender, original.body || "")}`,
		};
	}

	if (mode === "reply-all") {
		const recipients = buildReplyAllFields(original, mailboxEmail?.toLowerCase());
		return {
			...EMPTY_FIELDS,
			...recipients,
			subject: getPrefixedSubject(original.subject, "Re"),
			body: `<p><br></p>${sigBlock ? `${sigBlock}<br>` : ""}${buildQuotedReplyBlock(original.date, original.sender, original.body || "")}`,
		};
	}

	if (mode === "forward") {
		return {
			...EMPTY_FIELDS,
			subject: getPrefixedSubject(original.subject, "Fwd"),
			body: buildForwardBody(original, sigBlock),
		};
	}

	return {
		...EMPTY_FIELDS,
		body: sigBlock ? `<p><br></p>${sigBlock}` : "",
	};
}

/**
 * The composer's state and actions. `options` (the inline reply in a
 * conversation passes its own) replaces the store's `composeOptions`; pass a
 * stable object (memoized), since a new one resets the fields.
 */
export type DraftSaveStatus = "idle" | "saving" | "saved" | "error";

export interface UseComposeFormConfig {
	/**
	 * What to compose. Defaults to the legacy store's `composeOptions`. The
	 * fields re-initialize when its mode, original or draft id changes.
	 */
	options?: ComposeOptions;
	/** Saves a draft after this many ms without typing; off when unset. */
	autosaveMs?: number;
}

interface DraftFields {
	to: string;
	cc: string;
	bcc: string;
	subject: string;
	body: string;
}

/**
 * What the person wrote, ignoring the editor's markup normalization: the
 * editor rewrites the prefilled signature and quote (`<div>` to `<p>`, `<br>`
 * to paragraphs), which changes only the whitespace of the text.
 */
function contentKey(fields: DraftFields) {
	const text = htmlToPlainText(fields.body).replace(/\s+/g, " ").trim();
	return [fields.to.trim(), fields.cc.trim(), fields.bcc.trim(), fields.subject.trim(), text].join("\u0000");
}

/** Exactly what a save would store. */
function rawKey(fields: DraftFields) {
	return [fields.to, fields.cc, fields.bcc, fields.subject, fields.body].join("\u0000");
}

function optionsKey(options: ComposeOptions) {
	return `${options.mode}:${options.originalEmail?.id ?? ""}:${options.draftEmail?.id ?? ""}`;
}

export function useComposeForm(mailboxId?: string, _folder?: string, config: UseComposeFormConfig = {}) {
	const navigate = useNavigate();
	const { composeOptions: storeComposeOptions, closePanel, closeCompose } = useUIStore();
	const composeOptions = config.options ?? storeComposeOptions;
	const autosaveMs = config.autosaveMs;
	const { data: currentMailbox } = useMailbox(mailboxId);
	const sendEmailMutation = useSendEmail();
	const saveDraftMutation = useSaveDraft();
	const replyMutation = useReplyToEmail();
	const forwardMutation = useForwardEmail();
	const deleteEmailMutation = useDeleteEmail();

	const [to, setTo] = useState("");
	const [cc, setCc] = useState("");
	const [bcc, setBcc] = useState("");
	const [showCcBcc, setShowCcBcc] = useState(false);
	const [subject, setSubject] = useState("");
	const [body, setBody] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [isSavingDraft, setIsSavingDraft] = useState(false);
	const [isSending, setIsSending] = useState(false);
	const [saveStatus, setSaveStatus] = useState<DraftSaveStatus>("idle");
	const lastInitializedRef = useRef<unknown>(null);
	const isDraftEdit = !!composeOptions.draftEmail;

	// The draft on the server: saving replaces it under a new id, so the
	// latest id lives here, not in the options.
	const draftIdRef = useRef<string | null>(null);
	const [draftId, setDraftIdState] = useState<string | null>(null);
	const setDraftId = useCallback((id: string | null) => {
		draftIdRef.current = id;
		setDraftIdState(id);
	}, []);
	// The empty form's key until the fields initialize: a form that starts
	// empty doesn't re-render then, and "" would read as typed (dirty).
	const initialContentKeyRef = useRef(contentKey(EMPTY_FIELDS));
	const lastSavedKeyRef = useRef("");
	const savedThisSessionRef = useRef(false);
	const pendingSaveRef = useRef<Promise<boolean> | null>(null);
	// Set while sending and after the message is gone (sent, discarded):
	// no autosave may resurrect it.
	const autosaveBlockedRef = useRef(false);
	const fields: DraftFields = { to, cc, bcc, subject, body };
	const fieldsRef = useRef(fields);
	fieldsRef.current = fields;

	const formTitle = useMemo(() => {
		if (isDraftEdit) return "Edit draft";
		switch (composeOptions.mode) { case "reply": return "Reply"; case "reply-all": return "Reply all"; case "forward": return "Forward"; default: return "New message"; }
	}, [composeOptions.mode, isDraftEdit]);

	const sigBlock = useMemo(() => getSignatureBlock(currentMailbox?.settings), [currentMailbox]);
	const initKey = config.options ? optionsKey(config.options) : storeComposeOptions;

	useEffect(() => {
		if (lastInitializedRef.current === initKey) return;
		lastInitializedRef.current = initKey;

		const initialFields = buildInitialComposeFields(
			composeOptions,
			currentMailbox?.email,
			sigBlock,
		);
		setError(null);
		setTo(initialFields.to);
		setCc(initialFields.cc);
		setBcc(initialFields.bcc);
		setShowCcBcc(initialFields.showCcBcc);
		setSubject(initialFields.subject);
		setBody(initialFields.body);
		setSaveStatus("idle");
		setDraftId(composeOptions.draftEmail?.id || null);
		initialContentKeyRef.current = contentKey(initialFields);
		// What a cleanup before the next render (unmount) compares against.
		fieldsRef.current = { to: initialFields.to, cc: initialFields.cc, bcc: initialFields.bcc, subject: initialFields.subject, body: initialFields.body };
		lastSavedKeyRef.current = composeOptions.draftEmail ? rawKey(initialFields) : "";
		savedThisSessionRef.current = false;
		autosaveBlockedRef.current = false;
	}, [initKey, currentMailbox?.email, sigBlock]);

	const isDirty = contentKey(fields) !== initialContentKeyRef.current;

	/**
	 * Saves the fields as a draft (queued behind a save in flight, so the
	 * draft id stays current). A no-op when nothing changed since the last save.
	 */
	const persistDraft = useCallback(async (options?: { autosave?: boolean }): Promise<boolean> => {
		if (!mailboxId) return false;
		const previous = pendingSaveRef.current;
		const run = (async () => {
			if (previous) await previous;
			if (options?.autosave && autosaveBlockedRef.current) return false;
			const current = fieldsRef.current;
			const key = rawKey(current);
			if (key === lastSavedKeyRef.current && draftIdRef.current) return true;
			// Nothing typed beyond what was prefilled (signature, quote): no blank draft.
			if (!draftIdRef.current && contentKey(current) === initialContentKeyRef.current) return false;
			setSaveStatus("saving");
			try {
				const result = await saveDraftMutation.mutateAsync({ mailboxId, draft: {
					to: current.to,
					cc: current.cc || undefined,
					bcc: current.bcc || undefined,
					subject: current.subject,
					body: current.body,
					in_reply_to: composeOptions.originalEmail?.id || composeOptions.draftEmail?.in_reply_to || undefined,
					thread_id: composeOptions.originalEmail?.thread_id || composeOptions.draftEmail?.thread_id || undefined,
					draft_id: draftIdRef.current || undefined,
				} });
				setDraftId(result?.id || draftIdRef.current);
				lastSavedKeyRef.current = key;
				savedThisSessionRef.current = true;
				setSaveStatus("saved");
				return true;
			} catch (err: unknown) {
				setSaveStatus("error");
				if (!options?.autosave) throw err;
				return false;
			}
		})();
		const settled = run.catch(() => false);
		pendingSaveRef.current = settled;
		void settled.finally(() => {
			if (pendingSaveRef.current === settled) pendingSaveRef.current = null;
		});
		return run;
	}, [mailboxId, composeOptions, saveDraftMutation, setDraftId]);

	/** Typed text the server doesn't have yet (not since the last save, or never saved). */
	const hasUnsavedChanges = useCallback(() => {
		if (autosaveBlockedRef.current) return false;
		const current = fieldsRef.current;
		const typed = contentKey(current) !== initialContentKeyRef.current || savedThisSessionRef.current;
		return typed && rawKey(current) !== lastSavedKeyRef.current;
	}, []);

	// Leaving with unsaved text (the window replaced, the conversation left,
	// another mailbox) keeps it as a draft: the autosave timer dies with the
	// component, so save once more on the way out.
	const persistDraftRef = useRef(persistDraft);
	persistDraftRef.current = persistDraft;
	useEffect(() => {
		return () => {
			if (!hasUnsavedChanges()) return;
			void persistDraftRef.current({ autosave: true }).then((saved) => {
				if (saved) toast("Draft saved.");
			});
		};
	}, [hasUnsavedChanges]);

	// Closing the tab or reloading with unsaved text asks first.
	const unsaved = hasUnsavedChanges() || saveStatus === "saving";
	useEffect(() => {
		if (!unsaved) return;
		const onBeforeUnload = (e: BeforeUnloadEvent) => {
			e.preventDefault();
			e.returnValue = "";
		};
		window.addEventListener("beforeunload", onBeforeUnload);
		return () => window.removeEventListener("beforeunload", onBeforeUnload);
	}, [unsaved]);

	// Autosave after a pause in typing, once there's something to keep.
	useEffect(() => {
		if (!autosaveMs || !mailboxId || isSending || autosaveBlockedRef.current) return;
		if (!isDirty && !savedThisSessionRef.current) return;
		if (rawKey(fields) === lastSavedKeyRef.current) return;
		const timer = setTimeout(() => void persistDraft({ autosave: true }), autosaveMs);
		return () => clearTimeout(timer);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [to, cc, bcc, subject, body, autosaveMs, mailboxId, isSending]);

	const handleSaveDraft = async () => {
		if (!mailboxId || isSending) return; setIsSavingDraft(true); setError(null);
		try {
			if (await persistDraft()) toast("Draft saved.");
		}
		catch (err: unknown) {
			const message = (err instanceof Error ? err.message : null) || "Failed to save draft.";
			setError(message);
			toast.error(message);
		}
		finally { setIsSavingDraft(false); }
	};

	/**
	 * Closing the window: keeps what was written as a draft ("Draft saved.")
	 * and closes; closes quietly when nothing was typed beyond what was
	 * prefilled (a new message's draft the autosave made before the text was
	 * erased again goes too). Stays open with the error when the save fails.
	 */
	const closeWithDraft = async (onClose: () => void) => {
		if (isSending) return;
		// A draft being edited keeps its last state even when that's what it started as.
		const keepEdit = Boolean(composeOptions.draftEmail) && hasUnsavedChanges();
		if (!mailboxId || (!isDirty && !keepEdit)) {
			autosaveBlockedRef.current = true;
			onClose();
			if (!mailboxId || composeOptions.draftEmail || !savedThisSessionRef.current) return;
			if (pendingSaveRef.current) await pendingSaveRef.current;
			const emptied = draftIdRef.current;
			setDraftId(null);
			if (emptied) deleteEmailMutation.mutate({ mailboxId, id: emptied });
			return;
		}
		setIsSavingDraft(true); setError(null);
		try {
			const saved = await persistDraft();
			autosaveBlockedRef.current = true;
			onClose();
			if (saved) toast("Draft saved.");
		} catch (err: unknown) {
			setError((err instanceof Error ? err.message : null) || "Failed to save draft.");
		} finally { setIsSavingDraft(false); }
	};

	/**
	 * Pop out: saves what was typed and hands the draft over (its id, or null
	 * when nothing was typed). This composer saves no more, so the window that
	 * takes the draft over is the only one writing it. Throws when the save fails.
	 */
	const handOffDraft = async (): Promise<string | null> => {
		if (hasUnsavedChanges()) await persistDraft();
		else if (pendingSaveRef.current) await pendingSaveRef.current;
		autosaveBlockedRef.current = true;
		return draftIdRef.current;
	};

	/** Throws the message away: deletes its draft if one was saved ("Draft discarded."). */
	const discardDraft = async (onClose: () => void) => {
		if (isSending) return;
		autosaveBlockedRef.current = true;
		if (pendingSaveRef.current) await pendingSaveRef.current;
		const draftId = draftIdRef.current;
		const hadContent = isDirty || Boolean(draftId);
		onClose();
		if (draftId && mailboxId) {
			setDraftId(null);
			try {
				await deleteEmailMutation.mutateAsync({ mailboxId, id: draftId });
			} catch {
				toast.error("Couldn't delete the draft.");
				return;
			}
		}
		if (hadContent) toast("Draft discarded.");
	};

	const handleSend = async (e: FormEvent, onClose: () => void) => {
		e.preventDefault(); if (isSending) return; setError(null);
		if (!currentMailbox || !mailboxId) { setError("No mailbox selected."); return; }
		const toRecipients = splitEmailList(to);
		if (toRecipients.length === 0) { setError("Add at least one recipient."); return; }
		const ccRecipients = splitEmailList(cc); const bccRecipients = splitEmailList(bcc);
		const fromName = currentMailbox.settings?.fromName || currentMailbox.name;
		const from = fromName && fromName !== currentMailbox.email ? { email: currentMailbox.email, name: fromName } : currentMailbox.email;
		const emailData = {
			to: toEmailListValue(toRecipients),
			cc: toEmailListValue(ccRecipients),
			bcc: toEmailListValue(bccRecipients),
			from,
			subject,
			html: body,
			text: htmlToPlainText(body),
		};
		const mode = composeOptions.mode; const originalId = composeOptions.originalEmail?.id || composeOptions.draftEmail?.in_reply_to;
		setIsSending(true);
		autosaveBlockedRef.current = true;
		try {
			if ((mode === "reply" || mode === "reply-all") && originalId) await replyMutation.mutateAsync({ mailboxId, emailId: originalId, email: emailData });
			else if (mode === "forward" && originalId) await forwardMutation.mutateAsync({ mailboxId, emailId: originalId, email: emailData });
			else await sendEmailMutation.mutateAsync({ mailboxId, email: emailData });
			// An autosave in flight lands first, so its draft is the one deleted.
			if (pendingSaveRef.current) await pendingSaveRef.current;
			const draftId = draftIdRef.current;
			setDraftId(null);
			if (draftId) deleteEmailMutation.mutate({ mailboxId, id: draftId });
			toast("Message sent.", {
				action: { label: "View message", onClick: () => navigate(folderPath(mailboxId, Folders.SENT)) },
			});
			onClose();
		} catch (err: unknown) {
			autosaveBlockedRef.current = false;
			// The composer's banner shows it, next to the mail it is about; no toast too.
			// The sender refusal's command has a `<domain>` placeholder; this mailbox's domain fills it.
			const message = (err instanceof Error ? err.message : null) || "Failed to send email.";
			const domain = currentMailbox.email.split("@")[1];
			setError(err instanceof ApiError && err.code === "email_sender_not_allowed" && domain ? message.replace("<domain>", domain) : message);
		}
		finally { setIsSending(false); }
	};

	return {
		to, setTo, cc, setCc, bcc, setBcc, showCcBcc, setShowCcBcc, subject, setSubject, body, setBody,
		error, setError, isSavingDraft, isSending, formTitle, handleSaveDraft, handleSend, closeCompose, closePanel,
		/** The mailbox's own address: the From line. */
		fromAddress: currentMailbox?.email ?? mailboxId ?? "",
		/** Something was written since the composer opened. */
		isDirty,
		/** The draft this composer saved to (or is editing), or null; changes with every save. The conversation hides its card. */
		draftId,
		/** The autosave's state, for "Saving…" / "Saved". */
		saveStatus,
		closeWithDraft,
		discardDraft,
		handOffDraft,
	};
}
