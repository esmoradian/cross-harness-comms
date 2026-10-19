import { hostname } from "node:os";
import { createClient, type AdapterRuntime, type CommandIO } from "@cross-harness-comms/client";
import { RELEASE_VERSION, VERSION_RANGE, COMMS_TOOLS, MAX_LINE_BYTES, splitLines } from "@cross-harness-comms/protocol";
import { createCodexAdapter, type McpCall, type SessionEndInput, type SessionStartInput } from "./index.ts";

// The comms CLI supplies the core's lifecycle and platform, so this adapter never imports the core.
export interface CodexHost extends Pick<AdapterRuntime, "ensure" | "connect"> {
  processExecutable(pid: number): Promise<string | undefined>;
}

// Codex hooks: SessionStart marks the thread online, SessionEnd marks it offline.
export async function codexHook(hookInput: Record<string, unknown>, host: CodexHost): Promise<number> {
  const input = hookInput as unknown as SessionStartInput | SessionEndInput;
  if (!["SessionStart", "SessionEnd"].includes(input.hook_event_name) || !input.session_id || !input.cwd) throw new Error("Invalid Codex hook input");
  const client = createClient(await host.connect(await host.ensure()));
  try {
    await client.hello({ versions: VERSION_RANGE });
    if (input.hook_event_name === "SessionEnd") await client.request("codex_session_end", { session_key: input.session_id });
    else await client.request("codex_session_start", {
      session: { harness: "codex", session_key: input.session_id, host: hostname(), cwd: input.cwd },
      // The hook's parent is the Codex that owns this thread, so `codex queue` reaches the same install.
      executable: await host.processExecutable(process.ppid) ?? "codex",
    });
    return 0;
  } finally { await client.close(); }
}

export async function runMcp(io: CommandIO, host: CodexHost): Promise<number> {
  const adapter = createCodexAdapter({ host: hostname(), connect: host.connect,
    ensure: host.ensure, notice: text => io.stderr(text + "\n") });
  let stopped = false;
  const close = async () => { stopped = true; await adapter.close(); };
  const abort = () => { void close(); };
  io.signal.addEventListener("abort", abort, { once: true });
  try {
    let buffer = "";
    for await (const chunk of io.stdin) {
      if (stopped) break;
      const { lines, rest } = splitLines(buffer + chunk);
      buffer = rest;
      for (const line of lines) {
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error("MCP line exceeds 1 MB");
        let request: { id?: string | number; method: string; params?: Record<string, unknown> };
        try { request = JSON.parse(line); }
        catch { io.stdout(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n"); continue; }
        if (request.id === undefined) continue;
        let result: unknown;
        if (request.method === "initialize") result = { protocolVersion: request.params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} }, serverInfo: { name: "comms", version: RELEASE_VERSION } };
        else if (request.method === "tools/list") result = { tools: COMMS_TOOLS };
        else if (request.method === "tools/call") result = await adapter.toolsCall(request as McpCall); else if (request.method === "ping") result = {};
        else { io.stdout(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } }) + "\n"); continue; }
        io.stdout(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
      }
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) throw new Error("MCP line exceeds 1 MB");
    }
    return 0;
  } finally { io.signal.removeEventListener("abort", abort); await close(); }
}
