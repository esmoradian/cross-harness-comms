import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Harness } from "@cross-harness-comms/protocol";
import { eventually, uuid } from "./helpers.ts";
import { registration, withRig } from "./rig.ts";
import { helloRequests, shellAttach } from "./fixes-support.ts";
import { FakeClaude } from "./fakes/claude.ts";

for (const token of [undefined, "wrong-token"]) {
  test(`fix 1: shell attach with ${token === undefined ? "no token" : "a wrong token"} cannot take over a responsive live session`, async () => {
    await withRig(async rig => {
      const owner = await rig.peer(), sender = await rig.peer();
      const native = registration("pi");
      const a = await owner.register(native), b = await sender.register(registration("codex"));
      const shell = shellAttach(rig, native, token);
      try {
        const response = await shell.response;
        expect(response).not.toHaveProperty("result");
        if ("exitCode" in response) expect(response.exitCode).not.toBe(0);
        else expect(response).toHaveProperty("error");
        expect(owner.received.some(p => "method" in p && p.method === "ping")).toBe(true);
        const id = uuid();
        await sender.request("send", { token: b.token, id, to: `comms:${a.agent.name}`, body: "Owner still receives" });
        expect((await owner.deliveries.next()).message.id).toBe(id);
        await owner.request("ack", { token: a.token, id });
        expect(rig.rows()[0]!.state).toBe("acked");
      } finally { await shell.close(); }
    }, undefined, { pingTimeoutMs: 100 });
  });
}

test("fix 1: the current token replaces a live connection without rotating credentials", async () => {
  await withRig(async rig => {
    const old = await rig.peer(), replacement = await rig.peer(), sender = await rig.peer();
    const native = registration("pi");
    const a = await old.register(native), b = await sender.register(registration("codex"));
    const resumed = await replacement.register(native, { min: 1, max: 1 }, a.token);
    expect(resumed.agent.id).toBe(a.agent.id);
    expect(resumed.token).toBe(a.token);
    const id = uuid();
    await sender.request("send", { token: b.token, id, to: `comms:${a.agent.name}`, body: "Replacement receives" });
    expect((await replacement.deliveries.next()).message.id).toBe(id);
    expect(old.deliveries.values).toEqual([]);
    await replacement.request("ack", { token: a.token, id });
    expect(rig.rows()[0]!.state).toBe("acked");
  });
});

test("fix 1: reconnect after core restart preserves the token and unacknowledged mailbox", async () => {
  await withRig(async rig => {
    const owner = await rig.peer(), sender = await rig.peer();
    const native = registration("pi");
    const a = await owner.register(native), b = await sender.register(registration("codex"));
    const id = uuid();
    await sender.request("send", { token: b.token, id, to: `comms:${a.agent.name}`, body: "Across restart" });
    await owner.deliveries.next();
    await rig.restart();
    const replacement = await rig.peer();
    const hello = await replacement.register(native, { min: 1, max: 1 }, a.token);
    expect(hello.token).toBe(a.token);
    expect(hello.agent.id).toBe(a.agent.id);
    expect((await replacement.deliveries.next()).message.id).toBe(id);
    await replacement.request("ack", { token: a.token, id });
    expect(rig.rows()[0]!.state).toBe("acked");
  });
});

test("fix 1: SQLite persists a token hash and never the plaintext token", async () => {
  await withRig(async rig => {
    const a = await (await rig.peer()).register(registration("pi"));
    const db = new Database(rig.databasePath, { readonly: true });
    try {
      const row = db.query("SELECT * FROM agents WHERE id = ?").get(a.agent.id) as Record<string, unknown>;
      expect(row.token_hash).toBeString();
      expect((row.token_hash as string).length).toBeGreaterThan(0);
      expect(row.token_hash).not.toBe(a.token);
    } finally { db.close(); }
    // Covers both the main database and the WAL where the current commit may live.
    for (const file of readdirSync(rig.directory)) expect(readFileSync(join(rig.directory, file)).includes(Buffer.from(a.token))).toBe(false);
  });
});

