// Screenshots pages of a running `everyapp dev`, for UI review.
//
//   node scripts/shoot.mjs <gateway port> <out dir> <name>=<path>[@<width>x<height>][#dark] ...
//
// Each argument is one shot: `inbox=/mailbox/dev@example.com/emails/inbox`,
// `inbox-mobile=/mailbox/dev@example.com/emails/inbox@390x844`, a `#dark`
// suffix sets prefers-color-scheme: dark. For states that need clicks, import
// `launch` and `openPage` from this file in a script of your own.
//
// Playwright isn't a dependency here: set PLAYWRIGHT to a checkout's
// node_modules/@playwright/test (OpenSEO has one), or install it globally.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";

const require = createRequire(import.meta.url);
const playwrightPath =
	process.env.PLAYWRIGHT ?? "@playwright/test";
const { chromium } = require(playwrightPath);

// *.localhost may resolve to ::1: pin it to 127.0.0.1 in Chromium's resolver.
export function launch() {
	return chromium.launch({ args: ["--host-resolver-rules=MAP openmail.localhost 127.0.0.1"] });
}

export async function openPage(browser, port, path, { width = 1440, height = 900, dark = false } = {}) {
	const host = `openmail.localhost:${port}`;
	const context = await browser.newContext({
		viewport: { width, height },
		deviceScaleFactor: 2,
		colorScheme: dark ? "dark" : "light",
	});
	const page = await context.newPage();
	await page.goto(`http://${host}${path}`, { waitUntil: "networkidle" });
	await page.waitForTimeout(500);
	return page;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const [port, outDir, ...shots] = process.argv.slice(2);
	if (!port || !outDir || shots.length === 0) {
		console.error("usage: node scripts/shoot.mjs <gateway port> <out dir> <name>=<path>[@WxH][#dark] ...");
		process.exit(1);
	}
	mkdirSync(outDir, { recursive: true });
	const browser = await launch();
	for (const shot of shots) {
		const m = shot.match(/^([^=]+)=(.+?)(?:@(\d+)x(\d+))?(#dark)?$/);
		if (!m) throw new Error(`bad shot: ${shot}`);
		const [, name, path, w, h, dark] = m;
		const page = await openPage(browser, port, path, {
			width: w ? Number(w) : undefined,
			height: h ? Number(h) : undefined,
			dark: Boolean(dark),
		});
		const file = `${outDir}/${name}.png`;
		await page.screenshot({ path: file });
		console.log(file);
		await page.context().close();
	}
	await browser.close();
}
