// One chat turn with a mailbox's agent over its WebSocket, as the chat
// panel sends it (@cloudflare/ai-chat's cf_agent_use_chat_request), through
// `everyapp dev`'s gateway-lite:
//   node scripts/chat-probe.mjs <ws url> <host header> <origin> "<message>"
// e.g. node scripts/chat-probe.mjs ws://127.0.0.1:8787/agents/email-agent/dev@example.com \
//        agentic-inbox.localhost:8787 http://agentic-inbox.localhost:8787 "Any unread emails?"
// Prints the reply's text and tool calls. Exit 0 when the reply finished
// without a stream error, 1 otherwise.
import WebSocket from "ws";

const [url, host, origin, text] = process.argv.slice(2);
if (!url || !text) {
	console.error('usage: node scripts/chat-probe.mjs <ws url> <host header> <origin> "<message>"');
	process.exit(1);
}
const headers = {};
if (host) headers.Host = host;
if (origin) headers.Origin = origin;

const requestId = `probe-${Date.now()}`;
const ws = new WebSocket(url, { headers, handshakeTimeout: 10_000 });
let reply = "";
const tools = [];
let failed = null;

ws.on("open", () => {
	const message = { id: `m-${Date.now()}`, role: "user", parts: [{ type: "text", text }] };
	ws.send(
		JSON.stringify({
			id: requestId,
			type: "cf_agent_use_chat_request",
			init: { method: "POST", body: JSON.stringify({ id: "probe-chat", messages: [message], trigger: "submit-message" }) },
		}),
	);
});
ws.on("message", (data) => {
	let msg;
	try {
		msg = JSON.parse(String(data));
	} catch {
		return;
	}
	if (msg.type !== "cf_agent_use_chat_response" || msg.id !== requestId) return;
	if (msg.error) failed = msg.body || "stream error";
	if (msg.body?.trim()) {
		try {
			const chunk = JSON.parse(msg.body);
			if (chunk.type === "text-delta") reply += chunk.delta;
			if (chunk.type === "tool-input-available") tools.push({ tool: chunk.toolName, input: chunk.input });
			if (chunk.type === "tool-output-available") tools.push({ output: chunk.output });
			if (chunk.type === "error") failed = chunk.errorText;
		} catch {
			// a plain-text body
		}
	}
	if (msg.done || msg.error) {
		console.log(JSON.stringify({ reply, tools, error: failed }, null, 2));
		ws.close(1000, "probe done");
		process.exit(failed ? 1 : 0);
	}
});
ws.on("unexpected-response", (_req, res) => {
	console.error("refused", res.statusCode);
	process.exit(1);
});
ws.on("error", (error) => {
	console.error("error", error.message);
	process.exit(1);
});
setTimeout(() => {
	console.error("timeout", JSON.stringify({ reply, tools, error: failed }));
	process.exit(1);
}, 60_000);
