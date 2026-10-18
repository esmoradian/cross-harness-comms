import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { expect } from "bun:test";
import { createCore, type Core, type CodexSnapshot } from "@cross-harness-comms/core";
import { runCli, type CliRuntime } from "@cross-harness-comms/core/cli";
import type { AdapterHandle, AdapterRuntime } from "@cross-harness-comms/client";
import type { Agent, Harness, Message, SessionRegistration, VersionPolicy, WirePacket } from "@cross-harness-comms/protocol";
import { registerPi } from "../adapters/pi/src/index.ts";
import { registerClaude } from "../adapters/claude/src/index.ts";
import { createCodexAdapter } from "../adapters/codex/src/index.ts";
import { FakePi } from "./fakes/pi.ts";
import { CLAUDE_VERSION, FakeClaude, FakeClaudeInbox } from "./fakes/claude.ts";
import { FakeCodex } from "./fakes/codex.ts";
import type { CodexEvent } from "./fakes/codex-events.ts";
import { eventually, memoryPair, Peer, uuid } from "./helpers.ts";

export interface HarnessSession {
  harness: Harness;
  sessionId: string;
  agent: Agent;
  fake: FakePi | FakeClaude | FakeCodex;
  send(to: string, text: string, reply_to?: string, extra?: Record<string, unknown>): Promise<unknown>;
  list(): Promise<unknown>;
  incoming(): string[];
  close(): Promise<void>;
}

// A Claude session with CLAUDE_CODE_MESSAGING_SOCKET set: `listen: false` leaves no listener
// at that path, and `version` is what $.session.version() reports.
export interface NativeClaudeOptions { listen?: boolean; version?: string }

export class Rig {
  readonly traffic: { connection: number; direction: "to-core" | "from-core"; packet: WirePacket }[] = [];
  readonly links: { client: Duplex; server: Duplex }[] = [];
  dropNextSendReceipt = false;
  // Codex threads by ID, and the executable path their SessionStart hook reports.
  readonly codexFakes = new Map<string, FakeCodex>();
  codexExecutable = "codex";
  readonly directory = mkdtempSync(join(tmpdir(), "comms-unit-"));
  // Claude's inbox sockets and the core's reply sockets share a short directory, like /tmp/cc-socks,
  // so socket paths stay under the 104-byte Unix limit.
  readonly socketDirectory = mkdtempSync("/tmp/cc-");
  private inboxCount = 0;
  private inboxes: FakeClaudeInbox[] = [];
  readonly databasePath = join(this.directory, "comms.sqlite");
  readonly notices: string[] = [];
  readonly runtimeCalls: string[] = [];
  // Each `watchParent` call a CLI process made through this rig's platform: `gone()` reports its
  // parent gone, and `stopped` is set once it stops watching. No real process tree is read.
  readonly parentWatchers: { gone(): void; stopped: boolean }[] = [];
  readonly sessions: HarnessSession[] = [];
  private streams: Duplex[] = [];
  private handles: AdapterHandle[] = [];
  private core: Core | undefined;
  private observer: Peer | undefined;

