import { expect, test } from "bun:test";
import type { Agent } from "@cross-harness-comms/protocol";
import { FakeCodex } from "./support/fakes/codex.ts";
import { FakeCodexEvents } from "./support/fakes/codex-events.ts";
import { eventually, uuid } from "./support/helpers.ts";
import { withRig, type Rig } from "./support/rig.ts";

// Tests only: codexEvents is the proposed sequential event input to createCore.
// No new protocol method, daemon polling, real sockets, or harness processes.
async function withEvents(run: (rig: Rig, events: FakeCodexEvents) => Promise<void>, options: Rig["coreOptions"] = {}) {
  const events = new FakeCodexEvents();
  await withRig(async rig => {
    try { await run(rig, events); }
    finally { events.close(); }
  }, undefined, { ...options, codexEvents: events });
}

async function started(rig: Rig, events: FakeCodexEvents) {
  const fake = new FakeCodex(uuid(), "/projects/shared");
  rig.codexFakes.set(fake.threadId, fake);
  const event = { method: "thread/started" as const, executable: "/daemon/codex",
    params: { thread: { id: fake.threadId, cwd: fake.cwd, parentThreadId: null, ephemeral: false as const } } };
  await events.publish(event);
  return { fake, event, agent: await rig.agent("codex", fake.threadId) };
}

async function status(events: FakeCodexEvents, threadId: string, type: "notLoaded" | "idle" | "active") {
  await events.publish({ method: "thread/status/changed", params: { threadId,
    status: type === "active" ? { type, activeFlags: [] } : { type } } });
}

async function sameSession(rig: Rig, agent: Agent, online: boolean) {
  const matches = (await rig.agents()).filter(row => row.harness === "codex" && row.session_key === agent.session_key);
  expect(matches).toHaveLength(1);
  expect(matches[0]).toMatchObject({ id: agent.id, name: agent.name, cwd: agent.cwd, online });
}

test("codex lifecycle: thread/started creates a new available session before any SessionStart hook", async () => {
  await withEvents(async (rig, events) => {
    expect(await rig.agents()).toEqual([]);
    const { fake, agent } = await started(rig, events);
    expect(agent.online).toBe(true);
    expect(agent.session_key).toBe(fake.threadId);
    expect(agent.cwd).toBe(fake.cwd);
    expect((await rig.agents()).filter(row => row.harness === "codex")).toHaveLength(1);
  });
});

test("codex lifecycle: a duplicate thread/started does not replace or rename the existing session", async () => {
  await withEvents(async (rig, events) => {
    const { event, agent } = await started(rig, events);
    const peer = await rig.peer();
    await peer.request("hello", { versions: { min: 1, max: 1 } });
    const renamed = await peer.request("rename", { address: `comms:${agent.name}`, name: "codex-lifecycle" });
    await events.publish(event);
    await sameSession(rig, renamed, true);
  });
});

test("codex lifecycle: SessionStart confirms the existing thread without creating another identity", async () => {
  await withEvents(async (rig, events) => {
    const { fake, agent } = await started(rig, events);
    expect((await rig.hook("session-start", fake.sessionStart())).exitCode).toBe(0);
    await sameSession(rig, agent, true);
  });
});

test("codex lifecycle: SessionEnd keeps the session and mailbox, and messages wait for its next SessionStart", async () => {
  await withEvents(async (rig, events) => {
    const { fake, agent } = await started(rig, events);
    expect((await rig.hook("session-end", fake.sessionEnd())).exitCode).toBe(0);
    await sameSession(rig, agent, false);
    const sender = await rig.harness("pi");
    await sender.send(`comms:${agent.name}`, "first, waiting for the same session");
    await sender.send(`comms:${agent.name}`, "second, waiting for the same session");
    const messages = rig.rows();
    expect(messages.map(row => [row.recipient, row.state])).toEqual([[agent.id, "queued"], [agent.id, "queued"]]);
    expect(fake.commands).toHaveLength(0);
    expect((await rig.hook("session-start", fake.sessionStart())).exitCode).toBe(0);
    await sameSession(rig, agent, true);
    for (const message of messages) await rig.state(message.id, "acked");
    // Delivered in order, through the executable the SessionStart hook reported.
    expect(fake.commands.map(argv => argv.slice(0, 4))).toEqual([0, 1].map(() => ["codex", "queue", "--thread", fake.threadId]));
    expect(fake.commands.map(argv => argv.at(-1))).toEqual([expect.stringContaining("first"), expect.stringContaining("second")]);
  });
});

test("codex lifecycle: notLoaded marks an existing session offline without removing its name or mailbox", async () => {
  await withEvents(async (rig, events) => {
    const { fake, agent } = await started(rig, events);
    await status(events, fake.threadId, "notLoaded");
    await sameSession(rig, agent, false);
    const sender = await rig.harness("pi");
    await sender.send(`comms:${agent.name}`, "still addressed to the unloaded session");
    expect(rig.rows()[0]).toMatchObject({ recipient: agent.id, state: "queued" });
    expect(fake.commands).toHaveLength(0);
  });
});

