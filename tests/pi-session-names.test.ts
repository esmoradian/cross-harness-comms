import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as protocol from "@cross-harness-comms/protocol";
import { resolveAddress, type Agent, type Harness } from "@cross-harness-comms/protocol";
import type { FakeClaude } from "./support/fakes/claude.ts";
import type { FakePi } from "./support/fakes/pi.ts";
import { eventually, uuid } from "./support/helpers.ts";
import { registration, withRig, type Rig } from "./support/rig.ts";

// HANDOFF-PI-LIVE-SUBAGENTS, comms decisions: the Pi session name is the agent's chosen comms name, and lookups are forgiving.
// `normalizeName(text)` lowercases, turns every run of characters outside `[a-z0-9._/-]` into `-`, trims `-` and `/` from both
// ends, and cuts to 64, returning undefined for an empty result. On `session_start` with a session name, and on every
// `session_info_changed`, the Pi adapter calls the core's `name` with the normalized session name. `resolveAddress` tries an
// exact name, an agent ID, a harness session ID, the normalized name, then the ID-prefix rule.

// Read from the module at call time, so the other tests in this file run before normalizeName exists.
const normalizeName = (text: string): string | undefined => protocol.normalizeName(text);

function nameChosen(rig: Rig, id: string): number | undefined {
  const db = new Database(rig.databasePath, { readonly: true });
  try { return (db.query("SELECT name_chosen FROM agents WHERE id = ?").get(id) as { name_chosen: number } | null)?.name_chosen; }
  finally { db.close(); }
}

async function named(rig: Rig, id: string): Promise<Agent> {
  const agent = (await rig.agents()).find(a => a.id === id);
  expect(agent).toBeDefined();
  return agent!;
}

// The `name` requests every connection sent the core.
const nameRequests = (rig: Rig) => rig.traffic.filter(entry => entry.direction === "to-core" && "method" in entry.packet && entry.packet.method === "name");

// An agent on its own wire connection holding `name`.
async function holder(rig: Rig, harness: Harness, cwd: string, name: string) {
  const peer = await rig.peer();
  const hello = await peer.register(registration(harness, uuid(), cwd));
  await peer.request("name", { token: hello.token, name });
  return { peer, agent: hello.agent };
}

test("normalizeName lowercases, turns runs of other characters into -, trims - and / from both ends, and cuts to 64", () => {
  const cases: [string, string][] = [
    ["Misc/W1", "misc/w1"],
    ["Misc/My Worker", "misc/my-worker"],
    ["  Hello,   World!  ", "hello-world"],
    ["a  \t b", "a-b"],
    ["a.b_c-d/e", "a.b_c-d/e"],
    ["a--b", "a--b"],
    ["a / b", "a-/-b"],
    ["/misc/w1/", "misc/w1"],
    ["--misc--", "misc"],
    ["-/-a-/-", "a"],
    ["Ünïcode Wörker", "n-code-w-rker"],
    ["x".repeat(70), "x".repeat(64)],
  ];
  for (const [text, name] of cases) expect(normalizeName(text), text).toBe(name);
});

test("normalizeName returns nothing for an empty result", () => {
  for (const text of ["", "   ", "!!!", "/", "-/-", "🐾"]) expect(normalizeName(text), text).toBeUndefined();
});

test("normalizeName's result always fits the name rule's ends: a cut never leaves a trailing / or -", () => {
  expect(normalizeName(`${"a".repeat(63)}/b`)).toBe("a".repeat(63));
  expect(normalizeName(`${"a".repeat(63)} b`)).toBe("a".repeat(63));
  for (const text of [`${"a".repeat(63)}/b`, `${"Group ".repeat(12)}/W1`, `x/${"-".repeat(70)}y`]) {
    const name = normalizeName(text)!;
    expect(name.length, text).toBeLessThanOrEqual(64);
    expect(name, text).toMatch(/^[a-z0-9._-](?:[a-z0-9._/-]*[a-z0-9._-])?$/);
    expect(name, text).not.toMatch(/^-|-$/);
  }
});

// Pi: the session name becomes the chosen comms name.

test("pi session names: a session that starts with a Pi session name takes its normalized form as its chosen name", async () => {
  await withRig(async rig => {
    const pi = await rig.harness("pi", uuid(), "/projects/shared", { pi: { sessionName: "Misc/W1" } });
    await eventually(() => named(rig, pi.agent.id), agent => expect(agent.name).toBe("misc/w1"));
    expect(nameChosen(rig, pi.agent.id)).toBe(1);
    expect((pi.fake as FakePi).notifications).toEqual([]);
  });
});

