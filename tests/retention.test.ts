import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { VERSION_RANGE, type Harness } from "@cross-harness-comms/protocol";
import { FakeCodex } from "./support/fakes/codex.ts";
import { FakeCodexEvents } from "./support/fakes/codex-events.ts";
import { claudeAddress, connectable, nativePeer, socketPath } from "./support/claude.ts";
import { eventually, uuid } from "./support/helpers.ts";
import { Rig, registration, withRig } from "./support/rig.ts";

// HANDOFF-RETENTION: a sweep, at core start and whenever a registration creates a new agent, removes each agent that is
// offline (no live connection, not an online Codex thread), has a generated name (`name_chosen = 0`), was last seen more
// than 30 days ago on the core's clock, and has no `queued` or `delivered` message it sent to an agent that stays.
// Removal takes every message to or from the agent, its `codex_threads` and `codex_lifecycle` rows, and clears `reply_to`
// on remaining messages that pointed at a removed one. The name is tombstoned in `released_names` for 30 more days: generated
// naming skips it, and `name` and `rename` refuse it with NAME_TAKEN. A sweep deletes tombstones older than 30 days.

const M = 60_000, D = 24 * 60 * M;
const T0 = Date.parse("2030-01-01T00:00:00.000Z");
const iso = (time: number) => new Date(time).toISOString();

function clock(start = T0) {
  const value = { now: start, read: () => value.now };
  return value;
}

// Reads the database the way the token and name tests do, so a removal is checked in storage, not only in listings.
function query<T>(rig: Rig, sql: string): T[] {
  const db = new Database(rig.databasePath, { readonly: true });
  try { return db.query(sql).all() as T[]; }
  finally { db.close(); }
}
const agentIds = (rig: Rig) => query<{ id: string }>(rig, "SELECT id FROM agents ORDER BY rowid").map(row => row.id);
const tombstones = (rig: Rig) => query<{ name: string }>(rig, "SELECT name FROM released_names ORDER BY name").map(row => row.name);

// An agent on its own wire connection, as an adapter registers; `leave` waits until the core has it offline,
// so its `last_seen` is the clock reading at that moment.
async function join(rig: Rig, cwd: string, harness: Harness = "pi", session_key = uuid()) {
  const peer = await rig.peer();
  const hello = await peer.register(registration(harness, session_key, cwd));
  return { peer, agent: hello.agent, token: hello.token, session_key };
}
type Joined = Awaited<ReturnType<typeof join>>;

async function leave(rig: Rig, joined: Joined) {
  joined.peer.close();
  await eventually(() => rig.agents(), agents => expect(agents.find(a => a.id === joined.agent.id)?.online).toBe(false));
}

const send = (from: Joined, to: string, body: string, reply_to?: string) =>
  from.peer.request("send", { token: from.token, id: uuid(), to, body, ...(reply_to ? { reply_to } : {}) });

// Acknowledges the next message delivered to `joined`.
async function ackNext(joined: Joined) {
  const { message } = await joined.peer.deliveries.next();
  await joined.peer.request("ack", { token: joined.token, id: message.id });
  return message;
}

async function withEvents(time: ReturnType<typeof clock>, run: (rig: Rig, events: FakeCodexEvents) => Promise<void>) {
  const events = new FakeCodexEvents();
  await withRig(async rig => {
    try { await run(rig, events); }
    finally { events.close(); }
  }, undefined, { codexEvents: events, now: time.read });
}

function codexThread(rig: Rig, cwd: string) {
  const fake = new FakeCodex(uuid(), cwd);
  rig.codexFakes.set(fake.threadId, fake);
  return fake;
}
// A daemon snapshot whose loaded threads are exactly `fakes`.
const snapshot = (events: FakeCodexEvents, ...fakes: FakeCodex[]) => events.publish({ method: "comms/daemon-snapshot", executable: "/daemon/codex",
  params: { threads: fakes.map(fake => ({ id: fake.threadId, cwd: fake.cwd, active_at: iso(T0) })) } });

