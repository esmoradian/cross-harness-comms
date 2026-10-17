import { expect, test } from "bun:test";
import type { Harness } from "@cross-harness-comms/protocol";
import { registration, withRig } from "./rig.ts";
import { eventually, uuid, uuidV7 } from "./helpers.ts";
import { cli, sendRequests } from "./fixes-support.ts";
import { FakeClaude } from "./fakes/claude.ts";

for (const harness of ["pi", "claude", "codex"] as Harness[]) {
  test(`fix 3: ${harness} mints UUIDv7 before the first send boundary, with distinct IDs for separate sends`, async () => {
    await withRig(async rig => {
      const sender = await rig.harness(harness), recipient = await rig.harness("pi");
      const before = Date.now();
      for (const _ of [1, 2]) await sender.send(`comms:${recipient.agent.name}`, "Same text, separate message");
      const after = Date.now();
      const requests = sender.fake instanceof FakeClaude
        ? sender.fake.runs.filter(p => p.argv[1] === "send").map(p => JSON.parse(p.init?.stdin ?? "{}") as { id?: string })
        : sendRequests(rig);
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.id).toBeString();
        expect(request.id).toMatch(uuidV7);
        const timestamp = Number.parseInt(request.id!.replaceAll("-", "").slice(0, 12), 16);
        expect(timestamp).toBeGreaterThanOrEqual(before);
        expect(timestamp).toBeLessThanOrEqual(after);
      }
      expect(requests[0]!.id).not.toBe(requests[1]!.id);
      expect(rig.rows().map(row => row.id)).toEqual(requests.map(request => request.id!));
    });
  });

  test(`fix 3: ${harness} retries an uncertain send with its original ID and stores one message`, async () => {
    await withRig(async rig => {
      const sender = await rig.harness(harness), recipient = await rig.harness("pi");
      if (sender.fake instanceof FakeClaude) sender.fake.loseNextSendReceipt = true;
      else rig.dropNextSendReceipt = true;
      // Lose the receipt only after the real core has committed the message.
      let outcome: { result: unknown } | { error: unknown } | undefined;
      void sender.send(`comms:${recipient.agent.name}`, "Receipt can be lost").then(
        result => { outcome = { result }; }, error => { outcome = { error }; },
      );
      const settled = await eventually(() => {
        if (sender.fake instanceof FakeClaude) sender.fake.runScheduled();
        return outcome;
      }, value => expect(value).toBeDefined());
      expect(rig.rows()).toHaveLength(1);
      const requests = sendRequests(rig);
      expect(requests).toHaveLength(2);
      expect(requests[0]!.id).toMatch(uuidV7);
      expect(requests[1]!.id).toBe(requests[0]!.id);
      expect(requests.map(({ id, body, to, reply_to }) => ({ id, body, to, reply_to }))[1])
        .toEqual(requests.map(({ id, body, to, reply_to }) => ({ id, body, to, reply_to }))[0]);
      expect(settled).not.toHaveProperty("error");
      if (settled && "result" in settled) {
        expect(settled.result).not.toHaveProperty("deny");
        expect(settled.result).not.toMatchObject({ isError: true });
      }
      if (sender.fake instanceof FakeClaude) {
        const inputs = sender.fake.runs.filter(p => p.argv[1] === "send").map(p => JSON.parse(p.init?.stdin ?? "{}"));
        expect(inputs).toHaveLength(2);
        expect(inputs[0].id).toBe(requests[0]!.id);
        expect(inputs[1].id).toBe(requests[0]!.id);
      }
      await eventually(recipient.incoming, messages => expect(messages).toHaveLength(1));
      await rig.state(requests[0]!.id!, "acked");
    });
  });
}

test("fix 3: comms send without an id is refused and stores no message", async () => {
  await withRig(async rig => {
    const a = await (await rig.peer()).register(registration("pi"));
    const b = await (await rig.peer()).register(registration("codex"));
    const result = await cli(rig, "send", { token: a.token, to: `comms:${b.agent.name}`, body: "No sender ID" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/id/i);
    expect(rig.rows()).toEqual([]);
    expect(result.stdout).not.toContain('"id"');
  });
});

test("fix 3: retrying comms send with an explicit id returns the same receipt and stores once", async () => {
  await withRig(async rig => {
    const a = await (await rig.peer()).register(registration("pi"));
    const b = await (await rig.peer()).register(registration("codex"));
    const params = { token: a.token, id: uuid(), to: `comms:${b.agent.name}`, body: "Retry this exact send" };
    for (const _ of [1, 2]) {
      const result = await cli(rig, "send", params);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).id).toBe(params.id);
    }
    expect(rig.rows()).toHaveLength(1);
    expect(rig.rows()[0]).toMatchObject({ id: params.id, body: params.body, sender: a.agent.id, recipient: b.agent.id });
  });
});
