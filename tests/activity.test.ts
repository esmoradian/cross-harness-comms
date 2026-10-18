import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "@cross-harness-comms/protocol";
import type { CodexSnapshot } from "@cross-harness-comms/core";
import { codexDaemon } from "../packages/core/codex-daemon.ts";
import type { Platform } from "../packages/core/platform/platform.ts";
import { createCodexAdapter, type McpResult } from "../adapters/codex/src/index.ts";
import type { PiToolResult } from "../adapters/pi/src/index.ts";
import { FakeClaude } from "./fakes/claude.ts";
import { FakeCodex } from "./fakes/codex.ts";
import { eventually, uuid } from "./helpers.ts";
import { registration, withRig, type Rig } from "./rig.ts";

// ADR-018: every agent carries `active_at`, the time of its last activity, kept in the core's memory.
// The core sets it on register or reconnect, send, and ACK, and for a Codex thread also from the
// daemon's `recencyAt` (or `updatedAt`) on each poll; it never moves backward, and until an agent is
// active after a core start it falls back to `last_seen`. Times come from the core's injected clock.

const T = (iso: string) => Date.parse(iso);
const T1 = T("2030-01-01T00:00:00.000Z"), T2 = T("2030-01-01T00:05:00.000Z"), T3 = T("2030-01-01T00:10:00.000Z");
const T4 = T("2030-01-01T00:15:00.000Z");

function clock(start = T1) {
  const value = { now: start, read: () => value.now };
  return value;
}

const activity = (agent: Agent | undefined) => Date.parse(agent?.active_at ?? "");

async function activeAt(rig: Rig, id: string): Promise<number> {
  return activity((await rig.agents()).find(agent => agent.id === id));
}

test("activity: registering sets active_at, disconnecting leaves it, and reconnecting moves it forward", async () => {
  const time = clock();
  await withRig(async rig => {
    const peer = await rig.peer();
    const session = registration("pi", uuid(), "/projects/web");
    const hello = await peer.register(session);
    const codex = new FakeCodex(uuid(), "/projects/api");
    rig.codexFakes.set(codex.threadId, codex);
    expect((await rig.hook("session-start", codex.sessionStart())).exitCode).toBe(0);
    const thread = await rig.agent("codex", codex.threadId);
    expect(await activeAt(rig, hello.agent.id)).toBe(T1);
    expect(activity(thread)).toBe(T1);

    time.now = T2;
    peer.close();
    await eventually(() => rig.agents(), list => expect(list.find(a => a.id === hello.agent.id)?.online).toBe(false));
    expect(await activeAt(rig, hello.agent.id)).toBe(T1);

    time.now = T3;
    await (await rig.peer()).register(session, undefined, hello.token);
    expect(await activeAt(rig, hello.agent.id)).toBe(T3);
  }, undefined, { now: time.read });
});

test("activity: sending moves the sender's active_at, delivery leaves the recipient's, and an ACK moves the recipient's", async () => {
  const time = clock();
  await withRig(async rig => {
    const sender = await rig.peer(), receiver = await rig.peer();
    const a = await sender.register(registration("pi", uuid(), "/projects/web"));
    const b = await receiver.register(registration("pi", uuid(), "/projects/api"));
    time.now = T2;
    const id = uuid();
    await sender.request("send", { token: a.token, id, to: `comms:${b.agent.name}`, body: "Busy?" });
    expect((await receiver.deliveries.next()).message.id).toBe(id);
    expect(await activeAt(rig, a.agent.id)).toBe(T2);
    expect(await activeAt(rig, b.agent.id)).toBe(T1);
    time.now = T3;
    await receiver.request("ack", { token: b.token, id });
    expect(await activeAt(rig, b.agent.id)).toBe(T3);
    expect(await activeAt(rig, a.agent.id)).toBe(T2);
  }, undefined, { now: time.read });
});

test("activity: a Codex thread sending through the MCP server moves its active_at", async () => {
  const time = clock();
  await withRig(async rig => {
    const target = await rig.harness("pi", uuid(), "/projects/web");
    const codex = await rig.harness("codex", uuid(), "/projects/api");
    time.now = T2;
    await codex.send(`comms:${target.agent.name}`, "From Codex");
    expect(await activeAt(rig, codex.agent.id)).toBe(T2);
  }, undefined, { now: time.read });
});