test("pi session names: a session without a Pi session name keeps its generated name and sends no name request", async () => {
  await withRig(async rig => {
    const pi = await rig.harness("pi");
    expect(pi.agent.name).toBe("pi-shared");
    expect(nameRequests(rig)).toEqual([]);
    expect(nameChosen(rig, pi.agent.id)).toBe(0);
  });
});

test("pi session names: every session_info_changed sets the comms name to the new normalized session name", async () => {
  await withRig(async rig => {
    const pi = await rig.harness("pi", uuid(), "/projects/shared", { pi: { sessionName: "Misc/W1" } });
    const fake = pi.fake as FakePi;
    await eventually(() => named(rig, pi.agent.id), agent => expect(agent.name).toBe("misc/w1"));
    fake.setSessionName("Misc/W2");
    await fake.renamed();
    await eventually(() => named(rig, pi.agent.id), agent => expect(agent.name).toBe("misc/w2"));
    // A session first named after it started, as `/name` does.
    const unnamed = await rig.harness("pi", uuid(), "/projects/other");
    const other = unnamed.fake as FakePi;
    other.setSessionName("Review Desk/Parser Fix");
    await other.renamed();
    await eventually(() => named(rig, unnamed.agent.id), agent => expect(agent.name).toBe("review-desk/parser-fix"));
    expect([nameChosen(rig, pi.agent.id), nameChosen(rig, unnamed.agent.id)]).toEqual([1, 1]);
    expect([...fake.notifications, ...other.notifications]).toEqual([]);
  });
});

test("pi session names: a session name an online agent holds is refused at start with a Pi warning, and the generated name stays", async () => {
  await withRig(async rig => {
    const held = await holder(rig, "claude", "/projects/api-service", "misc/w1");
    const pi = await rig.harness("pi", uuid(), "/projects/shared", { pi: { sessionName: "Misc/W1" } });
    const fake = pi.fake as FakePi;
    await eventually(() => fake.notifications, notes => expect(notes).toHaveLength(1));
    expect(fake.notifications[0]).toMatchObject({ type: "warning", message: expect.stringContaining("misc/w1") });
    expect((await named(rig, pi.agent.id)).name).toBe("pi-shared");
    expect(nameChosen(rig, pi.agent.id)).toBe(0);
    expect((await named(rig, held.agent.id)).name).toBe("misc/w1");
  });
});

test("pi session names: a rename to a name an online agent holds is refused with a Pi warning, and the current name stays", async () => {
  await withRig(async rig => {
    const held = await holder(rig, "codex", "/projects/codex-work", "misc/w9");
    const pi = await rig.harness("pi", uuid(), "/projects/shared", { pi: { sessionName: "Misc/W1" } });
    const fake = pi.fake as FakePi;
    await eventually(() => named(rig, pi.agent.id), agent => expect(agent.name).toBe("misc/w1"));
    fake.setSessionName("Misc/W9");
    await fake.renamed();
    await eventually(() => fake.notifications, notes => expect(notes).toHaveLength(1));
    expect(fake.notifications[0]).toMatchObject({ type: "warning", message: expect.stringContaining("misc/w9") });
    expect((await named(rig, pi.agent.id)).name).toBe("misc/w1");
    expect((await named(rig, held.agent.id)).name).toBe("misc/w9");
  });
});

test("pi session names: a cleared session name or one that normalizes to nothing changes nothing and sends no name request", async () => {
  await withRig(async rig => {
    const pi = await rig.harness("pi", uuid(), "/projects/shared", { pi: { sessionName: "Misc/W1" } });
    const fake = pi.fake as FakePi;
    await eventually(() => named(rig, pi.agent.id), agent => expect(agent.name).toBe("misc/w1"));
    const before = nameRequests(rig).length;
    for (const name of ["", "   ", "!!!", "🐾"]) {
      fake.setSessionName(name);
      await fake.renamed();
    }
    // A later real rename is still handled, so the requests above were not merely slow.
    fake.setSessionName("Misc/W3");
    await fake.renamed();
    await eventually(() => named(rig, pi.agent.id), agent => expect(agent.name).toBe("misc/w3"));
    expect(nameRequests(rig)).toHaveLength(before + 1);
    expect(fake.notifications).toEqual([]);
    // A session that starts with a name that normalizes to nothing keeps its generated name.
    const empty = await rig.harness("pi", uuid(), "/projects/empty", { pi: { sessionName: "!!!" } });
    expect(empty.agent.name).toBe("pi-empty");
    expect((await named(rig, empty.agent.id)).name).toBe("pi-empty");
    expect(nameRequests(rig)).toHaveLength(before + 1);
    expect((empty.fake as FakePi).notifications).toEqual([]);
  });
});

