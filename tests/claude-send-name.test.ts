import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Harness } from "@cross-harness-comms/protocol";
import type { ProcessRunResult, ToolEvent, ToolResult } from "../adapters/claude/src/api.ts";
import { claudeSendResult, type FakeClaude } from "./support/fakes/claude.ts";
import { eventually, uuid } from "./support/helpers.ts";
import { attachToken, claudeAddress, claudeLine, inboxLine, nativeClaude, peerSessions, post, runsOf, socketPath } from "./support/claude.ts";
import { sendRequests, withRig, type HarnessSession, type Rig } from "./support/rig.ts";

// Claude draws a SendMessage row from `display` in its own result, and the model never sees it
//. The adapter also replaces the successful model-facing message with a submission receipt.

function sendEvent(to: string, message: string): Extract<ToolEvent, { tool: "SendMessage" }> {
  return { tool: "SendMessage", tool_use_id: uuid(), to, message, summary: "Answer by name" };
}

// Keep native IDs and metadata, name the UI row, and describe submission without claiming a read state.
function named(native: ToolResult, address: string, name: string): ToolResult {
  const result = (native as { result: { display: string } }).result;
  return { result: { ...result, display: result.display.replace(address, name), message: `Submitted to ${name} through comms.` } };
}

// `agent` asks Claude something natively and returns that message's ID.
async function ask(rig: Rig, fake: FakeClaude, agent: HarnessSession, claude: HarnessSession) {
  const count = fake.inbox!.lines.length;
  await agent.send(`comms:${claude.agent.name}`, "Who is there?");
  const line = await inboxLine(fake.inbox!, count);
  await rig.state(line.msg_id, "acked");
  return line.msg_id;
}

// Claude's own SendMessage delivers by writing its line to the address that reached it.
async function deliverNatively(rig: Rig, fake: FakeClaude, agent: HarnessSession, body: string) {
  const to = (fake.nativeCalls.at(-1) as { to: string }).to;
  const msg_id = randomUUID();
  const count = agent.incoming().length;
  await post(socketPath(to), claudeLine({ from: `uds:${fake.env.CLAUDE_CODE_MESSAGING_SOCKET}`, body, msg_id }));
  await eventually(agent.incoming, texts => expect(texts).toHaveLength(count + 1));
  await rig.state(msg_id, "acked");
  return rig.rows().find(row => row.id === msg_id)!;
}

// The `uds:` address a native ListAgents row tells Claude to send to.
async function listedAddress(claude: HarnessSession, name: string) {
  (claude.fake as FakeClaude).nativeListing = peerSessions;
  const { result } = await claude.list() as { result: { listing: string } };
  const row = result.listing.split("\n").find(line => line.includes(`  ${name}  `));
  return /send to (uds:\S+)$/.exec(row ?? "")?.[1] ?? "";
}

for (const harness of ["pi", "codex"] as Harness[]) {
  test(`Claude's SendMessage result names the recipient on the native route, for a bare ${harness} name`, async () => {
    await withRig(async rig => {
      const { session: claude, fake } = await nativeClaude(rig);
      const agent = await rig.harness(harness);
      const address = await claudeAddress(rig, attachToken(fake), agent.agent.id);
      const question = await ask(rig, fake, agent, claude);
      const event = sendEvent(agent.agent.name, "Answer by bare name");
      fake.nativeResult = claudeSendResult(address, event.message);
      const sends = sendRequests(rig).length;

      const result = await fake.tool(event);
      expect(result).toEqual(named(fake.nativeResult, address, agent.agent.name));
      expect((result as { result: { display: string } }).result.display).toBe(`“Answer by bare name” → ${agent.agent.name}`);
      // Native delivery is unchanged; only the model-facing receipt and UI label change.
      expect(fake.nativeCalls.at(-1)).toEqual({ ...event, to: address });
      const message = (result as { result: { message: string } }).result.message;
      expect(message).toBe(`Submitted to ${agent.agent.name} through comms.`);
      expect(message).not.toMatch(/read|Claude|uds:/);
      // Nothing went through comms send.
      expect(sendRequests(rig).slice(sends)).toEqual([]);
      const row = await deliverNatively(rig, fake, agent, "Answer by bare name");
      expect(row).toMatchObject({ sender: claude.agent.id, recipient: agent.agent.id, reply_to: question });
    });
  });

  test(`Claude's SendMessage result names the recipient on the native route, for a ListAgents row's uds address of ${harness}`, async () => {
    await withRig(async rig => {
      const { session: claude, fake } = await nativeClaude(rig);
      const agent = await rig.harness(harness);
      const address = await listedAddress(claude, agent.agent.name);
      expect(address).toBe(await claudeAddress(rig, attachToken(fake), agent.agent.id));
      const question = await ask(rig, fake, agent, claude);
      const event = sendEvent(address, "Answer by socket");
      fake.nativeResult = claudeSendResult(address, event.message);
      const lists = runsOf(fake, "list").length, sends = sendRequests(rig).length;

      expect(await fake.tool(event)).toEqual(named(fake.nativeResult, address, agent.agent.name));
      // The call reaches Claude's tool exactly as the model made it.
      expect(fake.nativeCalls.at(-1)).toBe(event);
      // The name comes from comms list with the session token, not from resolve.
      expect(runsOf(fake, "resolve")).toEqual([]);
      const looked = runsOf(fake, "list").slice(lists);
      expect(looked).toHaveLength(1);
      expect(JSON.parse(looked[0]!.init?.stdin ?? "{}")).toEqual({ token: attachToken(fake) });
      // Nothing went through comms send.
      expect(sendRequests(rig).slice(sends)).toEqual([]);
      const row = await deliverNatively(rig, fake, agent, "Answer by socket");
      expect(row).toMatchObject({ sender: claude.agent.id, recipient: agent.agent.id, reply_to: question });
    });
  });
}

