import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { MAX_LINE_BYTES, VERSION_RANGE } from "@cross-harness-comms/protocol";
import { eventually, uuid } from "./support/helpers.ts";
import { cli, registration, withRig } from "./support/rig.ts";
import { claudeAddress, claudeLine, connectable, deliveries, inboxLine, listWithToken, nativePeer, post, REPLY_SOCKET, socketPath } from "./support/claude.ts";

// These drive the core over its wire protocol, with real Unix sockets for Claude's inbox and the
// core's reply sockets. The Claude session here is a protocol peer whose inbox runs no hooks,
// so each native ACK is explicit.

test("native core: native_ack needs the session's token and the in-flight message's reply socket", async () => {
  await withRig(async rig => {
    const claude = await nativePeer(rig);
    const sender = await rig.peer();
    const pi = await sender.register(registration("pi"));
    const id = uuid();
    await sender.request("send", { token: pi.token, id, to: `comms:${claude.agent.name}`, body: "Native hello" });
    const line = await inboxLine(claude.inbox!, 0);
    expect(line).toMatchObject({ msgV: 1, msg_id: id, type: "user", from_plugin: "cross-harness-comms" });
    await rig.state(id, "delivered");
    await eventually(() => claude.inbox!.connections, connections => expect(connections[0]?.ended).toBe(true));
    expect(deliveries(claude.peer)).toEqual([]);

    const one = await rig.peer();
    await one.request("hello", { versions: VERSION_RANGE });
    await expect(one.request("native_ack", { token: claude.token, from: `uds:${dirname(claude.path)}/9000000000.sock` })).rejects.toThrow();
    await expect(one.request("native_ack", { token: pi.token, from: line.from })).rejects.toThrow();
    await expect(one.request("native_ack", { token: "not-a-token", from: line.from })).rejects.toThrow();
    expect(rig.rows().find(row => row.id === id)?.state).toBe("delivered");

    const ack = await cli(rig, "native-ack", { token: claude.token, from: line.from });
    expect(ack.exitCode).toBe(0);
    expect(JSON.parse(ack.stdout)).toEqual({ id });
    expect(ack.stdout).not.toContain(claude.token);
    await rig.state(id, "acked");
  });
});

test("native core: at most one native message is unacknowledged per session, written in order after each ACK", async () => {
  await withRig(async rig => {
    const claude = await nativePeer(rig);
    const sender = await rig.peer();
    const codex = await sender.register(registration("codex"));
    const ids = [uuid(), uuid(), uuid()];
    for (const [index, id] of ids.entries())
      await sender.request("send", { token: codex.token, id, to: `comms:${claude.agent.name}`, body: `Message ${index}` });
    for (const [index, id] of ids.entries()) {
      const line = await inboxLine(claude.inbox!, index);
      expect(line.msg_id).toBe(id);
      // The core marks a message delivered before writing its line, so a line written early shows here at once.
      for (const later of ids.slice(index + 1)) expect(rig.rows().find(row => row.id === later)?.state).toBe("queued");
      const ack = await cli(rig, "native-ack", { token: claude.token, from: line.from });
      expect(JSON.parse(ack.stdout)).toEqual({ id });
      await rig.state(id, "acked");
    }
    // A last message's line is written after every earlier one, so any extra line arrives before it.
    const last = uuid();
    await sender.request("send", { token: codex.token, id: last, to: `comms:${claude.agent.name}`, body: "Last" });
    await inboxLine(claude.inbox!, ids.length);
    expect(claude.inbox!.lines.map(line => JSON.parse(line).msg_id)).toEqual([...ids, last]);
    expect(deliveries(claude.peer)).toEqual([]);
  });
});