test("pi session names: /comms-name and comms_name still work, and the last name set wins", async () => {
  await withRig(async rig => {
    const pi = await rig.harness("pi", uuid(), "/projects/shared", { pi: { sessionName: "Misc/W1" } });
    const fake = pi.fake as FakePi;
    await eventually(() => named(rig, pi.agent.id), agent => expect(agent.name).toBe("misc/w1"));
    expect((await fake.tool("comms_name", { name: "planner" })).content[0]!.text).toContain("comms:planner");
    expect((await named(rig, pi.agent.id)).name).toBe("planner");
    fake.setSessionName("Misc/W2");
    await fake.renamed();
    await eventually(() => named(rig, pi.agent.id), agent => expect(agent.name).toBe("misc/w2"));
    await fake.command("comms-name", "reviewer");
    expect(fake.notifications.at(-1)).toMatchObject({ message: expect.stringContaining("comms:reviewer") });
    expect((await named(rig, pi.agent.id)).name).toBe("reviewer");
    expect(nameChosen(rig, pi.agent.id)).toBe(1);
  });
});

test("pi session names: a session name an offline agent holds moves to the new session, and the offline agent falls back to a generated name", async () => {
  await withRig(async rig => {
    const old = await holder(rig, "pi", "/projects/old", "misc/w1");
    old.peer.close();
    await eventually(() => rig.agents(), agents => expect(agents.find(a => a.id === old.agent.id)?.online).toBe(false));
    const pi = await rig.harness("pi", uuid(), "/projects/shared", { pi: { sessionName: "Misc/W1" } });
    await eventually(() => named(rig, pi.agent.id), agent => expect(agent.name).toBe("misc/w1"));
    expect((await named(rig, old.agent.id)).name).toBe("pi-old");
    expect((pi.fake as FakePi).notifications).toEqual([]);
  });
});

test("pi session names: resuming a named Pi session keeps its identity and name without a warning", async () => {
  await withRig(async rig => {
    const sessionId = uuid();
    const first = await rig.harness("pi", sessionId, "/projects/shared", { pi: { sessionName: "Misc/W1" } });
    await eventually(() => named(rig, first.agent.id), agent => expect(agent.name).toBe("misc/w1"));
    await first.close();
    const resumed = await rig.harness("pi", sessionId, "/projects/shared", { pi: { sessionName: "Misc/W1" } });
    expect(resumed.agent.id).toBe(first.agent.id);
    await eventually(() => named(rig, resumed.agent.id), agent => expect(agent).toMatchObject({ name: "misc/w1", online: true }));
    expect((resumed.fake as FakePi).notifications).toEqual([]);
  });
});

// Lookups: exact name, agent ID, harness session ID, normalized name, then ID prefix.

const agent = (fields: Partial<Agent> & Pick<Agent, "id" | "name" | "session_key">): Agent =>
  ({ harness: "pi", host: "h", cwd: "/p", last_seen: "2026-10-18T00:00:00Z", online: true, ...fields });
const lookupAgents: Agent[] = [
  agent({ id: "019f1234-0000-7000-8000-000000000001", name: "misc/w1", session_key: "0f6c2b8e-1111-4222-8333-444455556666" }),
  agent({ id: "019f1234-0000-7000-8000-000000000002", name: "codex-api", harness: "codex", session_key: "019a0000-aaaa-7bbb-8ccc-ddddeeeeffff" }),
  agent({ id: "019f5678-0000-7000-8000-000000000003", name: "misc/my-worker", harness: "claude", session_key: "c-session" }),
];

function lookup(address: string, agents = lookupAgents) {
  try { return resolveAddress(address, agents).id; }
  catch (error) { return (error as { data?: { code?: string } }).data?.code; }
}

test("lookups: resolveAddress reaches an agent by harness session ID, for any harness, with or without comms:", () => {
  for (const target of lookupAgents) for (const prefix of ["", "comms:"]) {
    expect(lookup(`${prefix}${target.session_key}`), `${prefix}${target.session_key}`).toBe(target.id);
  }
});

test("lookups: resolveAddress reaches a name given in another case or with spaces through normalizeName", () => {
  const [w1, , worker] = lookupAgents;
  for (const address of ["Misc/W1", "comms:Misc/W1", "comms:MISC/W1", " misc/w1 ", "comms:/Misc/W1/"]) expect(lookup(address), address).toBe(w1!.id);
  for (const address of ["Misc/My Worker", "comms:Misc/My Worker", "comms:misc/my worker", "MISC/MY WORKER"]) {
    expect(lookup(address), address).toBe(worker!.id);
  }
  for (const address of ["Misc/W2", "comms:Nobody Here", "uds:misc/w1", "uds:Misc/W1", "http:misc/w1"]) expect(lookup(address), address).toBe("UNKNOWN_RECIPIENT");
});

