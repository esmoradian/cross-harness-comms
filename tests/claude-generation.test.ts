import { expect, test } from "bun:test";
import { FakeClaude } from "./support/fakes/claude.ts";
import { runsOf } from "./support/claude.ts";
import { deferred, eventually, settle, uuid } from "./support/helpers.ts";
import { helloRequests, registration, withRig, type HarnessSession, type Rig } from "./support/rig.ts";
import { registerClaude } from "../adapters/claude/src/index.ts";

// Each test holds one async step of an older run with a fake hook or the fake clock, changes
// ownership, then lets the step continue. Counts come from the fake's `runs` and `spawns`.

const attaches = (fake: FakeClaude) => fake.spawns.filter(call => call.argv[1] === "attach");
const ensures = (fake: FakeClaude) => fake.runs.filter(call => call.argv[1] === "ensure");
const retries = (fake: FakeClaude) => fake.calls.filter(call => call.method === "clock.after" && call.args[0] === 250);
const stdinToken = (run: { init?: { stdin?: string } }) => (JSON.parse(run.init?.stdin ?? "{}") as { token?: string }).token;

// The token the core issued to the first attachment of a Claude session ID.
function helloToken(rig: Rig, sessionId: string): string {
  const hello = helloRequests(rig, "claude", sessionId)[0]!;
  const reply = rig.traffic.find(entry => entry.connection === hello.connection && entry.direction === "from-core" && "result" in entry.packet
    && typeof (entry.packet.result as { token?: unknown }).token === "string")!;
  return (reply.packet as { result: { token: string } }).result.token;
}

// Ends the session's attachment transport, so its attach loop ends and schedules its 250 ms retry.
async function dropAttachment(rig: Rig, claude: HarnessSession) {
  const fake = claude.fake as FakeClaude;
  const link = rig.links[helloRequests(rig, "claude", claude.sessionId)[0]!.connection]!;
  link.client.destroy(); link.server.destroy();
  await fake.spawnResults[0];
  await settle();
}

for (const ending of ["session.end", "/clear"] as const) {
  test(`an attach retry scheduled before ${ending} spawns nothing when its timer fires`, async () => {
    await withRig(async rig => {
      const claude = await rig.harness("claude");
      const fake = claude.fake as FakeClaude;
      await dropAttachment(rig, claude);
      expect(retries(fake)).toHaveLength(1);
      const nextId = uuid();
      if (ending === "/clear") await fake.clear(nextId);
      else await fake.end();
      const count = attaches(fake).length;
      expect(count).toBe(ending === "/clear" ? 2 : 1);
      fake.runScheduled();
      await settle();
      expect(attaches(fake)).toHaveLength(count);
      if (ending === "/clear") expect((await rig.agent("claude", nextId)).online).toBe(true);
    });
  });
}

test("after session_replaced the old run neither acks nor retries, and new and queued sends are denied", async () => {
  await withRig(async rig => {
    const claude = await rig.harness("claude"), pi = await rig.harness("pi");
    const fake = claude.fake as FakeClaude;
    const to = `comms:${pi.agent.name}`;
    const held = fake.holdRun("send");
    const first = claude.send(to, "in flight at the replacement");
    await held.entered;
    const queued = claude.send(to, "queued behind it");
    await settle();
    // Another attachment claims the session with its current token, so the core sends session_replaced.
    const intruder = await rig.peer();
    await intruder.register(registration("claude", claude.sessionId), undefined, helloToken(rig, claude.sessionId));
    await fake.spawnResults[0];
    await settle();
    expect(fake.incoming.map(input => input.text)).toContain("This session connection was replaced by another attachment.");
    expect(await claude.send(to, "after the replacement")).toEqual({ deny: "comms session is not connected" });
    held.release();
    await first;
    expect(await queued).toEqual({ deny: "comms session changed" });
    // Mail for the session now reaches the replacement; the old run sees none of it.
    await pi.send(`comms:${claude.agent.name}`, "for the replacement");
    expect((await intruder.deliveries.next()).message.body).toBe("for the replacement");
    await settle();
    expect(runsOf(fake, "ack")).toEqual([]);
    expect(retries(fake)).toEqual([]);
    expect(attaches(fake)).toHaveLength(1);
  });
});