for (const credential of [undefined, "stale-token"]) {
  test(`fix 1: offline hello with ${credential === undefined ? "no token" : "a wrong token"} rotates credentials and invalidates the old token`, async () => {
    await withRig(async rig => {
      const old = await rig.peer(), sender = await rig.peer();
      const native = registration("pi");
      const a = await old.register(native), b = await sender.register(registration("codex"));
      old.close();
      await eventually(() => rig.agents(), list => expect(list.find(x => x.id === a.agent.id)?.online).toBe(false));
      const id = uuid();
      await sender.request("send", { token: b.token, id, to: `comms:${a.agent.name}`, body: "Offline mail" });
      const replacement = await rig.peer();
      const hello = await replacement.register(native, { min: 1, max: 1 }, credential);
      expect(hello.agent.id).toBe(a.agent.id);
      expect(hello.token).not.toBe(a.token);
      expect((await replacement.deliveries.next()).message.id).toBe(id);
      await expect(sender.request("send", { token: a.token, id: uuid(), to: `comms:${b.agent.name}`, body: "Old credential" }))
        .rejects.toMatchObject({ data: { code: "INVALID_TOKEN" } });
      await expect(sender.request("ack", { token: a.token, id })).rejects.toMatchObject({ data: { code: "INVALID_TOKEN" } });
      await replacement.request("ack", { token: hello.token, id });
      expect(rig.rows()).toHaveLength(1);
      expect(rig.rows()[0]!.state).toBe("acked");
    });
  });
}

test("fix 1: an unresponsive connection is pinged and reclaimed after the injected timeout", async () => {
  await withRig(async rig => {
    const stale = await rig.peer(), sender = await rig.peer();
    stale.answerPings = false;
    const native = registration("pi");
    const a = await stale.register(native), b = await sender.register(registration("codex"));
    const replacement = await rig.peer();
    const hello = await replacement.register(native);
    expect(stale.received.some(p => "method" in p && p.method === "ping" && p.id !== undefined)).toBe(true);
    expect(hello.agent.id).toBe(a.agent.id);
    expect(hello.token).not.toBe(a.token);
    const id = uuid();
    await sender.request("send", { token: b.token, id, to: `comms:${a.agent.name}`, body: "Recovered" });
    expect((await replacement.deliveries.next()).message.id).toBe(id);
    await expect(sender.request("ack", { token: a.token, id })).rejects.toMatchObject({ data: { code: "INVALID_TOKEN" } });
    await replacement.request("ack", { token: hello.token, id });
  }, undefined, { pingTimeoutMs: 0 });
}, 1000);

// Codex holds no session connection (ADR-014); see codex.test.ts.
for (const harness of ["pi", "claude"] as Harness[]) {
  test(`fix 1: ${harness} answers liveness pings so a live adapter cannot be displaced`, async () => {
    await withRig(async rig => {
      const owner = await rig.harness(harness), sender = await rig.harness("pi");
      const intruder = await rig.peer();
      await expect(intruder.request("hello", { versions: { min: 1, max: 1 }, session: registration(harness, owner.sessionId) })).rejects.toBeDefined();
      const count = owner.incoming().length;
      await sender.send(`comms:${owner.agent.name}`, "Still owned by the live adapter");
      await eventually(owner.incoming, messages => expect(messages).toHaveLength(count + 1));
      await rig.state(rig.rows()[0]!.id, "acked");
      const hello = helloRequests(rig, harness, owner.sessionId)[0]!;
      expect(rig.traffic.some(e => e.connection === hello.connection && e.direction === "from-core" && "method" in e.packet && e.packet.method === "ping")).toBe(true);
    }, undefined, { pingTimeoutMs: 100 });
  });

  test(`fix 1: ${harness} presents its held token when its transport reconnects`, async () => {
    await withRig(async rig => {
      const owner = await rig.harness(harness);
      const first = helloRequests(rig, harness, owner.sessionId)[0]!;
      const hello = rig.traffic.find(e => e.connection === first.connection && e.direction === "from-core" && "result" in e.packet)!;
      const token = (hello.packet as { result: { token: string } }).result.token;
      const link = rig.links[first.connection]!;
      link.client.destroy(); link.server.destroy();
      const requests = await eventually(() => {
        if (owner.fake instanceof FakeClaude) owner.fake.runScheduled();
        return helloRequests(rig, harness, owner.sessionId);
      }, entries => expect(entries.length).toBeGreaterThanOrEqual(2));
      expect((requests[1]!.packet as { params: { token?: string } }).params.token).toBe(token);
      await eventually(() => rig.agents(), agents => expect(agents.find(a => a.id === owner.agent.id)?.online).toBe(true));
      const sender = await rig.harness("pi");
      await sender.send(`comms:${owner.agent.name}`, "After reconnect");
      await eventually(owner.incoming, messages => expect(messages).toHaveLength(1));
      await rig.state(rig.rows()[0]!.id, "acked");
    });
  });
}
