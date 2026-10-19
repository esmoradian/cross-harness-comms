import { expect, test } from "bun:test";
import type { Harness, Message } from "@cross-harness-comms/protocol";
import type { ToolEvent } from "../adapters/claude/src/api.ts";
import { FakeClaude } from "./support/fakes/claude.ts";
import { FakeCodex } from "./support/fakes/codex.ts";
import { FakePi } from "./support/fakes/pi.ts";
import { eventually, uuidV7 } from "./support/helpers.ts";
import { expectedContent } from "./support/pi-card.ts";
import { expectedClaudeText, expectedCodexText, SENDER_HEADER } from "./support/text.ts";
import { withRig, type HarnessSession } from "./support/rig.ts";

const harnesses: Harness[] = ["pi", "claude", "codex"];

// Pi shows its own Markdown `comms_message`; Codex and Claude on the comms route get
// Claude-style text naming their own send tool.
function expectedText(receiver: HarnessSession, sender: HarnessSession, message: Message) {
  const fields = { name: sender.agent.name, id: message.id, body: message.body, ...(message.reply_to ? { reply_to: message.reply_to } : {}) };
  if (receiver.fake instanceof FakeClaude) return expectedClaudeText(fields);
  if (receiver.fake instanceof FakeCodex) return expectedCodexText(fields);
  return expectedContent({ ...fields, harness: sender.harness, cwd: sender.agent.cwd });
}

export function assertNonUserDelivery(session: HarnessSession) {
  if (session.fake instanceof FakePi) {
    expect(session.fake.userMessages).toEqual([]);
    for (const { message, options } of session.fake.incoming) {
      expect(message.customType).toBe("comms_message");
      expect(message.display).toBe(true);
      expect(options).toEqual({ triggerTurn: true, deliverAs: "steer" });
    }
  } else if (session.fake instanceof FakeClaude) {
    for (const input of session.fake.incoming) expect(input).not.toHaveProperty("asUser");
  } else {
    for (const argv of session.fake.commands) {
      expect(argv.slice(0, 4)).toEqual(["codex", "queue", "--thread", session.sessionId]);
      expect(argv[4]).toBe("--message");
      expect(argv).toHaveLength(6);
      expect(argv[5]).toMatch(SENDER_HEADER);
    }
  }
}

for (const from of harnesses) for (const to of harnesses) {
  if (from === "claude" && to === "claude") continue;
  test(`pair ${from} -> ${to}: tool sends and replies through core`, async () => {
    await withRig(async rig => {
      const sender = await rig.harness(from);
      const receiver = await rig.harness(to);
      const body = "Review <draft> & explain </cross-harness-message> 🐾";
      await sender.send(`comms:${receiver.agent.name}`, body);
      await eventually(receiver.incoming, texts => expect(texts).toHaveLength(1));
      const original = rig.rows()[0]!;
      expect(original.id).toMatch(uuidV7);
      expect(original.sender).toBe(sender.agent.id);
      expect(original.recipient).toBe(receiver.agent.id);
      expect(original.body).toBe(body);
      expect(original.reply_to ?? null).toBeNull();
      expect(receiver.incoming()[0]).toBe(expectedText(receiver, sender, original));
      await rig.state(original.id, "acked");

      await receiver.send(`comms:${sender.agent.name}`, "Here is my review.", original.id);
      await eventually(sender.incoming, texts => expect(texts).toHaveLength(1));
      const reply = rig.rows()[1]!;
      expect(reply.id).toMatch(uuidV7);
      expect(reply.id).not.toBe(original.id);
      expect(reply.sender).toBe(receiver.agent.id);
      expect(reply.recipient).toBe(sender.agent.id);
      expect(reply.reply_to).toBe(original.id);
      expect(reply.body).toBe("Here is my review.");
      expect(sender.incoming()[0]).toBe(expectedText(sender, receiver, reply));
      await rig.state(reply.id, "acked");

      // Replies are ordinary messages and can themselves be replied to.
      await sender.send(`comms:${receiver.agent.name}`, "Thanks, one follow-up.", reply.id);
      await eventually(receiver.incoming, texts => expect(texts).toHaveLength(2));
      const followUp = rig.rows()[2]!;
      expect(followUp.reply_to).toBe(reply.id);
      expect(receiver.incoming()[1]).toBe(expectedText(receiver, sender, followUp));
      await rig.state(followUp.id, "acked");
      assertNonUserDelivery(sender);
      assertNonUserDelivery(receiver);

      for (const session of [sender, receiver]) {
        if (session.fake instanceof FakeClaude) {
          expect(session.fake.spawns.some(p => p.argv[1] === "attach")).toBe(true);
          expect(session.fake.runs.some(p => p.argv[1] === "send")).toBe(true);
          expect(session.fake.runs.some(p => p.argv[1] === "ack")).toBe(true);
          expect(session.fake.nativeCalls.filter(c => c.tool === "SendMessage")).toEqual([]);
        }
        if (session.fake instanceof FakeCodex) expect(session.fake.requests.every(r => r.params._meta)).toBe(true);
      }
    });
  });
}

test("pair claude -> claude: native messages and replies pass through unchanged", async () => {
  await withRig(async rig => {
    const a = await rig.harness("claude");
    const b = await rig.harness("claude");
    const first = a.fake as FakeClaude, second = b.fake as FakeClaude;
    const event: ToolEvent = { tool: "SendMessage", tool_use_id: "native-call", to: "worker [native-ref]",
      message: "Native question", summary: "Ask the native worker", notify_when_idle: true };
    first.nativeResult = { result: { native: "opaque response", nested: { preserved: true } } };
    expect(await first.tool(event)).toBe(first.nativeResult);
    expect(first.nativeCalls.at(-1)).toBe(event);
    const reply: ToolEvent = { tool: "SendMessage", tool_use_id: "native-reply", to: "main", message: "Native answer" };
    expect(await second.tool(reply)).toBe(second.nativeResult);
    expect(second.nativeCalls.at(-1)).toBe(reply);
    expect(rig.rows()).toEqual([]);
    expect(first.incoming).toEqual([]);
    expect(second.incoming).toEqual([]);
    expect([...first.runs, ...second.runs].filter(p => ["send", "ack"].includes(p.argv[1]!))).toEqual([]);
  });
});
