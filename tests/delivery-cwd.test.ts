import { expect, test } from "bun:test";
import type { Harness } from "@cross-harness-comms/protocol";
import { eventually, uuid } from "./support/helpers.ts";
import { registration, withRig } from "./support/rig.ts";

// ADR-017: a delivery carries the sender's working directory from its agent record, additive under ADR-005.

test("the core includes the sender's cwd in live deliveries in both directions", async () => {
  await withRig(async rig => {
    const api = await rig.peer(), web = await rig.peer();
    const a = await api.register(registration("codex", uuid(), "/Users/ed/src/api"));
    const b = await web.register(registration("pi", uuid(), "/Users/ed/src/web"));
    const first = uuid();
    await api.request("send", { token: a.token, id: first, to: `comms:${b.agent.name}`, body: "From api" });
    expect(await web.deliveries.next()).toMatchObject({
      message: { id: first, sender: a.agent.id, body: "From api" },
      from: `comms:${a.agent.name}`, harness: "codex", cwd: "/Users/ed/src/api",
    });
    await web.request("send", { token: b.token, id: uuid(), to: `comms:${a.agent.name}`, body: "From web", reply_to: first });
    expect(await api.deliveries.next()).toMatchObject({ from: `comms:${b.agent.name}`, harness: "pi", cwd: "/Users/ed/src/web" });
  });
});

test("the core includes the sender's cwd when a queued message is delivered on reconnect", async () => {
  await withRig(async rig => {
    const sender = await rig.peer(), receiver = await rig.peer();
    const native = registration("pi", uuid(), "/Users/ed/src/web");
    const a = await sender.register(registration("claude", uuid(), "/Users/ed/src/api"));
    const b = await receiver.register(native);
    receiver.close();
    await eventually(() => rig.agents(), list => expect(list.find(x => x.id === b.agent.id)?.online).toBe(false));
    const id = uuid();
    await sender.request("send", { token: a.token, id, to: `comms:${b.agent.name}`, body: "Queued" });
    const resumed = await rig.peer();
    await resumed.register(native, undefined, b.token);
    expect(await resumed.deliveries.next()).toMatchObject({ message: { id }, harness: "claude", cwd: "/Users/ed/src/api" });
  });
});

for (const harness of ["pi", "claude", "codex"] as Harness[]) {
  test(`the core includes the cwd of a ${harness} sender registered through its adapter`, async () => {
    await withRig(async rig => {
      const target = await rig.peer();
      const b = await target.register(registration("pi", uuid(), "/Users/ed/src/web"));
      const sender = await rig.harness(harness, uuid(), "/Users/ed/src/api");
      await sender.send(`comms:${b.agent.name}`, "Where am I?");
      expect(await target.deliveries.next()).toMatchObject({ from: `comms:${sender.agent.name}`, harness, cwd: "/Users/ed/src/api" });
    });
  });
}
