// A fake Gmail REST API behind the gateway, for gmailClient()'s `fetcher`:
// messages, drafts, labels (with colors; create, patch, delete) and history
// in memory, every call recorded, and refusals on demand (the route rules'
// method refusal, a connection that needs a reconnect, a label color Gmail
// won't take).
import { toBase64Url, type GmailHistoryRecord, type GmailLabel } from "../../workers/everyapp/gmail/client";

export interface FakeMessage {
	id: string;
	threadId: string;
	labelIds: string[];
	raw: string;
	internalDate: string;
}

export interface Call {
	method: string;
	path: string;
	query: Record<string, string>;
	body: any;
}

export function rfc822({
	from = "alice@example.org",
	to = "me@example.com",
	subject = "Hello",
	body = "Hi there",
	messageId,
	inReplyTo,
	attachment,
}: {
	from?: string;
	to?: string;
	subject?: string;
	body?: string;
	messageId?: string;
	inReplyTo?: string;
	attachment?: { filename: string; content: string };
} = {}): string {
	const headers = [
		`From: ${from}`,
		`To: ${to}`,
		`Subject: ${subject}`,
		`Date: Thu, 30 Oct 2026 10:00:00 +0000`,
		...(messageId ? [`Message-ID: <${messageId}>`] : []),
		...(inReplyTo ? [`In-Reply-To: <${inReplyTo}>`, `References: <${inReplyTo}>`] : []),
		"MIME-Version: 1.0",
	];
	if (!attachment) return [...headers, "Content-Type: text/plain; charset=UTF-8", "", body].join("\r\n");
	return [
		...headers,
		'Content-Type: multipart/mixed; boundary="b1"',
		"",
		"--b1",
		"Content-Type: text/plain; charset=UTF-8",
		"",
		body,
		"--b1",
		`Content-Type: text/plain; name="${attachment.filename}"`,
		`Content-Disposition: attachment; filename="${attachment.filename}"`,
		"Content-Transfer-Encoding: base64",
		"",
		btoa(attachment.content),
		"--b1--",
	].join("\r\n");
}

