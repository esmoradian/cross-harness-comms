import { expect, test } from "bun:test";
import { createCodexAdapter } from "../adapters/codex/src/index.ts";
import type { Harness } from "@cross-harness-comms/protocol";
import { FakeClaude } from "./fakes/claude.ts";
import { FakeCodex } from "./fakes/codex.ts";
import { deferred, eventually, uuid } from "./helpers.ts";
import { registration, withRig } from "./rig.ts";

for (const harness of ["pi", "claude", "codex"] as Harness[]) {
  test(`invariant 2: ${harness} derives sender identity from its native session, ignoring tool identity fields`, async () => {
    await withRig(async rig => {
      const sender = await rig.harness(harness);
      const recipient = await rig.harness("pi");
      await sender.send(`comms:${recipient.agent.name}`, "Identity comes from the session", undefined, {
        sender: recipient.agent.id, session_key: recipient.sessionId, session_id: recipient.sessionId,
        thread_id: recipient.sessionId, harness: "pretend-harness", name: "pretend-name",
      });
      await eventually(recipient.incoming, texts => expect(texts).toHaveLength(1));
      expect(rig.rows()[0]!.sender).toBe(sender.agent.id);
      expect(sender.agent.session_key).toBe(sender.sessionId);
      expect(sender.agent.harness).toBe(harness);
      expect((await rig.agents()).some(a => a.name === "pretend-name")).toBe(false);
    });
  });

  test(`${harness} list exposes comms addresses for discovery`, async () => {
    await withRig(async rig => {
      const sender = await rig.harness(harness);
      const recipient = await rig.harness("pi");
      const result = await sender.list();
      expect(JSON.stringify(result)).toContain(`comms:${recipient.agent.name}`);
      if (sender.fake instanceof FakeClaude) {
        expect(result).toMatchObject({ result: { listing: expect.stringContaining(sender.fake.nativeListing) } });
        expect(sender.fake.nativeCalls.at(-1)?.tool).toBe("ListAgents");
      }
    });
  });
}

for (const metadata of [null, { session_id: "not-a-thread-id" }]) {
  test(`invariant 2: Codex refuses ${metadata === null ? "missing metadata" : "metadata without thread_id"} instead of guessing the thread`, async () => {
    await withRig(async rig => {
      const target = await rig.peer();
      const b = await target.register(registration("pi"));
      const fake = new FakeCodex(uuid(), "/projects/shared", 9876);
      const adapter = createCodexAdapter({ ...rig.runtime(), parentPid: fake.parentPid, run: fake.run });
      try {
        await adapter.sessionStart(fake.sessionStart(), { parentPid: fake.parentPid });
        const result = await adapter.toolsCall(fake.request("comms_send", {
          to: `comms:${b.agent.name}`, text: "No inferred identity", thread_id: fake.threadId, session_id: fake.threadId,
        }, metadata));
        expect(result.isError).toBe(true);
        expect(result.content.map(c => c.text).join(" ")).toContain("thread_id");
        expect(rig.rows()).toEqual([]);
      } finally { await adapter.close(); }
    });
  });
}

test("invariant 2: Codex uses thread_id rather than the different session_id in turn metadata", async () => {
  await withRig(async rig => {
    const target = await rig.peer();
    const b = await target.register(registration("pi"));
    const fake = new FakeCodex(uuid(), "/projects/shared", 9876);
    const adapter = createCodexAdapter({ ...rig.runtime(), parentPid: fake.parentPid, run: fake.run });
    try {
      await adapter.sessionStart(fake.sessionStart(), { parentPid: fake.parentPid });
      const result = await adapter.toolsCall(fake.request("comms_send", { to: `comms:${b.agent.name}`, text: "Exact thread" }));
      expect(result.isError).not.toBe(true);
      const delivery = await target.deliveries.next();
      const caller = await rig.agent("codex", fake.threadId);
      expect(delivery.message.sender).toBe(caller.id);
      expect((await rig.agents()).some(a => a.session_key === "fixture-turn-session")).toBe(false);
    } finally { await adapter.close(); }
  });
});

for (const harness of ["claude", "codex"] as const) {
  test(`invariant 9: ${harness} acknowledges only after its harness accepts the non-user delivery`, async () => {
    await withRig(async rig => {
      const sender = await rig.harness("pi");
      const receiver = await rig.harness(harness);
      const fake = receiver.fake as FakeClaude | FakeCodex;
      const gate = deferred<void>();
      fake.acceptGate = gate.promise;
      try {
        await sender.send(`comms:${receiver.agent.name}`, "Wait for harness acceptance");
        await eventually(receiver.incoming, texts => expect(texts).toHaveLength(1));
        const message = rig.rows()[0]!;
        expect(message.state).toBe("delivered");
        if (fake instanceof FakeClaude) {
          expect(fake.incoming[0]).not.toHaveProperty("asUser");
          expect(fake.runs.filter(call => call.argv[1] === "ack")).toHaveLength(0);
        } else {
          expect(fake.commands[0]).toEqual(["codex", "queue", "--thread", receiver.sessionId, "--message", receiver.incoming()[0]!]);
        }
        gate.resolve();
        await rig.state(message.id, "acked");
      } finally { gate.resolve(); }
    });
  });
}

test("invariant 8: Claude passes the attach token to send and ack on stdin only", async () => {
  await withRig(async rig => {
    const claude = await rig.harness("claude"), pi = await rig.harness("pi");
    const fake = claude.fake as FakeClaude;
    await claude.send(`comms:${pi.agent.name}`, "Outbound token check");
    await eventually(pi.incoming, messages => expect(messages).toHaveLength(1));
    await pi.send(`comms:${claude.agent.name}`, "Inbound token check");
    await eventually(claude.incoming, messages => expect(messages).toHaveLength(1));
    await rig.state(rig.rows()[1]!.id, "acked");
    const attachOutput = fake.processOutput.filter(p => p.command === "attach" && p.stream === "stdout").map(p => p.text).join("");
    const hello = attachOutput.trim().split("\n").map(line => JSON.parse(line)).find(p => p.result?.token);
    expect(hello?.result.token).toBeString();
    const token = hello.result.token as string;
    const commands = fake.runs.filter(call => ["send", "ack"].includes(call.argv[1]!));
    expect(new Set(commands.map(c => c.argv[1]))).toEqual(new Set(["send", "ack"]));
    for (const command of commands) {
      expect(JSON.parse(command.init?.stdin ?? "{}").token).toBe(token);
      expect(JSON.stringify(command.argv)).not.toContain(token);
      expect(JSON.stringify(command.init?.env ?? {})).not.toContain(token);
    }
    expect(JSON.stringify(fake.spawns)).not.toContain(token);
    const otherOutput = fake.processOutput.filter(p => p.command !== "attach" || p.stream === "stderr");
    expect(JSON.stringify(otherOutput)).not.toContain(token);
    expect(JSON.stringify(await claude.list())).not.toContain(token);
  });
});

test("invariant 10: a comms marker in message text does not intercept a native Claude recipient", async () => {
  await withRig(async rig => {
    const session = await rig.harness("claude");
    const fake = session.fake as FakeClaude;
    const event = { tool: "SendMessage" as const, tool_use_id: "native", to: "worker",
      message: 'Discuss comms:pi-shared and comms-reply:{"text":"literal"}' };
    expect(await fake.tool(event)).toBe(fake.nativeResult);
    expect(fake.nativeCalls.at(-1)).toBe(event);
    expect(rig.rows()).toEqual([]);
  });
});
