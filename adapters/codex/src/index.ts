import { createClient, retryDisconnected, type AdapterRuntime, type CommsClient } from "@cross-harness-comms/client";
import { hiddenLine, listedAgents, messageId, sendSummary, VERSION_RANGE } from "@cross-harness-comms/protocol";

export interface SessionStartInput {
  hook_event_name: "SessionStart";
  session_id: string;
  cwd: string;
  source: "startup" | "resume" | "clear";
  transcript_path?: string;
  model?: string;
  permission_mode?: string;
}
export interface SessionEndInput {
  hook_event_name: "SessionEnd";
  session_id: string;
  cwd: string;
}
export interface McpCall {
  jsonrpc: "2.0";
  id: string | number;
  method: "tools/call";
  params: { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> };
}
export interface McpResult { content: { type: "text"; text: string }[]; isError?: boolean }
interface CodexAdapter {
  toolsCall(request: McpCall): Promise<McpResult>;
  close(): Promise<void>;
}

// One MCP server serves every Codex thread in its process, so it holds no session:
// presence comes from native lifecycle events and hooks, delivery from the core, and each call acts as
// the thread its `_meta` names.
export function createCodexAdapter(runtime: AdapterRuntime): CodexAdapter {
  let client: Promise<CommsClient> | undefined;
  let closed = false;
  const connect = () => client ??= (async () => {
    const next = createClient(await runtime.connect(await runtime.ensure()));
    const hello = await next.hello({ versions: VERSION_RANGE });
    if (hello.notice) runtime.notice(hello.notice);
    return next;
  })().catch(error => { client = undefined; throw error; });
  const request = <T>(call: (connection: CommsClient) => Promise<T>): Promise<T> => retryDisconnected(async () => {
    if (closed) throw new Error("Adapter is closed");
    return await connect();
  }, call, async connection => { client = undefined; await connection.close(); });
  return {
    async toolsCall(call) {
      try {
        const metadata = call.params._meta?.["x-codex-turn-metadata"];
        const thread = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>).thread_id : undefined;
        if (typeof thread !== "string" || !thread) throw new Error('Missing Codex thread identity: _meta["x-codex-turn-metadata"].thread_id is required');
        const args = call.params.arguments ?? {};
        let text: string;
        if (call.params.name === "comms_list") {
          const { agents, hidden } = await request(connection => connection.request("list", { include_stale: args.all === true }));
          // The count is its own item, so the JSON stays parseable.
          return { content: [{ type: "text", text: JSON.stringify(listedAgents(agents)) }, ...(hidden ? [{ type: "text" as const, text: hiddenLine(hidden) }] : [])] };
        } else if (call.params.name === "comms_send") {
          const params = { codex_thread: thread, id: messageId(Date.now()), to: args.to as string, body: args.text as string,
            ...(typeof args.reply_to === "string" ? { reply_to: args.reply_to } : {}) };
          const result = await request(connection => connection.request("send", params));
          if (result.notice) runtime.notice(result.notice);
          text = sendSummary(result);
        } else if (call.params.name === "comms_name") {
          const agent = await request(connection => connection.request("name", { codex_thread: thread, name: args.name as string }));
          text = `This thread is now comms:${agent.name}.`;
        } else throw new Error("Unknown tool");
        return { content: [{ type: "text", text }] };
      } catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Tool failed" }] }; }
    },
    async close() {
      closed = true;
      const current = client;
      client = undefined;
      await (await current?.catch(() => undefined))?.close();
    },
  };
}