test("native core: a late native_ack after the comms fallback still acknowledges the message", async () => {
  await withRig(async rig => {
    const claude = await nativePeer(rig);
    const sender = await rig.peer();
    const pi = await sender.register(registration("pi"));
    const id = uuid();
    await sender.request("send", { token: pi.token, id, to: `comms:${claude.agent.name}`, body: "Arrives twice" });
    const line = await inboxLine(claude.inbox!, 0);
    const fallback = await eventually(() => deliveries(claude.peer), list => expect(list).toHaveLength(1));
    expect(fallback[0]!.message).toMatchObject({ id, body: "Arrives twice" });
    expect(rig.rows().find(row => row.id === id)?.state).toBe("delivered");
    const ack = await cli(rig, "native-ack", { token: claude.token, from: line.from });
    expect(ack.exitCode).toBe(0);
    expect(JSON.parse(ack.stdout)).toEqual({ id });
    await rig.state(id, "acked");
  }, undefined, { nativeAckMs: 30 });
});

test("native core: a new attachment turns the native route back on after an ACK timeout disabled it", async () => {
  await withRig(async rig => {
    const claude = await nativePeer(rig);
    const sender = await rig.peer();
    const codex = await sender.register(registration("codex"));
    const send = (body: string) => sender.request("send", { token: codex.token, id: uuid(), to: `comms:${claude.agent.name}`, body });
    await send("Times out");
    await inboxLine(claude.inbox!, 0);
    await eventually(() => deliveries(claude.peer), list => expect(list).toHaveLength(1));
    expect((await listWithToken(rig, claude.token)).some(agent => agent.claude_address)).toBe(false);
    await send("Disabled route");
    const fallback = await eventually(() => deliveries(claude.peer), list => expect(list).toHaveLength(2));
    expect(claude.inbox!.lines).toHaveLength(1);
    // The comms path acknowledges both, so nothing is pending when the session reattaches.
    for (const delivery of fallback) await claude.peer.request("ack", { token: claude.token, id: delivery.message.id });

    claude.peer.close();
    await eventually(() => rig.agents(), agents => expect(agents.find(a => a.id === claude.agent.id)?.online).toBe(false));
    const again = await nativePeer(rig, { session: claude.session, token: claude.token, inbox: claude.path, listen: false });
    expect(again.agent.id).toBe(claude.agent.id);
    const id = uuid();
    await sender.request("send", { token: codex.token, id, to: `comms:${claude.agent.name}`, body: "Native again" });
    expect((await inboxLine(claude.inbox!, 1)).msg_id).toBe(id);
  }, undefined, { nativeAckMs: 30 });
});

test("native core: list gives non-Claude agents a claude_address only for a Claude caller on the native route", async () => {
  await withRig(async rig => {
    const codexPeer = await rig.peer();
    const codex = await codexPeer.register(registration("codex"));
    const claude = await nativePeer(rig);
    // Created while a native session is attached.
    const piPeer = await rig.peer();
    const pi = await piPeer.register(registration("pi"));
    const plain = await (await rig.peer()).register(registration("claude"));
    const old = await nativePeer(rig, { version: "2.1.288" });

    const agents = await listWithToken(rig, claude.token);
    const addresses = [codex.agent.id, pi.agent.id].map(id => agents.find(a => a.id === id)?.claude_address ?? "");
    for (const address of addresses) {
      const path = socketPath(address);
      expect(dirname(path)).toBe(dirname(claude.path));
      expect(basename(path)).toMatch(REPLY_SOCKET);
      expect(Buffer.byteLength(path)).toBeLessThan(104);
      expect(await connectable(path)).toBe(true);
    }
    expect(addresses[0]).not.toBe(addresses[1]);
    for (const id of [claude.agent.id, plain.agent.id, old.agent.id]) expect(agents.find(a => a.id === id)).not.toHaveProperty("claude_address");

    for (const token of [plain.token, old.token, codex.token])
      expect((await listWithToken(rig, token)).some(agent => "claude_address" in agent)).toBe(false);
    expect((await rig.agents()).some(agent => "claude_address" in agent)).toBe(false);
  });
});

