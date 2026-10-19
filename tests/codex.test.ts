import { expect, test } from "bun:test";
import { createCodexAdapter } from "../adapters/codex/src/index.ts";
import { FakeCodex } from "./support/fakes/codex.ts";
import { eventually, uuid } from "./support/helpers.ts";
import { withRig, type Rig } from "./support/rig.ts";

// ADR-014: Codex presence comes from its hooks, the core delivers through
// `codex queue`, and one MCP server acts for whichever thread `_meta` names.

const online = async (rig: Rig, id: string) => (await rig.agents()).find(a => a.id === id)?.online;

test("codex: a failed codex queue marks the thread offline and keeps the message for the next SessionStart", async () => {
  await withRig(async rig => {
    const sender = await rig.harness("pi"), codex = await rig.harness("codex");
    const fake = codex.fake as FakeCodex;
    fake.exitCode = 1;
    await sender.send(`comms:${codex.agent.name}`, "Codex has gone away");
    await eventually(() => fake.commands, commands => expect(commands).toHaveLength(1));
    await eventually(() => online(rig, codex.agent.id), value => expect(value).toBe(false));
    expect(rig.rows()[0]!.state).not.toBe("acked");
    fake.exitCode = 0;
    await rig.hook("session-start", fake.sessionStart());
    await rig.state(rig.rows()[0]!.id, "acked");
    expect(fake.commands).toHaveLength(2);
  });
});

for (const throws of [false, true]) test(`codex: ${throws ? "a throwing queue" : "a refused queue"} records the offline time only once`, async () => {
  let now = Date.parse("2030-01-01T00:00:00Z");
  await withRig(async rig => {
    const sender = await rig.harness("pi"), codex = await rig.harness("codex");
    const fake = codex.fake as FakeCodex;
    if (throws) fake.run = async () => { throw new Error("Executable disappeared"); };
    else fake.exitCode = 1;
    now += 3_600_000;
    await sender.send(codex.agent.id, "The receiver is gone");
    await eventually(() => rig.agent("codex", fake.threadId), agent => {
      expect(agent.online).toBe(false);
      expect(agent.last_seen).toBe(new Date(now).toISOString());
    });
    const stoppedAt = new Date(now).toISOString();
    now += 3_600_000;
    await rig.hook("session-end", fake.sessionEnd());
    expect((await rig.agent("codex", fake.threadId)).last_seen).toBe(stoppedAt);
    expect(rig.rows()[0]!.state).not.toBe("acked");
  }, undefined, { now: () => now });
});

test("codex: the core runs the Codex executable the SessionStart hook reported", async () => {
  await withRig(async rig => {
    rig.codexExecutable = "/opt/codex/bin/codex";
    const sender = await rig.harness("pi"), codex = await rig.harness("codex");
    await sender.send(`comms:${codex.agent.name}`, "Which binary?");
    await eventually(() => (codex.fake as FakeCodex).commands, commands => expect(commands[0]?.[0]).toBe("/opt/codex/bin/codex"));
  });
});

test("codex: one MCP adapter serves several threads, each acting as the thread named in _meta", async () => {
  await withRig(async rig => {
    const target = await rig.harness("pi");
    const threads = [new FakeCodex(uuid(), "/projects/one"), new FakeCodex(uuid(), "/projects/two")];
    for (const thread of threads) {
      rig.codexFakes.set(thread.threadId, thread);
      expect((await rig.hook("session-start", thread.sessionStart())).exitCode).toBe(0);
    }
    const adapter = createCodexAdapter(rig.runtime());
    try {
      for (const thread of threads) {
        const result = await adapter.toolsCall(thread.request("comms_send", { to: `comms:${target.agent.name}`, text: `From ${thread.cwd}` }));
        expect(result.isError).not.toBe(true);
      }
      const senders = await Promise.all(threads.map(thread => rig.agent("codex", thread.threadId)));
      expect(rig.rows().map(row => row.sender)).toEqual(senders.map(agent => agent.id));
    } finally { await adapter.close(); }
  });
});

test("codex: an MCP call for a thread without a SessionStart is refused", async () => {
  await withRig(async rig => {
    const target = await rig.harness("pi");
    const fake = new FakeCodex(uuid(), "/projects/shared");
    const adapter = createCodexAdapter(rig.runtime());
    try {
      const result = await adapter.toolsCall(fake.request("comms_send", { to: `comms:${target.agent.name}`, text: "Who am I?" }));
      expect(result.isError).toBe(true);
      expect(rig.rows()).toEqual([]);
    } finally { await adapter.close(); }
  });
});

test("codex: a thread stays online across a core restart and keeps receiving", async () => {
  await withRig(async rig => {
    const codex = await rig.harness("codex");
    await rig.restart();
    expect(await online(rig, codex.agent.id)).toBe(true);
    const sender = await rig.harness("pi");
    await sender.send(`comms:${codex.agent.name}`, "After restart");
    await eventually(codex.incoming, messages => expect(messages).toHaveLength(1));
    await rig.state(rig.rows()[0]!.id, "acked");
  });
});