test("activity: an earlier clock reading never moves active_at backward", async () => {
  const time = clock(T3);
  await withRig(async rig => {
    const sender = await rig.peer(), receiver = await rig.peer();
    const a = await sender.register(registration("pi", uuid(), "/projects/web"));
    const b = await receiver.register(registration("pi", uuid(), "/projects/api"));
    time.now = T2;
    const id = uuid();
    await sender.request("send", { token: a.token, id, to: `comms:${b.agent.name}`, body: "Clock went back" });
    await receiver.deliveries.next();
    await receiver.request("ack", { token: b.token, id });
    expect(await activeAt(rig, a.agent.id)).toBe(T3);
    expect(await activeAt(rig, b.agent.id)).toBe(T3);
  }, undefined, { now: time.read });
});

test("activity: after a core start, an agent not yet active falls back to last_seen", async () => {
  const time = clock();
  await withRig(async rig => {
    const peer = await rig.peer();
    const hello = await peer.register(registration("pi", uuid(), "/projects/web"));
    peer.close();
    await eventually(() => rig.agents(), list => expect(list.find(a => a.id === hello.agent.id)?.online).toBe(false));
    time.now = T3;
    await rig.restart();
    const agent = (await rig.agents()).find(a => a.id === hello.agent.id)!;
    expect(agent.active_at).toBeString();
    expect(agent.active_at).toBe(agent.last_seen);
  }, undefined, { now: time.read });
});

// A fake daemon snapshot, as the core's Codex poll reads it, counting reads so a test can wait for polls.
function fakeDaemon() {
  const daemon = {
    snapshot: undefined as CodexSnapshot | undefined,
    reads: 0,
    read: async () => { daemon.reads++; return daemon.snapshot; },
    async polls(count: number) {
      const target = daemon.reads + count;
      await eventually(() => daemon.reads, reads => expect(reads).toBeGreaterThanOrEqual(target));
    },
  };
  return daemon;
}

test("activity: a Codex thread's active_at follows the daemon's activity time on each poll and never moves backward", async () => {
  const daemon = fakeDaemon();
  // The clock stays before every daemon time, so registering the thread does not mask them.
  const time = clock(T("2029-12-31T00:00:00.000Z"));
  await withRig(async rig => {
    const fake = new FakeCodex(uuid(), "/projects/api");
    rig.codexFakes.set(fake.threadId, fake);
    const loaded = (active_at: string): CodexSnapshot => ({ executable: "/daemon/codex", threads: [{ id: fake.threadId, cwd: fake.cwd, active_at }] });
    daemon.snapshot = loaded("2030-01-01T00:05:00.000Z");
    const agent = await rig.agent("codex", fake.threadId);
    await eventually(() => activeAt(rig, agent.id), value => expect(value).toBe(T2));

    daemon.snapshot = loaded("2030-01-01T00:00:00.000Z");
    await daemon.polls(3);
    expect(await activeAt(rig, agent.id)).toBe(T2);

    daemon.snapshot = loaded("2030-01-01T00:10:00.000Z");
    await eventually(() => activeAt(rig, agent.id), value => expect(value).toBe(T3));

    // A send at a later clock time is not undone by the next poll's earlier daemon time.
    const target = await rig.harness("pi", uuid(), "/projects/web");
    time.now = T4;
    const adapter = createCodexAdapter(rig.runtime());
    try {
      const result = await adapter.toolsCall(fake.request("comms_send", { to: `comms:${target.agent.name}`, text: "Done" }));
      expect(result.isError).not.toBe(true);
    } finally { await adapter.close(); }
    expect(await activeAt(rig, agent.id)).toBe(T4);
    await daemon.polls(3);
    expect(await activeAt(rig, agent.id)).toBe(T4);
  }, undefined, { codexDaemon: daemon.read, codexPollMs: 5, now: time.read });
});

test("activity: Pi's and Codex's comms_list results include active_at", async () => {
  const time = clock();
  await withRig(async rig => {
    const pi = await rig.harness("pi", uuid(), "/projects/web");
    time.now = T2;
    const codex = await rig.harness("codex", uuid(), "/projects/api");
    const fromPi = JSON.parse((await pi.list() as PiToolResult).content[0]!.text) as Agent[];
    const fromCodex = JSON.parse((await codex.list() as McpResult).content[0]!.text) as Agent[];
    for (const agents of [fromPi, fromCodex]) {
      expect(activity(agents.find(a => a.id === pi.agent.id))).toBe(T1);
      expect(activity(agents.find(a => a.id === codex.agent.id))).toBe(T2);
    }
  }, undefined, { now: time.read });
});

// Claude's ListAgents shows activity relative to $.clock.now(): `active now` under a minute, then whole
// minutes, hours, and days.
const boundaries: [number, string][] = [
  [0, "active now"],
  [59_999, "active now"],
  [60_000, "active 1m ago"],
  [12 * 60_000 + 30_000, "active 12m ago"],
  [60 * 60_000 - 1, "active 59m ago"],
  [60 * 60_000, "active 1h ago"],
  [24 * 60 * 60_000 - 1, "active 23h ago"],
  [24 * 60 * 60_000, "active 1d ago"],
  [3 * 24 * 60 * 60_000 + 5 * 60 * 60_000, "active 3d ago"],
];

