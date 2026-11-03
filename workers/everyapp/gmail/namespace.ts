/**
 * `env.MAILBOX` as withGateway() hands it to the routes, the agent and the
 * MCP tools (docs/GMAIL.md, "The seam is withGateway()").
 *
 * `idFromName` and `get` work as on the binding. For a Gmail mailbox (its
 * R2 settings say `provider: "gmail"`), the stub's mutating methods apply
 * the change to MailboxDO as upstream does and queue the same change for
 * Gmail in the mailbox's GmailSync outbox. The outbox is flushed at once
 * when a person is behind the env (a request), else at the next sync.
 * Everything else, and every native mailbox, passes straight through.
 *
 *   updateEmail      read → UNREAD, starred → STARRED
 *   markThreadRead   UNREAD off the thread
 *   moveEmail        archive, inbox, spam as labels; trash as messages.trash
 *   deleteEmail      a draft → drafts.delete; anything else → trash
 *   createEmail      into Drafts → drafts.create / update; into Sent → nothing
 *                    (Gmail files sent mail itself; the next sync pulls it)
 *   createLabel      labels.create, linked to the new label (./label-sync.ts)
 *   updateLabel      labels.patch: the new name and color
 *   deleteLabel      labels.delete
 *   labelThread      threads.modify with the linked Gmail labels
 */
import type { GatewayCallFor } from "@every-app/sdk/server";
import { Folders } from "../../../shared/folders";
import type { LabelResult, LabelThreadResult } from "../label-model";
import { readMailboxSettings } from "../mailbox-settings";
import { flagChange, moveChange } from "./labels";
import type { OutboxOp } from "./store";
import { forwardTarget, gmailSyncOf, personBehind } from "./target";

type Namespace = Cloudflare.Env["MAILBOX"];

/** The env the wrapper reads: the binding, the bucket with the settings, GmailSync. */
type WrapperEnv = Pick<Cloudflare.Env, "MAILBOX" | "BUCKET" | "GMAIL_SYNC">;

interface StubLike {
	getEmail(id: string): Promise<{ folder_id?: string | null } | null>;
	updateEmail(id: string, patch: { read?: boolean; starred?: boolean }): Promise<unknown>;
	markThreadRead(threadId: string): Promise<unknown>;
	moveEmail(id: string, folderId: string): Promise<boolean>;
	deleteEmail(id: string): Promise<unknown[] | null>;
	createEmail(folder: string, email: { id: string }, attachments: unknown[]): Promise<unknown>;
	createLabel(name: string, color?: string): Promise<LabelResult>;
	updateLabel(id: string, changes: { name?: string; color?: string }): Promise<LabelResult>;
	deleteLabel(id: string): Promise<boolean>;
	labelThread(threadKey: string, add?: string[], remove?: string[]): Promise<LabelThreadResult>;
}

const DRAFT_NAMES = new Set([Folders.DRAFT, "drafts"]);

