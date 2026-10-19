import type { Duplex } from "node:stream";
import { createClient, readPackets, writePacket, type CommandIO } from "@cross-harness-comms/client";
import { VERSION_RANGE, MAX_LINE_BYTES, type HelloParams, type MethodTable, type RequestMethod } from "@cross-harness-comms/protocol";
import type { Platform } from "./platform/platform.ts";
import { ensure, serve, CORE_VERSION } from "./lifecycle.ts";
import { runMcp, codexHook, type CodexHost } from "@cross-harness-comms/codex/mcp";

export interface CliRuntime {
  platform: Platform;
  connect(address: string): Promise<Duplex>;
  command?: readonly string[];
  compiled?: boolean;
}

// `optional` input may be empty, which reads as `{}`.
export async function readInput(io: CommandIO, optional = false): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of io.stdin) {
    text += chunk;
    if (Buffer.byteLength(text) > MAX_LINE_BYTES) throw new Error("Input exceeds 1 MB");
    if (text.includes("\n")) break;
  }
  if (optional && !text.trim()) return {};
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
  native-ack             Acknowledge a native Claude inbox line, JSON on stdin: token, from
  detach                 Close a session using its token on stdin
  list                   List agents and presence as JSON; optional JSON stdin: token, include_stale
  resolve                Find the agent named exactly, JSON on stdin: name, optional token, skip_claude
  rename <address> <name> Rename an agent
  name <name>            Choose this session's name, using its token on stdin
  inspect <message-id>   Inspect delivery state
  status                 Show core and protocol versions
  mcp                    Run the Codex MCP server over stdio
  session-start          Mark a Codex thread online from its SessionStart hook JSON
  session-end            Mark a Codex thread offline from its SessionEnd hook JSON
  version                Print binary version
  help                   Show this help
`;

// Commands forwarded to one core method, with how each reads its params, after the hello.
type Params = (argv: readonly string[], io: CommandIO) => Promise<object>;
const stdin: Params = (_argv, io) => readInput(io);
const COMMANDS: Record<string, [RequestMethod, Params]> = {
  send: ["send", async (_argv, io) => {
    const params = await readInput(io);
    if (typeof params.id !== "string" || !params.id) throw new Error("send requires a sender-minted id");
    return params;
  }],
  ack: ["ack", stdin],
  "native-ack": ["native_ack", stdin],
  detach: ["detach", stdin],
  // People see every agent; agent-facing lists pass `include_stale: false`.
  list: ["list", async (_argv, io) => ({ include_stale: true, ...await readInput(io, true) })],
  resolve: ["resolve", stdin],
  rename: ["rename", async argv => {
    if (!argv[1] || !argv[2]) throw new Error("Usage: comms rename <address> <name>");
    return { address: argv[1], name: argv[2] };
  }],
  name: ["name", async (argv, io) => {
    if (!argv[1]) throw new Error("Usage: comms name <name>");
    return { token: (await readInput(io)).token, name: argv[1] };
  }],
  inspect: ["inspect", async argv => {
    if (!argv[1]) throw new Error("Usage: comms inspect <message-id>");
    return { id: argv[1] };
  }],
  status: ["status", async () => ({})],
};

// What the Codex MCP server and hooks need from the core, passed in so the adapter does not import the core.
function codexHost(runtime: CliRuntime): CodexHost {
  return { connect: runtime.connect, ensure: () => ensure(runtime), processExecutable: pid => runtime.platform.processExecutable(pid) };
}

export async function runCli(argv: readonly string[], io: CommandIO, runtime: CliRuntime): Promise<number> {
  const command = argv[0] ?? "help";
  try {
    if (["help", "--help", "-h"].includes(command)) { io.stdout(HELP); return 0; }
    if (["version", "--version"].includes(command)) { io.stdout(CORE_VERSION + "\n"); return 0; }
    if (command === "ensure") { io.stdout(await ensure(runtime) + "\n"); return 0; }
    if (command === "serve") return await serve(io, runtime);
    if (command === "mcp") return await runMcp(io, codexHost(runtime));
    if (command === "session-start" || command === "session-end") return await codexHook(await readInput(io), codexHost(runtime));
    if (command === "attach") {
      const params = await readInput(io) as unknown as HelloParams;
      const stream = await runtime.connect(runtime.platform.socketAddress());
      stream.setEncoding("utf8");
      let stopWatching = () => {};
      try {
        await new Promise<void>((resolve, reject) => {
          const abort = () => { stream.destroy(); resolve(); };
          // Once the process that started attach is gone, nobody reads its output, so closing the
          // connection ends the session's presence as for any closed connection.
          stopWatching = runtime.platform.watchParent(abort);
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
      } finally { stopWatching(); stream.destroy(); }
      return 0;
    }
    if (!Object.hasOwn(COMMANDS, command)) throw new Error("Unknown command; run comms help");
    const [method, params] = COMMANDS[command]!;
    const client = createClient(await runtime.connect(runtime.platform.socketAddress()));
    try {
      const hello = await client.hello({ versions: VERSION_RANGE });
      if (hello.notice) io.stderr(hello.notice + "\n");
      // The core validates every request's params.
      const result = await client.request(method, await params(argv, io) as MethodTable[RequestMethod]["params"]);
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
