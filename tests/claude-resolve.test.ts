import { expect, test } from "bun:test";
import { runCli } from "@cross-harness-comms/core/cli";
import { VERSION_RANGE, type Agent, type Harness } from "@cross-harness-comms/protocol";
import type { ProcessRunResult, ToolEvent } from "../adapters/claude/src/api.ts";
import type { FakeClaude } from "./support/fakes/claude.ts";
import { eventually, settle, uuid } from "./support/helpers.ts";
import { attachToken, claudeAddress, nativeClaude, nativePeer, peerSessions, runsOf } from "./support/claude.ts";
import { expectedClaudeText } from "./support/text.ts";
import { cli, registration, sendRequests, withRig, type HarnessSession, type Rig } from "./support/rig.ts";

// Claude resolves every bare name through the core's `resolve`, without needing ListAgents first.

// Claude sessions on the fallback route: no inbox socket, or a Claude older than the native minimum.
const fallbacks: Record<string, (rig: Rig) => Promise<HarnessSession>> = {
  "no inbox socket": rig => rig.harness("claude"),
  "Claude 2.1.288": rig => rig.harness("claude", undefined, undefined, { claude: { version: "2.1.288" } }),
};

function sendEvent(to: string, message = "By name"): Extract<ToolEvent, { tool: "SendMessage" }> {
  return { tool: "SendMessage", tool_use_id: uuid(), to, message, summary: "Reach an agent by name" };
}

// The JSON each `comms resolve` call read on stdin.
function resolveInputs(fake: FakeClaude): { token?: string; name?: string; skip_claude?: boolean }[] {
  return runsOf(fake, "resolve").map(run => JSON.parse(run.init?.stdin ?? "null"));
}

async function rename(rig: Rig, address: string, name: string) {
  const { exitCode, stderr } = await cli(rig, ["rename", address, name]);
  expect(exitCode, stderr).toBe(0);
}

for (const harness of ["pi", "codex"] as Harness[]) {
  test(`on the native route, SendMessage to the bare name of an online ${harness} agent with no ListAgents goes to its uds address natively`, async () => {
    await withRig(async rig => {
      const agent = await rig.harness(harness);
      const { fake } = await nativeClaude(rig);
      const token = attachToken(fake);
      const address = await claudeAddress(rig, token, agent.agent.id);
      const event = sendEvent(agent.agent.name);
      expect(await fake.tool(event)).toBe(fake.nativeResult);
      expect(fake.nativeCalls.filter(call => call.tool === "ListAgents")).toEqual([]);
      expect(fake.nativeCalls).toEqual([{ ...event, to: address }]);
      const inputs = resolveInputs(fake);
      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toMatchObject({ token, name: agent.agent.name });
      expect(JSON.stringify(runsOf(fake, "resolve")[0]!.argv)).not.toContain(token);
      expect(sendRequests(rig)).toEqual([]);
      expect(rig.rows()).toEqual([]);
    });
  });

  for (const [route, start] of Object.entries(fallbacks)) {
    test(`on the fallback route (${route}), SendMessage to the bare name of an online ${harness} agent goes through comms`, async () => {
      await withRig(async rig => {
        const agent = await rig.harness(harness);
        const claude = await start(rig);
        const fake = claude.fake as FakeClaude;
        const result = await fake.tool(sendEvent(agent.agent.name, "By name through comms"));
        expect(result).toEqual({ result: { success: true, message: `Sent to ${agent.agent.name}.` } });
        expect(fake.nativeCalls.filter(call => call.tool === "SendMessage")).toEqual([]);
        expect(sendRequests(rig).map(send => send.to)).toEqual([`comms:${agent.agent.name}`]);
        await eventually(agent.incoming, texts => expect(texts).toHaveLength(1));
        expect(rig.rows()).toEqual([expect.objectContaining({ sender: claude.agent.id, recipient: agent.agent.id, body: "By name through comms" })]);
        expect(resolveInputs(fake)).toEqual([expect.objectContaining({ name: agent.agent.name })]);
      });
    });
  }
}

