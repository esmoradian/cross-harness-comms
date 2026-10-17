import { expect, test } from "bun:test";
import { createCodexAdapter } from "../adapters/codex/src/index.ts";
import { FakeCodex } from "./fakes/codex.ts";
import { eventually, uuid } from "./helpers.ts";
import { withRig, type Rig } from "./rig.ts";

// ADR-014: Codex presence comes from its hooks, the core delivers through
// `codex queue`, and one MCP server acts for whichever thread `_meta` names.

const online = async (rig: Rig, id: string) => (await rig.agents()).find(a => a.id === id)?.online;

test("codex: SessionStart registers the thread online and SessionEnd marks it offline", async () => {
  await withRig(async rig => {
    const codex = await rig.harness("codex");
    expect(await online(rig, codex.agent.id)).toBe(true);
    expect((await rig.hook("session-end", (codex.fake as FakeCodex).sessionEnd())).exitCode).toBe(0);
    expect(await online(rig, codex.agent.id)).toBe(false);
  });
});

test("codex: messages to an ended thread queue, then arrive in order on the next SessionStart", async () => {
  await withRig(async rig => {
    const sender = await rig.harness("pi"), codex = await rig.harness("codex");
    const fake = codex.fake as FakeCodex;
    await rig.hook("session-end", fake.sessionEnd());
    await sender.send(`comms:${codex.agent.name}`, "first");
    await sender.send(`comms:${codex.agent.name}`, "second");
    expect(fake.commands).toHaveLength(0);
    expect(rig.rows().map(row => row.state)).toEqual(["queued", "queued"]);
    expect((await rig.hook("session-start", fake.sessionStart())).exitCode).toBe(0);
    await eventually(() => rig.rows(), rows => expect(rows.map(row => row.state)).toEqual(["acked", "acked"]));
    expect(fake.commands.map(argv => argv.slice(0, 4))).toEqual([0, 1].map(() => ["codex", "queue", "--thread", codex.sessionId]));
    expect(codex.incoming()[0]).toContain("first");
    expect(codex.incoming()[1]).toContain("second");
  });
});

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

// The core watches Codex's app-server daemon, so interactive threads are online
// from the moment they load, before any hook fires.
function fakeDaemon() {
  const daemon = {
    snapshot: undefined as { executable: string; threads: { id: string; cwd: string }[] } | undefined,
    read: async () => daemon.snapshot,
  };
  return daemon;
}

test("codex daemon: a thread is online as soon as the daemon loads it, before any hook", async () => {
  const daemon = fakeDaemon();
  await withRig(async rig => {
    const id = uuid();
    daemon.snapshot = { executable: "/daemon/codex", threads: [{ id, cwd: "/projects/fresh" }] };
    const agent = await rig.agent("codex", id);
    expect(agent.online).toBe(true);
    expect(agent.cwd).toBe("/projects/fresh");
  }, undefined, { codexDaemon: daemon.read, codexPollMs: 5 });
});

test("codex daemon: a thread the daemon unloads goes offline", async () => {
  const daemon = fakeDaemon();
  await withRig(async rig => {
    const id = uuid();
    daemon.snapshot = { executable: "/daemon/codex", threads: [{ id, cwd: "/projects/shared" }] };
    const agent = await rig.agent("codex", id);
    daemon.snapshot = { executable: "/daemon/codex", threads: [] };
    await eventually(() => online(rig, agent.id), value => expect(value).toBe(false));
  }, undefined, { codexDaemon: daemon.read, codexPollMs: 5 });
});

test("codex daemon: queued messages arrive through the daemon's executable when the thread loads again", async () => {
  const daemon = fakeDaemon();
  await withRig(async rig => {
    const fake = new FakeCodex(uuid(), "/projects/shared");
    rig.codexFakes.set(fake.threadId, fake);
    const thread = { id: fake.threadId, cwd: fake.cwd };
    daemon.snapshot = { executable: "/daemon/codex", threads: [thread] };
    const agent = await rig.agent("codex", fake.threadId);
    daemon.snapshot = { executable: "/daemon/codex", threads: [] };
    await eventually(() => online(rig, agent.id), value => expect(value).toBe(false));
    const sender = await rig.harness("pi");
    await sender.send(`comms:${agent.name}`, "Waiting for you");
    expect(rig.rows()[0]!.state).toBe("queued");
    daemon.snapshot = { executable: "/daemon/codex", threads: [thread] };
    await rig.state(rig.rows()[0]!.id, "acked");
    expect(fake.commands[0]!.slice(0, 4)).toEqual(["/daemon/codex", "queue", "--thread", fake.threadId]);
  }, undefined, { codexDaemon: daemon.read, codexPollMs: 5 });
});

test("codex daemon: a hook-registered thread the daemon never listed stays online", async () => {
  const daemon = fakeDaemon();
  await withRig(async rig => {
    daemon.snapshot = { executable: "/daemon/codex", threads: [] };
    // Headless `codex exec` runs its own app server, so the shared daemon never lists its thread.
    const codex = await rig.harness("codex");
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await online(rig, codex.agent.id)).toBe(true);
  }, undefined, { codexDaemon: daemon.read, codexPollMs: 5 });
});

test("codex daemon: when no daemon is running, presence is left to the hooks", async () => {
  const daemon = fakeDaemon();
  await withRig(async rig => {
    const codex = await rig.harness("codex");
    daemon.snapshot = undefined;
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await online(rig, codex.agent.id)).toBe(true);
  }, undefined, { codexDaemon: daemon.read, codexPollMs: 5 });
});
