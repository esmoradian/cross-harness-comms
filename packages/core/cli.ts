import type { Duplex } from "node:stream";
import { createClient, readPackets, writePacket } from "@cross-harness-comms/client";
import { VERSION_RANGE, MAX_LINE_BYTES, type HelloParams, type SendParams } from "@cross-harness-comms/protocol";
import type { Platform } from "./platform/platform.ts";
import { ensure, serve, CORE_VERSION } from "./lifecycle.ts";
import { runMcp, registerCodexSession } from "./mcp.ts";

export interface CliIO {
  stdin: AsyncIterable<string>;
  stdout(text: string): void;
  stderr(text: string): void;
  signal: AbortSignal;
}
export interface CliRuntime {
  platform: Platform;
  connect(address: string): Promise<Duplex>;
  command?: readonly string[];
  compiled?: boolean;
}

export async function readInput(io: CliIO): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of io.stdin) {
    text += chunk;
    if (Buffer.byteLength(text) > MAX_LINE_BYTES) throw new Error("Input exceeds 1 MB");
    if (text.includes("\n")) break;
  }
  const input: unknown = JSON.parse(text);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected a JSON object on stdin");
  return input as Record<string, unknown>;
}

const HELP = `comms - cross-harness agent communication

Usage: comms <command>
  ensure                 Install/start the newest local core; print its address
  serve                  Run the core until interrupted
  attach                 Register from JSON stdin and stream protocol packets
  send                   Send JSON on stdin: token, id, to, body, optional reply_to
  ack                    Acknowledge JSON on stdin: token, id
  detach                 Close a session using its token on stdin
  list                   List agents and presence as JSON
  rename <address> <name> Rename an agent
  inspect <message-id>   Inspect delivery state
  status                 Show core and protocol versions
  mcp                    Run the Codex MCP server over stdio
  session-start          Register a Codex SessionStart hook from JSON stdin
  install <harness>      Print local integration instructions
  version                Print binary version
  help                   Show this help
`;

export async function runCli(argv: readonly string[], io: CliIO, runtime: CliRuntime): Promise<number> {
  const command = argv[0] ?? "help";
  try {
    if (["help", "--help", "-h"].includes(command)) { io.stdout(HELP); return 0; }
    if (["version", "--version"].includes(command)) { io.stdout(CORE_VERSION + "\n"); return 0; }
    if (command === "ensure") { io.stdout(await ensure(runtime) + "\n"); return 0; }
    if (command === "serve") return await serve(io, runtime);
    if (command === "mcp") return await runMcp(io, runtime);
    if (command === "session-start") return await registerCodexSession(io, runtime);
    if (command === "install") {
      const instructions: Record<string, string> = {
        pi: "Build first, then install with pi install /absolute/path/to/dist/plugins/pi.",
        claude: "Add the built dist marketplace with Claude Code's plugin manager, then install cross-harness-comms@comms-local.",
        codex: "Add the built local marketplace, then run codex plugin add cross-harness-comms@comms-local and trust its SessionStart hook.",
      };
      if (!argv[1] || !instructions[argv[1]]) throw new Error("Supported integrations: pi, claude, codex");
      io.stdout(instructions[argv[1]] + "\nKeep the compiled comms binary on PATH for local development.\n");
      return 0;
    }
    if (command === "attach") {
      const params = await readInput(io) as unknown as HelloParams;
      const stream = await runtime.connect(runtime.platform.socketAddress());
      stream.setEncoding("utf8");
      try {
        await new Promise<void>((resolve, reject) => {
          const abort = () => { stream.destroy(); resolve(); };
          const finish = () => { io.signal.removeEventListener("abort", abort); resolve(); };
          readPackets(stream, packet => {
            if ("method" in packet && packet.method === "ping" && packet.id !== undefined) {
              writePacket(stream, { jsonrpc: "2.0", id: packet.id, result: {} });
              return;
            }
            io.stdout(JSON.stringify(packet) + "\n");
            if ("error" in packet) { stream.destroy(); reject(new Error(packet.error.message)); }
          }, reject);
          stream.once("end", finish); stream.once("close", finish); stream.once("error", reject);
          io.signal.addEventListener("abort", abort, { once: true });
          if (io.signal.aborted) { abort(); return; }
          writePacket(stream, { jsonrpc: "2.0", id: 1, method: "hello", params });
        });
      } finally { stream.destroy(); }
      return 0;
    }
    if (!["send", "ack", "detach", "list", "rename", "inspect", "status"].includes(command)) throw new Error("Unknown command; run comms help");
    const client = createClient(await runtime.connect(runtime.platform.socketAddress()));
    try {
      const hello = await client.hello({ versions: VERSION_RANGE });
      if (hello.notice) io.stderr(hello.notice + "\n");
      let result: unknown;
      switch (command) {
        case "send": {
          const params = await readInput(io);
          if (typeof params.id !== "string" || !params.id) throw new Error("send requires a sender-minted id");
          result = await client.request("send", params as unknown as SendParams);
          break;
        }
        case "ack": result = await client.request("ack", await readInput(io) as unknown as { token: string; id: string }); break;
        case "detach": result = await client.request("detach", await readInput(io) as unknown as { token: string }); break;
        case "rename":
          if (!argv[1] || !argv[2]) throw new Error("Usage: comms rename <address> <name>");
          result = await client.request("rename", { address: argv[1], name: argv[2] }); break;
        case "inspect":
          if (!argv[1]) throw new Error("Usage: comms inspect <message-id>");
          result = await client.request("inspect", { id: argv[1] }); break;
        case "status": result = await client.request("status", {}); break;
        default: result = await client.request("list", {});
      }
      io.stdout(JSON.stringify(result) + "\n");
      return 0;
    } finally { await client.close(); }
  } catch (error) {
    // Syntax errors can contain source text, including credentials. Do not print them.
    io.stderr((error instanceof SyntaxError ? "Invalid JSON input" : error instanceof Error ? error.message : "Command failed") + "\n");
    // Exit 2 means the core answered with a definite rejection, so retrying cannot help.
    const code = (error as { data?: { code?: string } }).data?.code;
    return code && code !== "DISCONNECTED" ? 2 : 1;
  }
}