test("a bare name the core does not know passes through to Claude's native tool unchanged", async () => {
  await withRig(async rig => {
    await rig.harness("pi");
    for (const fake of [(await nativeClaude(rig)).fake, (await rig.harness("claude")).fake as FakeClaude]) {
      for (const to of ["no-such-agent", "worker [native-ref]", "researcher", "comms-test-8b"]) {
        const event = sendEvent(to, "Native recipient");
        expect(await fake.tool(event)).toBe(fake.nativeResult);
        expect(fake.nativeCalls.at(-1)).toBe(event);
        expect(resolveInputs(fake).at(-1)).toMatchObject({ name: to });
      }
      expect(resolveInputs(fake)).toHaveLength(4);
    }
    expect(sendRequests(rig)).toEqual([]);
    expect(rig.rows()).toEqual([]);
  });
});

test("a bare Claude agent's name passes through unchanged while native peer messaging is on", async () => {
  await withRig(async rig => {
    const peer = await rig.harness("claude");
    const { session: claude, fake } = await nativeClaude(rig);
    // The session's native ListAgents shows Claude's own peer section.
    fake.nativeListing = peerSessions;
    await claude.list();
    const event = sendEvent(peer.agent.name, "To a Claude peer");
    expect(await fake.tool(event)).toBe(fake.nativeResult);
    expect(fake.nativeCalls.at(-1)).toBe(event);
    expect(resolveInputs(fake)).toEqual([expect.objectContaining({ name: peer.agent.name, skip_claude: true })]);
    await settle();
    expect(sendRequests(rig)).toEqual([]);
    expect(peer.incoming()).toEqual([]);
  });
});

test("without native peer messaging, a bare Claude agent's name is sent through comms", async () => {
  await withRig(async rig => {
    const peer = await rig.harness("claude");
    const claude = await rig.harness("claude");
    const fake = claude.fake as FakeClaude;
    // The default native listing has no peer section.
    await claude.list();
    expect(await fake.tool(sendEvent(peer.agent.name, "To a Claude peer through comms")))
      .toEqual({ result: { success: true, message: `Sent to ${peer.agent.name}.` } });
    expect(fake.nativeCalls.filter(call => call.tool === "SendMessage")).toEqual([]);
    expect(sendRequests(rig).map(send => send.to)).toEqual([`comms:${peer.agent.name}`]);
    const inputs = resolveInputs(fake);
    expect(inputs).toEqual([expect.objectContaining({ name: peer.agent.name })]);
    expect(inputs[0]!.skip_claude ?? false).toBe(false);
    await eventually(peer.incoming, texts => expect(texts).toHaveLength(1));
    const message = rig.rows()[0]!;
    expect(peer.incoming()[0]).toBe(expectedClaudeText({ name: claude.agent.name, body: message.body, reply_to: null }));
  });
});

test("on the native route, an agent registered after the last ListAgents resolves, and after a rename only the new name does", async () => {
  await withRig(async rig => {
    const { session: claude, fake } = await nativeClaude(rig);
    fake.nativeListing = peerSessions;
    await claude.list();
    const late = await rig.harness("pi");
    const address = await claudeAddress(rig, attachToken(fake), late.agent.id);
    const byName = sendEvent(late.agent.name);
    await fake.tool(byName);
    expect(fake.nativeCalls.at(-1)).toEqual({ ...byName, to: address });

    const old = late.agent.name;
    await rename(rig, `comms:${old}`, "pi-renamed");
    const byNewName = sendEvent("pi-renamed");
    await fake.tool(byNewName);
    expect(fake.nativeCalls.at(-1)).toEqual({ ...byNewName, to: address });
    const byOldName = sendEvent(old);
    expect(await fake.tool(byOldName)).toBe(fake.nativeResult);
    expect(fake.nativeCalls.at(-1)).toBe(byOldName);
    expect(resolveInputs(fake).map(input => input.name)).toEqual([old, "pi-renamed", old]);
    expect(sendRequests(rig)).toEqual([]);
  });
});

