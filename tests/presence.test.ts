import { expect, test } from "bun:test";
import { COMMS_TOOLS, VERSION_RANGE, type Agent, type Harness } from "@cross-harness-comms/protocol";
import { watchCodexDaemon } from "../packages/core/src/codex/daemon.ts";
import type { CodexEvent } from "../packages/core/src/codex/events.ts";
import { createCodexAdapter, type McpResult } from "../adapters/codex/src/index.ts";
import { FakeClaude } from "./support/fakes/claude.ts";
import { FakeCodex } from "./support/fakes/codex.ts";
import { fakeCodexDaemon } from "./support/fakes/codex-daemon.ts";
import { FakeCodexEvents } from "./support/fakes/codex-events.ts";
import { FakePi } from "./support/fakes/pi.ts";
import { peerSessions, runsOf } from "./support/claude.ts";
import { eventually, uuid, type Peer } from "./support/helpers.ts";
import { cli, registration, withRig, type Rig } from "./support/rig.ts";

// HANDOFF-PRESENCE: every listed agent carries `presence`, computed from the core's injected clock when
// `list` or `resolve` answers. `offline` is not online; `active` is online with `active_at` within the
// threshold; `idle` is online with `active_at` older. The threshold is 1800 seconds for Claude and Pi, and
// for Codex the daemon's `thread_unload_delay_secs` from `config/read` on the observer's latest connection,
// or 1800 when that read failed or had no value. Agent-facing lists hide agents offline for more than a day.
// `last_seen` follows the same injected clock, so an agent's day offline is measured on it too.

const M = 60_000, H = 60 * M, D = 24 * H;
const T0 = Date.parse("2030-01-01T00:00:00.000Z");

function clock(start = T0) {
  const value = { now: start, read: () => value.now };
  return value;
}

const iso = (time: number) => new Date(time).toISOString();

async function presence(rig: Rig, id: string): Promise<Agent["presence"]> {
  const agent = (await rig.agents()).find(a => a.id === id);
  // `online` stays, and means not offline.
  expect(agent?.online).toBe(agent?.presence !== "offline");
  return agent?.presence;
}

// An agent registered on its own connection, which `leave` closes and waits until the core has it offline,
// so its `last_seen` is the clock reading at that moment.
async function join(rig: Rig, cwd: string, harness: Harness = "pi") {
  const peer = await rig.peer();
  return { peer, ...await peer.register(registration(harness, uuid(), cwd)) };
}
async function leave(rig: Rig, joined: { peer: Peer; agent: Agent }) {
  joined.peer.close();
  await eventually(() => rig.agents(), agents => expect(agents.find(a => a.id === joined.agent.id)?.online).toBe(false));
}

// A one-shot connection with no session, as an administrative caller.
async function caller(rig: Rig): Promise<Peer> {
  const peer = await rig.peer();
  await peer.request("hello", { versions: VERSION_RANGE });
  return peer;
}

async function withEvents(time: ReturnType<typeof clock>, run: (rig: Rig, events: FakeCodexEvents) => Promise<void>) {
  const events = new FakeCodexEvents();
  await withRig(async rig => {
    try { await run(rig, events); }
    finally { events.close(); }
  }, undefined, { codexEvents: events, now: time.read });
}

// A loaded Codex thread from the daemon's snapshot, last active at `active`.
async function loaded(rig: Rig, events: FakeCodexEvents, active: number, unload_delay_secs?: number) {
  const fake = new FakeCodex(uuid(), "/projects/api");
  rig.codexFakes.set(fake.threadId, fake);
  await events.publish({ method: "comms/daemon-snapshot", executable: "/daemon/codex", params: {
    threads: [{ id: fake.threadId, cwd: fake.cwd, active_at: iso(active) }], ...(unload_delay_secs === undefined ? {} : { unload_delay_secs }) } });
  return { fake, agent: await rig.agent("codex", fake.threadId) };
}

for (const harness of ["pi", "claude"] as Harness[]) {
  test(`presence: an attached ${harness} session is active within 30 minutes, idle after, and offline once detached`, async () => {
    const time = clock();
    await withRig(async rig => {
      const session = await rig.harness(harness, uuid(), "/projects/web");
      expect(await presence(rig, session.agent.id)).toBe("active");
      time.now = T0 + 29 * M;
      expect(await presence(rig, session.agent.id)).toBe("active");
      time.now = T0 + 31 * M;
      expect(await presence(rig, session.agent.id)).toBe("idle");
      await session.close();
      await eventually(() => presence(rig, session.agent.id), value => expect(value).toBe("offline"));
    }, undefined, { now: time.read });
  });
}