test("retention: at core start, an offline agent with a generated name last seen just over 30 days ago is removed with its mail, its Codex rows, and reply_to links to its messages; one just under stays", async () => {
  const time = clock();
  await withRig(async rig => {
    const stay = await join(rig, "/projects/stay"), old = await join(rig, "/projects/old"), recent = await join(rig, "/projects/recent");
    const codex = await rig.harness("codex", uuid(), "/projects/old-codex");

    // Acknowledged mail both ways with the old Pi agent and the old Codex thread.
    const asked = await send(stay, `comms:${old.agent.name}`, "Question");
    await ackNext(old);
    const answered = await send(old, `comms:${stay.agent.name}`, "Answer", asked.id);
    await ackNext(stay);
    const toCodex = await send(stay, `comms:${codex.agent.name}`, "For Codex");
    await rig.state(toCodex.id, "acked");
    await codex.send(`comms:${stay.agent.name}`, "From Codex");
    await ackNext(stay);
    // A message between agents that stay, replying to one the old agent sent.
    const kept = await send(stay, `comms:${recent.agent.name}`, "Forwarded", answered.id);
    await ackNext(recent);

    await leave(rig, old);
    expect((await rig.hook("session-end", (codex.fake as FakeCodex).sessionEnd())).exitCode).toBe(0);
    // Mail queued for an agent that never returns expires with it.
    await send(stay, `comms:${old.agent.name}`, "Too late");
    expect(query<{ agent: string }>(rig, "SELECT agent FROM codex_lifecycle")).toEqual([{ agent: codex.agent.id }]);
    expect(rig.rows()).toHaveLength(6);

    time.now = T0 + 2 * M;
    await leave(rig, recent);
    time.now = T0 + 30 * D + M;
    await leave(rig, stay);
    await rig.restart();

    await eventually(() => agentIds(rig), ids => expect(ids).toEqual([stay.agent.id, recent.agent.id]));
    expect(rig.rows()).toEqual([expect.objectContaining({ id: kept.id, sender: stay.agent.id, recipient: recent.agent.id, reply_to: null })]);
    expect(query(rig, "SELECT agent FROM codex_threads UNION ALL SELECT agent FROM codex_lifecycle")).toEqual([]);
    expect((await rig.agents()).map(agent => agent.id)).toEqual([stay.agent.id, recent.agent.id]);
  }, undefined, { now: time.read });
});

test("retention: a registration that creates an agent runs the sweep, and a resume, list, resolve, or send does not", async () => {
  const time = clock();
  await withRig(async rig => {
    const old = await join(rig, "/projects/old"), back = await join(rig, "/projects/back"), stay = await join(rig, "/projects/stay");
    await leave(rig, old);
    await leave(rig, back);
    time.now = T0 + 31 * D;

    const resumed = await rig.peer();
    const hello = await resumed.register(registration("pi", back.session_key, "/projects/back"), VERSION_RANGE, back.token);
    expect(hello.agent.id).toBe(back.agent.id);
    await stay.peer.request("list", { include_stale: true });
    expect((await stay.peer.request("resolve", { name: old.agent.name })).agent?.id).toBe(old.agent.id);
    await send(stay, `comms:${old.agent.name}`, "Still there?");
    expect(agentIds(rig)).toEqual([old.agent.id, back.agent.id, stay.agent.id]);
    expect(rig.rows()).toMatchObject([{ recipient: old.agent.id, state: "queued" }]);

    // A new wire session runs it, taking the queued message with the agent.
    const fresh = await join(rig, "/projects/fresh");
    await eventually(() => agentIds(rig), ids => expect(ids).toEqual([back.agent.id, stay.agent.id, fresh.agent.id]));
    expect(rig.rows()).toEqual([]);

    // So does a new Codex thread registering through its SessionStart hook.
    const later = await join(rig, "/projects/later");
    await leave(rig, later);
    time.now = T0 + 62 * D;
    const thread = await rig.harness("codex", uuid(), "/projects/thread");
    await eventually(() => agentIds(rig), ids => expect(ids).toEqual([back.agent.id, stay.agent.id, fresh.agent.id, thread.agent.id]));
  }, undefined, { now: time.read });
});