test("on the fallback route, an agent registered after the last ListAgents resolves, and after a rename only the new name does", async () => {
  await withRig(async rig => {
    const claude = await rig.harness("claude");
    const fake = claude.fake as FakeClaude;
    await claude.list();
    const late = await rig.harness("pi");
    expect(await fake.tool(sendEvent(late.agent.name, "First"))).toEqual({ result: { success: true, message: `Sent to ${late.agent.name}.` } });
    await eventually(late.incoming, texts => expect(texts).toHaveLength(1));

    const old = late.agent.name;
    await rename(rig, `comms:${old}`, "pi-renamed");
    expect(await fake.tool(sendEvent("pi-renamed", "Second"))).toEqual({ result: { success: true, message: "Sent to pi-renamed." } });
    await eventually(late.incoming, texts => expect(texts).toHaveLength(2));
    const byOldName = sendEvent(old, "Third");
    expect(await fake.tool(byOldName)).toBe(fake.nativeResult);
    expect(fake.nativeCalls.at(-1)).toBe(byOldName);
    expect(sendRequests(rig).map(send => send.to)).toEqual([`comms:${old}`, "comms:pi-renamed"]);
    expect(rig.rows().map(message => [message.recipient, message.body])).toEqual([[late.agent.id, "First"], [late.agent.id, "Second"]]);
    expect(resolveInputs(fake).map(input => input.name)).toEqual([old, "pi-renamed", old]);
  });
});

const outcome = (fields: Partial<ProcessRunResult>): ProcessRunResult =>
  ({ exitCode: 0, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false, ...fields });
const resolveFaults: [string, ProcessRunResult | Error][] = [
  ["the process cannot start", new Error("spawn failed")],
  ["exit 1", outcome({ exitCode: 1, stderr: "DISCONNECTED" })],
  ["exit 2", outcome({ exitCode: 2, stderr: "INVALID_PARAMS" })],
  ["no answer", outcome({ exitCode: 0 })],
];

for (const [route, start] of [["native", async (rig: Rig) => (await nativeClaude(rig)).session], ["fallback", fallbacks["no inbox socket"]!]] as const) {
  test(`on the ${route} route, a failed comms resolve passes the call through unchanged`, async () => {
    await withRig(async rig => {
      const pi = await rig.harness("pi");
      const claude = await start(rig);
      const fake = claude.fake as FakeClaude;
      for (const [name, fault] of resolveFaults) {
        fake.faults.set("resolve", fault);
        const attempts = runsOf(fake, "resolve").length;
        const event = sendEvent(pi.agent.name, `Resolve fails: ${name}`);
        expect(await fake.tool(event), name).toBe(fake.nativeResult);
        expect(fake.nativeCalls.at(-1), name).toBe(event);
        expect(runsOf(fake, "resolve").length, name).toBe(attempts + 1);
      }
      expect(sendRequests(rig)).toEqual([]);
      expect(rig.rows()).toEqual([]);
      expect(fake.backgroundErrors).toEqual([]);
    });
  });
}

test("comms: and uds: addresses never call resolve", async () => {
  await withRig(async rig => {
    const pi = await rig.harness("pi");
    const { fake } = await nativeClaude(rig);
    const address = await claudeAddress(rig, attachToken(fake), pi.agent.id);
    expect(await fake.tool(sendEvent(`comms:${pi.agent.name}`, "By comms address")))
      .toEqual({ result: { success: true, message: `Sent to ${pi.agent.name}.` } });
    for (const to of [address, `uds:${rig.socketDirectory}/51904.sock`]) {
      const event = sendEvent(to, "By socket");
      expect(await fake.tool(event)).toBe(fake.nativeResult);
      expect(fake.nativeCalls.at(-1)).toBe(event);
    }
    expect(await fake.tool(sendEvent("comms:no-such-agent", "Unknown"))).toHaveProperty("deny");
    expect(runsOf(fake, "resolve")).toEqual([]);
  });
});