for (const state of ["idle", "active"] as const) {
  test(`codex lifecycle: ${state} describes the existing running session, preserving its identity`, async () => {
    await withEvents(async (rig, events) => {
      const { fake, agent } = await started(rig, events);
      await status(events, fake.threadId, state);
      await sameSession(rig, agent, true);
    });
  });

  test(`codex lifecycle: ${state} alone cannot undo SessionEnd or deliver queued messages`, async () => {
    await withEvents(async (rig, events) => {
      const { fake, agent } = await started(rig, events);
      await rig.hook("session-end", fake.sessionEnd());
      const sender = await rig.harness("pi");
      await sender.send(`comms:${agent.name}`, "do not revive an ended session");
      await status(events, fake.threadId, state);
      await status(events, fake.threadId, state);
      await sameSession(rig, agent, false);
      expect(rig.rows()[0]).toMatchObject({ recipient: agent.id, state: "queued" });
      expect(fake.commands).toHaveLength(0);
    });
  });

  test(`codex lifecycle: notLoaded to ${state} reloads the same session and drains its existing mailbox`, async () => {
    await withEvents(async (rig, events) => {
      const { fake, agent } = await started(rig, events);
      await status(events, fake.threadId, "notLoaded");
      const sender = await rig.harness("pi");
      await sender.send(`comms:${agent.name}`, "first queued message");
      await sender.send(`comms:${agent.name}`, "second queued message");
      const messages = rig.rows();
      expect(messages.map(row => row.state)).toEqual(["queued", "queued"]);
      await status(events, fake.threadId, state);
      await sameSession(rig, agent, true);
      for (const message of messages) await rig.state(message.id, "acked");
      expect(fake.commands).toHaveLength(2);
      expect(fake.commands.every(argv => argv[0] === "/daemon/codex")).toBe(true);
      expect(fake.commands[0]!.at(-1)).toContain("first queued message");
      expect(fake.commands[1]!.at(-1)).toContain("second queued message");
    });
  });
}

test("codex lifecycle: a duplicate thread/started cannot revive an ended session", async () => {
  await withEvents(async (rig, events) => {
    const { fake, event, agent } = await started(rig, events);
    await rig.hook("session-end", fake.sessionEnd());
    await events.publish(event);
    await sameSession(rig, agent, false);
  });
});

test("codex lifecycle: snapshots recover discovery without overriding a persisted SessionEnd", async () => {
  await withEvents(async (rig, events) => {
    const fake = new FakeCodex(uuid(), "/projects/shared");
    rig.codexFakes.set(fake.threadId, fake);
    const snapshot = { method: "comms/daemon-snapshot" as const, executable: "/daemon/codex",
      params: { threads: [{ id: fake.threadId, cwd: fake.cwd }] } };
    await events.publish(snapshot);
    const agent = await rig.agent("codex", fake.threadId);
    expect(agent.online).toBe(true);
    await rig.hook("session-end", fake.sessionEnd());
    await events.publish(snapshot);
    await sameSession(rig, agent, false);
    await rig.restart();
    await events.publish(snapshot);
    await sameSession(rig, agent, false);
    await status(events, fake.threadId, "idle");
    await sameSession(rig, agent, false);
    await rig.hook("session-start", fake.sessionStart());
    await sameSession(rig, agent, true);
  });
});

test("codex lifecycle: disconnect makes daemon-owned sessions unavailable but leaves hook-only sessions alone", async () => {
  await withEvents(async (rig, events) => {
    const { agent, fake } = await started(rig, events);
    const headless = await rig.harness("codex", uuid(), "/projects/headless");
    await events.publish({ method: "comms/daemon-disconnected" });
    await sameSession(rig, agent, false);
    await sameSession(rig, headless.agent, true);
    await events.publish({ method: "comms/daemon-snapshot", executable: "/daemon/codex",
      params: { threads: [{ id: fake.threadId, cwd: fake.cwd }] } });
    await sameSession(rig, agent, true);
    await sameSession(rig, headless.agent, true);
    await events.publish({ method: "comms/daemon-snapshot", executable: "/daemon/codex", params: { threads: [] } });
    await sameSession(rig, agent, false);
    await sameSession(rig, headless.agent, true);
  });
});

test("codex lifecycle: reload after an end reuses its identity without needing a first prompt", async () => {
  await withEvents(async (rig, events) => {
    const { fake, agent } = await started(rig, events);
    await rig.hook("session-end", fake.sessionEnd());
    await status(events, fake.threadId, "notLoaded");
    await status(events, fake.threadId, "idle");
    await sameSession(rig, agent, true);
  });
});

