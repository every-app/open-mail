// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * React Router's build under the Cloudflare Vite plugin 2.x.
 *
 * The plugin writes the client build into the Build Output
 * (.cloudflare/output/v0/workers/default/assets), but React Router's plugin
 * reads the client manifest from its own buildDirectory
 * (build/client/.vite/manifest.json) when it builds the SSR environment, so
 * `cf build` fails with "Could not load virtual:react-router/server-manifest
 * … ENOENT … build/client/.vite/manifest.json" (React Router 7.13.1 and
 * 8.4.0 alike). This mirrors the manifest there after the client build, and
 * mirrors what React Router's SSR step writes into build/client/assets (the
 * browser route manifest, server-only CSS) back into the Build Output's
 * assets, which is all a deployed Worker serves.
 *
 * TODO: file upstream (remix-run/react-router and cloudflare/workers-sdk):
 * "React Router framework-mode build under @cloudflare/vite-plugin 2.x:
 * client manifest ENOENT"; React Router should read the client manifest from
 * the client environment's resolved outDir. Drop this shim once it does.
 */
function reactRouterBuildOutputShim(): Plugin {
  return {
    name: "openmail:react-router-build-output-shim",
    apply: "build",
    writeBundle(options) {
      if (this.environment?.name !== "client") return;
      const outDir = options.dir ?? this.environment.config.build.outDir;
      const src = path.join(outDir, ".vite", "manifest.json");
      const dest = path.resolve("build/client/.vite/manifest.json");
      if (!fs.existsSync(src)) return;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    },
    closeBundle() {
      if (this.environment?.name !== "ssr") return;
      const from = path.resolve("build/client/assets");
      const to = path.resolve(".cloudflare/output/v0/workers/default/assets/assets");
      if (!fs.existsSync(from) || !fs.existsSync(path.dirname(to))) return;
      fs.mkdirSync(to, { recursive: true });
      for (const file of fs.readdirSync(from)) {
        if (!fs.existsSync(path.join(to, file))) fs.copyFileSync(path.join(from, file), path.join(to, file));
      }
    },
  };
}

// Under Vitest neither the Worker nor React Router's app is built: the
// Cloudflare plugin's everyAppWorker() refuses Vitest's "test" mode, and
// React Router's plugin isn't meant to run in tests.
const vitest = Boolean(process.env.VITEST);

export default defineConfig({
  server: {
    // `cf dev` forwards no port flag; `everyapp dev` passes the port in PORT.
    host: "127.0.0.1",
    port: Number(process.env.PORT ?? 5173),
    strictPort: true,
  },
  // Source maps for the Worker bundle only: "hidden" leaves no
  // sourceMappingURL and keeps maps out of the public assets. The deploy
  // uploads them so Workers logs point at source lines.
  environments: {
    ssr: { build: { sourcemap: "hidden" } },
  },
  plugins: [
    // Reads cloudflare.config.ts. Local dev never touches remote resources.
    !vitest && cloudflare({ viteEnvironment: { name: "ssr" }, remoteBindings: false }),
    !vitest && reactRouterBuildOutputShim(),
    tailwindcss(),
    !vitest && reactRouter(),
    tsconfigPaths(),
  ],
});