test("retention: an online agent, a Codex thread online through hooks or the daemon, and an agent with a chosen name are never removed, however old", async () => {
  const time = clock();
  await withEvents(time, async (rig, events) => {
    const online = await join(rig, "/projects/online");
    const hooked = await rig.harness("codex", uuid(), "/projects/hooked");
    const loaded = codexThread(rig, "/projects/loaded");
    await snapshot(events, loaded);
    const daemon = await rig.agent("codex", loaded.threadId);
    const named = await join(rig, "/projects/named");
    await named.peer.request("name", { token: named.token, name: "planner" });
    await leave(rig, named);
    const kept = [online.agent.id, hooked.agent.id, daemon.id, named.agent.id];

    for (const days of [31, 90, 365]) {
      time.now = T0 + days * D;
      const fresh = await join(rig, `/projects/fresh-${days}`);
      expect(agentIds(rig), `${days} days`).toEqual(expect.arrayContaining([...kept, fresh.agent.id]));
    }
    expect((await rig.agents()).filter(agent => kept.includes(agent.id)).map(agent => [agent.name, agent.online]))
      .toEqual([[online.agent.name, true], [hooked.agent.name, true], [daemon.name, true], ["planner", false]]);

    // A chosen name and a hook-only Codex thread also survive the sweep at core start.
    await rig.restart();
    expect(agentIds(rig)).toEqual(expect.arrayContaining([hooked.agent.id, named.agent.id]));
    expect(await rig.agent("codex", hooked.sessionId)).toMatchObject({ id: hooked.agent.id, online: true });
  });
});

// An agent online until the core stopped was not offline for 30 days, whatever its `last_seen` from registration says;
// a daemon-owned Codex thread online then stays online until the first snapshot after the start omits it (presence.test.ts).
test("retention: agents online when the core stopped are not removed by the sweep at the next start, however old their last_seen", async () => {
  const time = clock();
  await withEvents(time, async (rig, events) => {
    const online = await join(rig, "/projects/online");
    const loaded = codexThread(rig, "/projects/loaded");
    await snapshot(events, loaded);
    const daemon = await rig.agent("codex", loaded.threadId);
    time.now = T0 + 31 * D;
    await rig.restart();
    expect(agentIds(rig)).toEqual([online.agent.id, daemon.id]);

    // The Pi session reconnects to its identity, and the daemon's next snapshot finds the same thread.
    const back = await rig.peer();
    const hello = await back.register(registration("pi", online.session_key, "/projects/online"), VERSION_RANGE, online.token);
    expect(hello.agent).toMatchObject({ id: online.agent.id, name: online.agent.name });
    await snapshot(events, loaded);
    expect(await rig.agent("codex", loaded.threadId)).toMatchObject({ id: daemon.id, name: daemon.name, online: true });
  });
});

