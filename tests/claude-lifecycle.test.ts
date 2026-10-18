import { expect, test } from "bun:test";
import { FakeClaude } from "./fakes/claude.ts";
import { uuid } from "./helpers.ts";
import { withRig } from "./rig.ts";
import { registerClaude } from "../adapters/claude/src/index.ts";

test("Claude startup and classic start share one attachment when their hooks overlap", async () => {
  await withRig(async rig => {
    const fake = new FakeClaude(uuid(), "/projects/shared", rig.cliRuntime());
    const handle = registerClaude(fake.on, { binary: "comms", host: "fixture-host" });
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
