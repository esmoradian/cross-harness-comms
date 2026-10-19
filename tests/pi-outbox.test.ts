import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { registerPi } from "../adapters/pi/src/index.ts";
import { FakePi } from "./support/fakes/pi.ts";
import { eventually, settle, uuid } from "./support/helpers.ts";
import { registration, withRig, type HarnessSession, type Rig } from "./support/rig.ts";

// An event-bus send API in Pi mirroring Pi Intercom 0.13.0's outbox v1. The Pi adapter listens on
// `pi.events` for `comms:outbox-request` `{ version: 1, requestId, extensionId, extensionName, to, message }` and answers once
// on `comms:outbox-result` `{ version: 1, requestId, status, code?, extensionId, extensionName, messageId?, detail? }`, sending
// as this session's agent with no confirmation. `sent` covers delivered and queued (which `detail` says); `blocked` is
// `target_not_found`, `target_ambiguous`, or `self_target`; `failed` is `session_unavailable`, `delivery_failed`,
// `invalid_request`, or `duplicate_request`. A request without `version: 1` is ignored.

const REQUEST = "comms:outbox-request", RESULT = "comms:outbox-result";
const EXTENSION = { extensionId: "pi-live-subagents", extensionName: "Live Subagents" };

interface OutboxResult {
  version: number;
  requestId: string;
  status: string;
  code?: string;
  extensionId?: string;
  extensionName?: string;
  messageId?: string;
  detail?: string;
}

const results = (fake: FakePi, requestId: string) =>
  fake.emitted.filter(entry => entry.channel === RESULT).map(entry => entry.data as OutboxResult).filter(result => result?.requestId === requestId);

// Emits one request, as pi-live-subagents does, waits for its result, and checks it was answered exactly once.
async function outbox(fake: FakePi, fields: Record<string, unknown>) {
  const request = { version: 1, requestId: `live-${uuid()}`, ...EXTENSION, ...fields };
  fake.events.emit(REQUEST, request);
  const [result] = await eventually(() => results(fake, request.requestId as string), list => expect(list).toHaveLength(1));
  await settle();
  expect(results(fake, request.requestId as string)).toHaveLength(1);
  return { request, result: result! };
}

const pi = (session: HarnessSession) => session.fake as FakePi;

async function offline(rig: Rig, cwd: string) {
  const peer = await rig.peer();
  const hello = await peer.register(registration("codex", uuid(), cwd));
  peer.close();
  await eventually(() => rig.agents(), agents => expect(agents.find(a => a.id === hello.agent.id)?.online).toBe(false));
  return hello.agent;
}

test("pi outbox: a request to an online agent is sent as this session, answered sent with the message ID, and delivered", async () => {
  await withRig(async rig => {
    const target = await rig.harness("pi", uuid(), "/projects/target"), sender = await rig.harness("pi", uuid(), "/projects/sender");
    const { request, result } = await outbox(pi(sender), { to: `comms:${target.agent.name}`, message: "Worker w1 has gone quiet." });
    const row = rig.rows()[0]!;
    expect(result).toEqual({ version: 1, requestId: request.requestId, status: "sent", ...EXTENSION, messageId: row.id,
      ...(result.detail === undefined ? {} : { detail: result.detail }) });
    expect(result.detail ?? "").not.toMatch(/queued/i);
    expect(row).toMatchObject({ sender: sender.agent.id, recipient: target.agent.id, body: "Worker w1 has gone quiet." });
    await eventually(target.incoming, texts => expect(texts).toHaveLength(1));
    expect(pi(target).incoming[0]!.message.details).toMatchObject({ id: row.id, name: sender.agent.name, body: "Worker w1 has gone quiet." });
    expect(pi(sender).notifications).toEqual([]);
  });
});

test("pi outbox: a request to an offline agent is answered sent, with a detail saying it is queued", async () => {
  await withRig(async rig => {
    const target = await offline(rig, "/projects/offline");
    const sender = await rig.harness("pi");
    const { result } = await outbox(pi(sender), { to: target.name, message: "For when you are back" });
    const row = rig.rows()[0]!;
    expect(result).toMatchObject({ version: 1, status: "sent", ...EXTENSION, messageId: row.id });
    expect(result).not.toHaveProperty("code");
    expect(result.detail).toMatch(/queued/i);
    expect(row).toMatchObject({ sender: sender.agent.id, recipient: target.id, state: "queued" });
  });
});

