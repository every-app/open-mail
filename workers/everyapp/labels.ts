/**
 * The labels API, mounted by workers/index.ts right after upstream's
 * `requireMailbox` (so `c.var.mailboxStub` is set) and ahead of upstream's
 * email routes (so `GET …/emails?label=` is answered here).
 *
 * Every member of the organization may list, create, rename, recolor and
 * delete labels and label conversations: like moving and starring, none of
 * it touches mail (deleting a label only takes it off conversations).
 *
 *   GET    /api/v1/mailboxes/:mailboxId/labels                 → LabelWithCounts[]
 *   POST   /api/v1/mailboxes/:mailboxId/labels                 { name, color? } → 201 Label | 400 | 409
 *   PUT    /api/v1/mailboxes/:mailboxId/labels/:labelId        { name?, color? } → Label | 400 | 404 | 409
 *   DELETE /api/v1/mailboxes/:mailboxId/labels/:labelId        → 204 | 404
 *   POST   /api/v1/mailboxes/:mailboxId/threads/:threadKey/labels  { add?, remove? } (label ids)
 *                                                              → { threadKey, labels } | 404
 *   GET    /api/v1/mailboxes/:mailboxId/emails?label=<id>      → { emails, totalCount } (threaded)
 *   GET    /api/v1/mailboxes/:mailboxId/search?label=<name|id> → upstream's search, within the label
 *
 * The listings, search and single-email and thread reads carry each
 * conversation's `labels` from the Durable Object (workers/everyapp/mailbox.ts).
 */
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { MailboxContext } from "../lib/mailbox";
import { LABEL_COLORS, LABEL_NAME_MAX } from "./label-model";
import type { MailboxDO } from "./mailbox";

type LabelsContext = Context<MailboxContext>;

/** The mailbox's stub, typed with the port's subclass (upstream's middleware types upstream's class). */
export function labelsStub(c: LabelsContext): DurableObjectStub<MailboxDO> {
	return c.var.mailboxStub as unknown as DurableObjectStub<MailboxDO>;
}

const name = z.string().trim().min(1, "Label name is required").max(LABEL_NAME_MAX, `Label names are at most ${LABEL_NAME_MAX} characters`);
const color = z.enum(LABEL_COLORS);

const CreateLabelBody = z.object({ name, color: color.optional() });
const UpdateLabelBody = z
	.object({ name: name.optional(), color: color.optional() })
	.refine((b) => b.name !== undefined || b.color !== undefined, { message: "Give a name or a color" });
const ThreadLabelsBody = z.object({
	add: z.array(z.string().min(1)).max(100).optional(),
	remove: z.array(z.string().min(1)).max(100).optional(),
});

async function parseBody<T extends z.ZodTypeAny>(c: LabelsContext, schema: T): Promise<{ data: z.infer<T> } | { error: Response }> {
	const raw = await c.req.json().catch(() => undefined);
	const parsed = schema.safeParse(raw);
	if (!parsed.success) {
		const message = parsed.error.issues.map((i) => i.message).join("; ") || "Invalid request body";
		return { error: c.json({ error: message }, 400) };
	}
	return { data: parsed.data };
}

function intQuery(c: LabelsContext, key: string): number | undefined {
	const v = c.req.query(key);
	if (!v) return undefined;
	const n = Number(v);
	return Number.isNaN(n) ? undefined : n;
}

function boolQuery(c: LabelsContext, key: string): boolean | undefined {
	const v = c.req.query(key);
	if (v === undefined || v === "") return undefined;
	return v === "true" || v === "1";
}

const DUPLICATE = "A label with this name already exists";
const NOT_FOUND = "Label not found";

export const labelRoutes = new Hono<MailboxContext>();

labelRoutes.get("/api/v1/mailboxes/:mailboxId/labels", async (c) => c.json(await labelsStub(c).listLabels()));

labelRoutes.post("/api/v1/mailboxes/:mailboxId/labels", async (c) => {
	const body = await parseBody(c, CreateLabelBody);
	if ("error" in body) return body.error;
	const result = await labelsStub(c).createLabel(body.data.name, body.data.color);
	if (result.ok) return c.json(result.label, 201);
	return result.error === "duplicate" ? c.json({ error: DUPLICATE }, 409) : c.json({ error: "Invalid label name" }, 400);
});

labelRoutes.put("/api/v1/mailboxes/:mailboxId/labels/:labelId", async (c) => {
	const body = await parseBody(c, UpdateLabelBody);
	if ("error" in body) return body.error;
	const result = await labelsStub(c).updateLabel(c.req.param("labelId"), body.data);
	if (result.ok) return c.json(result.label);
	if (result.error === "not_found") return c.json({ error: NOT_FOUND }, 404);
	return result.error === "duplicate" ? c.json({ error: DUPLICATE }, 409) : c.json({ error: "Invalid label name" }, 400);
});

labelRoutes.delete("/api/v1/mailboxes/:mailboxId/labels/:labelId", async (c) => {
	const deleted = await labelsStub(c).deleteLabel(c.req.param("labelId"));
	return deleted ? c.body(null, 204) : c.json({ error: NOT_FOUND }, 404);
});

labelRoutes.post("/api/v1/mailboxes/:mailboxId/threads/:threadKey/labels", async (c) => {
	const body = await parseBody(c, ThreadLabelsBody);
	if ("error" in body) return body.error;
	const result = await labelsStub(c).labelThread(c.req.param("threadKey"), body.data.add ?? [], body.data.remove ?? []);
	if (result.ok) return c.json({ threadKey: result.threadKey, labels: result.labels });
	if (result.error === "unknown_labels") return c.json({ error: `Unknown label: ${result.ids.join(", ")}`, ids: result.ids }, 404);
	return c.json({ error: "Conversation not found" }, 404);
});

// A label's conversations; without `label`, upstream's listing answers.
labelRoutes.get("/api/v1/mailboxes/:mailboxId/emails", async (c, next) => {
	const labelParam = c.req.query("label");
	if (!labelParam) return next();
	const stub = labelsStub(c);
	const label = await stub.findLabel(labelParam);
	if (!label) return c.json({ error: NOT_FOUND }, 404);
	const emails = await stub.getThreadedEmailsByLabel(label.id, { page: intQuery(c, "page"), limit: intQuery(c, "limit") });
	const totalCount = await stub.countThreadedEmailsByLabel(label.id);
	return c.json({ emails, totalCount });
});

// `label:<name>` in search: upstream's filters within a label's
// conversations. An unknown label matches nothing, as in Gmail.
labelRoutes.get("/api/v1/mailboxes/:mailboxId/search", async (c, next) => {
	const labelParam = c.req.query("label");
	if (!labelParam) return next();
	const stub = labelsStub(c);
	const label = await stub.findLabel(labelParam);
	if (!label) return c.json({ emails: [], totalCount: 0 });
	const searchOpts = {
		query: c.req.query("query") || "", folder: c.req.query("folder"), from: c.req.query("from"),
		to: c.req.query("to"), subject: c.req.query("subject"), date_start: c.req.query("date_start"),
		date_end: c.req.query("date_end"), is_read: boolQuery(c, "is_read"),
		is_starred: boolQuery(c, "is_starred"), has_attachment: boolQuery(c, "has_attachment"),
		label_id: label.id,
	};
	const emails = await stub.searchEmails({ ...searchOpts, page: intQuery(c, "page"), limit: intQuery(c, "limit") });
	const totalCount = await stub.countSearchResults(searchOpts);
	return c.json({ emails, totalCount });
});
