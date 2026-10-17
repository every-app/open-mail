// `pnpm check:runbook`: every gateway secret docs/EVERY_APP.md tells the
// operator to set (`everyapp secret set NAME… --for gateway`) is one the
// command accepts, checked with the CLI's own assertSettableSecret(), offline.
//
// Run from the app with tsx, it reads the runbook and runs itself again
// through jiti from the CLI package (the pattern of scripts/policy-check.ts),
// where the CLI's TypeScript sources and their "@/..." imports resolve:
//
//   cd <checkout>/packages/cli && JITI_ALIAS='{"@":"<checkout>/packages/cli/src"}' \
//     node node_modules/jiti/lib/jiti-cli.mjs <app>/scripts/check-runbook-secrets.ts assert NAME…
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [mode, ...names] = process.argv.slice(2);

if (mode === "assert") {
	// Under jiti, from the CLI package.
	const secretsFile = path.join(process.cwd(), "src/lib/gateway/secretsFile.ts");
	const { assertSettableSecret } = (await import(secretsFile)) as {
		assertSettableSecret: (name: string) => void;
	};
	let refused = 0;
	for (const name of names) {
		try {
			assertSettableSecret(name);
			console.log(`ok   ${name}: everyapp secret set --for gateway accepts it`);
		} catch (error) {
			refused++;
			console.log(`FAIL ${name}: ${(error as Error).message}`);
		}
	}
	process.exit(refused === 0 ? 0 : 1);
}

const appDir = path.resolve(import.meta.dirname, "..");
const runbook = path.join(appDir, "docs/EVERY_APP.md");
const text = fs.readFileSync(runbook, "utf8");

// Each `everyapp secret set NAME… [--for gateway]` command, up to the end of
// its code span, table cell or line. One without `--for gateway` would set an
// app secret, and the runbook promises the app has none.
const gatewaySecrets = new Set<string>();
const appSecrets: string[] = [];
for (const match of text.matchAll(/everyapp secret set ([^`|\n]*)/g)) {
	const command = match[1]!;
	const secretNames = command.split(/\s+/).filter((word) => /^[A-Z][A-Z0-9_]*$/.test(word));
	if (/--for gateway\b/.test(command)) for (const name of secretNames) gatewaySecrets.add(name);
	else appSecrets.push(...secretNames);
}

if (gatewaySecrets.size === 0) {
	console.error(`FAIL no "everyapp secret set … --for gateway" command found in ${path.relative(appDir, runbook)}`);
	process.exit(1);
}
if (appSecrets.length > 0) {
	console.error(`FAIL the runbook sets app secrets (${appSecrets.join(", ")}); the app has none`);
	process.exit(1);
}

const cliDir = fs.realpathSync(path.join(appDir, "node_modules/everyapp"));
const run = spawnSync(
	process.execPath,
	[path.join(cliDir, "node_modules/jiti/lib/jiti-cli.mjs"), path.join(appDir, "scripts/check-runbook-secrets.ts"), "assert", ...gatewaySecrets],
	{
		cwd: cliDir,
		stdio: "inherit",
		env: { ...process.env, JITI_ALIAS: JSON.stringify({ "@": path.join(cliDir, "src") }) },
	},
);
if (run.status !== 0) {
	console.error("check:runbook FAILED");
	process.exit(1);
}
console.log(`check:runbook OK: ${gatewaySecrets.size} gateway secrets, no app secrets (${path.relative(appDir, runbook)})`);