test("presence: activity makes an idle session active again", async () => {
  const time = clock();
  await withRig(async rig => {
    const sender = await rig.harness("pi", uuid(), "/projects/web");
    const target = await rig.harness("pi", uuid(), "/projects/api");
    time.now = T0 + 45 * M;
    expect(await presence(rig, sender.agent.id)).toBe("idle");
    await sender.send(`comms:${target.agent.name}`, "Still here");
    expect(await presence(rig, sender.agent.id)).toBe("active");
  }, undefined, { now: time.read });
});

test("presence: resolve answers with the presence list gives", async () => {
  const time = clock();
  await withRig(async rig => {
    const pi = await rig.harness("pi", uuid(), "/projects/web");
    const admin = await caller(rig);
    expect((await admin.request("resolve", { name: pi.agent.name })).agent?.presence).toBe("active");
    time.now = T0 + 31 * M;
    expect((await admin.request("resolve", { name: pi.agent.name })).agent?.presence).toBe("idle");
  }, undefined, { now: time.read });
});

test("presence: a Codex thread started by its hook uses 1800 seconds without a daemon, and SessionEnd makes it offline", async () => {
  const time = clock();
  await withRig(async rig => {
    const codex = await rig.harness("codex", uuid(), "/projects/api");
    time.now = T0 + 29 * M;
    expect(await presence(rig, codex.agent.id)).toBe("active");
    time.now = T0 + 31 * M;
    expect(await presence(rig, codex.agent.id)).toBe("idle");
    expect((await rig.hook("session-end", (codex.fake as FakeCodex).sessionEnd())).exitCode).toBe(0);
    expect(await presence(rig, codex.agent.id)).toBe("offline");
  }, undefined, { now: time.read });
});

test("presence: a loaded Codex thread is active within the default delay, idle past it, and offline after thread/closed", async () => {
  const time = clock();
  await withEvents(time, async (rig, events) => {
    const { fake, agent } = await loaded(rig, events, T0);
    expect(await presence(rig, agent.id)).toBe("active");
    time.now = T0 + 29 * M;
    expect(await presence(rig, agent.id)).toBe("active");
    time.now = T0 + 31 * M;
    expect(await presence(rig, agent.id)).toBe("idle");
    await events.publish({ method: "thread/closed", params: { threadId: fake.threadId } });
    expect(await presence(rig, agent.id)).toBe("offline");
  });
});

test("presence: a loaded Codex thread is offline after SessionEnd", async () => {
  const time = clock();
  await withEvents(time, async (rig, events) => {
    const { fake, agent } = await loaded(rig, events, T0);
    time.now = T0 + 31 * M;
    expect(await presence(rig, agent.id)).toBe("idle");
    expect((await rig.hook("session-end", fake.sessionEnd())).exitCode).toBe(0);
    expect(await presence(rig, agent.id)).toBe("offline");
  });
});

test("presence: a 900-second delay from config/read moves the Codex boundary to 15 minutes, and only for Codex", async () => {
  const time = clock();
  await withEvents(time, async (rig, events) => {
    const { agent } = await loaded(rig, events, T0, 900);
    const hooked = await rig.harness("codex", uuid(), "/projects/hooked");
    const pi = await rig.harness("pi", uuid(), "/projects/web");
    time.now = T0 + 14 * M;
    expect(await presence(rig, agent.id)).toBe("active");
    expect(await presence(rig, hooked.agent.id)).toBe("active");
    time.now = T0 + 16 * M;
    expect(await presence(rig, agent.id)).toBe("idle");
    // The threshold is per harness: every Codex agent follows the daemon's delay, Pi keeps 1800 seconds.
    expect(await presence(rig, hooked.agent.id)).toBe("idle");
    expect(await presence(rig, pi.agent.id)).toBe("active");
  });
});