test("lookups: resolveAddress tries an exact name, an agent ID, a session ID, the normalized name, then an ID prefix, in that order", () => {
  const exact = agent({ id: "019f9999-0000-7000-8000-000000000010", name: "abc-def", session_key: "k1" });
  const bySession = agent({ id: "019f9999-0000-7000-8000-000000000011", name: "other", session_key: "ABC DEF" });
  const literal = agent({ id: "019f9999-0000-7000-8000-000000000012", name: "abc-ghi", session_key: "abc-def" });
  const idHolder = agent({ id: "019f9999-0000-7000-8000-000000000013", name: "id-holder", session_key: "k3" });
  const keyIsId = agent({ id: "019f9999-0000-7000-8000-000000000014", name: "key-is-id", session_key: idHolder.id });
  const agents = [exact, bySession, literal, idHolder, keyIsId];
  // An exact name beats another agent's session ID that equals it.
  expect(lookup("abc-def", agents)).toBe(exact.id);
  // An agent ID beats another agent's session ID that equals it.
  expect(lookup(idHolder.id, agents)).toBe(idHolder.id);
  // A session ID beats the normalized name it would also give.
  expect(lookup("ABC DEF", agents)).toBe(bySession.id);
  // The normalized name comes after session IDs; it is the only rule that reaches a differently cased name.
  expect(lookup("ABC-GHI", agents)).toBe(literal.id);
});

test("lookups: the ID-prefix rule still applies after names and session IDs, with ambiguity and the 8-character minimum", () => {
  const [, , worker] = lookupAgents;
  for (const prefix of ["", "comms:"]) {
    expect(lookup(`${prefix}019f5678`)).toBe(worker!.id);
    expect(lookup(`${prefix}019f5678-0000`)).toBe(worker!.id);
    expect(lookup(`${prefix}019f1234`)).toBe("AMBIGUOUS_RECIPIENT");
    expect(lookup(`${prefix}019f567`)).toBe("UNKNOWN_RECIPIENT");
    expect(lookup(`${prefix}nobody`)).toBe("UNKNOWN_RECIPIENT");
  }
});

test("lookups: a Pi worker named after its session is reached by comms:<alias> in any case, its plain name, and its Pi session ID from every harness", async () => {
  await withRig(async rig => {
    const sessionId = uuid();
    const worker = await rig.harness("pi", sessionId, "/projects/worker", { pi: { sessionName: "Misc/W1" } });
    await eventually(() => named(rig, worker.agent.id), agent => expect(agent.name).toBe("misc/w1"));
    const pi = await rig.harness("pi", uuid(), "/projects/parent");
    const codex = await rig.harness("codex", uuid(), "/projects/codex");
    const claude = await rig.harness("claude", uuid(), "/projects/claude");
    const sends: [string, () => Promise<unknown>][] = [
      ["pi comms:Misc/W1", () => pi.send("comms:Misc/W1", "pi comms:Misc/W1")],
      ["pi misc/w1", () => pi.send("misc/w1", "pi misc/w1")],
      ["pi session ID", () => pi.send(sessionId, "pi session ID")],
      ["pi comms:session ID", () => pi.send(`comms:${sessionId}`, "pi comms:session ID")],
      ["codex comms:Misc/W1", () => codex.send("comms:Misc/W1", "codex comms:Misc/W1")],
      ["codex session ID", () => codex.send(sessionId, "codex session ID")],
      ["claude comms:Misc/W1", () => (claude.fake as FakeClaude).tool({ tool: "SendMessage", tool_use_id: uuid(), to: "comms:Misc/W1", message: "claude comms:Misc/W1" })],
      ["claude comms:session ID", () => (claude.fake as FakeClaude).tool({ tool: "SendMessage", tool_use_id: uuid(), to: `comms:${sessionId}`, message: "claude comms:session ID" })],
    ];
    for (const [label, send] of sends) expect(JSON.stringify(await send()), label).toContain("Sent to misc/w1.");
    await eventually(worker.incoming, texts => expect(texts).toHaveLength(sends.length));
    expect(rig.rows().map(row => [row.recipient, row.body])).toEqual(sends.map(([label]) => [worker.agent.id, label]));
  });
});

test("lookups: a harness session ID reaches Codex and Claude agents too", async () => {
  await withRig(async rig => {
    const codex = await rig.harness("codex", uuid(), "/projects/codex");
    const claude = await rig.harness("claude", uuid(), "/projects/claude");
    const pi = await rig.harness("pi", uuid(), "/projects/sender");
    await pi.send(codex.sessionId, "To the Codex thread");
    await pi.send(claude.sessionId, "To the Claude session");
    await eventually(codex.incoming, texts => expect(texts).toHaveLength(1));
    await eventually(claude.incoming, texts => expect(texts).toHaveLength(1));
    expect(rig.rows().map(row => row.recipient)).toEqual([codex.agent.id, claude.agent.id]);
  });
});