test("native core: reply sockets are derived from the agent, survive a restart, replace stale files, and close with the core", async () => {
  await withRig(async rig => {
    const codexSession = registration("codex");
    let codexPeer = await rig.peer();
    const codex = await codexPeer.register(codexSession);
    const claude = await nativePeer(rig);
    const before = await claudeAddress(rig, claude.token, codex.agent.id);
    const path = socketPath(before);
    await rig.restart(async () => {
      await eventually(() => connectable(path), open => expect(open).toBe(false));
      // A socket file the old core left behind is stale already; otherwise leave a regular file.
      if (!existsSync(path)) writeFileSync(path, "stale");
    });
    codexPeer = await rig.peer();
    await codexPeer.register(codexSession, VERSION_RANGE, codex.token);
    const again = await nativePeer(rig, { session: claude.session, token: claude.token, inbox: claude.path, listen: false });
    expect(again.agent.id).toBe(claude.agent.id);
    expect(await claudeAddress(rig, claude.token, codex.agent.id)).toBe(before);
    await eventually(() => connectable(path), open => expect(open).toBe(true));
    const msg_id = randomUUID();
    await post(path, claudeLine({ from: `uds:${claude.path}`, body: "After restart", msg_id }));
    const received = await eventually(() => deliveries(codexPeer), list => expect(list).toHaveLength(1));
    expect(received[0]!.message).toMatchObject({ id: msg_id, sender: claude.agent.id, recipient: codex.agent.id, body: "After restart" });
  });
});

test("native core: reply socket lines from unknown senders, repeated IDs, or over 1 MB are dropped", async () => {
  await withRig(async rig => {
    const codexPeer = await rig.peer();
    const codex = await codexPeer.register(registration("codex"));
    const claude = await nativePeer(rig);
    const path = socketPath(await claudeAddress(rig, claude.token, codex.agent.id));
    const from = `uds:${claude.path}`;

    await post(path, claudeLine({ from: `uds:${rig.inboxPath()}`, body: "Nobody attached sent this" }));
    await post(path, claudeLine({ from, body: "x".repeat(MAX_LINE_BYTES + 1) }));
    await post(path, "not a peer-message line");
    const first = randomUUID();
    await post(path, claudeLine({ from, body: "Once", msg_id: first }));
    await eventually(() => deliveries(codexPeer), list => expect(list).toHaveLength(1));
    await post(path, claudeLine({ from, body: "Once", msg_id: first }));
    const last = randomUUID();
    await post(path, claudeLine({ from, body: "Last", msg_id: last }));
    // Each line is handled before the next is posted, so a delivery of any dropped line would arrive before Last's.
    await eventually(() => deliveries(codexPeer), list => expect(list.at(-1)?.message.id).toBe(last));
    expect(deliveries(codexPeer).map(d => d.message.id)).toEqual([first, last]);
    expect(rig.rows().map(row => ({ id: row.id, sender: row.sender, recipient: row.recipient, body: row.body }))).toEqual([
      { id: first, sender: claude.agent.id, recipient: codex.agent.id, body: "Once" },
      { id: last, sender: claude.agent.id, recipient: codex.agent.id, body: "Last" },
    ]);
  });
});

test("native core: an unsupported msgV still delivers and turns the native route off for that session", async () => {
  await withRig(async rig => {
    const codexPeer = await rig.peer();
    const codex = await codexPeer.register(registration("codex"));
    const claude = await nativePeer(rig);
    const path = socketPath(await claudeAddress(rig, claude.token, codex.agent.id));
    const msg_id = randomUUID();
    await post(path, claudeLine({ from: `uds:${claude.path}`, body: "From a newer Claude", msg_id, msgV: 2 }));
    const received = await eventually(() => deliveries(codexPeer), list => expect(list).toHaveLength(1));
    expect(received[0]!.message).toMatchObject({ id: msg_id, sender: claude.agent.id, body: "From a newer Claude" });
    const id = uuid();
    await codexPeer.request("send", { token: codex.token, id, to: `comms:${claude.agent.name}`, body: "Back on comms" });
    const fallback = await eventually(() => deliveries(claude.peer), list => expect(list).toHaveLength(1));
    expect(fallback[0]!.message.id).toBe(id);
    expect(claude.inbox!.lines).toEqual([]);
  });
});

