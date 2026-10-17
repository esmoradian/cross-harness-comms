import { connectSession, messageId, type SessionClient } from "@cross-harness-comms/client";
import { formatMessage, sendSummary } from "@cross-harness-comms/protocol";
import type { AdapterRuntime } from "@cross-harness-comms/client";

export interface SessionStartInput {
  hook_event_name: "SessionStart";
  session_id: string;
  cwd: string;
  source: "startup" | "resume" | "clear";
  transcript_path?: string;
  model?: string;
  permission_mode?: string;
}
export interface McpCall {
  jsonrpc: "2.0";
  id: string | number;
  method: "tools/call";
  params: { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> };
}
export interface McpResult { content: { type: "text"; text: string }[]; isError?: boolean }
export interface CodexAdapter {
  sessionStart(input: SessionStartInput, process: { parentPid: number }): Promise<void>;
  toolsCall(request: McpCall): Promise<McpResult>;
  close(): Promise<void>;
}
export interface CodexRuntime extends AdapterRuntime {
  parentPid: number;
  run(argv: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}
export function createCodexAdapter(runtime: CodexRuntime): CodexAdapter {
  let session: SessionClient | undefined;
  let thread: string | undefined;
  let closed = false;
  const closeSession = async () => { const previous = session; session = undefined; thread = undefined; await previous?.close(); };
  return {
    async sessionStart(input, process) {
      if (closed) throw new Error("Adapter is closed");
      if (process.parentPid !== runtime.parentPid) throw new Error("SessionStart belongs to another Codex process");
      if (!input.session_id) throw new Error("SessionStart has no thread ID");
      await closeSession();
      const id = input.session_id;
      session = await connectSession(runtime, { harness: "codex", session_key: id, cwd: input.cwd, host: runtime.host }, async delivery => {
        const result = await runtime.run(["codex", "queue", "--thread", id, "--message", formatMessage(delivery)]);
        if (result.exitCode) throw new Error("Codex rejected incoming message: " + result.stderr);
      });
      thread = id;
    },
    async toolsCall(request) {
      try {
        const metadata = request.params._meta?.["x-codex-turn-metadata"];
        const id = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>).thread_id : undefined;
        if (!session || typeof id !== "string" || id !== thread) throw new Error('Missing or unregistered Codex thread identity: _meta["x-codex-turn-metadata"].thread_id is required');
        const args = request.params.arguments ?? {};
        let text: string;
        if (request.params.name === "comms_list") text = JSON.stringify((await session.list()).agents.map(agent => ({ ...agent, address: `comms:${agent.name}` })));
        else if (request.params.name === "comms_send") text = sendSummary(await session.send({
          id: messageId(), to: args.to as string, body: args.text as string,
          ...(typeof args.reply_to === "string" ? { reply_to: args.reply_to } : {}),
        }));
        else throw new Error("Unknown tool");
        return { content: [{ type: "text", text }] };
      } catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Tool failed" }] }; }
    },
    async close() { closed = true; await closeSession(); },
  };
}
