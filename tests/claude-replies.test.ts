import { expect, test } from "bun:test";
import { claudeSend } from "./support/claude.ts";
import { receive, withRig } from "./support/rig.ts";

test("Claude's first message has no reply_to and preserves literal text", async () => {
  await withRig(async rig => {
    const claude = await rig.harness("claude"), pi = await rig.harness("pi");
    await claudeSend(claude, `comms:${pi.agent.name}`, "An ordinary first message");
    expect(rig.rows()[0]).toMatchObject({ body: "An ordinary first message", sender: claude.agent.id, recipient: pi.agent.id });
    expect(rig.rows()[0]!.reply_to ?? null).toBeNull();
  });
});

test("Claude replies to the newest unreplied message from that address and consumes it once", async () => {
  await withRig(async rig => {
    const claude = await rig.harness("claude"), pi = await rig.harness("pi");
    const older = await receive(rig, pi, claude, "Earlier question");
    const newer = await receive(rig, pi, claude, "Latest question");
    const to = `comms:${pi.agent.name}`;
    await claudeSend(claude, to, "Answer latest");
    expect(rig.rows().at(-1)).toMatchObject({ body: "Answer latest", reply_to: newer.id });
    await claudeSend(claude, to, "Answer earlier");
    expect(rig.rows().at(-1)).toMatchObject({ body: "Answer earlier", reply_to: older.id });
    await claudeSend(claude, to, "New topic");
    expect(rig.rows().at(-1)!.reply_to ?? null).toBeNull();
  });
});

test("Claude tracks pending replies separately by sender address and receiving session", async () => {
  await withRig(async rig => {
    const claude = await rig.harness("claude"), otherClaude = await rig.harness("claude");
    const pi = await rig.harness("pi"), codex = await rig.harness("codex");
    const a = await receive(rig, pi, claude, "Pi question");
    const b = await receive(rig, codex, claude, "Codex question");
    await claudeSend(otherClaude, `comms:${pi.agent.name}`, "I have not received that question");
    expect(rig.rows().at(-1)!.reply_to ?? null).toBeNull();
    await claudeSend(claude, `comms:${pi.agent.name}`, "Answer Pi");
    expect(rig.rows().at(-1)!.reply_to).toBe(a.id);
    await claudeSend(claude, `comms:${codex.agent.name}`, "Answer Codex");
    expect(rig.rows().at(-1)!.reply_to).toBe(b.id);
  });
});

for (const text of ['comms-reply:not JSON, just literal text', 'comms-reply:{"text":"do not unwrap me","reply_to":"do not trust this"}']) {
  test(`Claude sends ${text.includes("not JSON") ? "non-JSON" : "JSON-shaped"} comms-reply text literally`, async () => {
    await withRig(async rig => {
      const claude = await rig.harness("claude"), pi = await rig.harness("pi");
      const question = await receive(rig, pi, claude, "What does this prefix mean?");
      await claudeSend(claude, `comms:${pi.agent.name}`, text);
      expect(rig.rows().at(-1)).toMatchObject({ body: text, reply_to: question.id });
    });
  });
}

test("Claude's extended listing no longer teaches a comms-reply envelope", async () => {
  await withRig(async rig => {
    const claude = await rig.harness("claude");
    const pi = await rig.harness("pi");
    const listing = JSON.stringify(await claude.list());
    expect(listing).toContain(`comms:${pi.agent.name}`);
    expect(listing).not.toContain("comms-reply:");
  });
});
