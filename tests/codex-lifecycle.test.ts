import { expect, test } from "bun:test";
import type { Agent } from "@cross-harness-comms/protocol";
import { FakeCodex } from "./fakes/codex.ts";
import { FakeCodexEvents } from "./fakes/codex-events.ts";
import { uuid } from "./helpers.ts";
import { withRig, type Rig } from "./rig.ts";

// Tests only: codexEvents is the proposed sequential event input to createCore.
// No new protocol method, daemon polling, real sockets, or harness processes.
async function withEvents(run: (rig: Rig, events: FakeCodexEvents) => Promise<void>) {
  const events = new FakeCodexEvents();
  await withRig(async rig => {
    try { await run(rig, events); }
    finally { events.close(); }
  }, undefined, { codexEvents: events });
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
    await sender.send(`comms:${agent.name}`, "wait for the same session");
    const message = rig.rows()[0]!;
    expect(message.recipient).toBe(agent.id);
    expect(message.state).toBe("queued");
    expect(fake.commands).toHaveLength(0);
    expect((await rig.hook("session-start", fake.sessionStart())).exitCode).toBe(0);
    await sameSession(rig, agent, true);
    await rig.state(message.id, "acked");
    expect(fake.commands).toHaveLength(1);
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
