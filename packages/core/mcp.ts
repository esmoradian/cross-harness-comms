import { hostname } from "node:os";
import { createClient, type CommsClient } from "@cross-harness-comms/client";
import { runProcess } from "@cross-harness-comms/client/runtime";
import { VERSION_RANGE, SEND_SCHEMA, MAX_LINE_BYTES, type SessionRegistration } from "@cross-harness-comms/protocol";
import { createCodexAdapter, type McpCall, type SessionStartInput } from "../../adapters/codex/src/index.ts";
import { readInput, type CliIO, type CliRuntime } from "./cli.ts";
import { ensure } from "./lifecycle.ts";

export async function registerCodexSession(io: CliIO, runtime: CliRuntime): Promise<number> {
  const input = await readInput(io) as unknown as SessionStartInput;
  if (input.hook_event_name !== "SessionStart" || !input.session_id || !input.cwd) throw new Error("Invalid Codex SessionStart input");
  const client = createClient(await runtime.connect(await ensure(runtime)));
  try {
    await client.hello({ versions: VERSION_RANGE });
    await client.request("codex_start", { pid: process.ppid, session: {
      harness: "codex", session_key: input.session_id, host: hostname(), cwd: input.cwd,
    } });
    return 0;
  } finally { await client.close(); }
}

export async function runMcp(io: CliIO, runtime: CliRuntime): Promise<number> {
  const parentPid = process.ppid;
  const adapter = createCodexAdapter({ parentPid, host: hostname(), connect: runtime.connect,
    ensure: () => ensure(runtime), notice: text => io.stderr(text + "\n"), run: runProcess });
  let watcher: CommsClient | undefined;
  let stopped = false;
  let binding = Promise.resolve();
  let session: SessionRegistration | undefined;
  const bind = (next: SessionRegistration) => {
    session = next;
    binding = binding.catch(() => {}).then(() => adapter.sessionStart({ hook_event_name: "SessionStart", session_id: next.session_key,
      cwd: next.cwd, source: "startup" }, { parentPid }));
    void binding.catch(error => io.stderr(error instanceof Error ? error.message + "\n" : "Session binding failed\n"));
  };
  const watch = async () => {
    const client = createClient(await runtime.connect(await ensure(runtime)), (method, params) => {
      if (method === "codex_session") bind(params as SessionRegistration);
    });
    watcher = client;
    try {
      await client.hello({ versions: VERSION_RANGE });
      const registration = await client.request("codex_watch", { pid: parentPid });
      if (registration.session) bind(registration.session);
      else if (session) {
        // Re-establish the binding after a core restart without a new hook.
        await client.request("codex_start", { pid: parentPid, session });
      }
      void (async () => {
        for await (const _ of client.deliveries) { /* watch carries session notifications only */ }
        while (!stopped) {
          await new Promise(resolve => setTimeout(resolve, 250));
          if (stopped) break;
          try { await watch(); break; } catch { /* retry while this MCP process is alive */ }
        }
      })();
    } catch (error) { await client.close(); throw error; }
  };
  const close = async () => { stopped = true; await watcher?.close(); await binding.catch(() => {}); await adapter.close(); };
  const abort = () => { void close(); };
  io.signal.addEventListener("abort", abort, { once: true });
  try {
    await watch();
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
          capabilities: { tools: {} }, serverInfo: { name: "comms", version: "0.1.1" } };
        else if (request.method === "tools/list") result = { tools: [
          { name: "comms_send", description: "Send a message to a comms address; use reply_to when replying.", inputSchema: SEND_SCHEMA },
          { name: "comms_list", description: "List cross-harness agents and presence.", inputSchema: { type: "object", properties: {} } },
        ] };
        else if (request.method === "tools/call") {
          await binding.catch(() => {});
          result = await adapter.toolsCall(request as McpCall);
        } else if (request.method === "ping") result = {};
        else { io.stdout(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } }) + "\n"); continue; }
        io.stdout(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
      }
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) throw new Error("MCP line exceeds 1 MB");
    }
    return 0;
  } finally { io.signal.removeEventListener("abort", abort); await close(); }
}
