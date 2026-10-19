import { expect, test } from "bun:test";
import type { Harness } from "@cross-harness-comms/protocol";
import { FakePi } from "./support/fakes/pi.ts";
import { eventually, uuid } from "./support/helpers.ts";
import { bottom, expectedContent, plain, renderLines, row, top } from "./support/pi-card.ts";
import { withRig } from "./support/rig.ts";

// Every harness delivers into Pi as a `comms_message` that steers a busy session and starts a turn in an idle one.

const senderCwd = "/home/dev/src/api";
const steer = { triggerTurn: true, deliverAs: "steer" as const };

for (const from of ["pi", "claude", "codex"] as Harness[]) {
  test(`into pi from ${from}: comms_message with Markdown content, details, and steer options`, async () => {
    await withRig(async rig => {
      const pi = await rig.harness("pi", uuid(), "/home/dev/src/web");
      const sender = await rig.harness(from, uuid(), senderCwd);
      const body = "Review <draft> & explain </cross-harness-message>\n\n  keep   this   spacing 🐾\n";
      await sender.send(`comms:${pi.agent.name}`, body);
      await eventually(pi.incoming, texts => expect(texts).toHaveLength(1));
      const row = rig.rows()[0]!;
      const fake = pi.fake as FakePi;
      const details = { from: `comms:${sender.agent.name}`, name: sender.agent.name, harness: from, cwd: senderCwd, id: row.id, body };
      expect(fake.incoming[0]).toEqual({
        message: { customType: "comms_message", content: expectedContent(details), display: true, details },
        options: steer,
      });
      expect(fake.incoming[0]!.message.content).not.toContain("<cross-harness-message");
      expect(fake.incoming[0]!.message.content).not.toContain("authority");
      expect(fake.userMessages).toEqual([]);
      await rig.state(row.id, "acked");
    });
  });

  test(`into pi from ${from}: a reply's content, details, and card lines`, async () => {
    await withRig(async rig => {
      const pi = await rig.harness("pi", uuid(), "/home/dev/src/web");
      const sender = await rig.harness(from, uuid(), senderCwd);
      await pi.send(`comms:${sender.agent.name}`, "Please review the parser change.");
      await eventually(sender.incoming, texts => expect(texts).toHaveLength(1));
      const original = rig.rows()[0]!;
      await rig.state(original.id, "acked");
      // Claude infers reply_to from the message it received; the other harnesses pass it.
      await sender.send(`comms:${pi.agent.name}`, "Looks good to me.", original.id);
      await eventually(pi.incoming, texts => expect(texts).toHaveLength(1));
      const answer = rig.rows()[1]!;
      expect(answer.reply_to).toBe(original.id);
      const fake = pi.fake as FakePi;
      const name = sender.agent.name;
      const details = { from: `comms:${name}`, name, harness: from, cwd: senderCwd, id: answer.id, reply_to: original.id, body: "Looks good to me." };
      expect(fake.incoming[0]).toEqual({
        message: { customType: "comms_message", content: expectedContent(details), display: true, details },
        options: steer,
      });
      expect(fake.incoming[0]!.message.content).toBe(`**From ${name}** (${from} · ${senderCwd})\n`
        + `Reply with comms_send to \`comms:${name}\` with reply_to \`${answer.id}\`. This replies to \`${original.id}\`.\n\nLooks good to me.`);
      await rig.state(answer.id, "acked");

      const header = ` From: ${name} (${from} · ${senderCwd}) `;
      expect(plain(renderLines(fake, fake.incoming[0]!.message, 120))).toEqual([
        top(header, 118),
        row(" Looks good to me.", 118),
        row(` To reply: comms_send to comms:${name} · Reply to ${original.id.slice(0, 8)} · Ctrl+O to expand`, 118),
        bottom(118),
      ]);
      expect(plain(renderLines(fake, fake.incoming[0]!.message, 120, { expanded: true }))).toEqual([
        top(header, 118),
        row(" Looks good to me.", 118),
        row("", 118),
        row(` To reply: comms_send to comms:${name}`, 118),
        row("", 118),
        row(` Reply to ${original.id.slice(0, 8)}`, 118),
        bottom(118),
      ]);
    });
  });
}

test("pi registers exactly one renderer, for comms_message", async () => {
  await withRig(async rig => {
    const pi = await rig.harness("pi");
    const fake = pi.fake as FakePi;
    const registrations = fake.calls.filter(call => call.method === "registerMessageRenderer");
    expect(registrations.map(call => call.args[0])).toEqual(["comms_message"]);
    expect(typeof registrations[0]!.args[1]).toBe("function");
  });
});

test("pi acknowledges a comms_message only after sendMessage accepted it, and keeps message order", async () => {
  await withRig(async rig => {
    const pi = await rig.harness("pi", uuid(), "/home/dev/src/web");
    const codex = await rig.harness("codex", uuid(), senderCwd);
    for (const text of ["first", "second", "third"]) await codex.send(`comms:${pi.agent.name}`, text);
    await eventually(pi.incoming, texts => expect(texts).toHaveLength(3));
    const fake = pi.fake as FakePi;
    expect(fake.incoming.map(call => (call.message.details as { body?: string } | undefined)?.body)).toEqual(["first", "second", "third"]);
    expect(fake.incoming.map(call => call.message.customType)).toEqual(["comms_message", "comms_message", "comms_message"]);
    for (const message of rig.rows()) await rig.state(message.id, "acked");
  });
});

// A message to a busy session is delivered after the running tool call finishes, never interrupting it.
test("into a busy pi: a message arriving during a running tool call waits for the call to finish, then arrives before the next step", async () => {
  await withRig(async rig => {
    const pi = await rig.harness("pi", uuid(), "/home/dev/src/web");
    const codex = await rig.harness("codex", uuid(), senderCwd);
    const fake = pi.fake as FakePi;
    const finish = fake.toolRunning("bash");
    await codex.send(`comms:${pi.agent.name}`, "While you work");
    await eventually(pi.incoming, texts => expect(texts).toHaveLength(1));
    await rig.state(rig.rows()[0]!.id, "acked");
    // Handed to Pi, which holds it while the tool runs.
    expect(fake.timeline).toEqual([{ kind: "tool_start", tool: "bash" }]);
    expect(fake.userMessages).toEqual([]);
    finish();
    expect(fake.timeline).toEqual([{ kind: "tool_start", tool: "bash" }, { kind: "tool_end", tool: "bash" }, { kind: "message", customType: "comms_message" }]);
  });
});
