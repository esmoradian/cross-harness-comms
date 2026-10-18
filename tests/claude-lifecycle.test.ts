import { expect, test } from "bun:test";
import { FakeClaude } from "./fakes/claude.ts";
import { uuid } from "./helpers.ts";
import { withRig } from "./rig.ts";

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
