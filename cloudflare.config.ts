import { bindings, defineConfig } from "cf/config";
import { everyAppWorker } from "@every-app/sdk/cloudflare";
import * as entrypoint from "./workers/app.ts" with { type: "cf-worker" };
import manifest from "./everyapp.config.ts";

// The Worker definition comes from everyapp.config.ts; the app adds its
// bucket and its plain settings. Nothing the Worker imports may be imported
// here: in dev the Cloudflare Vite plugin hides this file's imports from the
// Worker. No secrets, no triggers and no `ai`/`send-email` bindings: the
// deploy refuses all three, and the gateway brokers AI and mail instead
// (withGateway() in workers/everyapp/gateway.ts). The entry is imported as a
// `cf-worker` module (a reference cf resolves, not code this file runs), so
// `cf workers types` types each Durable Object namespace with its class.
export default defineConfig((ctx) => {
  const worker = everyAppWorker({
    manifest,
    entrypoint,
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
        // Upstream's mailbox allowlist; off (organization roles replace it).
        EMAIL_ADDRESSES: bindings.json([] as string[]),
        // Where the agent, the injection scanner and the draft verifier call
        // a model. Empty (the default): the Gateway's default model provider
        // (the manifest's `ai.chat`; the operator picks it). "openrouter" or
        // "workers-ai": a pin to that provider's own route (both optional in
        // the manifest), for an operator who wants one provider.
        AI_PROVIDER: bindings.text(process.env.AI_PROVIDER ?? ""),
        // The agent's model id; empty takes the provider's default (on the
        // default route, the operator's model).
        AGENT_MODEL: bindings.text(process.env.AGENT_MODEL ?? ""),
      },
    },
  };
});
