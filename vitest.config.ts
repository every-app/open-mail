// `pnpm test` runs two Vitest projects:
//
//   node     unit tests in Node: the gateway shims, identity, the tool
//            catalog, frontend helpers. Fakes stand in for bindings.
//   workers  tests inside workerd (@cloudflare/vitest-pool-workers) against
//            the real Durable Objects and a local R2 bucket, with the
//            production entry (workers/app.ts) as the Worker: inbound mail
//            through receiveEmail(), the MailboxDO migrations, the entry's
//            identity check.
//
// A test file goes to the workers project when it is named
// `*.workers.test.ts` or listed in WORKERS_TESTS; everything else is a node
// test. This file replaces vite.config.ts for Vitest, so the Cloudflare and
// React Router plugins never load under test.
import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";
import tsconfigPaths from "vite-tsconfig-paths";
import { configDefaults, defineConfig } from "vitest/config";
import manifest from "./everyapp.config.ts";

const WORKERS_TESTS = ["test/**/*.workers.test.ts", "test/receive-email.test.ts"];

// The workerd that @cloudflare/vitest-pool-workers 0.12 bundles (the last line
// for Vitest 3) supports compatibility dates up to 2026-03-10; deployed, the
// Worker runs on the platform default (2026-06-01). Raise this with the pool.
const TEST_COMPATIBILITY_DATE = "2026-03-10";

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [tsconfigPaths()],
        test: {
          name: "node",
          environment: "node",
          include: ["test/**/*.test.ts", "app/**/*.test.{ts,tsx}", "workers/**/*.test.ts"],
          exclude: [...configDefaults.exclude, ...WORKERS_TESTS],
        },
      },
      defineWorkersProject({
        plugins: [tsconfigPaths()],
        test: {
          name: "workers",
          include: WORKERS_TESTS,
          // Each test wakes real SQLite Durable Objects in workerd (inbound
          // mail wakes EmailAgent too): a few seconds a test on a busy
          // machine, past Vitest's 5 s default.
          testTimeout: 30_000,
          poolOptions: {
            workers: {
              // The production entry: its exports are the Durable Object
              // classes the bindings below resolve to.
              main: "./workers/app.ts",
              // Every test file in one Worker, sharing the DOs and the R2
              // bucket: use a fresh mailbox address per test. Isolated storage
              // stays off because the pool can't undo SQLite Durable Object
              // storage that is still open ("Expected .sqlite, got
              // ….sqlite-shm"), and receiveEmail() always wakes EmailAgent.
              singleWorker: true,
              isolatedStorage: false,
              miniflare: {
                compatibilityDate: TEST_COMPATIBILITY_DATE,
                compatibilityFlags: ["nodejs_compat"],
                // The manifest's SQLite Durable Objects, as everyAppWorker()
                // binds them on the deployed Worker.
                durableObjects: Object.fromEntries(
                  manifest.resources.durableObjects.map((d) => [
                    d.name,
                    { className: d.className, useSQLite: true },
                  ]),
                ),
                r2Buckets: ["BUCKET"],
                // The app's plain settings (cloudflare.config.ts) at their
                // defaults, and the identity settings `everyapp deploy` writes:
                // the audience is the Worker's name. No identity key is bound;
                // tests that need one pass EVERYAPP_IDENTITY_PUBLIC_KEYS in the
                // env they call the entry with.
                bindings: {
                  DOMAINS: "example.com",
                  EMAIL_ADDRESSES: [],
                  AI_PROVIDER: "",
                  AGENT_MODEL: "",
                  EVERYAPP_APP_ID: manifest.id,
                  EVERYAPP_AUDIENCE: `every-acme-${manifest.id}`,
                  EVERYAPP_IDENTITY_ISSUER: "https://gateway.example.com",
                },
              },
            },
          },
        },
      }),
    ],
  },
});