test("a reply socket no comms agent owns keeps Claude's row", async () => {
  await withRig(async rig => {
    await rig.harness("pi");
    const { fake } = await nativeClaude(rig);
    const address = `uds:${rig.socketDirectory}/9000000000.sock`;
    const event = sendEvent(address, "Nobody owns this");
    fake.nativeResult = claudeSendResult(address, event.message);
    expect(await fake.tool(event)).toEqual(fake.nativeResult);
    expect(fake.nativeCalls.at(-1)).toBe(event);
  });
});

test("Claude's own peer sockets keep Claude's row and cost no lookup", async () => {
  await withRig(async rig => {
    await rig.harness("pi");
    const { fake } = await nativeClaude(rig);
    for (const address of [`uds:${rig.socketDirectory}/51904.sock`, `uds:${rig.socketDirectory}/900000000.sock`, `uds:${rig.socketDirectory}/9000000000.sock.bak`]) {
      const event = sendEvent(address, "To a Claude peer");
      fake.nativeResult = claudeSendResult(address, event.message);
      const lists = runsOf(fake, "list").length;
      expect(await fake.tool(event), address).toEqual(fake.nativeResult);
      expect(fake.nativeCalls.at(-1), address).toBe(event);
      expect(runsOf(fake, "list").length, address).toBe(lists);
    }
    expect(runsOf(fake, "resolve")).toEqual([]);
  });
});

const outcome = (fields: Partial<ProcessRunResult>): ProcessRunResult =>
  ({ exitCode: 0, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false, ...fields });

test("a failed comms list keeps Claude's row for a reply socket", async () => {
  await withRig(async rig => {
    const pi = await rig.harness("pi");
    const { fake } = await nativeClaude(rig);
    const address = await claudeAddress(rig, attachToken(fake), pi.agent.id);
    for (const [name, fault] of [["the process cannot start", new Error("spawn failed")], ["exit 1", outcome({ exitCode: 1, stderr: "DISCONNECTED" })],
      ["no answer", outcome({ exitCode: 0 })]] as const) {
      fake.faults.set("list", fault);
      const event = sendEvent(address, `List fails: ${name}`);
      fake.nativeResult = claudeSendResult(address, event.message);
      expect(await fake.tool(event), name).toEqual(fake.nativeResult);
      expect(fake.nativeCalls.at(-1), name).toBe(event);
    }
    expect(fake.backgroundErrors).toEqual([]);
  });
});

test("a deny, or a result without a string display, comes back from Claude's tool unchanged", async () => {
  await withRig(async rig => {
    const pi = await rig.harness("pi");
    const { fake } = await nativeClaude(rig);
    const address = await claudeAddress(rig, attachToken(fake), pi.agent.id);
    const results: ToolResult[] = [
      { deny: "The user declined the message" },
      { result: { success: false, message: "Not sent" } },
      { result: { success: false, message: "Not sent", display: "Denied" } },
      { result: { success: true, message: `“x” → ${address}`, display: { to: address } } },
      { result: "native message accepted" },
      { result: null },
    ];
    for (const to of [pi.agent.name, address]) {
      for (const result of results) {
        fake.nativeResult = result;
        expect(await fake.tool(sendEvent(to, "Unchanged")), `${to} ${JSON.stringify(result)}`).toBe(result);
        expect(fake.nativeCalls.at(-1)).toMatchObject({ to: address });
      }
    }
  });
});
