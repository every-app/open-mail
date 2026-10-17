// WebSocket probe through `everyapp dev`'s gateway-lite:
//   node scripts/ws-probe.mjs <ws url> [host header] [origin]
// Prints the upgrade and the first messages. Exit 0 when the socket opened
// and the agent announced itself (cf_agent_identity), 2 when the upgrade was
// refused (no 101: an error status, or, under `everyapp dev`, a closed
// connection, since the Vite dev server drops a refused upgrade's response),
// 1 otherwise.
import WebSocket from "ws";

const [url, host, origin] = process.argv.slice(2);
if (!url) {
	console.error("usage: node scripts/ws-probe.mjs <ws url> [host header] [origin]");
	process.exit(1);
}
const headers = {};
if (host) headers.Host = host;
if (origin) headers.Origin = origin;

const t0 = Date.now();
const log = (...args) => console.log(`[${Date.now() - t0}ms]`, ...args);
let identified = false;
let upgraded = false;

const ws = new WebSocket(url, { headers, handshakeTimeout: 10_000 });
ws.on("upgrade", (res) => {
	upgraded = true;
	log("upgrade", res.statusCode);
});
ws.on("unexpected-response", (_req, res) => {
	let body = "";
	res.on("data", (chunk) => (body += chunk));
	res.on("end", () => {
		log("refused", res.statusCode, body.slice(0, 300));
		process.exit(2);
	});
});
ws.on("open", () => log("open"));
ws.on("message", (data) => {
	const text = String(data);
	log("message", text.slice(0, 300));
	try {
		if (JSON.parse(text).type === "cf_agent_identity") {
			identified = true;
			ws.close(1000, "probe done");
		}
	} catch {
		// not JSON
	}
});
ws.on("error", (error) => {
	log("error", error.message);
	if (!upgraded) {
		log("refused (no upgrade)");
		process.exit(2);
	}
});
ws.on("close", (code) => {
	log("close", code);
	process.exit(identified ? 0 : upgraded ? 1 : 2);
});
setTimeout(() => {
	log("timeout");
	ws.terminate();
	process.exit(identified ? 0 : 1);
}, 8_000);
