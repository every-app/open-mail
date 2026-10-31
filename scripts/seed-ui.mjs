// Seeds a mailbox with a realistic spread of mail for UI work and screenshots,
// under `pnpm everyapp dev`.
//
//   node scripts/seed-ui.mjs <gateway port> <app Vite port> [mailbox address]
//
// Creates the mailbox (as the dev owner) if it is missing, then delivers a
// dozen messages through the app's email() handler: plain and HTML bodies,
// an attachment, a three-message thread, a long subject, and a few senders,
// spread over the last two weeks. Run it once per fresh dev state.
import { request } from "node:http";

const [gwPort, appPort, to = "dev@example.com"] = process.argv.slice(2);
if (!gwPort || !appPort) {
	console.error("usage: node scripts/seed-ui.mjs <gateway port> <app Vite port> [mailbox address]");
	process.exit(1);
}

function http(port, host, method, path, body, headers = {}) {
	return new Promise((resolve, reject) => {
		const req = request(
			{ host: "127.0.0.1", port, method, path, headers: { host, ...headers } },
			(res) => {
				let data = "";
				res.on("data", (c) => (data += c));
				res.on("end", () => resolve({ status: res.statusCode, body: data }));
			},
		);
		req.on("error", reject);
		if (body) req.write(body);
		req.end();
	});
}

const gwHost = `openmail.localhost:${gwPort}`;
const created = await http(
	gwPort,
	gwHost,
	"POST",
	"/api/v1/mailboxes",
	JSON.stringify({ name: "Dev", email: to }),
	{ "content-type": "application/json", origin: `http://${gwHost}` },
);
console.log(`mailbox ${to}: ${created.status === 201 ? "created" : created.status === 409 ? "exists" : `${created.status} ${created.body}`}`);

const now = Date.now();
const day = 86_400_000;
const hour = 3_600_000;
let n = 0;

function eml({ from, subject, text, html, ago, inReplyTo, references, id, attachment }) {
	const messageId = id ?? `seed-${now}-${n++}@example.org`;
	const date = new Date(now - ago).toUTCString();
	const lines = [
		`From: ${from}`,
		`To: Dev <${to}>`,
		`Subject: ${subject}`,
		`Date: ${date}`,
		`Message-ID: <${messageId}>`,
		...(inReplyTo ? [`In-Reply-To: <${inReplyTo}>`] : []),
		...(references ? [`References: ${references.map((r) => `<${r}>`).join(" ")}`] : []),
		"MIME-Version: 1.0",
	];
	const alt = [
		"Content-Type: multipart/alternative; boundary=alt",
		"",
		"--alt",
		"Content-Type: text/plain; charset=utf-8",
		"",
		text,
		"",
		"--alt",
		"Content-Type: text/html; charset=utf-8",
		"",
		html ?? text.split("\n\n").map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join(""),
		"",
		"--alt--",
	];
	if (!attachment) return { messageId, raw: [...lines, ...alt].join("\r\n") };
	return {
		messageId,
		raw: [
			...lines,
			"Content-Type: multipart/mixed; boundary=mixed",
			"",
			"--mixed",
			...alt,
			"",
			"--mixed",
			`Content-Type: ${attachment.type}; name="${attachment.name}"`,
			`Content-Disposition: attachment; filename="${attachment.name}"`,
			"Content-Transfer-Encoding: base64",
			"",
			Buffer.from(attachment.content).toString("base64"),
			"--mixed--",
		].join("\r\n"),
	};
}

async function deliver(msg, fromAddr) {
	const res = await http(
		appPort,
		`127.0.0.1:${appPort}`,
		"POST",
		`/cdn-cgi/local/email?from=${encodeURIComponent(fromAddr)}&to=${encodeURIComponent(to)}`,
		msg.raw,
	);
	if (res.status >= 300) console.log(`  deliver failed ${res.status} ${res.body.slice(0, 200)}`);
	return msg.messageId;
}

// Made-up people and companies (example domains only): never real mail.
const singles = [
	["Avery Stone <avery@northwind.example>", "Moving the roadmap review to Thursday?", "Hi,\n\nThursday at 2pm works better for the design team. Does that work for you?\n\nAvery", 2 * day + 3 * hour],
	["Code Host <noreply@codehost.example>", "[demo-app] Pull request #42 merged: sidebar polish", "Your pull request was merged.\n\nView it online.", 1 * day + 7 * hour],
	["Payments <receipts@payments.example>", "Your receipt from Example Co. #1001-2002", "Amount paid: $49.00\nDate paid: today\n\nThanks for your business.", 20 * hour],
	["Jordan Reyes <jordan@acme.example>", "Partnership idea", "Hey,\n\nLoved the demo last week. Any chance we could integrate with our support desk? Happy to jump on a call.\n\nJordan", 9 * hour],
	["Tracker <notifications@tracker.example>", "3 issues assigned to you this week", "DEMO-112 Empty state\nDEMO-118 Shortcuts sheet\nDEMO-121 Minimize button", 5 * hour],
	["Morgan Lee <morgan@vendor.example>", "Re: A very long subject line to check how the list truncates text that runs past the end of the row", "Hi,\n\nJust checking in on the two documents from last week. Could you send both by Friday?\n\nMorgan", 3 * day],
	["Riley Chen <riley@studio.example>", "Mockups for the new onboarding", "Attached are the latest mockups. Let me know what you think!\n\nRiley", 4 * hour, { name: "onboarding-mockups.pdf", type: "application/pdf", content: "%PDF-1.4 fake mockups" }],
	["Newsletter <hello@news.example>", "This week on the blog: five things we shipped", "Five things we shipped this week, and what's coming next.", 6 * day],
	["Sam Patel <sam@customer.example>", "Can't find my invoice", "Hi there, I need last month's invoice for my accountant. Where can I download it?\n\nSam", 50 * 60_000],
];

for (const [from, subject, text, ago, attachment] of singles) {
	const addr = from.match(/<(.+)>/)[1];
	await deliver(eml({ from, subject, text, ago, attachment }), addr);
}

// A three-message thread.
const a = await deliver(
	eml({ from: "Casey Brooks <casey@agency.example>", subject: "Launch checklist", text: "Hi,\n\nQuick question about the launch checklist. Who owns the final review?\n\nCasey", ago: 2 * day }),
	"casey@agency.example",
);
const b = await deliver(
	eml({ from: "Taylor Kim <taylor@example.org>", subject: "Re: Launch checklist", text: "Hi Casey, I can take this one. I'll send the list tomorrow.\n\nTaylor", ago: 1 * day + 2 * hour, inReplyTo: a, references: [a] }),
	"taylor@example.org",
);
await deliver(
	eml({ from: "Casey Brooks <casey@agency.example>", subject: "Re: Launch checklist", text: "Thanks Taylor. Please copy me when it's done.\n\nCasey", ago: 2 * hour, inReplyTo: b, references: [a, b] }),
	"casey@agency.example",
);

console.log(`seeded ${singles.length + 3} messages into ${to}`);
