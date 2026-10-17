// The deploy's own checks, offline, with the Every App CLI's modules. Run by
// scripts/offline-deploy-check.ts through jiti from the CLI package, so the
// CLI's source (its "@/..." imports) and dependencies resolve:
//
//   cd <checkout>/packages/cli && JITI_ALIAS='{"@":"<checkout>/packages/cli/src"}' \
//     node node_modules/jiti/lib/jiti-cli.mjs <app>/scripts/policy-check.ts manifest <app>
//   … policy-check.ts build-output <app> <worker name>
//
// `manifest` validates everyapp.config.ts as strictly as `everyapp dev` and
// `everyapp deploy` do. `build-output` runs appPolicyProblems() and
// prepareAppBuildOutput() on the production Build Output in
// <app>/.cloudflare/output, as `everyapp deploy` does before it uploads.
// The last line printed is `RESULT <json>`.
import path from "node:path";

const [mode, appDir, workerName] = process.argv.slice(2);
const cliSrc = path.join(process.cwd(), "src");

// Imported by path: these are the CLI's TypeScript sources, which only
// resolve inside the CLI package (with the "@" alias), not from this app.
type Module = Record<string, (...args: never[]) => unknown>;
const cliModule = (name: string) => import(path.join(cliSrc, name)) as Promise<Module>;

function result(value: unknown): void {
	console.log(`RESULT ${JSON.stringify(value)}`);
}

if (!appDir || (mode !== "manifest" && mode !== "build-output")) {
	console.error("usage: policy-check.ts manifest <app dir> | build-output <app dir> <worker name>");
	process.exit(2);
}

if (mode === "manifest") {
	const { loadEveryAppManifest } = await cliModule("lib/manifest.ts");
	const manifest = (await (loadEveryAppManifest as (cwd: string) => Promise<unknown>)(appDir)) as {
		id: string;
		resources?: { durableObjects?: { className: string }[] };
		capabilities?: { email?: { senders?: string[] } };
		email?: { inbound?: string[] };
	};
	result({
		id: manifest.id,
		durableObjects: (manifest.resources?.durableObjects ?? []).map((d) => d.className),
		senders: manifest.capabilities?.email?.senders ?? [],
		inbound: manifest.email?.inbound ?? [],
	});
} else {
	if (!workerName) throw new Error("build-output needs the worker name");
	const fs = await import("node:fs");
	const { appPolicyProblems, prepareAppBuildOutput } = await cliModule("lib/app/policy.ts");
	const inputs = { workerName, resources: {} };
	const configPath = path.join(appDir, ".cloudflare/output/v0/workers/default/worker.config.json");
	const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
	const problems = (appPolicyProblems as (c: unknown, i: unknown) => string[])(config, inputs);
	for (const problem of problems) console.log(`REFUSED: ${problem}`);
	console.log(`appPolicyProblems: ${problems.length === 0 ? "(none)" : problems.length}`);
	try {
		const prepared = await (prepareAppBuildOutput as (o: unknown) => Promise<unknown>)({ cwd: appDir, inputs });
		console.log(`prepareAppBuildOutput OK ${JSON.stringify(prepared)}`);
		result({ ok: true, problems, prepared });
	} catch (error) {
		const e = error as { code?: string; message?: string };
		console.log(`prepareAppBuildOutput THROWN ${e.code ?? ""}\n${e.message ?? String(error)}`);
		result({ ok: false, problems, error: { code: e.code, message: e.message } });
	}
}
