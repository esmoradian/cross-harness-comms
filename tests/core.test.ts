import { expect, test } from "bun:test";
import { resolveAddress, type Agent } from "@cross-harness-comms/protocol";
import { eventually, uuid, uuidV7 } from "./helpers.ts";
import { registration, withRig } from "./rig.ts";

test("invariant 1: resume after core restart retains identity, name, and queued mail", async () => {
  await withRig(async rig => {
    const sender = await rig.peer(), receiver = await rig.peer();
    const native = registration("pi");
    const a = await sender.register(registration("codex"));
    const b = await receiver.register(native);
    expect(b.agent.id).toMatch(uuidV7);
    receiver.close();
    await eventually(() => rig.agents(), list => expect(list.find(x => x.id === b.agent.id)?.online).toBe(false));
    const id = uuid();
    await sender.request("send", { token: a.token, id, to: `comms:${b.agent.name}`, body: "Queued across restart" });
    await rig.restart();
    const resumed = await rig.peer();
    const again = await resumed.register({ ...native, cwd: "/projects/moved", host: "renamed-host" });
    expect(again.agent.id).toBe(b.agent.id);
    expect(again.agent.name).toBe(b.agent.name);
    expect((await resumed.deliveries.next()).message.id).toBe(id);
    expect(rig.rows()).toHaveLength(1);
    const fork = await (await rig.peer()).register({ ...native, session_key: uuid() });
    const otherHarness = await (await rig.peer()).register({ ...native, harness: "claude" });
    expect(new Set([again.agent.id, fork.agent.id, otherHarness.agent.id]).size).toBe(3);
  });
});

test("invariant 3: name and UUID address reach only the intended peer; unknown recipients store nothing", async () => {
  await withRig(async rig => {
    const sender = await rig.peer(), target = await rig.peer(), bystander = await rig.peer();
    const a = await sender.register(registration("pi"));
    const b = await target.register(registration("codex"));
    const c = await bystander.register(registration("codex"));
    expect(b.agent.name).not.toBe(c.agent.name);
    for (const to of [`comms:${b.agent.name}`, `comms:${b.agent.id}`]) {
      const id = uuid();
      await sender.request("send", { token: a.token, id, to, body: to });
      expect((await target.deliveries.next()).message).toMatchObject({ id, recipient: b.agent.id });
    }
    await expect(sender.request("send", { token: a.token, id: uuid(), to: "comms:never-registered", body: "must fail" }))
      .rejects.toMatchObject({ data: { code: "UNKNOWN_RECIPIENT" } });
    expect(rig.rows()).toHaveLength(2);
    expect(rig.rows().every(row => row.recipient === b.agent.id)).toBe(true);
    await bystander.request("list", {});
    expect(bystander.deliveries.values).toEqual([]);
  });
});

const addressAgents: Agent[] = [
  { id: "019f1234-0000-7000-8000-000000000001", name: "pi-shared", harness: "pi", session_key: "a", host: "h", cwd: "/p", last_seen: "2026-10-17T00:00:00Z", online: true },
  { id: "019f1234-0000-7000-8000-000000000002", name: "pi-shared-2", harness: "pi", session_key: "b", host: "h", cwd: "/p", last_seen: "2026-10-17T00:00:00Z", online: false },
];
test("invariant 3: ambiguous UUID prefix fails instead of selecting the first match", () => {
  // A successful lookup first ensures the placeholder fails openly, not inside an expected rejection.
  expect(resolveAddress("comms:pi-shared", addressAgents).id).toBe(addressAgents[0]!.id);
  expect(() => resolveAddress("comms:019f1234", addressAgents)).toThrow("AMBIGUOUS_RECIPIENT");
  expect(resolveAddress(`comms:${addressAgents[1]!.id}`, addressAgents).id).toBe(addressAgents[1]!.id);
});

test("invariant 4: send confirmation follows a durable write and retries do not duplicate it", async () => {
  await withRig(async rig => {
    const sender = await rig.peer(), receiver = await rig.peer();
    const senderSession = registration("pi");
    let a = await sender.register(senderSession);
    const b = await receiver.register(registration("codex"));
    receiver.close();
    await eventually(() => rig.agents(), list => expect(list.find(x => x.id === b.agent.id)?.online).toBe(false));
    const request = { token: a.token, id: uuid(), to: `comms:${b.agent.name}`, body: "Durable before response" };
    expect(await sender.request("send", request)).toMatchObject({ id: request.id, state: "queued" });
    // A separate SQLite connection observes the commit immediately after the response.
    expect(rig.rows()).toMatchObject([{ id: request.id, sender: a.agent.id, recipient: b.agent.id, body: request.body, state: "queued" }]);
    await rig.restart();
    expect(rig.rows()).toHaveLength(1);
    const resumedSender = await rig.peer();
    a = await resumedSender.register(senderSession);
    await resumedSender.request("send", { ...request, token: a.token });
    expect(rig.rows()).toHaveLength(1);
  });
});