test("pi outbox: the address follows the core's lookups: a Pi session ID, a differently cased alias, and comms:", async () => {
  await withRig(async rig => {
    const target = await rig.harness("pi", uuid(), "/projects/target", { pi: { sessionName: "Misc/W1" } });
    await eventually(() => rig.agents(), agents => expect(agents.find(a => a.id === target.agent.id)?.name).toBe("misc/w1"));
    const sender = await rig.harness("pi");
    for (const to of [target.sessionId, `comms:${target.sessionId}`, "Misc/W1", "comms:Misc/W1", "misc/w1"]) {
      const { result } = await outbox(pi(sender), { to, message: to });
      expect(result, to).toMatchObject({ status: "sent", messageId: rig.rows().at(-1)!.id });
      expect(rig.rows().at(-1), to).toMatchObject({ recipient: target.agent.id, body: to });
    }
  });
});

test("pi outbox: an unknown address is blocked with target_not_found, and nothing is stored", async () => {
  await withRig(async rig => {
    const sender = await rig.harness("pi");
    for (const to of ["nobody", "comms:nobody", "uds:x", `other:${sender.agent.id}`]) {
      const { request, result } = await outbox(pi(sender), { to, message: "Anyone there?" });
      expect(result, to).toMatchObject({ version: 1, requestId: request.requestId, status: "blocked", code: "target_not_found", ...EXTENSION });
      expect(result, to).not.toHaveProperty("messageId");
    }
    expect(rig.rows()).toEqual([]);
  });
});

test("pi outbox: an ID prefix matching several agents is blocked with target_ambiguous, and nothing is stored", async () => {
  await withRig(async rig => {
    const sender = await rig.harness("pi", uuid(), "/projects/sender");
    // Two agents whose chosen IDs share the prefix `00000000`, which no minted UUIDv7 has, written the way the tests read the database.
    const db = new Database(rig.databasePath);
    try {
      for (const suffix of ["1", "2"]) db.query(`INSERT INTO agents (id, harness, session_key, host, name, cwd, last_seen, token_hash, name_chosen)
        VALUES (?, 'pi', ?, 'fixture-host', ?, '/projects/twins', ?, NULL, 0)`)
        .run(`00000000-0000-7000-8000-00000000000${suffix}`, uuid(), `pi-twin-${suffix}`, new Date().toISOString());
    } finally { db.close(); }
    const { result } = await outbox(pi(sender), { to: "comms:00000000", message: "Which one?" });
    expect(result).toMatchObject({ version: 1, status: "blocked", code: "target_ambiguous", ...EXTENSION });
    // Each twin's own ID still reaches it, so the agents are visible to the core.
    expect((await outbox(pi(sender), { to: "00000000-0000-7000-8000-000000000001", message: "Just one" })).result.status).toBe("sent");
    expect(rig.rows().map(row => [row.recipient, row.body])).toEqual([["00000000-0000-7000-8000-000000000001", "Just one"]]);
  });
});

test("pi outbox: a request addressed to this session is blocked with self_target, by session ID, name, or alias, and nothing is stored", async () => {
  await withRig(async rig => {
    const sender = await rig.harness("pi", uuid(), "/projects/shared", { pi: { sessionName: "Misc/W1" } });
    await eventually(() => rig.agents(), agents => expect(agents.find(a => a.id === sender.agent.id)?.name).toBe("misc/w1"));
    for (const to of [sender.sessionId, `comms:${sender.sessionId}`, sender.agent.id, "misc/w1", "comms:Misc/W1"]) {
      const { result } = await outbox(pi(sender), { to, message: "To myself" });
      expect(result, to).toMatchObject({ version: 1, status: "blocked", code: "self_target", ...EXTENSION });
    }
    expect(rig.rows()).toEqual([]);
  });
});

test("pi outbox: a request before the session is registered fails with session_unavailable", async () => {
  await withRig(async rig => {
    const target = await rig.harness("pi", uuid(), "/projects/target");
    const fake = new FakePi(uuid(), "/projects/early");
    const handle = registerPi(fake, rig.runtime());
    try {
      const { request, result } = await outbox(fake, { to: `comms:${target.agent.name}`, message: "Too early" });
      expect(result).toMatchObject({ version: 1, requestId: request.requestId, status: "failed", code: "session_unavailable", ...EXTENSION });
      expect(rig.rows()).toEqual([]);
    } finally { await handle.close(); }
  });
});