export function fakeGmail(address = "me@example.com") {
	const messages = new Map<string, FakeMessage>();
	const drafts = new Map<string, string>(); // draft id → message id
	const labels: GmailLabel[] = [
		{ id: "INBOX", name: "INBOX", type: "system" },
		{ id: "SENT", name: "SENT", type: "system" },
		{ id: "DRAFT", name: "DRAFT", type: "system" },
		{ id: "UNREAD", name: "UNREAD", type: "system" },
		{ id: "STARRED", name: "STARRED", type: "system" },
		{ id: "TRASH", name: "TRASH", type: "system" },
		{ id: "Label_1", name: "Customers", type: "user" },
	];
	const calls: Call[] = [];
	const state = {
		historyId: 1000,
		history: [] as GmailHistoryRecord[],
		historyExpired: false,
		/** Methods Gmail fails with a 503 (a call that should stay queued). */
		failMethods: new Set<string>(),
		/** Every call answers 409 integration_not_connected. */
		disconnected: false,
		/** labels.create and labels.patch answer 400 to any color, as Gmail does to one off its palette. */
		refuseColors: false,
		nextId: 1,
	};

	const add = (m: Partial<FakeMessage> & { raw: string }): FakeMessage => {
		let id = m.id;
		while (!id || (!m.id && messages.has(id))) id = `gm${state.nextId++}`;
		const message: FakeMessage = {
			id,
			threadId: m.threadId ?? `t-${id}`,
			labelIds: m.labelIds ?? ["INBOX", "UNREAD"],
			raw: m.raw,
			internalDate: m.internalDate ?? String(Date.now()),
		};
		messages.set(id, message);
		return message;
	};

	const refusal = (status: number, code: string, message: string) =>
		Response.json({ error: "Refused", code, message }, { status, headers: { "x-everyapp-error": code } });
	const badColor = () =>
		Response.json({ error: { code: 400, message: "Label color is not on the allowed palette", errors: [{ reason: "invalidArgument" }] } }, { status: 400 });
	const notFound = () => Response.json({ error: { code: 404, message: "Not Found", errors: [{ reason: "notFound" }] } }, { status: 404 });
	const view = (m: FakeMessage, format?: string) =>
		format === "raw" ? { ...m, raw: toBase64Url(m.raw) } : { id: m.id, threadId: m.threadId, labelIds: m.labelIds };
	const modify = (m: FakeMessage, add: string[] = [], remove: string[] = []) => {
		m.labelIds = [...m.labelIds.filter((l) => !remove.includes(l)), ...add.filter((l) => !m.labelIds.includes(l))];
		return m;
	};
	const rawText = (raw: string) => new TextDecoder().decode(Uint8Array.from(atob(raw.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

	const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		const path = url.pathname.replace(/^\/gmail\/v1\/users\/me/, "");
		const text = request.method === "GET" ? "" : await request.text();
		const body = text ? JSON.parse(text) : undefined;
		calls.push({ method: request.method, path, query: Object.fromEntries(url.searchParams), body });
		if (state.disconnected) return refusal(409, "integration_not_connected", "Connect Google again.");
		if (state.failMethods.has(request.method)) {
			return Response.json({ error: { code: 503, message: "Backend Error", status: "UNAVAILABLE" } }, { status: 503 });
		}
		const get = request.method === "GET";
		let m: RegExpMatchArray | null;

		if (get && path === "/profile") return Response.json({ emailAddress: address, messagesTotal: messages.size, threadsTotal: 0, historyId: String(state.historyId) });
		if (get && path === "/labels") return Response.json({ labels });
		if (request.method === "POST" && path === "/labels") {
			if (body.color && state.refuseColors) return badColor();
			if (labels.some((l) => l.name.toLowerCase() === String(body.name).toLowerCase())) {
				return Response.json({ error: { code: 409, message: "Label name exists or conflicts", errors: [{ reason: "conflict" }] } }, { status: 409 });
			}
			let id = `Label_${state.nextId++}`;
			while (labels.some((l) => l.id === id)) id = `Label_${state.nextId++}`;
			const label: GmailLabel = { id, name: body.name, type: "user", ...(body.color ? { color: body.color } : {}) };
			labels.push(label);
			return Response.json(label);
		}
		if (request.method === "PATCH" && (m = path.match(/^\/labels\/([^/]+)$/))) {
			const label = labels.find((l) => l.id === decodeURIComponent(m![1]));
			if (!label) return notFound();
			if (body.color && state.refuseColors) return badColor();
			if (body.name !== undefined) label.name = body.name;
			if (body.color !== undefined) label.color = body.color;
			return Response.json(label);
		}
		if (request.method === "DELETE" && (m = path.match(/^\/labels\/([^/]+)$/))) {
			const id = decodeURIComponent(m[1]);
			const at = labels.findIndex((l) => l.id === id);
			if (at < 0) return notFound();
			labels.splice(at, 1);
			for (const msg of messages.values()) msg.labelIds = msg.labelIds.filter((l) => l !== id);
			return new Response(null, { status: 204 });
		}
		if (get && path === "/messages") {
			const all = [...messages.values()].filter((x) => !x.labelIds.includes("DRAFT")).reverse();
			const size = Number(url.searchParams.get("maxResults") ?? 100);
			const start = Number(url.searchParams.get("pageToken") ?? 0);
			const page = all.slice(start, start + size);
			return Response.json({
				messages: page.map((x) => ({ id: x.id, threadId: x.threadId })),
				...(start + size < all.length ? { nextPageToken: String(start + size) } : {}),
			});
		}
		if (get && (m = path.match(/^\/messages\/([^/]+)$/))) {
			const msg = messages.get(decodeURIComponent(m[1]));
			return msg ? Response.json(view(msg, url.searchParams.get("format") ?? undefined)) : notFound();
		}
		if (request.method === "POST" && (m = path.match(/^\/messages\/([^/]+)\/modify$/))) {
			const msg = messages.get(m[1]);
			return msg ? Response.json(view(modify(msg, body.addLabelIds, body.removeLabelIds))) : notFound();
		}
		if (request.method === "POST" && (m = path.match(/^\/messages\/([^/]+)\/(trash|untrash)$/))) {
			const msg = messages.get(m[1]);
			if (!msg) return notFound();
			return Response.json(view(m[2] === "trash" ? modify(msg, ["TRASH"], ["INBOX"]) : modify(msg, [], ["TRASH"])));
		}
		if (request.method === "POST" && (m = path.match(/^\/threads\/([^/]+)\/modify$/))) {
			for (const msg of messages.values()) if (msg.threadId === m[1]) modify(msg, body.addLabelIds, body.removeLabelIds);
			return Response.json({ id: m[1] });
		}
		if (get && path === "/drafts") {
			return Response.json({ drafts: [...drafts].map(([id, mid]) => ({ id, message: { id: mid, threadId: messages.get(mid)!.threadId } })) });
		}
		if (request.method === "POST" && path === "/drafts") {
			const msg = add({ raw: rawText(body.message.raw), threadId: body.message.threadId, labelIds: ["DRAFT"] });
			const id = `d${state.nextId++}`;
			drafts.set(id, msg.id);
			return Response.json({ id, message: view(msg) });
		}
		if (request.method === "PUT" && (m = path.match(/^\/drafts\/([^/]+)$/))) {
			const old = drafts.get(m[1]);
			if (!old) return notFound();
			messages.delete(old);
			const msg = add({ raw: rawText(body.message.raw), threadId: body.message.threadId, labelIds: ["DRAFT"] });
			drafts.set(m[1], msg.id);
			return Response.json({ id: m[1], message: view(msg) });
		}
		if (request.method === "DELETE" && (m = path.match(/^\/drafts\/([^/]+)$/))) {
			const old = drafts.get(m[1]);
			if (!old) return notFound();
			drafts.delete(m[1]);
			messages.delete(old);
			return new Response(null, { status: 204 });
		}
		if (request.method === "POST" && path === "/messages/send") {
			const msg = add({ raw: rawText(body.raw), threadId: body.threadId, labelIds: ["SENT"] });
			return Response.json(view(msg));
		}
		if (get && path === "/history") {
			if (state.historyExpired) return notFound();
			const records = state.history;
			state.history = [];
			return Response.json({ history: records, historyId: String(state.historyId) });
		}
		return Response.json({ error: { message: `fake gmail: no route for ${request.method} ${path}` } }, { status: 400 });
	};

	return { fetch: fetch as typeof globalThis.fetch, messages, drafts, labels, calls, state, add, rawText };
}

export type FakeGmail = ReturnType<typeof fakeGmail>;
