import { bindings, defineConfig } from "cf/config";
import { everyAppWorker } from "@every-app/sdk/cloudflare";
import manifest from "./everyapp.config.ts";

// The Worker definition comes from everyapp.config.ts; the app adds its
// bucket and its plain settings. Nothing the Worker imports may be imported
// here: in dev the Cloudflare Vite plugin hides this file's imports from the
// Worker. No secrets, no triggers and no `ai`/`send-email` bindings: the
// deploy refuses all three, and the gateway brokers AI and mail instead
// (withGateway() in workers/everyapp/gateway.ts).
export default defineConfig((ctx) => {
  const worker = everyAppWorker({
    manifest,
    entrypoint: "./workers/app.ts",
    ctx,
  });
  return {
    worker: {
      ...worker,
      env: {
        ...worker.env,
        // Mailbox settings (mailboxes/<address>.json) and attachments, in a
        // bucket named after the Worker.
        BUCKET: bindings.r2({ name: worker.name }),
        // The domains mailboxes may be created on, comma-separated. Lane L2
        // derives them from the manifest's email senders.
        DOMAINS: bindings.text(process.env.INBOX_DOMAINS ?? "example.com"),
        // Upstream's mailbox allowlist; off (organization roles replace it).
        EMAIL_ADDRESSES: bindings.json([] as string[]),
        // "workers-ai" (default) or "openrouter": which gateway AI provider
        // the agent, the injection scanner and the draft verifier use.
        AI_PROVIDER: bindings.text(process.env.AI_PROVIDER ?? "workers-ai"),
        // The agent's model id; empty takes the provider's default.
        AGENT_MODEL: bindings.text(process.env.AGENT_MODEL ?? ""),
      },
    },
  };
});
