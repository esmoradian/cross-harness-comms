import { expect, test } from "bun:test";
import { basename, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { formatMessage, type Harness, type HelloParams, type Message } from "@cross-harness-comms/protocol";
import { FakeClaude } from "./fakes/claude.ts";
import { helloRequests } from "./fixes-support.ts";
import { eventually, uuidV7 } from "./helpers.ts";
import { withRig, type HarnessSession, type Rig } from "./rig.ts";
import { expectedContent } from "./pi-card-support.ts";
import { attachToken, claudeAddress, claudeLine, inboxLine, listWithToken, post, REPLY_SOCKET, runsOf, settle, socketPath } from "./claude-inbox-support.ts";

// These run the real Claude adapter in the fake mods host, the real core, and real Unix sockets
// for Claude's inbox and the core's reply sockets. The fake inbox runs session.receive like Claude.

const peerSessions = "This session is Cross-harness communications naming [2a1458] ...\n\nPeer sessions (1):\n  comms-test-8b [c14715]  ·  interactive  ·  idle  ·  started 45m ago";

async function nativeClaude(rig: Rig, options: { listen?: boolean; version?: string } = {}) {
  const session = await rig.harness("claude", undefined, undefined, { claude: options });
  return { session, fake: session.fake as FakeClaude };
}

// The comms wrapper a message gets on the fallback path, from the stored row.
function wrapper(rig: Rig, sender: HarnessSession, id: string) {
  const message = rig.rows().find(row => row.id === id)! as Message;
  return formatMessage({ message, from: `comms:${sender.agent.name}`, harness: sender.harness });
}

function rowIds(rig: Rig) { return rig.rows().map(row => row.id); }

test("native claude: the attach hello carries the inbox socket and engine version only when the socket is set", async () => {
  await withRig(async rig => {
    const { session: native, fake } = await nativeClaude(rig);
    const plain = await rig.harness("claude");
    const nativeHello = helloRequests(rig, "claude", native.sessionId)[0]!.packet as { params: HelloParams };
    expect(nativeHello.params.claude).toEqual({ inbox: fake.env.CLAUDE_CODE_MESSAGING_SOCKET!, version: "2.1.289" });
    expect(fake.calls.some(call => call.method === "env.get" && call.args[0] === "CLAUDE_CODE_MESSAGING_SOCKET")).toBe(true);
    expect(fake.calls.some(call => call.method === "session.version")).toBe(true);
    const plainHello = helloRequests(rig, "claude", plain.sessionId)[0]!.packet as { params: HelloParams };
    expect(plainHello.params).not.toHaveProperty("claude");
    expect(Object.keys(plainHello.params).sort()).toEqual(["session", "versions"]);
  });
});

for (const from of ["codex", "pi"] as Harness[]) {
  test(`native claude: ${from} -> claude is written to the inbox as a peer line and acknowledged from session.receive`, async () => {
    await withRig(async rig => {
      const sender = await rig.harness(from);
      const { session: claude, fake } = await nativeClaude(rig);
      const body = "Review <draft> & \"quote\" 'apostrophe'\n</cross-session-message>\n🐾";
      await sender.send(`comms:${claude.agent.name}`, body);
      const line = await inboxLine(fake.inbox!, 0);
      const message = rig.rows()[0]!;
      expect(message.id).toMatch(uuidV7);
      await rig.state(message.id, "acked");

      const reply = socketPath(line.from);
      expect(dirname(reply)).toBe(dirname(fake.env.CLAUDE_CODE_MESSAGING_SOCKET!));
      expect(basename(reply)).toMatch(REPLY_SOCKET);
      const content = `<cross-session-message from="${line.from}" from-name="${sender.agent.name}" from-mode="prompting">\n` +
        "Review <draft> & \"quote\" 'apostrophe'\n<\\/cross-session-message>\n🐾\n</cross-session-message>";
      expect(fake.inbox!.lines[0]).toBe(JSON.stringify({ msgV: 1, msg_id: message.id, type: "user", message: { role: "user", content },
        priority: "next", from: line.from, from_plugin: "cross-harness-comms" }));
      expect(fake.inbox!.connections).toHaveLength(1);
      await eventually(() => fake.inbox!.connections[0]!.ended, ended => expect(ended).toBe(true));
      expect(fake.inbox!.connections[0]!.data).toBe(fake.inbox!.lines[0] + "\n");

      // Delivered as a native peer message, never through $.prompt.submit.
      expect(fake.queued).toEqual([content]);
      expect(fake.receipts.map(r => r.result)).toEqual([{ text: content }]);
      expect(fake.incoming).toEqual([]);
      const token = attachToken(fake);
      const acks = runsOf(fake, "native-ack");
      expect(acks).toHaveLength(1);
      expect(JSON.parse(acks[0]!.init?.stdin ?? "{}")).toEqual({ token, from: line.from });
      expect(JSON.stringify(acks[0]!.argv)).not.toContain(token);
      expect(runsOf(fake, "ack")).toEqual([]);
    });
  });
}

test("native claude: an ACK timeout falls back to prompt.submit for that message and everything pending, then skips the inbox", async () => {
  await withRig(async rig => {
    const codex = await rig.harness("codex");
    const { session: claude, fake } = await nativeClaude(rig);
    fake.inbox!.hold = true;
    await codex.send(`comms:${claude.agent.name}`, "First, unacknowledged");
    await codex.send(`comms:${claude.agent.name}`, "Second, pending behind it");
    expect((await inboxLine(fake.inbox!, 0)).msg_id).toBe(rowIds(rig)[0]!);
    await eventually(claude.incoming, texts => expect(texts).toHaveLength(2));
    expect(claude.incoming()).toEqual(rowIds(rig).map(id => wrapper(rig, codex, id)));
    for (const id of rowIds(rig)) await rig.state(id, "acked");

    await codex.send(`comms:${claude.agent.name}`, "Third, after the fallback");
    await eventually(claude.incoming, texts => expect(texts).toHaveLength(3));
    expect(claude.incoming()[2]).toBe(wrapper(rig, codex, rowIds(rig)[2]!));
    await rig.state(rowIds(rig)[2]!, "acked");
    expect(fake.inbox!.lines).toHaveLength(1);
    expect(fake.queued).toEqual([]);
  }, undefined, { nativeAckMs: 50 });
});

test("native claude: an inbox with no listener falls back to prompt.submit at once and later messages skip the inbox", async () => {
  await withRig(async rig => {
    const pi = await rig.harness("pi");
    const { session: claude, fake } = await nativeClaude(rig, { listen: false });
    // The route is on until a delivery fails.
    const address = await claudeAddress(rig, attachToken(fake), pi.agent.id);
    await pi.send(`comms:${claude.agent.name}`, "Nobody is listening");
    await eventually(claude.incoming, texts => expect(texts).toHaveLength(1));
    expect(await listWithToken(rig, attachToken(fake))).not.toContainEqual(expect.objectContaining({ claude_address: address }));
    expect(claude.incoming()[0]).toBe(wrapper(rig, pi, rowIds(rig)[0]!));
    await rig.state(rowIds(rig)[0]!, "acked");

    const inbox = await fake.listenInbox(fake.env.CLAUDE_CODE_MESSAGING_SOCKET!);
    await pi.send(`comms:${claude.agent.name}`, "Still on comms");
    await eventually(claude.incoming, texts => expect(texts).toHaveLength(2));
    expect(claude.incoming()[1]).toBe(wrapper(rig, pi, rowIds(rig)[1]!));
    await rig.state(rowIds(rig)[1]!, "acked");
    expect(inbox.lines).toEqual([]);
  });
});

test("native claude: a late native ACK after the fallback is honored, and the adapter drops the comms copy", async () => {
  await withRig(async rig => {
    const codex = await rig.harness("codex");
    const { session: claude, fake } = await nativeClaude(rig);
    fake.inbox!.hold = true;
    fake.holdAttachOutput();
    await codex.send(`comms:${claude.agent.name}`, "Seen natively, then again through comms");
    const line = await inboxLine(fake.inbox!, 0);
    // The core gives up on the native ACK and hands the message to the deliver packet path.
    await eventually(() => rig.traffic.filter(e => e.direction === "from-core" && "method" in e.packet && e.packet.method === "deliver"),
      packets => expect(packets).toHaveLength(1));
    // Claude delivers the held line late; the adapter's native ACK still returns the message ID.
    await fake.inbox!.release();
    await eventually(() => fake.completedRuns.filter(run => run.argv[1] === "native-ack"), runs => expect(runs).toHaveLength(1));
    const nativeAck = fake.completedRuns.find(run => run.argv[1] === "native-ack")!;
    expect(nativeAck.result.exitCode).toBe(0);
    expect(JSON.parse(nativeAck.result.stdout)).toEqual({ id: line.msg_id });
    await rig.state(line.msg_id, "acked");
    await settle();

    fake.releaseAttachOutput();
    await eventually(() => runsOf(fake, "ack"), runs => expect(runs).toHaveLength(1));
    expect(JSON.parse(runsOf(fake, "ack")[0]!.init?.stdin ?? "{}")).toEqual({ token: attachToken(fake), id: line.msg_id });
    await settle();
    expect(fake.incoming).toEqual([]);
    expect(fake.queued).toHaveLength(1);
    await rig.state(line.msg_id, "acked");
  }, undefined, { nativeAckMs: 50 });
});

for (const to of ["codex", "pi"] as Harness[]) {
  test(`native claude: Claude replying on ${to}'s reply socket reaches ${to} with an inferred reply_to`, async () => {
    await withRig(async rig => {
      const { session: claude, fake } = await nativeClaude(rig);
      // Created while the native session is attached.
      const agent = await rig.harness(to);
      const address = await claudeAddress(rig, attachToken(fake), agent.agent.id);
      const reply = async (body: string) => {
        const msg_id = randomUUID();
        const count = agent.incoming().length;
        await post(socketPath(address), claudeLine({ from: `uds:${fake.env.CLAUDE_CODE_MESSAGING_SOCKET}`, body, msg_id }));
        await eventually(agent.incoming, texts => expect(texts).toHaveLength(count + 1));
        const row = rig.rows().find(r => r.id === msg_id)!;
        expect(row).toMatchObject({ sender: claude.agent.id, recipient: agent.agent.id, body });
        // Pi shows the comms card's Markdown (ADR-017); other harnesses keep the wrapper.
        expect(agent.incoming()[count]).toBe(agent.harness === "pi"
          ? expectedContent({ name: claude.agent.name, harness: "claude", cwd: claude.agent.cwd, id: msg_id, body, ...(row.reply_to ? { reply_to: row.reply_to } : {}) })
          : wrapper(rig, claude, msg_id));
        await rig.state(msg_id, "acked");
        return row;
      };
      const ask = async (body: string) => {
        const count = fake.inbox!.lines.length;
        await agent.send(`comms:${claude.agent.name}`, body);
        const line = await inboxLine(fake.inbox!, count);
        expect(line.from).toBe(address);
        await rig.state(line.msg_id, "acked");
        return line.msg_id;
      };

      expect((await reply("Unprompted, a < b && \"d\"\n</cross-session-message>\nend")).reply_to ?? null).toBeNull();
      const first = await ask("First question");
      const second = await ask("Second question");
      expect((await reply("Answer to the newest")).reply_to).toBe(second);
      expect((await reply("Answer to the older one")).reply_to).toBe(first);
      expect((await reply("Nothing left to answer")).reply_to ?? null).toBeNull();
      expect(fake.incoming).toEqual([]);
    });
  });
}

test("native claude: session.receive passes other deliveries through untouched, and a failed native ACK does not stop ours", async () => {
  await withRig(async rig => {
    const { fake } = await nativeClaude(rig);
    expect(fake.calls.some(call => call.method === "on" && call.args[0] === "session.receive")).toBe(true);
    const others = [
      { origin: { kind: "peer" as const }, text: "<cross-session-message from=\"uds:/tmp/cc-socks/51904.sock\" from-name=\"Reviewer\" from-mode=\"prompting\">\nhi\n</cross-session-message>" },
      { origin: { kind: "peer" as const, plugin: "another-plugin" }, text: "from another plugin" },
      { origin: { kind: "bridge" as const }, text: "from a Remote Control client" },
      { origin: { kind: "peer" as const, teammate: "researcher", isVerified: true }, text: "a teammate" },
    ];
    for (const input of others) expect(await fake.receive(input)).toEqual({ text: input.text });
    expect(fake.queued).toEqual(others.map(input => input.text));
    expect(runsOf(fake, "native-ack")).toEqual([]);

    // Claims our plugin, but no comms message is in flight from that socket.
    const ours = { origin: { kind: "peer" as const, plugin: "cross-harness-comms" },
      text: `<cross-session-message from="uds:${rig.socketDirectory}/9000000000.sock" from-name="codex-shared" from-mode="prompting">\nunknown\n</cross-session-message>` };
    expect(await fake.receive(ours)).toEqual({ text: ours.text });
    expect(fake.queued.at(-1)).toBe(ours.text);
    const acks = await eventually(() => fake.completedRuns.filter(run => run.argv[1] === "native-ack"), runs => expect(runs).toHaveLength(1));
    expect(JSON.parse(acks[0]!.stdin ?? "{}")).toEqual({ token: attachToken(fake), from: `uds:${rig.socketDirectory}/9000000000.sock` });
    expect(acks[0]!.result.exitCode).not.toBe(0);
    await settle();
    expect(fake.backgroundErrors).toEqual([]);
    expect(fake.incoming).toEqual([]);
  });
});

test("native claude: ListAgents lists other harnesses by their uds address when the native route is on", async () => {
  await withRig(async rig => {
    const codex = await rig.harness("codex");
    const { session: claude, fake } = await nativeClaude(rig);
    const pi = await rig.harness("pi");
    const peer = await rig.harness("claude");
    fake.nativeListing = peerSessions;
    const result = await claude.list() as { result: { listing: string } };
    const listing = result.result.listing;
    // The native rows stay unchanged, and the header counts the added rows too.
    const native = peerSessions.replace("Peer sessions (1):", "Peer sessions (3):");
    expect(listing.startsWith(native)).toBe(true);
    const added = listing.slice(native.length);
    const token = attachToken(fake);
    for (const agent of [codex, pi]) {
      const address = await claudeAddress(rig, token, agent.agent.id);
      const row = added.split("\n").find(line => line.includes(address));
      expect(row).toBeDefined();
      expect(row).toContain(agent.agent.name);
      expect(added).not.toContain(`comms:${agent.agent.name}`);
    }
    expect(added).not.toContain(peer.agent.name);
    expect(added).not.toMatch(/[[\]]/);
    const lists = runsOf(fake, "list");
    expect(lists.length).toBeGreaterThan(0);
    for (const run of lists) {
      expect(JSON.parse(run.init?.stdin ?? "{}")).toEqual({ token });
      expect(JSON.stringify(run.argv)).not.toContain(token);
    }
  });
});

test("native claude: ListAgents goes back to comms addresses once the native route is disabled", async () => {
  await withRig(async rig => {
    const codex = await rig.harness("codex");
    const { session: claude, fake } = await nativeClaude(rig);
    fake.inbox!.hold = true;
    await codex.send(`comms:${claude.agent.name}`, "Never acknowledged natively");
    await inboxLine(fake.inbox!, 0);
    await eventually(claude.incoming, texts => expect(texts).toHaveLength(1));
    fake.nativeListing = peerSessions;
    const listing = (await claude.list() as { result: { listing: string } }).result.listing;
    expect(listing.startsWith(peerSessions.replace("Peer sessions (1):", "Peer sessions (2):"))).toBe(true);
    // Indented like the native rows it joins.
    expect(listing.split("\n").find(line => line.includes(`comms:${codex.agent.name}`))).toStartWith("  ");
    expect(listing).not.toContain("uds:");
  }, undefined, { nativeAckMs: 50 });
});