export function gmailMailboxNamespace(env: WrapperEnv, target?: GatewayCallFor): Namespace {
	const namespace = env.MAILBOX;
	if (!namespace || !env.BUCKET || !env.GMAIL_SYNC) return namespace;
	const names = new Map<string, string>();
	const gmail = new Map<string, Promise<boolean>>();

	const isGmail = (name: string) => {
		let known = gmail.get(name);
		if (!known) {
			known = readMailboxSettings(env.BUCKET, name)
				.then((settings) => settings?.provider === "gmail")
				.catch(() => false);
			gmail.set(name, known);
		}
		return known;
	};

	const record = async (name: string, op: OutboxOp) => {
		const sync = gmailSyncOf(env, name);
		await sync.enqueue(name, op);
		if (!personBehind(target)) return;
		const flushed = await sync.flush(name, forwardTarget(target)).catch((e: Error) => ({ error: { message: e.message } }));
		if (flushed.error) console.warn(`[gmail] outbox for ${name} not flushed: ${flushed.error.message}`);
	};

	const wrap = <S extends object>(name: string, stub: S): S => {
		const raw = stub as unknown as StubLike;
		const methods: Partial<StubLike> = {
			async updateEmail(id, patch) {
				const result = await raw.updateEmail(id, patch);
				if (result && (await isGmail(name))) {
					const { add, remove } = flagChange(patch ?? {});
					if (add.length || remove.length) await record(name, { kind: "labels", localId: id, add, remove });
				}
				return result;
			},
			async markThreadRead(threadId) {
				const result = await raw.markThreadRead(threadId);
				if (await isGmail(name)) await record(name, { kind: "thread_labels", localId: threadId, add: [], remove: ["UNREAD"] });
				return result;
			},
			async moveEmail(id, folderId) {
				if (!(await isGmail(name))) return raw.moveEmail(id, folderId);
				const before = await raw.getEmail(id);
				const moved = await raw.moveEmail(id, folderId);
				const change = moved && before ? moveChange(before.folder_id, folderId) : null;
				if (change) await record(name, { kind: "move", localId: id, change });
				return moved;
			},
			async deleteEmail(id) {
				if (!(await isGmail(name))) return raw.deleteEmail(id);
				const before = await raw.getEmail(id);
				const result = await raw.deleteEmail(id);
				if (result !== null && before) {
					await record(
						name,
						before.folder_id === Folders.DRAFT
							? { kind: "draft_delete", localId: id }
							: { kind: "move", localId: id, change: { trash: true, add: [], remove: [] } },
					);
				}
				return result;
			},
			async createEmail(folder, email, attachments) {
				if (!(await isGmail(name))) return raw.createEmail(folder, email, attachments);
				const key = String(folder).toLowerCase();
				if (key === Folders.SENT) return undefined;
				const result = await raw.createEmail(folder, email, attachments);
				if (DRAFT_NAMES.has(key)) await record(name, { kind: "draft_upsert", localId: email.id });
				return result;
			},
			async createLabel(labelName, color) {
				const result = await raw.createLabel(labelName, color);
				if (result.ok && (await isGmail(name))) {
					await record(name, { kind: "label_create", localId: result.label.id, name: result.label.name, color: result.label.color });
				}
				return result;
			},
			async updateLabel(id, changes) {
				const result = await raw.updateLabel(id, changes);
				if (result.ok && (await isGmail(name))) {
					await record(name, { kind: "label_update", localId: id, name: result.label.name, color: result.label.color });
				}
				return result;
			},
			async deleteLabel(id) {
				const deleted = await raw.deleteLabel(id);
				// The link (GmailSync's) outlives the label: the outbox reads its Gmail id from it.
				if (deleted && (await isGmail(name))) await record(name, { kind: "label_delete", localId: id });
				return deleted;
			},
			async labelThread(threadKey, add = [], remove = []) {
				const result = await raw.labelThread(threadKey, add, remove);
				if (result.ok && (add.length > 0 || remove.length > 0) && (await isGmail(name))) {
					await record(name, {
						kind: "label_thread",
						localId: result.threadKey,
						add: [...new Set(add)],
						remove: [...new Set(remove)].filter((id) => !add.includes(id)),
					});
				}
				return result;
			},
		};
		return new Proxy(stub, {
			get(target, property) {
				if (typeof property === "string" && Object.hasOwn(methods, property)) {
					return methods[property as keyof StubLike];
				}
				return passThrough(target, property);
			},
		});
	};

	const overrides = {
		idFromName(name: string): DurableObjectId {
			const id = namespace.idFromName(name);
			names.set(id.toString(), name.trim().toLowerCase());
			return id;
		},
		get(id: DurableObjectId, options?: DurableObjectNamespaceGetDurableObjectOptions) {
			const stub = namespace.get(id, options);
			const name = names.get(id.toString());
			return name ? wrap(name, stub) : stub;
		},
	};
	return new Proxy(namespace, {
		get(target, property) {
			if (property === "idFromName" || property === "get") return overrides[property];
			if (property === "getByName") {
				return (name: string, options?: DurableObjectNamespaceGetDurableObjectOptions) =>
					overrides.get(overrides.idFromName(name), options);
			}
			return passThrough(target, property);
		},
	}) as Namespace;
}

/**
 * A property of the stub or namespace as is, a method called on it. Never
 * `value.bind(target)`: on an RPC stub every property is remote, `bind`
 * included, so that would send the stub itself over RPC.
 */
function passThrough(target: object, property: string | symbol): unknown {
	const value = Reflect.get(target, property);
	return typeof value === "function" ? (...args: unknown[]) => Reflect.apply(value, target, args) : value;
}