test("retention: an agent whose sent mail is still queued or delivered to an agent that stays is kept; agents whose undelivered mail goes only to each other are removed together", async () => {
  const time = clock();
  await withRig(async rig => {
    const stay = await join(rig, "/projects/stay");
    const reviewer = await join(rig, "/projects/review");
    await reviewer.peer.request("name", { token: reviewer.token, name: "reviewer" });
    await leave(rig, reviewer);

    // Delivered to an online agent that has not acknowledged it.
    const delivering = await join(rig, "/projects/delivering");
    await send(delivering, `comms:${stay.agent.name}`, "Unacknowledged");
    const unacknowledged = (await stay.peer.deliveries.next()).message;
    await leave(rig, delivering);
    // Queued for an offline agent that its chosen name keeps.
    const queuing = await join(rig, "/projects/queuing");
    await send(queuing, "comms:reviewer", "Queued for the reviewer");
    await leave(rig, queuing);
    // A chain: first's mail waits for second, which stays because its own mail waits for the reviewer.
    const second = await join(rig, "/projects/second");
    await send(second, "comms:reviewer", "Also for the reviewer");
    await leave(rig, second);
    const first = await join(rig, "/projects/first");
    await send(first, `comms:${second.agent.name}`, "Waiting for second");
    await leave(rig, first);
    // A pair whose undelivered mail goes only to each other.
    const x = await join(rig, "/projects/x"), y = await join(rig, "/projects/y");
    await send(x, `comms:${y.agent.name}`, "To y");
    await send(y, `comms:${x.agent.name}`, "To x");
    await leave(rig, x);
    await send(y, `comms:${x.agent.name}`, "To x, queued");
    await leave(rig, y);
    expect(rig.rows().map(row => [row.body, row.state])).toEqual([
      ["Unacknowledged", "delivered"], ["Queued for the reviewer", "queued"], ["Also for the reviewer", "queued"],
      ["Waiting for second", "queued"], ["To y", "delivered"], ["To x", "delivered"], ["To x, queued", "queued"]]);

    time.now = T0 + 31 * D;
    const trigger = await join(rig, "/projects/trigger");
    const kept = [stay, reviewer, delivering, queuing, second, first, trigger].map(joined => joined.agent.id);
    await eventually(() => agentIds(rig), ids => expect(ids).toEqual(kept));
    expect(rig.rows().map(row => row.body)).toEqual(["Unacknowledged", "Queued for the reviewer", "Also for the reviewer", "Waiting for second"]);

    // Once its mail is acknowledged, the next sweep removes the sender with it.
    await stay.peer.request("ack", { token: stay.token, id: unacknowledged.id });
    const next = await join(rig, "/projects/next");
    await eventually(() => agentIds(rig), ids => expect(ids).toEqual([...kept.filter(id => id !== delivering.agent.id), next.agent.id]));
    expect(rig.rows().map(row => row.body)).toEqual(["Queued for the reviewer", "Also for the reviewer", "Waiting for second"]);
  }, undefined, { now: time.read });
});

test("retention: a removed agent's name is held for 30 days, so generated names skip it and name and rename refuse it, then a sweep frees it", async () => {
  const time = clock();
  await withRig(async rig => {
    const old = await join(rig, "/projects/shared");
    expect(old.agent.name).toBe("pi-shared");
    await leave(rig, old);
    const removedAt = T0 + 31 * D;
    time.now = removedAt;
    await rig.restart();
    await eventually(() => agentIds(rig), ids => expect(ids).toEqual([]));
    expect(tombstones(rig)).toEqual(["pi-shared"]);

    const next = await join(rig, "/projects/shared");
    expect(next.agent.name).toBe("pi-shared-2");
    const other = await join(rig, "/projects/other");
    const admin = await rig.peer();
    await admin.request("hello", { versions: VERSION_RANGE });
    const refused = async (label: string) => {
      for (const attempt of [
        () => other.peer.request("name", { token: other.token, name: "pi-shared" }),
        () => admin.request("rename", { address: `comms:${other.agent.name}`, name: "pi-shared" }),
      ]) {
        const error = await attempt().catch(caught => caught as Error);
        expect(error, label).toMatchObject({ data: { code: "NAME_TAKEN" } });
        expect((error as Error).message, label).toMatch(/released/i);
      }
      expect((await rig.agents()).find(agent => agent.id === other.agent.id)?.name, label).toBe("pi-other");
    };
    await refused("just released");

    time.now = removedAt + 30 * D - M;
    await join(rig, "/projects/trigger-early");
    expect(tombstones(rig)).toEqual(["pi-shared"]);
    await refused("just under 30 days");

    time.now = removedAt + 30 * D + M;
    await join(rig, "/projects/trigger-late");
    await eventually(() => tombstones(rig), names => expect(names).toEqual([]));
    expect(await other.peer.request("name", { token: other.token, name: "pi-shared" })).toMatchObject({ id: other.agent.id, name: "pi-shared" });
  }, undefined, { now: time.read });
});

test("retention: a send to a removed agent's name or ID fails as unknown and stores nothing", async () => {
  const time = clock();
  await withRig(async rig => {
    const old = await join(rig, "/projects/old");
    await leave(rig, old);
    time.now = T0 + 31 * D;
    await rig.restart();
    const sender = await join(rig, "/projects/sender");
    await eventually(() => agentIds(rig), ids => expect(ids).toEqual([sender.agent.id]));
    for (const to of [`comms:${old.agent.name}`, `comms:${old.agent.id}`]) {
      await expect(send(sender, to, "Anyone there?")).rejects.toMatchObject({ data: { code: "UNKNOWN_RECIPIENT" } });
    }
    expect(rig.rows()).toEqual([]);
    expect((await sender.peer.request("resolve", { name: old.agent.name })).agent).toBeNull();
  }, undefined, { now: time.read });
});