test("a delivery accepted after /clear reconnected the session sends no ack with either token", async () => {
  await withRig(async rig => {
    const claude = await rig.harness("claude"), pi = await rig.harness("pi");
    const fake = claude.fake as FakeClaude;
    const accepted = deferred<void>();
    fake.acceptGate = accepted.promise;
    await pi.send(`comms:${claude.agent.name}`, "accepted after the clear");
    await eventually(claude.incoming, texts => expect(texts).toHaveLength(1));
    const oldToken = helloToken(rig, claude.sessionId), nextId = uuid();
    await fake.clear(nextId);
    const newToken = helloToken(rig, nextId);
    expect(newToken).not.toBe(oldToken);
    accepted.resolve();
    await settle();
    const tokens = runsOf(fake, "ack").map(stdinToken);
    expect(tokens).not.toContain(oldToken);
    expect(tokens).not.toContain(newToken);
    expect(tokens).toEqual([]);
    expect(rig.rows()[0]!.state).toBe("delivered");
  });
});

test("a newer start keeps its token and its disconnect when an older close resumes from detach", async () => {
  await withRig(async rig => {
    const claude = await rig.harness("claude"), pi = await rig.harness("pi");
    const fake = claude.fake as FakeClaude;
    const held = fake.holdRun("detach");
    const ending = fake.end("clear");
    await held.entered;
    const nextId = uuid();
    fake.sessionId = nextId;
    await fake.classicStart("clear");
    const token = helloToken(rig, nextId);
    held.release();
    await ending;
    const current = await rig.agent("claude", nextId);
    expect(current.online).toBe(true);
    // The token survived: the newer session can still send.
    expect(await claude.send(`comms:${pi.agent.name}`, "after the old close")).not.toHaveProperty("deny");
    expect(rig.rows()).toMatchObject([{ sender: current.id, recipient: pi.agent.id, body: "after the old close" }]);
    // The disconnect survived: ending the newer session detaches it with its own token.
    const before = runsOf(fake, "detach").length;
    await fake.end();
    expect(runsOf(fake, "detach").slice(before).map(stdinToken)).toEqual([token]);
    expect((await rig.agent("claude", nextId)).online).toBe(false);
  });
});

test("a session.receive whose next resolves after /clear sends no native-ack and records nothing for the new session", async () => {
  await withRig(async rig => {
    const pi = await rig.harness("pi");
    const claude = await rig.harness("claude", undefined, undefined, { claude: {} });
    const fake = claude.fake as FakeClaude;
    const oldHold = fake.holdReceive();
    await pi.send(`comms:${claude.agent.name}`, "for the old session");
    await oldHold.entered;
    const nextId = uuid();
    await fake.clear(nextId);
    const next = await rig.agent("claude", nextId);
    // The new session's line comes from the same reply socket, so a stale native-ack would match it.
    const newHold = fake.holdReceive();
    await pi.send(`comms:${next.name}`, "for the new session");
    await newHold.entered;
    const [oldMessage, newMessage] = rig.rows();
    oldHold.release();
    await settle();
    expect(runsOf(fake, "native-ack")).toEqual([]);
    expect(rig.rows().find(row => row.id === newMessage!.id)!.state).toBe("delivered");
    // The new session's own receive acknowledges its message, which nothing else consumed.
    newHold.release();
    await rig.state(newMessage!.id, "acked");
    const acks = runsOf(fake, "native-ack");
    expect(acks.map(stdinToken)).toEqual([helloToken(rig, nextId)]);
    expect(fake.completedRuns.filter(run => run.argv[1] === "native-ack").map(run => JSON.parse(run.result.stdout))).toEqual([{ id: newMessage!.id }]);
    expect(rig.rows().find(row => row.id === oldMessage!.id)!.state).toBe("delivered");
    expect(fake.queued).toHaveLength(2);
  });
});

test("session.end during a start, before registration, settles it with an error and no attachment spawns", async () => {
  await withRig(async rig => {
    const fake = new FakeClaude(uuid(), "/projects/shared", rig.cliRuntime());
    const handle = registerClaude(fake.on, { binary: "comms", host: "fixture-host" });
    try {
      const held = fake.holdRun("ensure");
      const starting = fake.start();
      await held.entered;
      await fake.end();
      held.release();
      await expect(starting).rejects.toThrow("comms session changed");
      await settle();
      expect(attaches(fake)).toHaveLength(0);
      // state.connecting is clear: a later start runs at once instead of waiting on the cancelled one.
      await fake.classicStart("resume");
      expect(ensures(fake)).toHaveLength(2);
      expect(attaches(fake)).toHaveLength(1);
      expect((await rig.agent("claude", fake.sessionId)).online).toBe(true);
    } finally { fake.close(); await handle.close(); }
  });
});