  // `now` is the core's clock for activity times in epoch milliseconds (ADR-018), passed structurally
  // until the implementation adds it to the core's public type.
  constructor(readonly protocol?: VersionPolicy, readonly coreOptions: {
    pingTimeoutMs?: number; codexPollMs?: number; codexDaemon?: () => Promise<CodexSnapshot | undefined>; nativeAckMs?: number;
    now?: () => number;
    codexEvents?: AsyncIterable<CodexEvent>;
  } = {}) {}
  // Real Claude names an inbox after the session's PID; these never start with 9.
  inboxPath(): string { return join(this.socketDirectory, `${20000 + this.inboxCount++}.sock`); }
  // A bare inbox listener for wire-level tests, which records lines and runs no hooks.
  async inbox(path = this.inboxPath()): Promise<FakeClaudeInbox> {
    const inbox = new FakeClaudeInbox(path);
    await inbox.listen();
    this.inboxes.push(inbox);
    return inbox;
  }
  open() {
    this.core = createCore({ databasePath: this.databasePath, run: this.codexRun, ...this.coreOptions, ...(this.protocol ? { protocol: this.protocol } : {}) });
  }
  // The core delivers to Codex itself by running `codex queue --thread <id>`.
  codexRun = async (argv: readonly string[]) => {
    const fake = this.codexFakes.get(argv[argv.indexOf("--thread") + 1] ?? "");
    return fake ? fake.run(argv) : { exitCode: 1, stdout: "", stderr: "no such thread" };
  };
  // Runs a Codex hook through the same CLI handler the plugin's hook command uses.
  async hook(command: "session-start" | "session-end", input: unknown) {
    let stderr = "";
    async function* stdin() { yield JSON.stringify(input) + "\n"; }
    const exitCode = await runCli([command], { stdin: stdin(), signal: new AbortController().signal,
      stdout: () => {}, stderr: text => { stderr += text; } }, this.cliRuntime());
    return { exitCode, stderr };
  }
  connect = async (_address = "memory://comms"): Promise<Duplex> => {
    if (!this.core) throw new Error("Fixture core not started");
    const connection = this.links.length;
    const requests = new Map<string | number, string>();
    const incoming = new StringDecoder("utf8"), outgoing = new StringDecoder("utf8");
    let clientBuffer = "", serverBuffer = "";
    const [client, server] = memoryPair(chunk => {
      serverBuffer += outgoing.write(chunk);
      let forwarded = "", end: number;
      while ((end = serverBuffer.indexOf("\n")) >= 0) {
        const line = serverBuffer.slice(0, end);
        serverBuffer = serverBuffer.slice(end + 1);
        const packet = JSON.parse(line) as WirePacket;
        this.traffic.push({ connection, direction: "from-core", packet });
        if (this.dropNextSendReceipt && "result" in packet && requests.get(packet.id) === "send") {
          this.dropNextSendReceipt = false;
          queueMicrotask(() => { client.destroy(); server.destroy(); });
        } else forwarded += line + "\n";
      }
      return forwarded;
    });
    server.on("data", (chunk: Buffer | string) => {
      clientBuffer += typeof chunk === "string" ? chunk : incoming.write(chunk);
      let end: number;
      while ((end = clientBuffer.indexOf("\n")) >= 0) {
        const packet = JSON.parse(clientBuffer.slice(0, end)) as WirePacket;
        clientBuffer = clientBuffer.slice(end + 1);
        this.traffic.push({ connection, direction: "to-core", packet });
        if ("method" in packet && packet.id !== undefined) requests.set(packet.id, packet.method);
      }
    });
    this.links.push({ client, server });
    this.streams.push(client, server);
    this.core.attach(server);
    return client;
  };
  async peer(): Promise<Peer> { return new Peer(await this.connect()); }
  async agents(): Promise<Agent[]> {
    if (!this.observer) {
      this.observer = await this.peer();
      await this.observer.request("hello", { versions: { min: this.protocol?.latest ?? 1, max: this.protocol?.latest ?? 1 } });
    }
    return (await this.observer.request("list", {})).agents;
  }
  async agent(harness: Harness, session_key: string): Promise<Agent> {
    const agents = await eventually(() => this.agents(), agents => {
      expect(agents.some(a => a.harness === harness && a.session_key === session_key)).toBe(true);
    });
    return agents.find(a => a.harness === harness && a.session_key === session_key)!;
  }
  rows(): Message[] {
    const db = new Database(this.databasePath, { readonly: true });
    try { return db.query("SELECT * FROM messages ORDER BY rowid").all() as Message[]; }
    finally { db.close(); }
  }
  async state(id: string, expected: Message["state"]) {
    return eventually(() => this.rows().find(m => m.id === id), row => expect(row?.state).toBe(expected));
  }
  runtime(): AdapterRuntime {
    return { host: "fixture-host", connect: this.connect,
      ensure: async () => { this.runtimeCalls.push("ensure"); return "memory://comms"; },
      notice: text => { this.notices.push(text); } };
  }
  cliRuntime(): CliRuntime {
    return { connect: this.connect, platform: {
      dataDirectory: () => this.directory, socketAddress: () => "memory://comms", binaryName: () => "comms",
      processExecutable: async () => this.codexExecutable, codexHome: () => join(this.directory, "codex"),
      prepareListen: async () => { throw new Error("Unit tests must not listen"); },
      restrictAccess: async () => { throw new Error("Unit tests must not change socket permissions"); },
      watchParent: onGone => {
        const watcher = { gone: onGone, stopped: false };
        this.parentWatchers.push(watcher);
        return () => { watcher.stopped = true; };
      },
    } };
  }
  async harness(harness: Harness, sessionId = uuid(), cwd = "/projects/shared", options: { claude?: NativeClaudeOptions } = {}): Promise<HarnessSession> {
    let handle: AdapterHandle;
    let fake: HarnessSession["fake"];
    let send: HarnessSession["send"];
    let list: HarnessSession["list"];
    let incoming: HarnessSession["incoming"];
    if (harness === "pi") {
      const pi = new FakePi(sessionId, cwd);
      fake = pi;
      handle = registerPi(pi, this.runtime());
      this.handles.push(handle);
      await pi.emit("session_start");
      send = (to, text, reply_to, extra) => pi.tool("comms_send", { to, text, ...(reply_to ? { reply_to } : {}), ...extra });
      list = () => pi.tool("comms_list", {});
      incoming = () => pi.incoming.map(call => call.message.content);
    } else if (harness === "claude") {
      let claude: FakeClaude;
      if (options.claude) {
        const inbox = this.inboxPath();
        const version = options.claude.version ?? CLAUDE_VERSION.version;
        claude = new FakeClaude(sessionId, cwd, this.cliRuntime(), {
          env: { CLAUDE_CODE_MESSAGING_SOCKET: inbox }, version: { ...CLAUDE_VERSION, version, base: version } });
        if (options.claude.listen !== false) this.inboxes.push(await claude.listenInbox(inbox));
      } else claude = new FakeClaude(sessionId, cwd, this.cliRuntime());
      fake = claude;
      handle = registerClaude(claude.on, { binary: "comms", host: "fixture-host" });
      this.handles.push(handle);
      await claude.start();
      send = (to, text, reply_to, extra) => claude.tool({ tool: "SendMessage", tool_use_id: uuid(), to,
        message: text, ...extra });
      list = () => claude.tool({ tool: "ListAgents", tool_use_id: uuid() });
      incoming = () => claude.incoming.map(call => call.text);
    } else {
      const codex = new FakeCodex(sessionId, cwd);
      fake = codex;
      this.codexFakes.set(sessionId, codex);
      const adapter = createCodexAdapter(this.runtime());
      handle = { close: async () => { await this.hook("session-end", codex.sessionEnd()).catch(() => {}); await adapter.close(); } };
      this.handles.push(handle);
      const started = await this.hook("session-start", codex.sessionStart());
      if (started.exitCode) throw new Error(started.stderr);
      send = (to, text, reply_to, extra) => adapter.toolsCall(codex.request("comms_send", { to, text, ...(reply_to ? { reply_to } : {}), ...extra }));
      list = () => adapter.toolsCall(codex.request("comms_list", {}));
      incoming = () => codex.commands.filter(argv => argv[1] === "queue").map(argv => argv[argv.indexOf("--message") + 1]!);
    }
    const session: HarnessSession = { harness, sessionId, agent: await this.agent(harness, sessionId), fake, send, list, incoming,
      close: async () => {
        if (fake instanceof FakePi) await fake.emit("session_shutdown");
        await handle.close();
        if (fake instanceof FakeClaude) fake.close();
        this.handles = this.handles.filter(h => h !== handle);
      } };
    this.sessions.push(session);
    return session;
  }
  // `between` runs after the old core has closed and before the new one opens.
  async restart(between?: () => void | Promise<void>) {
    for (const stream of this.streams) stream.destroy();
    this.streams = [];
    await this.core?.close();
    this.core = undefined;
    this.observer = undefined;
    await between?.();
    this.open();
  }
  async close() {
    try {
      for (const session of this.sessions) if (session.fake instanceof FakeClaude) session.fake.close();
      for (const handle of this.handles) await handle.close();
      for (const stream of this.streams) stream.destroy();
      await this.core?.close();
      for (const inbox of this.inboxes) await inbox.close();
    } finally {
      rmSync(this.directory, { recursive: true, force: true });
      rmSync(this.socketDirectory, { recursive: true, force: true });
    }
  }
}

export async function withRig(run: (rig: Rig) => Promise<void>, protocol?: VersionPolicy, coreOptions?: Rig["coreOptions"]) {
  const rig = new Rig(protocol, coreOptions);
  try { rig.open(); await run(rig); }
  finally { await rig.close(); }
}

export function registration(harness: Harness, session_key = uuid(), cwd = "/projects/shared"): SessionRegistration {
  return { harness, session_key, cwd, host: "fixture-host" };
}
