import { expect, test } from "bun:test";
import type { VersionPolicy } from "@cross-harness-comms/protocol";
import { registration, withRig } from "./support/rig.ts";
import { uuid } from "./support/helpers.ts";

// Artificial versions, not a proposed release schema. The latest fixture shape is the canonical schema.
// Older fixture clients use legacy_text for bodies, legacy_id for receipt IDs, and label for names.
const policy: VersionPolicy = {
  latest: 101,
  versions: {
    99: { status: "removed" },
    100: { status: "deprecated", notice: "Fixture protocol 100 is deprecated; update your adapter." },
    101: { status: "supported" },
  },
  steps: [{ from: 100, to: 101,
    up(packet) {
      const p = structuredClone(packet);
      if ("method" in p && p.method === "send") {
        const params = p.params as Record<string, unknown>;
        params.body = params.legacy_text;
        delete params.legacy_text;
      }
      return p;
    },
    down(packet) {
      const p = structuredClone(packet);
      if ("method" in p && p.method === "deliver") {
        const message = (p.params as { message: Record<string, unknown> }).message;
        message.legacy_text = message.body;
        delete message.body;
      } else if ("result" in p && p.result && typeof p.result === "object") {
        const result = p.result as Record<string, unknown>;
        if (typeof result.id === "string") { result.legacy_id = result.id; delete result.id; }
        if (Array.isArray(result.agents)) result.agents = result.agents.map(({ name, ...agent }) => ({ ...agent, label: name }));
      }
      return p;
    },
  }],
};

test("invariant 11: newer core converts requests, responses, lists, and deliveries at each negotiated edge", async () => {
  await withRig(async rig => {
    const older = await rig.peer(), newer = await rig.peer();
    const a = await older.register(registration("pi"), { min: 100, max: 100 });
    const b = await newer.register(registration("codex"), { min: 100, max: 101 });
    expect(a.version).toBe(100);
    expect(a.notice).toBe(policy.versions[100]!.notice!);
    expect(b.version).toBe(101);
    const id = uuid();
    const receipt = await older.raw("send", { token: a.token, id, to: `comms:${b.agent.name}`, legacy_text: "Old client sends" });
    expect(receipt).toMatchObject({ legacy_id: id });
    expect(receipt).not.toHaveProperty("id");
    const inbound = await newer.deliveries.next();
    expect(inbound.message.body).toBe("Old client sends");
    expect(inbound.message).not.toHaveProperty("legacy_text");
    await newer.request("ack", { token: b.token, id });

    const replyId = uuid();
    const latestReceipt = await newer.request("send", { token: b.token, id: replyId, to: `comms:${a.agent.name}`, body: "New client replies", reply_to: id });
    expect(latestReceipt.id).toBe(replyId);
    const legacyDelivery = await older.deliveries.next();
    expect(legacyDelivery.message).toMatchObject({ id: replyId, legacy_text: "New client replies", reply_to: id });
    expect(legacyDelivery.message).not.toHaveProperty("body");
    const ack = await older.raw("ack", { token: a.token, id: replyId });
    expect(ack).toMatchObject({ legacy_id: replyId, state: "acked" });

    const olderList = await older.raw("list", {}) as { agents: Record<string, unknown>[] };
    expect(olderList.agents.find(agent => agent.id === b.agent.id)?.label).toBe(b.agent.name);
    expect(olderList.agents.every(agent => !("name" in agent))).toBe(true);
    const latestList = await newer.request("list", {});
    expect(latestList.agents.find(agent => agent.id === a.agent.id)?.name).toBe(a.agent.name);
    expect(rig.rows().map(row => row.body)).toEqual(["Old client sends", "New client replies"]);
    expect(rig.rows().every(row => !("legacy_text" in row))).toBe(true);
  }, policy);
});

for (const version of [99, 102]) {
  test(`invariant 11: no protocol overlap at version ${version} fails explicitly`, async () => {
    await withRig(async rig => {
      const peer = await rig.peer();
      await expect(peer.request("hello", { versions: { min: version, max: version }, session: registration("pi") }))
        .rejects.toMatchObject({ data: { code: "INCOMPATIBLE_PROTOCOL" }, message: expect.stringMatching(/updat/i) });
      expect(await rig.agents()).toEqual([]);
    }, policy);
  });
}

test("invariant 11: production v1 negotiates without synthetic conversion steps", async () => {
  await withRig(async rig => {
    const peer = await rig.peer();
    const hello = await peer.register(registration("pi"));
    expect(hello.version).toBe(1);
    expect(hello.notice).toBeUndefined();
    expect((await peer.request("list", {})).agents[0]?.id).toBe(hello.agent.id);
  });
});
