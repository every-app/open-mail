/**
 * What the port adds to a mailbox's settings (R2 `mailboxes/<address>.json`).
 * docs/GMAIL.md is the spec. Upstream's fields (fromName, signature,
 * agentSystemPrompt, …) are untouched; everything here is optional, so a
 * mailbox created before it reads as a shared, native one.
 */

export interface ReplyRule {
	id: string;
	/** When it applies, in plain words ("a customer asks for a refund"). */
	when: string;
	/** What to do ("apologize, link the refund form, don't promise a date"). */
	then: string;
	/** Who made it: the person, or the agent proposing it from an edited draft (accepted by the person). */
	source: "person" | "agent";
	createdAt: string;
	updatedAt: string;
}

export interface PortMailboxSettings {
	/**
	 * The gateway user id of the person the mailbox belongs to: only they see
	 * and use it. Absent on a mailbox created before ownership existed, which
	 * stays shared with the organization.
	 */
	ownerId?: string;
	/** `gmail`: a mirror of the owner's Gmail, kept in sync through the gateway. Absent: a native mailbox. */
	provider?: "gmail";
	/** How the agent should reply, learned with the person. */
	replyRules?: ReplyRule[];
}

export function mailboxKey(mailboxId: string): string {
	return `mailboxes/${mailboxId.trim().toLowerCase()}.json`;
}

export async function readMailboxSettings(
	bucket: R2Bucket,
	mailboxId: string,
): Promise<(PortMailboxSettings & Record<string, unknown>) | null> {
	const obj = await bucket.get(mailboxKey(mailboxId));
	if (!obj) return null;
	return (await obj.json()) as PortMailboxSettings & Record<string, unknown>;
}

/** Whether `userId` may see and use the mailbox: its owner, or anyone for a shared (ownerless) one. */
export function canUseMailbox(settings: PortMailboxSettings, userId: string | undefined): boolean {
	return !settings.ownerId || settings.ownerId === userId;
}

/**
 * The mailboxes `userId` may see and use, in `listMailboxes()`'s shape
 * (`{ id, email }`, the bucket's order) plus who owns each and its
 * provider (`settings`, for the UI): their own and the shared ones. A
 * settings file that isn't an object reads as a shared mailbox's.
 */
export async function listUsableMailboxes(
	bucket: R2Bucket,
	userId: string | undefined,
): Promise<{ id: string; email: string; settings: Pick<PortMailboxSettings, "ownerId" | "provider"> }[]> {
	const { objects } = await bucket.list({ prefix: "mailboxes/" });
	const ids = objects.map((obj) => obj.key.replace("mailboxes/", "").replace(".json", ""));
	const settings = (await Promise.all(ids.map((id) => readMailboxSettings(bucket, id)))).map(asSettings);
	return ids.flatMap((id, i) => {
		const { ownerId, provider } = settings[i];
		return canUseMailbox(settings[i], userId) ? [{ id, email: id, settings: { ownerId, provider } }] : [];
	});
}

/** Settings as read from R2, or `{}` for anything that isn't an object (a shared, native mailbox). */
export function asSettings(value: unknown): PortMailboxSettings & Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as PortMailboxSettings & Record<string, unknown>)
		: {};
}
