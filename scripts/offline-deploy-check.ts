// `pnpm check:deploy`: what `everyapp deploy` checks before it uploads, run
// offline. Nothing here talks to Cloudflare or a gateway.
//
//  1. writes a fake .everyapp/deploy.json (the inputs `everyapp deploy`
//     writes from the gateway's registry; Worker every-acme-agentic-inbox,
//     the identity key in test/fixtures/identity.pem);
//  2. validates everyapp.config.ts with the CLI's strict schema;
//  3. builds for production (`cf build`), logins hidden;
//  4. runs the CLI's appPolicyProblems()/prepareAppBuildOutput() on the
//     Build Output (scripts/policy-check.ts, through jiti);
//  5. asserts the built worker.config.json: the Durable Object exports, the
//     bucket and audience named after the Worker, no triggers, no AI or
//     send-email binding, nodejs_compat;
//  6. removes deploy.json again, whatever happened.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const WORKER = "every-acme-agentic-inbox";
const appDir = path.resolve(import.meta.dirname, "..");
const deployJson = path.join(appDir, ".everyapp/deploy.json");
const outputDir = path.join(appDir, ".cloudflare/output");
const workerConfigPath = path.join(outputDir, "v0/workers/default/worker.config.json");

// The CLI is linked from the platform checkout (link:../private-every-app/packages/cli).
const cliDir = fs.realpathSync(path.join(appDir, "node_modules/everyapp"));
const jitiCli = path.join(cliDir, "node_modules/jiti/lib/jiti-cli.mjs");
const cfBin = path.join(appDir, "node_modules/.bin/cf");

const failures: string[] = [];
function check(ok: boolean, what: string, detail?: unknown): void {
	console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok || detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
	if (!ok) failures.push(what);
}

// Hide cf's and wrangler's logins (and any token in the environment) from
// every child: this machine's cf is logged in to a real account.
const noLogin = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-inbox-nologin-"));
const childEnv: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: noLogin, CI: "1" };
for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL", "CF_API_TOKEN"]) {
	delete childEnv[name];
}
// The build reads these; the check covers the defaults.
for (const name of ["AI_PROVIDER", "AGENT_MODEL", "INBOX_DOMAINS"]) delete childEnv[name];