test("native core: the route needs a Claude version of at least 2.1.289 by numeric comparison", async () => {
  await withRig(async rig => {
    const sender = await rig.peer();
    const pi = await sender.register(registration("pi"));
    for (const [version, native] of [["2.1.289", true], ["2.1.1000", true], ["2.10.0", true], ["3.0.0", true],
      ["2.1.288", false], ["2.0.999", false], ["1.99.300", false]] as const) {
      const claude = await nativePeer(rig, { version });
      const id = uuid();
      await sender.request("send", { token: pi.token, id, to: `comms:${claude.agent.name}`, body: version });
      if (native) {
        expect({ version, line: (await inboxLine(claude.inbox!, 0)).msg_id }).toEqual({ version, line: id });
        expect(deliveries(claude.peer)).toEqual([]);
      } else {
        await eventually(() => deliveries(claude.peer), list => expect(list.map(d => d.message.id)).toEqual([id]));
        expect({ version, lines: claude.inbox!.lines }).toEqual({ version, lines: [] });
      }
    }
  });
});

test("native core: a Claude sender's comms message to a native Claude session uses the deliver packet", async () => {
  await withRig(async rig => {
    const claude = await nativePeer(rig);
    const codexPeer = await rig.peer();
    const codex = await codexPeer.register(registration("codex"));
    const viaInbox = uuid();
    await codexPeer.request("send", { token: codex.token, id: viaInbox, to: `comms:${claude.agent.name}`, body: "Native" });
    expect((await inboxLine(claude.inbox!, 0)).msg_id).toBe(viaInbox);
    const other = await rig.peer();
    const sender = await other.register(registration("claude"));
    const id = uuid();
    await other.request("send", { token: sender.token, id, to: `comms:${claude.agent.name}`, body: "Claude to Claude through comms" });
    await eventually(() => deliveries(claude.peer), list => expect(list.map(d => d.message.id)).toEqual([id]));
    expect(claude.inbox!.lines).toHaveLength(1);
  });
});

test("native core: a native ACK or fallback never resends a message already handed over as a deliver packet", async () => {
  await withRig(async rig => {
    const claude = await nativePeer(rig);
    const codexPeer = await rig.peer();
    const codex = await codexPeer.register(registration("codex"));
    const other = await rig.peer();
    const sender = await other.register(registration("claude"));
    const sendCodex = async (body: string) => {
      const id = uuid();
      await codexPeer.request("send", { token: codex.token, id, to: `comms:${claude.agent.name}`, body });
      return id;
    };
    const first = await sendCodex("Native first");
    const line = await inboxLine(claude.inbox!, 0);
    // Delivered as a packet and not yet acknowledged by the comms path.
    const id = uuid();
    await other.request("send", { token: sender.token, id, to: `comms:${claude.agent.name}`, body: "Claude to Claude through comms" });
    await eventually(() => deliveries(claude.peer), list => expect(list.map(d => d.message.id)).toEqual([id]));
    const second = await sendCodex("Native second");

    const ack = await cli(rig, "native-ack", { token: claude.token, from: line.from });
    expect(JSON.parse(ack.stdout)).toEqual({ id: first });
    await inboxLine(claude.inbox!, 1);

    // The second line is never acknowledged, so the fallback resends it, and only it. A message sent after
    // the fallback arrives as a packet after everything the ACK or the fallback could resend.
    await eventually(() => deliveries(claude.peer), list => expect(list.map(d => d.message.id)).toContain(second));
    const third = await sendCodex("After the fallback");
    const all = await eventually(() => deliveries(claude.peer), list => expect(list.map(d => d.message.id)).toContain(third));
    expect(all.map(d => d.message.id)).toEqual([id, second, third]);
  }, undefined, { nativeAckMs: 200 });
});