test("pi outbox: a send the core refuses for another reason fails with delivery_failed, and nothing is stored", async () => {
  await withRig(async rig => {
    const target = await rig.harness("pi", uuid(), "/projects/target"), sender = await rig.harness("pi");
    // Over the 1 MB protocol line limit.
    const { result } = await outbox(pi(sender), { to: `comms:${target.agent.name}`, message: "x".repeat(1_100_000) });
    expect(result).toMatchObject({ version: 1, status: "failed", code: "delivery_failed", ...EXTENSION });
    expect(rig.rows()).toEqual([]);
    // The session still sends afterwards.
    expect((await outbox(pi(sender), { to: `comms:${target.agent.name}`, message: "Small" })).result.status).toBe("sent");
  });
});

test("pi outbox: a malformed version 1 request fails with invalid_request, and nothing is stored", async () => {
  await withRig(async rig => {
    const target = await rig.harness("pi", uuid(), "/projects/target"), sender = await rig.harness("pi");
    const to = `comms:${target.agent.name}`;
    const malformed: Record<string, unknown>[] = [
      { message: "No recipient" },
      { to: "", message: "Empty recipient" },
      { to: 42, message: "Recipient not a string" },
      { to },
      { to, message: 42 },
      { to, message: "No extension ID", extensionId: undefined },
      { to, message: "Extension name not a string", extensionName: 7 },
    ];
    for (const fields of malformed) {
      const { request, result } = await outbox(pi(sender), fields);
      expect(result, JSON.stringify(fields)).toMatchObject({ version: 1, requestId: request.requestId, status: "failed", code: "invalid_request" });
    }
    expect(rig.rows()).toEqual([]);
  });
});

test("pi outbox: a requestId already answered fails with duplicate_request, and only the first is stored", async () => {
  await withRig(async rig => {
    const target = await rig.harness("pi", uuid(), "/projects/target"), sender = await rig.harness("pi");
    const requestId = `live-${uuid()}`;
    const first = (await outbox(pi(sender), { requestId, to: `comms:${target.agent.name}`, message: "Once" })).result;
    expect(first).toMatchObject({ status: "sent" });
    pi(sender).events.emit(REQUEST, { version: 1, requestId, ...EXTENSION, to: `comms:${target.agent.name}`, message: "Twice" });
    const answers = await eventually(() => results(pi(sender), requestId), list => expect(list).toHaveLength(2));
    expect(answers[1]).toMatchObject({ version: 1, requestId, status: "failed", code: "duplicate_request", ...EXTENSION });
    // A blocked request's ID is used up too.
    const blockedId = `live-${uuid()}`;
    expect((await outbox(pi(sender), { requestId: blockedId, to: "nobody", message: "Lost" })).result.code).toBe("target_not_found");
    pi(sender).events.emit(REQUEST, { version: 1, requestId: blockedId, ...EXTENSION, to: `comms:${target.agent.name}`, message: "Retry" });
    await eventually(() => results(pi(sender), blockedId), list => expect(list).toHaveLength(2));
    expect(results(pi(sender), blockedId)[1]).toMatchObject({ status: "failed", code: "duplicate_request" });
    await settle();
    expect(rig.rows().map(row => row.body)).toEqual(["Once"]);
    expect(results(pi(sender), requestId)).toHaveLength(2);
  });
});

test("pi outbox: a request without version 1 is ignored, with no result and nothing stored", async () => {
  await withRig(async rig => {
    const target = await rig.harness("pi", uuid(), "/projects/target"), sender = await rig.harness("pi");
    const to = `comms:${target.agent.name}`;
    const ignored = [{ version: 2 }, { version: "1" }, { version: undefined }, {}].map(fields => {
      const request = { version: 1, requestId: `live-${uuid()}`, ...EXTENSION, to, message: "Ignored", ...fields };
      if (!("version" in fields)) delete (request as { version?: unknown }).version;
      pi(sender).events.emit(REQUEST, request);
      return request.requestId;
    });
    // Not a request object at all.
    for (const payload of [null, "send", 1, []]) pi(sender).events.emit(REQUEST, payload);
    // A later valid request is answered, so the ignored ones had their chance.
    expect((await outbox(pi(sender), { to, message: "Answered" })).result.status).toBe("sent");
    await Bun.sleep(20);
    for (const requestId of ignored) expect(results(pi(sender), requestId)).toEqual([]);
    expect(pi(sender).emitted.filter(entry => entry.channel === RESULT)).toHaveLength(1);
    expect(rig.rows().map(row => row.body)).toEqual(["Answered"]);
  });
});