test("the core's resolve returns the exact-name agent as list shows it, and null otherwise", async () => {
  await withRig(async rig => {
    const native = await nativePeer(rig);
    const piPeer = await rig.peer();
    const pi = (await piPeer.register(registration("pi", uuid(), "/projects/web"))).agent;
    const other = (await (await rig.peer()).register(registration("claude", uuid(), "/projects/other"))).agent;
    const caller = await rig.peer();
    await caller.request("hello", { versions: VERSION_RANGE });
    const resolve = (params: { token?: string; name: string; skip_claude?: boolean }) => caller.request("resolve", params);
    const listed = async (token?: string) => (await caller.request("list", token ? { token } : {})).agents;
    const find = (agents: Agent[], id: string) => agents.find(agent => agent.id === id)!;

    // On the native route the caller gets each other harness's reply socket, as from list.
    const forNative = await listed(native.token);
    expect(find(forNative, pi.id).claude_address).toStartWith("uds:");
    expect(await resolve({ token: native.token, name: pi.name })).toEqual({ agent: find(forNative, pi.id) });
    expect(await resolve({ token: native.token, name: pi.name, skip_claude: true })).toEqual({ agent: find(forNative, pi.id) });
    // Without a token, as list without one: no claude_address.
    const plainList = await listed();
    expect(await resolve({ name: pi.name })).toEqual({ agent: find(plainList, pi.id) });
    expect(find(plainList, pi.id)).not.toHaveProperty("claude_address");

    // A Claude agent resolves unless skip_claude asks for null.
    expect(await resolve({ token: native.token, name: other.name })).toEqual({ agent: find(forNative, other.id) });
    expect(find(forNative, other.id)).not.toHaveProperty("claude_address");
    expect(await resolve({ token: native.token, name: other.name, skip_claude: true })).toEqual({ agent: null });
    expect(await resolve({ token: native.token, name: native.agent.name, skip_claude: true })).toEqual({ agent: null });

    // Only an exact name matches.
    for (const name of ["no-such-agent", `comms:${pi.name}`, pi.name.toUpperCase(), `${pi.name} `, pi.id, pi.id.slice(0, 8), pi.name.slice(0, -1)]) {
      expect(await resolve({ token: native.token, name }), name).toEqual({ agent: null });
    }

    // An offline agent still resolves, with its presence.
    piPeer.close();
    await eventually(() => listed(native.token), agents => expect(find(agents, pi.id).online).toBe(false));
    expect(await resolve({ token: native.token, name: pi.name })).toEqual({ agent: find(await listed(native.token), pi.id) });
  });
});

test("comms resolve reads JSON on stdin and prints the core's answer", async () => {
  await withRig(async rig => {
    const native = await nativePeer(rig);
    const pi = (await (await rig.peer()).register(registration("pi"))).agent;
    const found = await cli(rig, "resolve", { token: native.token, name: pi.name });
    expect(found.exitCode, found.stderr).toBe(0);
    const listed = await cli(rig, "list", { token: native.token });
    const agent = (JSON.parse(listed.stdout) as { agents: Agent[] }).agents.find(a => a.id === pi.id)!;
    expect(agent.claude_address).toStartWith("uds:");
    expect(JSON.parse(found.stdout)).toEqual({ agent });
    const claude = await cli(rig, "resolve", { token: native.token, name: native.agent.name, skip_claude: true });
    expect(claude.exitCode, claude.stderr).toBe(0);
    expect(JSON.parse(claude.stdout)).toEqual({ agent: null });
    const unknown = await cli(rig, "resolve", { name: "no-such-agent" });
    expect(unknown.exitCode, unknown.stderr).toBe(0);
    expect(JSON.parse(unknown.stdout)).toEqual({ agent: null });
    expect(JSON.stringify([found, claude, unknown])).not.toContain(native.token);
  });
});

test("comms help lists resolve", async () => {
  let stdout = "";
  const exitCode = await runCli(["help"], { stdin: (async function* () {})(), signal: new AbortController().signal,
    stdout: text => { stdout += text; }, stderr: () => {} }, { connect: async () => { throw new Error("help must not connect"); },
    platform: undefined as never });
  expect(exitCode).toBe(0);
  expect(stdout).toMatch(/^ {2}resolve\s+\S/m);
});
