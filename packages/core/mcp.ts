import { hostname } from "node:os";
import { createClient } from "@cross-harness-comms/client";
import { RELEASE_VERSION, VERSION_RANGE, SEND_SCHEMA, MAX_LINE_BYTES } from "@cross-harness-comms/protocol";
import { createCodexAdapter, type McpCall, type SessionEndInput, type SessionStartInput } from "../../adapters/codex/src/index.ts";
import { readInput, type CliIO, type CliRuntime } from "./cli.ts";
import { ensure } from "./lifecycle.ts";

// Codex hooks: SessionStart marks the thread online, SessionEnd marks it offline (ADR-014).
export async function codexHook(io: CliIO, runtime: CliRuntime): Promise<number> {
  const input = await readInput(io) as unknown as SessionStartInput | SessionEndInput;
  if (!["SessionStart", "SessionEnd"].includes(input.hook_event_name) || !input.session_id || !input.cwd) throw new Error("Invalid Codex hook input");
  const client = createClient(await runtime.connect(await ensure(runtime)));
  try {
    await client.hello({ versions: VERSION_RANGE });
    if (input.hook_event_name === "SessionEnd") await client.request("codex_session_end", { session_key: input.session_id });
    else await client.request("codex_session_start", {
      session: { harness: "codex", session_key: input.session_id, host: hostname(), cwd: input.cwd },
      // The hook's parent is the Codex that owns this thread, so `codex queue` reaches the same install.
      executable: await runtime.platform.parentExecutable() ?? "codex",
    });
    return 0;
  } finally { await client.close(); }
}

export async function runMcp(io: CliIO, runtime: CliRuntime): Promise<number> {
  const adapter = createCodexAdapter({ host: hostname(), connect: runtime.connect,
    ensure: () => ensure(runtime), notice: text => io.stderr(text + "\n") });
  let stopped = false;
  const close = async () => { stopped = true; await adapter.close(); };
  const abort = () => { void close(); };
  io.signal.addEventListener("abort", abort, { once: true });
  try {
    let buffer = "";
    for await (const chunk of io.stdin) {
      if (stopped) break;
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error("MCP line exceeds 1 MB");
        let request: { id?: string | number; method: string; params?: Record<string, unknown> };
        try { request = JSON.parse(line); }
        catch { io.stdout(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n"); continue; }
        if (request.id === undefined) continue;
        let result: unknown;
        if (request.method === "initialize") result = { protocolVersion: request.params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} }, serverInfo: { name: "comms", version: RELEASE_VERSION } };
        else if (request.method === "tools/list") result = { tools: [
          { name: "comms_send", description: "Send a message to a comms address; use reply_to when replying.", inputSchema: SEND_SCHEMA },
          { name: "comms_list", description: "List cross-harness agents and presence.", inputSchema: { type: "object", properties: {} } },
        ] };
        else if (request.method === "tools/call") result = await adapter.toolsCall(request as McpCall); else if (request.method === "ping") result = {};
        else { io.stdout(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } }) + "\n"); continue; }
        io.stdout(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
      }
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) throw new Error("MCP line exceeds 1 MB");
    }
    return 0;
  } finally { io.signal.removeEventListener("abort", abort); await close(); }
}