test("presence: a snapshot whose config/read failed uses 1800 seconds, also after an earlier connection read 900", async () => {
  const time = clock();
  await withEvents(time, async (rig, events) => {
    const { fake, agent } = await loaded(rig, events, T0);
    time.now = T0 + 16 * M;
    expect(await presence(rig, agent.id)).toBe("active");

    await events.publish({ method: "comms/daemon-disconnected" });
    await events.publish({ method: "comms/daemon-snapshot", executable: "/daemon/codex", params: {
      threads: [{ id: fake.threadId, cwd: fake.cwd, active_at: iso(T0) }], unload_delay_secs: 900 } });
    expect(await presence(rig, agent.id)).toBe("idle");

    // The next connection's read failed, so its snapshot has no value.
    await events.publish({ method: "comms/daemon-disconnected" });
    await events.publish({ method: "comms/daemon-snapshot", executable: "/daemon/codex", params: {
      threads: [{ id: fake.threadId, cwd: fake.cwd, active_at: iso(T0) }] } });
    expect(await presence(rig, agent.id)).toBe("active");
    time.now = T0 + 31 * M;
    expect(await presence(rig, agent.id)).toBe("idle");
  });
});

// The daemon side: `config/read` on each connection, reported on that connection's snapshot. Shapes are
// `ConfigReadParams` and `ConfigReadResponse` from `codex app-server generate-ts`; see tests/SOURCES.md.
test("codex daemon client: each connection reads the unload delay with config/read and reports it on its snapshot", async () => {
  let config: () => unknown = () => ({ config: { model: null, thread_unload_delay_secs: 900 }, origins: {}, layers: null });
  const daemon = fakeCodexDaemon(request => request.method === "thread/loaded/list" ? { data: [], nextCursor: null } : {},
    { config: () => config() });
  const events = watchCodexDaemon(daemon.platform, { retryMs: 5, timeoutMs: 200 })[Symbol.asyncIterator]();
  type Snapshot = Extract<CodexEvent, { method: "comms/daemon-snapshot" }>;
  const snapshot = async () => {
    const event = (await events.next()).value as Snapshot;
    expect(event.method).toBe("comms/daemon-snapshot");
    return event;
  };
  const reconnect = async () => {
    daemon.disconnect();
    expect((await events.next()).value).toEqual({ method: "comms/daemon-disconnected" });
    return snapshot();
  };
  try {
    expect((await snapshot()).params).toEqual({ threads: [], unload_delay_secs: 900 });
    config = () => ({ config: { model: null, thread_unload_delay_secs: 1200 }, origins: {}, layers: null });
    expect((await reconnect()).params).toEqual({ threads: [], unload_delay_secs: 1200 });
    // A failed read still yields the snapshot, without a value.
    config = () => { throw new Error("config unavailable"); };
    expect((await reconnect()).params).toEqual({ threads: [] });
    // So does a config without the key, and one whose value is not a number.
    config = () => ({ config: { model: null }, origins: {}, layers: null });
    expect((await reconnect()).params).toEqual({ threads: [] });
    config = () => ({ config: { model: null, thread_unload_delay_secs: "soon" }, origins: {}, layers: null });
    expect((await reconnect()).params).toEqual({ threads: [] });
    expect(daemon.requests.filter(method => method === "config/read")).toHaveLength(5);
    // Read only: never a config write.
    expect(daemon.requests.filter(method => method.startsWith("config/") && method !== "config/read")).toEqual([]);
  } finally { await events.return?.(); daemon.close(); }
});

test("list: hides agents offline for more than a day and counts them, include_stale returns all, and 23 hours offline is shown", async () => {
  const time = clock();
  await withRig(async rig => {
    const old = await join(rig, "/projects/old");
    await leave(rig, old);
    const live = await join(rig, "/projects/live");
    const admin = await caller(rig);
    const ids = (agents: Agent[]) => agents.map(agent => agent.id);

    time.now = T0 + 23 * H;
    const shown = await admin.request("list", {});
    expect(ids(shown.agents)).toEqual([old.agent.id, live.agent.id]);
    expect(shown.hidden).toBe(0);

    time.now = T0 + 25 * H;
    const filtered = await admin.request("list", {});
    // An online agent is never hidden, however long since its last activity.
    expect(ids(filtered.agents)).toEqual([live.agent.id]);
    expect(filtered.agents[0]!.presence).toBe("idle");
    expect(filtered.hidden).toBe(1);
    expect(await admin.request("list", { include_stale: false })).toEqual(filtered);

    const all = await admin.request("list", { include_stale: true });
    expect(ids(all.agents)).toEqual([old.agent.id, live.agent.id]);
    expect(all.agents[0]!.presence).toBe("offline");
    expect(all.hidden).toBe(0);
  }, undefined, { now: time.read });
});