const peerSessions = "This session is planner [2a1458].\n\nPeer sessions (1):\n  reviewer [036dfb]  ·  interactive  ·  idle";

test("activity: ListAgents rows under the native header show relative activity after the presence", async () => {
  const time = clock();
  await withRig(async rig => {
    const claude = await rig.harness("claude", uuid(), "/projects/shared");
    await rig.harness("pi", uuid(), "/projects/web");
    const fake = claude.fake as FakeClaude;
    fake.nativeListing = peerSessions;
    for (const [elapsed, active] of boundaries) {
      fake.time = T1 + elapsed;
      const listing = (await claude.list() as { result: { listing: string } }).result.listing;
      expect(listing.split("\n").find(line => line.includes("pi-web"))).toBe(
        `  pi-web  ·  pi  ·  online  ·  ${active}  ·  /projects/web  ·  send to comms:pi-web`);
    }
  }, undefined, { now: time.read });
});

test("activity: ListAgents rows without the native header show relative activity after the presence", async () => {
  const time = clock();
  await withRig(async rig => {
    const claude = await rig.harness("claude", uuid(), "/projects/shared");
    await rig.harness("codex", uuid(), "/projects/api");
    const fake = claude.fake as FakeClaude;
    for (const [elapsed, active] of boundaries) {
      fake.time = T1 + elapsed;
      const listing = (await claude.list() as { result: { listing: string } }).result.listing;
      expect(listing.split("\n").find(line => line.includes("codex-api"))).toBe(`comms:codex-api (codex, online, ${active}, /projects/api)`);
    }
  }, undefined, { now: time.read });
});

// A stand-in for Codex's app-server daemon whose `thread/read` answers with the thread's current times,
// as `Thread` in the generated app-server schema has them: `updatedAt`, and nullable `recencyAt`, in Unix seconds.
test("codex daemon client: each poll reports a thread's recencyAt, or its updatedAt without one, as active_at", async () => {
  const home = mkdtempSync("/tmp/cxh-");
  mkdirSync(join(home, "app-server-control"));
  mkdirSync(join(home, "app-server-daemon"));
  writeFileSync(join(home, "app-server-daemon", "daemon.pid"), JSON.stringify({ pid: 4242 }));
  const platform = { codexHome: () => home, processExecutable: async (pid: number) => pid === 4242 ? "/daemon/codex" : undefined } as unknown as Platform;
  const threads: Record<string, { cwd: string; parentThreadId: null; ephemeral: false; updatedAt: number; recencyAt: number | null }> = {
    recent: { cwd: "/projects/api", parentThreadId: null, ephemeral: false, updatedAt: 1_893_456_000, recencyAt: 1_893_456_300 },
    updated: { cwd: "/projects/web", parentThreadId: null, ephemeral: false, updatedAt: 1_893_456_120, recencyAt: null },
  };
  const server = Bun.serve({
    unix: join(home, "app-server-control", "app-server-control.sock"),
    fetch: (request, srv) => srv.upgrade(request) ? undefined : new Response("upgrade required", { status: 426 }),
    websocket: {
      message(ws, raw) {
        const request = JSON.parse(String(raw)) as { id?: number; method: string; params?: { threadId?: string } };
        if (request.id === undefined) return;
        const result = request.method === "initialize" ? {}
          : request.method === "thread/loaded/list" ? { data: Object.keys(threads), nextCursor: null }
          : { thread: { id: request.params!.threadId!, ...threads[request.params!.threadId!] } };
        ws.send(JSON.stringify({ id: request.id, result }));
      },
    },
  });
  const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
  try {
    const read = codexDaemon(platform);
    const first = await read();
    expect(first?.threads.map(t => ({ id: t.id, cwd: t.cwd, active: Date.parse(t.active_at ?? "") }))).toEqual([
      { id: "recent", cwd: "/projects/api", active: Date.parse(iso(1_893_456_300)) },
      { id: "updated", cwd: "/projects/web", active: Date.parse(iso(1_893_456_120)) },
    ]);
    threads.recent!.recencyAt = 1_893_456_900;
    threads.updated!.updatedAt = 1_893_457_000;
    const second = await read();
    expect(second?.threads.map(t => Date.parse(t.active_at ?? ""))).toEqual([Date.parse(iso(1_893_456_900)), Date.parse(iso(1_893_457_000))]);
  } finally { server.stop(true); rmSync(home, { recursive: true, force: true }); }
});
