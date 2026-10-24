// `pnpm check:deploy`: what `everyapp deploy` checks before it uploads, run
// offline. Nothing here talks to Cloudflare or a gateway.
//
//  1. `everyapp release --json` (the vendored CLI, vendor/README.md): installs
//     dependencies, validates everyapp.config.ts with the CLI's strict schema,
//     builds for production (`cf build`, logins hidden), installs the Build
//     Output for the build's placeholder target (the SDK's BUILD_SENTINEL),
//     runs the CLI's app policy and prepareAppBuildOutput() on it, checks the
//     migrations against the schema, and packs the release to a temp file;
//  2. reads the release's release.json: the manifest the CLI evaluated;
//  3. asserts the built worker.config.json: the Durable Object exports, the
//     bucket and audience named after the Worker, no triggers, no AI or
//     send-email binding, nodejs_compat;
//  4. removes the temp release again, whatever happened.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUILD_SENTINEL } from "@every-app/sdk/cloudflare";

// A release is tenant-neutral: the Worker, bucket and audience carry the
// build placeholder a deploy replaces with the real names.
const WORKER = BUILD_SENTINEL.workerName;
const appDir = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(appDir, ".cloudflare/output");
const workerConfigPath = path.join(outputDir, "v0/workers/default/worker.config.json");
const everyappBin = path.join(appDir, "node_modules/.bin/everyapp");

const failures: string[] = [];
function check(ok: boolean, what: string, detail?: unknown): void {
	console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok || detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
	if (!ok) failures.push(what);
}

// Hide cf's and wrangler's logins (and any token in the environment) from
// every child: this machine's cf is logged in to a real account.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-inbox-check-deploy-"));
const childEnv: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: path.join(scratch, "nologin"), CI: "1" };
for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL", "CF_API_TOKEN"]) {
	delete childEnv[name];
}
// The build reads these; the check covers the defaults.
for (const name of ["AI_PROVIDER", "AGENT_MODEL"]) delete childEnv[name];

interface CliEvent {
	type: string;
	step?: string;
	status?: string;
	code?: string;
	message?: string;
	data?: Record<string, unknown>;
}

/** Run `everyapp <args> --json` in the app and parse its events; throws on a non-zero exit with the output shown. */
function everyapp(what: string, args: string[]): CliEvent[] {
	console.log(`\n$ ${what}`);
	const res = spawnSync(everyappBin, [...args, "--json"], { cwd: appDir, env: childEnv, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	const events: CliEvent[] = [];
	for (const line of (res.stdout ?? "").split("\n")) {
		if (!line.trim()) continue;
		try {
			events.push(JSON.parse(line) as CliEvent);
		} catch {
			console.log(line);
		}
	}
	for (const event of events) {
		if (event.type === "step" && event.status === "ok") console.log(`  ${event.step}: ${event.message ?? "ok"}`);
		if (event.type === "warning") console.log(`  warning ${event.code}: ${event.message?.split("\n")[0]}`);
		if (event.type === "error") console.log(`  error ${event.code}: ${event.message}`);
	}
	if (res.status !== 0) {
		process.stdout.write(res.stderr ?? "");
		throw new Error(`${what} exited ${res.status ?? res.signal}`);
	}
	return events;
}

const tarball = path.join(scratch, "everyapp-release.tar.gz");
try {
	// A clean production build: no stale development output.
	fs.rmSync(outputDir, { recursive: true, force: true });
	fs.rmSync(path.join(appDir, "build"), { recursive: true, force: true });

	const events = everyapp("everyapp release", ["release", "--out", tarball]);
	const step = (name: string) => events.find((e) => e.type === "step" && e.step === name && e.status === "ok");
	const done = events.find((e) => e.type === "done");
	check(step("app.build") !== undefined, "cf build completes and the deploy policy accepts the Build Output (app.build ok)");
	// The inbox keeps its data in Durable Objects: no D1, so nothing emits app.schema; a D1 app would get the step, and a skip or failure is a warning or an error.
	const schema = events.filter((e) => e.step === "app.schema");
	check(schema.length === 0 || step("app.schema") !== undefined, "no D1 migrations, or they match the schema (app.schema ok)", schema);
	check(done?.data?.["version"] !== undefined && done?.data?.["sha256"] !== undefined, "the release is packed (done with version and sha256)", done?.data);
	const warnings = events.filter((e) => e.type === "warning").map((e) => e.code);
	check(warnings.length === 0, "no warnings from the release", warnings);

	const rootConfig = JSON.parse(fs.readFileSync(path.join(outputDir, "v0/config.json"), "utf8"));
	check(rootConfig.buildContext?.mode === "production", "Build Output is a production build", rootConfig);

	// The manifest as the CLI evaluated and validated it, from the release.
	const releaseJson = spawnSync("tar", ["-xOzf", tarball, "./release.json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	if (releaseJson.status !== 0) throw new Error(`tar couldn't read release.json: ${releaseJson.stderr}`);
	const release = JSON.parse(releaseJson.stdout) as {
		appId: string;
		manifest: { id: string; resources?: { durableObjects?: { className: string }[] }; email?: { inbound?: boolean } };
	};
	const manifest = release.manifest;
	const durableObjects = (manifest.resources?.durableObjects ?? []).map((d) => d.className);
	check(release.appId === "agentic-inbox" && manifest.id === "agentic-inbox", "manifest validates strictly (id agentic-inbox)", { appId: release.appId, id: manifest.id });
	check(manifest.email?.inbound === true, "email.inbound declares the Worker's email handler", manifest.email?.inbound);

	const config = JSON.parse(fs.readFileSync(workerConfigPath, "utf8")) as {
		name?: string;
		compatibilityFlags?: string[];
		triggers?: unknown[];
		env?: Record<string, { type: string; name?: string; value?: unknown }>;
		exports?: Record<string, { type?: string; storage?: string }>;
	};
	const env = config.env ?? {};
	const exportsSeen = Object.keys(config.exports ?? {}).sort();
	check(config.name === WORKER, `worker name is the build placeholder ${WORKER}`, config.name);
	check(
		JSON.stringify(exportsSeen) === JSON.stringify([...durableObjects].sort()) &&
			// Exactly these two: the MCP tools are a defineTools() catalog, not a Durable Object.
			JSON.stringify(exportsSeen) === JSON.stringify(["EmailAgent", "MailboxDO"]),
		`exports are the manifest's Durable Objects (${durableObjects.join(", ")})`,
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
	check(env["EMAIL_ADDRESSES"]?.type === "json" && JSON.stringify(env["EMAIL_ADDRESSES"].value) === "[]", "EMAIL_ADDRESSES is []", env["EMAIL_ADDRESSES"]);
	check(env["AI_PROVIDER"]?.type === "text" && env["AI_PROVIDER"].value === "workers-ai", "AI_PROVIDER defaults to workers-ai", env["AI_PROVIDER"]);
	const secrets = Object.entries(env).filter(([, b]) => b.type === "secret").map(([name]) => name).sort();
	check(JSON.stringify(secrets) === JSON.stringify(["EVERY_APP_ORG_ID", "GATEWAY_URL"]), "the only secrets are the platform's (GATEWAY_URL, EVERY_APP_ORG_ID)", secrets);
} catch (error) {
	failures.push(String((error as Error).message ?? error));
	console.error(`\nerror: ${(error as Error).message ?? error}`);
} finally {
	fs.rmSync(scratch, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.log(`\ncheck:deploy FAILED (${failures.length}): ${failures.join("; ")}`);
	process.exit(1);
}
console.log("\ncheck:deploy OK: the production Build Output passes the deploy policy offline.");