test("list: a hidden agent still resolves by bare name and receives its queued mail on reconnect", async () => {
  const time = clock();
  await withRig(async rig => {
    const away = await join(rig, "/projects/away");
    await leave(rig, away);
    time.now = T0 + 2 * D;
    const sender = await rig.harness("pi", uuid(), "/projects/web");
    const admin = await caller(rig);
    expect((await admin.request("list", {})).agents.map(a => a.id)).not.toContain(away.agent.id);

    const resolved = (await admin.request("resolve", { name: away.agent.name })).agent;
    expect(resolved).toMatchObject({ id: away.agent.id, name: away.agent.name, online: false, presence: "offline" });

    await sender.send(`comms:${away.agent.name}`, "Waiting for you");
    const queued = rig.rows().at(-1)!;
    expect(queued).toMatchObject({ recipient: away.agent.id, state: "queued" });
    await sender.send(`comms:${away.agent.name}`, "And this one");
    expect(rig.rows().filter(row => row.recipient === away.agent.id && row.state === "queued")).toHaveLength(2);

    const back = await rig.peer();
    await back.register(registration("pi", away.agent.session_key, "/projects/away"), undefined, away.token);
    expect((await back.deliveries.next()).message.body).toBe("Waiting for you");
    expect((await back.deliveries.next()).message.body).toBe("And this one");
    expect(await presence(rig, away.agent.id)).toBe("active");
  }, undefined, { now: time.read });
});

test("comms list from the CLI still returns every agent", async () => {
  const time = clock();
  await withRig(async rig => {
    const old = await join(rig, "/projects/old");
    await leave(rig, old);
    const live = await join(rig, "/projects/live");
    time.now = T0 + 3 * D;
    for (const input of [undefined, { token: live.token }]) {
      const listed = await cli(rig, "list", input);
      expect(listed.exitCode, listed.stderr).toBe(0);
      const result = JSON.parse(listed.stdout) as { agents: Agent[]; hidden?: number };
      expect(result.agents.map(a => a.id)).toEqual([old.agent.id, live.agent.id]);
      expect(result.agents.map(a => a.presence)).toEqual(["offline", "idle"]);
      expect(result.hidden).toBe(0);
    }
  }, undefined, { now: time.read });
});

// Two agents offline for two days (hidden), one idle, one active, and one offline for minutes, all Pi.
async function population(rig: Rig, time: ReturnType<typeof clock>, start: number) {
  time.now = start;
  for (const cwd of ["/projects/old", "/projects/older"]) await leave(rig, await join(rig, cwd));
  time.now = start + 2 * D;
  const idle = await join(rig, "/projects/idle");
  time.now = start + 2 * D + 35 * M;
  const active = await rig.harness("pi", uuid(), "/projects/web");
  await leave(rig, await join(rig, "/projects/gone"));
  return { idle, active };
}

test("Claude ListAgents: rows without the native header show presence, and one line counts the hidden agents", async () => {
  const time = clock();
  await withRig(async rig => {
    const claude = await rig.harness("claude", uuid(), "/projects/shared");
    await population(rig, time, T0);
    const fake = claude.fake as FakeClaude;
    fake.time = time.now;
    const listing = (await claude.list() as { result: { listing: string } }).result.listing;
    expect(listing).toBe([
      fake.nativeListing,
      "comms:pi-idle (pi, idle, active 35m ago, /projects/idle)",
      "comms:pi-web (pi, active, active now, /projects/web)",
      "comms:pi-gone (pi, offline, active now, /projects/gone)",
      "2 offline agents not shown",
    ].join("\n"));
    // Claude asks for the agent-facing list; the CLI otherwise shows everything.
    expect(JSON.parse(runsOf(fake, "list").at(-1)!.init!.stdin!)).toMatchObject({ include_stale: false });
  }, undefined, { now: time.read });
});