function run(what: string, command: string, args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}): string {
	console.log(`\n$ ${what}`);
	const res = spawnSync(command, args, { cwd, env: { ...childEnv, ...extraEnv }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
	if (res.status !== 0) {
		process.stdout.write(output);
		throw new Error(`${what} exited ${res.status ?? res.signal}`);
	}
	return output;
}

function policyCheck(args: string[]): { output: string; result: unknown } {
	const output = run(`policy-check.ts ${args.join(" ")}`, process.execPath, [jitiCli, path.join(appDir, "scripts/policy-check.ts"), ...args], cliDir, {
		JITI_ALIAS: JSON.stringify({ "@": path.join(cliDir, "src") }),
	});
	const line = output.split("\n").reverse().find((l) => l.startsWith("RESULT "));
	if (!line) {
		process.stdout.write(output);
		throw new Error("policy-check.ts printed no RESULT line");
	}
	return { output, result: JSON.parse(line.slice("RESULT ".length)) };
}

if (fs.existsSync(deployJson)) {
	console.error(`${deployJson} exists (a real deploy's inputs?); refusing to overwrite it.`);
	process.exit(1);
}

let createdEveryappDir = false;
try {
	if (!fs.existsSync(path.dirname(deployJson))) {
		fs.mkdirSync(path.dirname(deployJson), { recursive: true });
		createdEveryappDir = true;
	}
	const identityKey = fs.readFileSync(path.join(appDir, "test/fixtures/identity.pem"), "utf8");
	fs.writeFileSync(
		deployJson,
		`${JSON.stringify(
			{
				schema: 1,
				workerName: WORKER,
				organizationId: "org_acme0000000000",
				gatewayUrl: "https://apps.example.com",
				identityIssuer: "https://apps.example.com",
				identityPublicKeys: [identityKey],
				resources: {},
				createdAt: new Date().toISOString(),
			},
			null,
			2,
		)}\n`,
	);

	const manifest = policyCheck(["manifest", appDir]).result as { id: string; durableObjects: string[] };
	check(manifest.id === "agentic-inbox", "manifest validates strictly (id agentic-inbox)", manifest);

	// A clean production build: no stale development output.
	fs.rmSync(outputDir, { recursive: true, force: true });
	fs.rmSync(path.join(appDir, "build"), { recursive: true, force: true });
	const buildLog = run("cf build (production)", cfBin, ["build"], appDir);
	check(/Build complete/i.test(buildLog), "cf build completes");

	const rootConfig = JSON.parse(fs.readFileSync(path.join(outputDir, "v0/config.json"), "utf8"));
	check(rootConfig.buildContext?.mode === "production", "Build Output is a production build", rootConfig);

	const policy = policyCheck(["build-output", appDir, WORKER]);
	process.stdout.write(policy.output.split("\n").filter((l) => /^(REFUSED|appPolicyProblems|prepareAppBuildOutput)/.test(l)).join("\n") + "\n");
	const verdict = policy.result as { ok: boolean; problems: string[]; prepared?: unknown };
	check(verdict.ok && verdict.problems.length === 0, "deploy policy accepts the Build Output", verdict);
	check(JSON.stringify(verdict.prepared) === JSON.stringify({ workflows: [], helperWorkflows: {} }), 'prepareAppBuildOutput -> {"workflows":[],"helperWorkflows":{}}', verdict.prepared);

	const config = JSON.parse(fs.readFileSync(workerConfigPath, "utf8")) as {
		name?: string;
		compatibilityFlags?: string[];
		triggers?: unknown[];
		env?: Record<string, { type: string; name?: string; value?: unknown }>;
		exports?: Record<string, { type?: string; storage?: string }>;
	};
	const env = config.env ?? {};
	const exportsSeen = Object.keys(config.exports ?? {}).sort();
	check(config.name === WORKER, `worker name is ${WORKER}`, config.name);
	check(
		JSON.stringify(exportsSeen) === JSON.stringify([...manifest.durableObjects].sort()) &&
			["MailboxDO", "EmailAgent"].every((c) => manifest.durableObjects.includes(c)) &&
			exportsSeen.every((c) => ["MailboxDO", "EmailAgent", "EmailMCP"].includes(c)),
		`exports are the manifest's Durable Objects (${manifest.durableObjects.join(", ")})`,
		exportsSeen,
	);
	check(
		Object.values(config.exports ?? {}).every((e) => e.type === "durable-object" && e.storage === "sqlite"),
		"every export is a SQLite Durable Object",
		config.exports,
	);
	check(env["BUCKET"]?.type === "r2" && env["BUCKET"].name === WORKER, "BUCKET is the R2 bucket named after the Worker", env["BUCKET"]);
	check(env["EVERYAPP_AUDIENCE"]?.type === "text" && env["EVERYAPP_AUDIENCE"].value === WORKER, "EVERYAPP_AUDIENCE is the Worker's name", env["EVERYAPP_AUDIENCE"]);
	check(!config.triggers || config.triggers.length === 0, "no triggers", config.triggers);
	const refusedKinds = Object.entries(env).filter(([name, b]) => name === "AI" || name === "EMAIL" || b.type === "ai" || b.type === "send-email");
	check(refusedKinds.length === 0, "no AI or send-email binding", refusedKinds);
	check((config.compatibilityFlags ?? []).includes("nodejs_compat"), "compatibilityFlags has nodejs_compat", config.compatibilityFlags);
	check(env["DOMAINS"]?.type === "text" && env["DOMAINS"].value === "example.com", "DOMAINS defaults to example.com", env["DOMAINS"]);
	check(env["EMAIL_ADDRESSES"]?.type === "json" && JSON.stringify(env["EMAIL_ADDRESSES"].value) === "[]", "EMAIL_ADDRESSES is []", env["EMAIL_ADDRESSES"]);
	check(env["AI_PROVIDER"]?.type === "text" && env["AI_PROVIDER"].value === "workers-ai", "AI_PROVIDER defaults to workers-ai", env["AI_PROVIDER"]);
	const secrets = Object.entries(env).filter(([, b]) => b.type === "secret").map(([name]) => name).sort();
	check(JSON.stringify(secrets) === JSON.stringify(["EVERY_APP_ORG_ID", "GATEWAY_URL"]), "the only secrets are the platform's (GATEWAY_URL, EVERY_APP_ORG_ID)", secrets);
} catch (error) {
	failures.push(String((error as Error).message ?? error));
	console.error(`\nerror: ${(error as Error).message ?? error}`);
} finally {
	fs.rmSync(deployJson, { force: true });
	if (createdEveryappDir) fs.rmSync(path.dirname(deployJson), { recursive: true, force: true });
	fs.rmSync(noLogin, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.log(`\ncheck:deploy FAILED (${failures.length}): ${failures.join("; ")}`);
	process.exit(1);
}
console.log("\ncheck:deploy OK: the production Build Output passes the deploy policy offline.");
