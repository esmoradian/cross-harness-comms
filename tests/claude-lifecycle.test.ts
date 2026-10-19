import { expect, test } from "bun:test";
import { FakeClaude } from "./support/fakes/claude.ts";
import { settle, uuid } from "./support/helpers.ts";
import { withRig } from "./support/rig.ts";
import { registerClaude } from "../adapters/claude/src/index.ts";

test("Claude startup and classic start share one attachment when their hooks overlap", async () => {
  await withRig(async rig => {
    const fake = new FakeClaude(uuid(), "/projects/shared", rig.cliRuntime());
    const handle = registerClaude(fake.on, { host: "fixture-host" });
    try {
      await Promise.all([fake.start(), fake.classicStart("startup")]);
      expect(fake.spawns.filter(call => call.argv[1] === "attach")).toHaveLength(1);
      expect((await rig.agent("claude", fake.sessionId)).online).toBe(true);
    } finally { fake.close(); await handle.close(); }
  });
});

test("Claude clear ends the old identity and connects the new session without reloading the mod", async () => {
  await withRig(async rig => {
    const claude = await rig.harness("claude"), pi = await rig.harness("pi");
    const fake = claude.fake as FakeClaude;
    const oldId = fake.sessionId, nextId = uuid();
    await fake.clear(nextId);
    expect((await rig.agent("claude", oldId)).online).toBe(false);
    const current = await rig.agent("claude", nextId);
    expect(current.online).toBe(true);
    expect(current.id).not.toBe(claude.agent.id);
    expect(fake.calls.filter(call => call.method === "session.start")).toHaveLength(1);
    await fake.tool({ tool: "SendMessage", tool_use_id: uuid(), to: `comms:${pi.agent.name}`, message: "from the cleared session" });
    expect(rig.rows()).toMatchObject([{ sender: current.id, recipient: pi.agent.id, body: "from the cleared session" }]);
    await pi.send(`comms:${claude.agent.name}`, "mail for the old identity");
    expect(rig.rows()[1]).toMatchObject({ recipient: claude.agent.id, state: "queued" });
    expect(fake.incoming).toHaveLength(0);
  });
});

const attaches = (fake: FakeClaude) => fake.spawns.filter(call => call.argv[1] === "attach");
const ensures = (fake: FakeClaude) => fake.runs.filter(call => call.argv[1] === "ensure");

test("a failed first start wakes two waiting classic starts and exactly one of them starts", async () => {
  await withRig(async rig => {
    const fake = new FakeClaude(uuid(), "/projects/shared", rig.cliRuntime());
    const handle = registerClaude(fake.on, { host: "fixture-host" });
    try {
      const held = fake.holdRun("ensure");
      const first = fake.start();
      await held.entered;
      const waiters = [fake.classicStart("startup"), fake.classicStart("startup")];
      await settle();
      held.release(new Error("first start failed"));
      // The caller whose own start failed still sees its error.
      await expect(first).rejects.toThrow("first start failed");
      expect(await Promise.allSettled(waiters)).toMatchObject([{ status: "fulfilled" }, { status: "fulfilled" }]);
      expect(ensures(fake)).toHaveLength(2);
      expect(attaches(fake)).toHaveLength(1);
      expect((await rig.agent("claude", fake.sessionId)).online).toBe(true);
      expect((await rig.agents()).filter(agent => agent.harness === "claude" && agent.online)).toHaveLength(1);
    } finally { fake.close(); await handle.close(); }
  });
});

test("two concurrent classic starts after a native ID change add exactly one attachment", async () => {
  await withRig(async rig => {
    const fake = new FakeClaude(uuid(), "/projects/shared", rig.cliRuntime());
    const handle = registerClaude(fake.on, { host: "fixture-host" });
    try {
      await fake.start();
      expect(attaches(fake)).toHaveLength(1);
      fake.sessionId = uuid();
      await Promise.all([fake.classicStart("clear"), fake.classicStart("clear")]);
      expect(ensures(fake)).toHaveLength(2);
      expect(attaches(fake)).toHaveLength(2);
      expect((await rig.agent("claude", fake.sessionId)).online).toBe(true);
      expect((await rig.agents()).filter(agent => agent.harness === "claude" && agent.online)).toHaveLength(1);
    } finally { fake.close(); await handle.close(); }
  });
});

test("a waiting classic start reads the native ID after the wait and connects the new ID", async () => {
  await withRig(async rig => {
    const fake = new FakeClaude(uuid(), "/projects/shared", rig.cliRuntime());
    const handle = registerClaude(fake.on, { host: "fixture-host" });
    try {
      const held = fake.holdRun("ensure");
      const first = fake.start();
      await held.entered;
      const waiter = fake.classicStart("clear");
      await settle();
      // The native ID changes while the waiter waits on the first start.
      fake.sessionId = uuid();
      held.release();
      await Promise.all([first, waiter]);
      expect(ensures(fake)).toHaveLength(2);
      expect(attaches(fake)).toHaveLength(2);
      expect((await rig.agent("claude", fake.sessionId)).online).toBe(true);
      expect((await rig.agents()).filter(agent => agent.harness === "claude" && agent.online)).toHaveLength(1);
    } finally { fake.close(); await handle.close(); }
  });
});

test("a classic start during an in-flight startup shares its single attachment", async () => {
  await withRig(async rig => {
    const fake = new FakeClaude(uuid(), "/projects/shared", rig.cliRuntime());
    const handle = registerClaude(fake.on, { host: "fixture-host" });
    try {
      const held = fake.holdRun("ensure");
      const first = fake.start();
      await held.entered;
      const waiter = fake.classicStart("startup");
      await settle();
      held.release();
      await Promise.all([first, waiter]);
      expect(ensures(fake)).toHaveLength(1);
      expect(attaches(fake)).toHaveLength(1);
      expect((await rig.agent("claude", fake.sessionId)).online).toBe(true);
    } finally { fake.close(); await handle.close(); }
  });
});