test("Claude ListAgents: rows under the native header show presence, the count excludes the hidden line", async () => {
  const time = clock();
  await withRig(async rig => {
    const claude = await rig.harness("claude", uuid(), "/projects/shared");
    await population(rig, time, T0);
    const fake = claude.fake as FakeClaude;
    fake.nativeListing = peerSessions;
    fake.time = time.now;
    const listing = (await claude.list() as { result: { listing: string } }).result.listing;
    expect(listing).toBe([
      peerSessions.replace("Peer sessions (1):", "Peer sessions (4):"),
      "  pi-idle  ·  pi  ·  idle  ·  active 35m ago  ·  /projects/idle  ·  send to comms:pi-idle",
      "  pi-web  ·  pi  ·  active  ·  active now  ·  /projects/web  ·  send to comms:pi-web",
      "  pi-gone  ·  pi  ·  offline  ·  active now  ·  /projects/gone  ·  send to comms:pi-gone",
      "2 offline agents not shown",
    ].join("\n"));
  }, undefined, { now: time.read });
});

test("Claude ListAgents: no hidden line when nothing is hidden", async () => {
  await withRig(async rig => {
    const claude = await rig.harness("claude", uuid(), "/projects/shared");
    await rig.harness("pi", uuid(), "/projects/web");
    const listing = (await claude.list() as { result: { listing: string } }).result.listing;
    expect(listing).toBe(`${(claude.fake as FakeClaude).nativeListing}\ncomms:pi-web (pi, active, active now, /projects/web)`);
  });
});

test("Pi comms_list: one line per agent with presence and activity, a hidden count, and all", async () => {
  // Pi reads its own clock for the relative activity, so the core's clock runs on real time here.
  const time = clock();
  await withRig(async rig => {
    const now = Date.now();
    const { active } = await population(rig, time, now - 2 * D - 40 * M);
    time.now = Date.now();
    const pi = active.fake as FakePi;
    const text = (all?: boolean) => pi.tool("comms_list", all === undefined ? {} : { all }).then(result => result.content.map(c => c.text).join("\n"));
    const rows = [
      "pi-idle · pi · idle · active 40m ago · /projects/idle · comms:pi-idle",
      "pi-web · pi · active · active 5m ago · /projects/web · comms:pi-web",
      "pi-gone · pi · offline · active 5m ago · /projects/gone · comms:pi-gone",
    ];
    expect(await text()).toBe([...rows, "2 offline agents not shown"].join("\n"));
    expect(await text(false)).toBe([...rows, "2 offline agents not shown"].join("\n"));
    expect(await text(true)).toBe([
      "pi-old · pi · offline · active 2d ago · /projects/old · comms:pi-old",
      "pi-older · pi · offline · active 2d ago · /projects/older · comms:pi-older",
      ...rows,
    ].join("\n"));
  }, undefined, { now: time.read });
});

test("Codex comms_list: JSON with presence, a hidden count after it, and all", async () => {
  const time = clock();
  await withRig(async rig => {
    const { idle } = await population(rig, time, T0);
    const codex = await rig.harness("codex", uuid(), "/projects/api");
    const fake = codex.fake as FakeCodex;
    const adapter = createCodexAdapter(rig.runtime());
    try {
      const call = async (args: Record<string, unknown>) => {
        const result = await adapter.toolsCall(fake.request("comms_list", args)) as McpResult;
        expect(result.isError).not.toBe(true);
        return result;
      };
      const presences = (result: McpResult) => Object.fromEntries((JSON.parse(result.content[0]!.text) as (Agent & { address: string })[])
        .map(agent => [agent.address, agent.presence]));
      const visible: Record<string, Agent["presence"]> = { "comms:pi-idle": "idle", "comms:pi-web": "active", "comms:pi-gone": "offline", "comms:codex-api": "active" };
      for (const args of [{}, { all: false }]) {
        const result = await call(args);
        expect(presences(result)).toEqual(visible);
        expect(result.content.slice(1)).toEqual([{ type: "text", text: "2 offline agents not shown" }]);
      }
      const all = await call({ all: true });
      expect(presences(all)).toEqual({ "comms:pi-old": "offline", "comms:pi-older": "offline", ...visible });
      expect(all.content).toHaveLength(1);
      expect(JSON.parse(all.content[0]!.text).find((a: Agent) => a.id === idle.agent.id)).toMatchObject({ online: true, presence: "idle" });
    } finally { await adapter.close(); }
  }, undefined, { now: time.read });
});

test("comms_list takes an optional all boolean", () => {
  const list = COMMS_TOOLS.find(tool => tool.name === "comms_list")!;
  expect(list.inputSchema).toMatchObject({ type: "object", properties: { all: { type: "boolean" } } });
  expect((list.inputSchema as unknown as { required?: string[] }).required ?? []).not.toContain("all");
});
