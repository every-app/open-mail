// `pnpm check:runbook`: every setting docs/EVERY_APP.md tells the operator to
// set (`everyapp secret set NAME…`) is a Gateway setting the command accepts.
// `everyapp secret set` routes each name by itself (a Gateway setting goes to
// the Gateway Worker from any directory, any other name to the app in the
// current directory), so a name that isn't one would be taken for an app
// secret, and the runbook promises the app has none. The list is the SDK's
// own (`SETTABLE_GATEWAY_SETTINGS` in `@every-app/sdk/internal`, what the
// CLI consults), less the settings `everyapp setup` owns. Offline.
import fs from "node:fs";
import path from "node:path";
import { isInstallOwnedGatewaySetting, isSettableGatewaySetting } from "@every-app/sdk/internal";

const appDir = path.resolve(import.meta.dirname, "..");
const runbook = path.join(appDir, "docs/EVERY_APP.md");
const text = fs.readFileSync(runbook, "utf8");

// Each `everyapp secret set NAME…` command, up to the end of its code span,
// table cell or line; the names are its words in capitals.
const names = new Set<string>();
for (const match of text.matchAll(/everyapp secret set ([^`|\n]*)/g)) {
	for (const word of match[1]!.split(/\s+/)) if (/^[A-Z][A-Z0-9_]*$/.test(word)) names.add(word);
}

if (names.size === 0) {
	console.error(`FAIL no "everyapp secret set NAME" command found in ${path.relative(appDir, runbook)}`);
	process.exit(1);
}

let refused = 0;
for (const name of names) {
	if (isSettableGatewaySetting(name) && !isInstallOwnedGatewaySetting(name)) {
		console.log(`ok   ${name}: a Gateway setting everyapp secret set accepts`);
	} else {
		refused++;
		const why = isInstallOwnedGatewaySetting(name)
			? "everyapp setup owns it"
			: "not a Gateway setting; the CLI would take it for an app secret, and the app has none";
		console.log(`FAIL ${name}: ${why}`);
	}
}
if (refused > 0) {
	console.error("check:runbook FAILED");
	process.exit(1);
}
console.log(`check:runbook OK: ${names.size} Gateway settings, no app secrets (${path.relative(appDir, runbook)})`);
