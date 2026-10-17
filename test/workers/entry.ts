// The Worker the Workers-runtime tests run in (vitest.config.ts, project
// "workers"): the real MailboxDO, and in place of the chat agent an Agent
// (the same agents/partyserver base class EmailAgent has) that records the
// auto-draft trigger receiveEmail() sends it, so the tests need neither a
// model nor a gateway.
import { Agent } from "agents";

export { MailboxDO } from "../../workers/durableObject";

export interface AgentCall {
	path: string;
	body: unknown;
}

export class RecordingAgent extends Agent<Record<string, unknown>> {
	override async onRequest(request: Request): Promise<Response> {
		const calls = (await this.ctx.storage.get<AgentCall[]>("calls")) ?? [];
		calls.push({ path: new URL(request.url).pathname, body: await request.json() });
		await this.ctx.storage.put("calls", calls);
		return new Response("recorded");
	}

	async calls(): Promise<AgentCall[]> {
		return (await this.ctx.storage.get<AgentCall[]>("calls")) ?? [];
	}
}

export default {
	async fetch(): Promise<Response> {
		return new Response("test worker", { status: 404 });
	},
};