test("retention: removing an agent closes the reply socket the core opened for it beside a Claude session's inbox, and never reopens it", async () => {
  const time = clock();
  await withRig(async rig => {
    const old = await join(rig, "/projects/old");
    await leave(rig, old);
    const claude = await nativePeer(rig);
    const path = socketPath(await claudeAddress(rig, claude.token, old.agent.id));
    expect(await connectable(path)).toBe(true);

    time.now = T0 + 31 * D;
    // A new Pi agent runs the sweep, and its registration opens reply sockets again.
    const fresh = await join(rig, "/projects/fresh");
    await eventually(() => agentIds(rig), ids => expect(ids).toEqual([claude.agent.id, fresh.agent.id]));
    expect(await connectable(socketPath(await claudeAddress(rig, claude.token, fresh.agent.id)))).toBe(true);
    await eventually(() => connectable(path), open => expect(open).toBe(false));
    await join(rig, "/projects/another");
    expect(await connectable(path)).toBe(false);
  }, undefined, { now: time.read });
});

// The schema as 0.1.24 left it (`packages/core/src/store.ts` at 4965387), with no `released_names` table.
const SCHEMA_0_1_24 = `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
  CREATE TABLE agents (
    id TEXT PRIMARY KEY, harness TEXT NOT NULL, session_key TEXT NOT NULL,
    host TEXT NOT NULL, name TEXT NOT NULL UNIQUE, cwd TEXT NOT NULL, last_seen TEXT NOT NULL, token_hash TEXT,
    name_chosen INTEGER NOT NULL DEFAULT 0, UNIQUE(harness, session_key));
  CREATE TABLE messages (
    id TEXT PRIMARY KEY, sender TEXT NOT NULL REFERENCES agents(id), recipient TEXT NOT NULL REFERENCES agents(id),
    reply_to TEXT REFERENCES messages(id), body TEXT NOT NULL, created_at TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued','delivered','acked')));
  CREATE INDEX mailbox ON messages(recipient, state);
  CREATE TABLE codex_threads (agent TEXT PRIMARY KEY REFERENCES agents(id), executable TEXT NOT NULL);
  CREATE TABLE codex_lifecycle (
    agent TEXT PRIMARY KEY REFERENCES agents(id), executable TEXT NOT NULL,
    runtime_state TEXT NOT NULL, ended INTEGER NOT NULL DEFAULT 0, ended_at INTEGER, daemon_owned INTEGER NOT NULL DEFAULT 0);
  CREATE UNIQUE INDEX agent_token ON agents(token_hash);`;

test("retention: a database from before this change, with no released_names table, opens and sweeps", async () => {
  const now = T0 + 31 * D;
  const rig = new Rig(undefined, { now: () => now });
  try {
    const old = uuid(), stay = uuid(), question = uuid(), answer = uuid();
    const db = new Database(rig.databasePath, { create: true });
    try {
      db.exec(SCHEMA_0_1_24);
      const agent = db.query("INSERT INTO agents (id, harness, session_key, host, name, cwd, last_seen, token_hash) VALUES (?, 'pi', ?, 'fixture-host', ?, ?, ?, NULL)");
      agent.run(old, uuid(), "pi-old", "/projects/old", iso(T0));
      agent.run(stay, uuid(), "pi-stay", "/projects/stay", iso(now - D));
      const message = db.query("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)");
      message.run(question, stay, old, null, "Question", iso(T0), "acked");
      message.run(answer, old, stay, question, "Answer", iso(T0), "acked");
    } finally { db.close(); }

    rig.open();
    await eventually(() => agentIds(rig), ids => expect(ids).toEqual([stay]));
    expect(rig.rows()).toEqual([]);
    expect(tombstones(rig)).toEqual(["pi-old"]);
    expect((await rig.agents()).map(agent => agent.name)).toEqual(["pi-stay"]);
  } finally { await rig.close(); }
});
