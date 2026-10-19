import { expect, test } from "bun:test";
import { FakeClaude } from "./support/fakes/claude.ts";
import { uuid } from "./support/helpers.ts";
import { withRig } from "./support/rig.ts";

// Native model.fork passes tool.call an agentId absent from $.agent.list(), and
// its downstream permission path refuses tools even though it inherits schemas.
// Reproduced in real Claude Code 2.1.296.
test("Claude internal forks cannot send comms messages under the main session's identity", async () => {
  await withRig(async rig => {
    const claude = await rig.harness("claude"), pi = await rig.harness("pi");
    const fake = claude.fake as FakeClaude;
    fake.nativeResult = { deny: "A model fork cannot use tools" };
    for (const to of [`comms:${pi.agent.name}`, pi.agent.name]) {
      const event = { tool: "SendMessage" as const, tool_use_id: uuid(), agentId: "internal-suggestion-fork", to, message: "must not leave the fork" };
      expect(await fake.tool(event)).toEqual(fake.nativeResult);
      expect(fake.nativeCalls.at(-1)).toEqual(event);
    }
    expect(fake.runs.filter(call => ["send", "resolve"].includes(call.argv[1]!))).toHaveLength(0);
    expect(rig.rows()).toHaveLength(0);
  });
});

test("Claude listed subagents can send comms messages through their session", async () => {
  await withRig(async rig => {
    const claude = await rig.harness("claude"), pi = await rig.harness("pi");
    const fake = claude.fake as FakeClaude;
    fake.agents.push({ id: "user-spawned-worker" });
    const result = await fake.tool({ tool: "SendMessage", tool_use_id: uuid(), agentId: "user-spawned-worker",
      to: `comms:${pi.agent.name}`, message: "authorized worker message" });
    expect(result).not.toHaveProperty("deny");
    expect(rig.rows()).toMatchObject([{ sender: claude.agent.id, recipient: pi.agent.id, body: "authorized worker message" }]);
    expect(fake.nativeCalls).toHaveLength(0);
  });
});

test("Claude agent lookup failure preserves the native decision and sends nothing", async () => {
  await withRig(async rig => {
    const claude = await rig.harness("claude"), pi = await rig.harness("pi");
    const fake = claude.fake as FakeClaude;
    fake.api.agent.list = async () => { throw new Error("agent roster unavailable"); };
    fake.nativeResult = { deny: "Native tool restrictions still apply" };
    const event = { tool: "SendMessage" as const, tool_use_id: uuid(), agentId: "unverified-worker",
      to: `comms:${pi.agent.name}`, message: "must not bypass native restrictions" };
    expect(await fake.tool(event)).toEqual(fake.nativeResult);
    expect(fake.nativeCalls).toEqual([event]);
    expect(rig.rows()).toHaveLength(0);
  });
});

test("Claude main-session and native subagent messaging keep their existing routes", async () => {
  await withRig(async rig => {
    const claude = await rig.harness("claude"), pi = await rig.harness("pi");
    const fake = claude.fake as FakeClaude;
    await fake.tool({ tool: "SendMessage", tool_use_id: uuid(), to: `comms:${pi.agent.name}`, message: "main message" });
    expect(fake.calls.filter(call => call.method === "agent.list")).toHaveLength(0);
    fake.agents.push({ id: "native-worker" });
    const event = { tool: "SendMessage" as const, tool_use_id: uuid(), agentId: "native-worker", to: "native-peer", message: "native message" };
    expect(await fake.tool(event)).toEqual(fake.nativeResult);
    expect(fake.nativeCalls).toEqual([event]);
    expect(rig.rows()).toMatchObject([{ sender: claude.agent.id, recipient: pi.agent.id, body: "main message" }]);
    expect(rig.rows()).toHaveLength(1);
  });
});
