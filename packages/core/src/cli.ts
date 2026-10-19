import type { Duplex } from "node:stream";
import { cp, mkdir, readdir, readFile, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { createClient, readPackets, writePacket, type CommandIO } from "@cross-harness-comms/client";
import { VERSION_RANGE, MAX_LINE_BYTES, compareVersions, type HelloParams, type MethodTable, type RequestMethod } from "@cross-harness-comms/protocol";
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
  install pi             Install the built Pi package beside this binary; print the path for Pi's settings
  install <harness>      Print the published install commands for claude or codex
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

// Codex's standing authorization for comms replies, which its automatic review otherwise rejects. It names the published plugin;
// a local build's `@comms-local` approval is declared by hand.
const CODEX_APPROVAL = '[plugins."cross-harness-comms@comms".mcp_servers.comms.tools.comms_send]\napproval_mode = "approve"\n';

// Appends the approval section to Codex's config unless its table is already there, leaving the rest untouched.
async function allowCodexReplies(io: CommandIO, platform: Platform): Promise<void> {
  const path = join(platform.codexHome(), "config.toml");
  const current = await readFile(path, "utf8").catch(() => undefined);
  if (current?.includes(CODEX_APPROVAL.split("\n")[0]!)) { io.stdout(`Comms replies are already allowed in ${path}.\n`); return; }
  await mkdir(platform.codexHome(), { recursive: true });
  const separator = !current ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  await writeFile(path, (current ?? "") + separator + "# Let agents reply to each other through comms without auto-review.\n" + CODEX_APPROVAL);
  io.stdout(`Allowed comms replies without review in ${path}.\n`);
}

// Copies `plugins/pi` beside this binary to `<data>/pi/<version>`, points `<data>/pi/current` at it, and keeps it and the
// newest other version. Same-version replacements also retain recent fallback copies.
async function installPi(io: CommandIO, runtime: CliRuntime): Promise<number> {
  const source = join(dirname(runtime.command?.[0] ?? process.execPath), "plugins", "pi");
  const version = await readFile(join(source, "package.json"), "utf8").then(text => (JSON.parse(text) as { version?: unknown }).version, () => undefined);
  if (version === undefined) throw new Error(`No built Pi package in ${source}; run bun run build and use dist/comms`);
  // The version names a directory, so it must be a plain version.
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Unreadable Pi package version in ${join(source, "package.json")}`);
  const root = join(runtime.platform.dataDirectory(), "pi"), current = join(root, "current"), target = join(root, version);
  const temporary = (label: string) => join(root, `.${label}-${randomBytes(6).toString("hex")}`);
  await mkdir(root, { recursive: true });
  const staged = temporary(version), replaced = temporary(`${version}-old`), link = temporary("current");
  const previous = temporary("previous");
  let preservePrevious = false;
  try {
    await cp(source, staged, { recursive: true });
    if (resolve(root, await readlink(current).catch(() => "")) === target) {
      // Switch to a complete copy before moving the selected version. A crash can leave current here safely.
      await cp(target, previous, { recursive: true });
      preservePrevious = true;
      await symlink(basename(previous), link);
      await runtime.platform.publishLink(link, current);
    }
    await rename(target, replaced).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    await rename(staged, target);
    await symlink(version, link);
    await runtime.platform.publishLink(link, current);
  } finally {
    await Promise.all([staged, replaced, link, ...(!preservePrevious ? [previous] : [])]
      .map(path => rm(path, { recursive: true, force: true })));
  }
  const others = (await readdir(root)).filter(entry => entry !== "current" && entry !== version);
  const kept = others.filter(entry => /^\d+\.\d+\.\d+$/.test(entry)).sort((a, b) => compareVersions(b, a)).slice(0, 1);
  // Readers may already have followed current to the fallback. Keep the latest two copies past publication.
  const snapshots = await Promise.all(others.filter(entry => entry.startsWith(".previous-"))
    .map(async entry => ({ entry, time: (await stat(join(root, entry))).mtimeMs })));
  kept.push(...snapshots.sort((a, b) => b.time - a.time || b.entry.localeCompare(a.entry)).slice(0, 2).map(snapshot => snapshot.entry));
  await Promise.all(others.filter(entry => !kept.includes(entry)).map(entry => rm(join(root, entry), { recursive: true, force: true })));
  io.stdout(`Installed the comms Pi package ${version} in ${target}.\nAdd this path to the packages in Pi's settings: ${current}\n`);
  return 0;
}

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
    if (command === "install") {
      if (argv[1] === "pi") return await installPi(io, runtime);
      // The published install: the `release` branch marketplace, then the plugin from it.
      const instructions: Record<string, string> = {
        claude: "Install comms from its published release:\n\n"
          + "  claude plugin marketplace add esmoradian/cross-harness-comms#release\n  claude plugin install cross-harness-comms@comms\n",
        codex: "Install comms from its published release, then trust its SessionStart hook:\n\n"
          + "  codex plugin marketplace add esmoradian/cross-harness-comms --ref release\n  codex plugin add cross-harness-comms@comms\n",
      };
      if (!argv[1] || !instructions[argv[1]]) throw new Error("Supported integrations: pi, claude, codex");
      if (argv[1] === "codex" && argv[2] === "--allow-replies") { await allowCodexReplies(io, runtime.platform); return 0; }
      io.stdout(instructions[argv[1]]!);
      if (argv[1] === "codex") io.stdout("\nCodex's automatic review asks you before each reply to another agent. To let agents reply through comms\n"
        + "without review, add this to ~/.codex/config.toml, or run comms install codex --allow-replies:\n\n" + CODEX_APPROVAL);
      return 0;
    }
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