test("codex lifecycle: subagent and ephemeral thread notifications do not create public agents", async () => {
  await withEvents(async (rig, events) => {
    for (const extra of [{ parentThreadId: uuid() }, { ephemeral: true }]) {
      await events.publish({ method: "thread/started", executable: "/daemon/codex",
        params: { thread: { id: uuid(), cwd: "/projects/shared", ...extra } } });
    }
    expect(await rig.agents()).toEqual([]);
  });
});

test("codex lifecycle: buffered statuses emitted before SessionEnd cannot masquerade as a later resume", async () => {
  const events = new FakeCodexEvents();
  const endedAt = Date.parse("2030-01-01T00:01:00.000Z");
  await withRig(async rig => {
    try {
      const { fake, agent } = await started(rig, events);
      await rig.hook("session-end", fake.sessionEnd());
      const transition = async (at: number) => {
        for (const type of ["notLoaded", "idle"] as const) {
          await events.publish({ method: "thread/status/changed", active_at: new Date(at).toISOString(),
            params: { threadId: fake.threadId, status: { type } } });
        }
      };
      await transition(endedAt - 1000);
      await sameSession(rig, agent, false);
      await transition(endedAt + 1000);
      await sameSession(rig, agent, true);
    } finally { events.close(); }
  }, undefined, { codexEvents: events, now: () => endedAt });
});

test("codex lifecycle: a busy thread is steered mid-turn instead of queued for its next turn", async () => {
  const steers: { threadId: string; text: string; messageId: string }[] = [];
  await withEvents(async (rig, events) => {
    const { fake, agent } = await started(rig, events);
    await status(events, fake.threadId, "active");
    const sender = await rig.harness("pi");
    await sender.send(`comms:${agent.name}`, "steer me mid-turn");
    const [message] = rig.rows();
    await rig.state(message!.id, "acked");
    expect(steers).toEqual([{ threadId: fake.threadId, text: expect.stringContaining("steer me mid-turn"), messageId: message!.id }]);
    expect(fake.commands).toHaveLength(0);
  }, { codexSteer: async (threadId, text, messageId) => { steers.push({ threadId, text, messageId }); return true; } });
});

test("codex lifecycle: a thread that cannot be steered gets the message through the queue exactly once", async () => {
  let steers = 0;
  await withEvents(async (rig, events) => {
    const { fake, agent } = await started(rig, events);
    await status(events, fake.threadId, "idle");
    const sender = await rig.harness("pi");
    await sender.send(`comms:${agent.name}`, "queue me for the next turn");
    const [message] = rig.rows();
    await rig.state(message!.id, "acked");
    expect(steers).toBe(1);
    expect(fake.commands).toHaveLength(1);
    expect(fake.commands[0]!.at(-1)).toContain("queue me for the next turn");
  }, { codexSteer: async () => { steers++; return false; } });
});

test("codex lifecycle: does not immediately fall back to queue after an uncertain steer", async () => {
  await withEvents(async (rig, events) => {
    const { fake, agent } = await started(rig, events);
    await status(events, fake.threadId, "active");
    const sender = await rig.harness("pi");
    await sender.send(`comms:${agent.name}`, "maybe steered");
    const [message] = rig.rows();
    await eventually(() => rig.agent("codex", fake.threadId), row => expect(row.online).toBe(false));
    expect(rig.rows()[0]).toMatchObject({ id: message!.id, state: "delivered" });
    expect(fake.commands).toHaveLength(0);
  }, { codexSteer: async () => { throw new Error("Codex daemon request timed out: turn/steer"); } });
});

test("codex lifecycle: a steer accepted while the core shuts down stays acked and is not replayed after restart", async () => {
  let steers = 0, accept!: (accepted: boolean) => void;
  await withEvents(async (rig, events) => {
    const { fake, agent } = await started(rig, events);
    await status(events, fake.threadId, "active");
    const sender = await rig.harness("pi");
    await sender.send(`comms:${agent.name}`, "accepted during shutdown");
    const [message] = rig.rows();
    await eventually(() => steers, count => expect(count).toBe(1));
    const restarting = rig.restart();
    await Bun.sleep(1);
    accept(true);
    await restarting;
    expect(rig.rows().find(row => row.id === message!.id)?.state).toBe("acked");
    // Deliveries to a thread run in order, so a replay of the first message would steer before this one.
    const again = await rig.harness("pi");
    await again.send(`comms:${agent.name}`, "after restart");
    await rig.state(rig.rows().at(-1)!.id, "acked");
    expect(steers).toBe(2);
    expect(fake.commands).toHaveLength(0);
  }, { codexSteer: () => ++steers === 1 ? new Promise<boolean>(resolve => { accept = resolve; }) : Promise.resolve(true) });
});
