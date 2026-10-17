import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { expect } from "bun:test";
import { createCore, type Core } from "@cross-harness-comms/core";
import type { CliRuntime } from "@cross-harness-comms/core/cli";
import type { AdapterHandle, AdapterRuntime } from "@cross-harness-comms/client";
import type { Agent, Harness, Message, SessionRegistration, VersionPolicy } from "@cross-harness-comms/protocol";
import { registerPi } from "../adapters/pi/src/index.ts";
import { registerClaude } from "../adapters/claude/src/index.ts";
import { createCodexAdapter } from "../adapters/codex/src/index.ts";
import { FakePi } from "./fakes/pi.ts";
import { FakeClaude } from "./fakes/claude.ts";
import { FakeCodex } from "./fakes/codex.ts";
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

export class Rig {
  readonly directory = mkdtempSync(join(tmpdir(), "comms-unit-"));
  readonly databasePath = join(this.directory, "comms.sqlite");
  readonly notices: string[] = [];
  readonly runtimeCalls: string[] = [];
  readonly sessions: HarnessSession[] = [];
  private streams: Duplex[] = [];
  private handles: AdapterHandle[] = [];
  private core: Core | undefined;
  private observer: Peer | undefined;

  constructor(readonly protocol?: VersionPolicy) {}
  open() {
    this.core = createCore({ databasePath: this.databasePath, ...(this.protocol ? { protocol: this.protocol } : {}) });
  }
  connect = async (_address = "memory://comms"): Promise<Duplex> => {
    if (!this.core) throw new Error("Fixture core not started");
    const [client, server] = memoryPair();
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
      prepareListen: async () => { throw new Error("Unit tests must not listen"); },
      restrictAccess: async () => { throw new Error("Unit tests must not change socket permissions"); },
    } };
  }
  async harness(harness: Harness, sessionId = uuid(), cwd = "/projects/shared"): Promise<HarnessSession> {
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
      const claude = new FakeClaude(sessionId, cwd, this.cliRuntime());
      fake = claude;
      handle = registerClaude(claude.on, { binary: "comms", host: "fixture-host" });
      this.handles.push(handle);
      await claude.start();
      send = (to, text, reply_to, extra) => claude.tool({ tool: "SendMessage", tool_use_id: uuid(), to,
        message: reply_to ? `comms-reply:${JSON.stringify({ text, reply_to })}` : text, ...extra });
      list = () => claude.tool({ tool: "ListAgents", tool_use_id: uuid() });
      incoming = () => claude.incoming.map(call => call.text);
    } else {
      const codex = new FakeCodex(sessionId, cwd, 1000 + this.sessions.length);
      fake = codex;
      const adapter = createCodexAdapter({ ...this.runtime(), parentPid: codex.parentPid, run: codex.run });
      handle = adapter;
      this.handles.push(handle);
      await adapter.sessionStart(codex.sessionStart(), { parentPid: codex.parentPid });
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
  async restart() {
    for (const stream of this.streams) stream.destroy();
    this.streams = [];
    await this.core?.close();
    this.core = undefined;
    this.observer = undefined;
    this.open();
  }
  async close() {
    try {
      for (const session of this.sessions) if (session.fake instanceof FakeClaude) session.fake.close();
      for (const handle of this.handles) await handle.close();
      for (const stream of this.streams) stream.destroy();
      await this.core?.close();
    } finally { rmSync(this.directory, { recursive: true, force: true }); }
  }
}

export async function withRig(run: (rig: Rig) => Promise<void>, protocol?: VersionPolicy) {
  const rig = new Rig(protocol);
  try { rig.open(); await run(rig); }
  finally { await rig.close(); }
}

export function registration(harness: Harness, session_key = uuid(), cwd = "/projects/shared"): SessionRegistration {
  return { harness, session_key, cwd, host: "fixture-host" };
}