test("invariant 5: an offline mailbox drains in stored order for one sender and receiver", async () => {
  await withRig(async rig => {
    const sender = await rig.peer(), receiver = await rig.peer();
    const a = await sender.register(registration("pi"));
    const native = registration("codex");
    const b = await receiver.register(native);
    receiver.close();
    await eventually(() => rig.agents(), list => expect(list.find(x => x.id === b.agent.id)?.online).toBe(false));
    const ids = [uuid(), uuid(), uuid()];
    for (const [index, id] of ids.entries()) await sender.request("send", { token: a.token, id, to: `comms:${b.agent.name}`, body: `item ${index}` });
    expect(rig.rows().map(row => row.id)).toEqual(ids);
    const resumed = await rig.peer();
    await resumed.register(native);
    const delivered = [];
    for (const _ of ids) delivered.push((await resumed.deliveries.next()).message.id);
    expect(delivered).toEqual(ids);
  });
});

test("invariant 6: reconnect redelivers unacked mail and never redelivers acked mail", async () => {
  await withRig(async rig => {
    const sender = await rig.peer(), receiver = await rig.peer();
    const a = await sender.register(registration("pi"));
    const native = registration("codex");
    const b = await receiver.register(native);
    const id = uuid();
    await sender.request("send", { token: a.token, id, to: `comms:${b.agent.name}`, body: "Deliver twice until acknowledged" });
    expect((await receiver.deliveries.next()).message.id).toBe(id);
    await rig.state(id, "delivered");
    receiver.close();
    await eventually(() => rig.agents(), list => expect(list.find(x => x.id === b.agent.id)?.online).toBe(false));
    const second = await rig.peer();
    const hello = await second.register(native);
    expect((await second.deliveries.next()).message.id).toBe(id);
    await second.request("ack", { token: hello.token, id });
    await rig.state(id, "acked");
    second.close();
    await eventually(() => rig.agents(), list => expect(list.find(x => x.id === b.agent.id)?.online).toBe(false));
    const third = await rig.peer();
    await third.register(native);
    const marker = uuid();
    await sender.request("send", { token: a.token, id: marker, to: `comms:${b.agent.name}`, body: "Mailbox drain barrier" });
    expect((await third.deliveries.next()).message.id).toBe(marker);
    expect(third.received.filter(p => "method" in p && p.method === "deliver")).toHaveLength(1);
    expect(rig.rows().filter(row => row.id === id)).toHaveLength(1);
  });
});

for (const token of [undefined, "invalid-session-token"]) {
  test(`invariant 8: ${token === undefined ? "missing" : "invalid"} token cannot send or acknowledge`, async () => {
    await withRig(async rig => {
      const sender = await rig.peer(), receiver = await rig.peer();
      const a = await sender.register(registration("pi"));
      const b = await receiver.register(registration("codex"));
      const credentials = token === undefined ? {} : { token };
      await expect(sender.raw("send", { ...credentials, id: uuid(), to: `comms:${b.agent.name}`, body: "forged" }))
        .rejects.toMatchObject({ data: { code: "INVALID_TOKEN" } });
      expect(rig.rows()).toEqual([]);
      const id = uuid();
      await sender.request("send", { token: a.token, id, to: `comms:${b.agent.name}`, body: "legitimate" });
      await receiver.deliveries.next();
      await expect(receiver.raw("ack", { ...credentials, id })).rejects.toMatchObject({ data: { code: "INVALID_TOKEN" } });
      expect(rig.rows()[0]!.state).not.toBe("acked");
    });
  });
}

test("invariant 8: a valid token binds the sender and cannot acknowledge someone else's mail", async () => {
  await withRig(async rig => {
    const sender = await rig.peer(), receiver = await rig.peer();
    const a = await sender.register(registration("pi"));
    const b = await receiver.register(registration("codex"));
    const id = uuid();
    // Unknown additive sender/session fields cannot override authenticated identity.
    await sender.raw("send", { token: a.token, id, to: `comms:${b.agent.name}`, body: "bound to token", sender: b.agent.id, session_key: b.agent.session_key });
    expect((await receiver.deliveries.next()).message.sender).toBe(a.agent.id);
    await expect(sender.request("ack", { token: a.token, id })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    expect(rig.rows()[0]!.state).not.toBe("acked");
    await receiver.request("ack", { token: b.token, id });
    expect(rig.rows()[0]!.state).toBe("acked");
  });
});
