import { expect, test } from "bun:test";
import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { runCli } from "@cross-harness-comms/core/cli";
import { VERSION_RANGE, type Agent, type Harness, type HelloResult, type SessionRegistration } from "@cross-harness-comms/protocol";
import type { ProcessRunResult, ToolEvent } from "../adapters/claude/src/api.ts";
import type { CommsMessageDetails } from "../adapters/pi/src/index.ts";
import { FakeClaude } from "./fakes/claude.ts";
import { FakePi } from "./fakes/pi.ts";
import { cli, helloRequests, sendRequests } from "./fixes-support.ts";
import { deferred, eventually, uuid } from "./helpers.ts";
import { attachToken, claudeAddress, nativePeer, runsOf, settle } from "./claude-inbox-support.ts";
import { bottom, commsMessage, detailsFor, expectColor, expectMutedFrame, expectWidths, identityTheme, markerTheme, plain,
  renderLines, row, top } from "./pi-card-support.ts";
import { expectedClaudeText } from "./text-support.ts";
import { registration, withRig, type HarnessSession, type Rig } from "./rig.ts";

// The second round of fixes, specified in internal/HANDOFF-FIXES-2.md.

// Claude Code's native ListAgents output when its own peer messaging is on.
const peerSessions = "This session is Cross-harness communications naming [2a1458] ...\n\nPeer sessions (1):\n  comms-test-8b [c14715]  ·  interactive  ·  idle  ·  started 45m ago";

// A Claude session whose native route is on: an inbox socket and a tested Claude version (ADR-016).
async function nativeClaude(rig: Rig) {
  const session = await rig.harness("claude", undefined, undefined, { claude: {} });
  return { session, fake: session.fake as FakeClaude };
}

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
  let stderr = "";
  const exitCode = await runCli(["rename", address, name], { stdin: (async function* () {})(), signal: new AbortController().signal,
    stdout: () => {}, stderr: text => { stderr += text; } }, rig.cliRuntime());
  expect(exitCode, stderr).toBe(0);
}

// Fix 1: Claude resolves every bare name through the core.

for (const harness of ["pi", "codex"] as Harness[]) {
  test(`fix2 1: on the native route, SendMessage to the bare name of an online ${harness} agent with no ListAgents goes to its uds address natively`, async () => {
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
    test(`fix2 1: on the fallback route (${route}), SendMessage to the bare name of an online ${harness} agent goes through comms`, async () => {
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

test("fix2 1: a bare name the core does not know passes through to Claude's native tool unchanged", async () => {
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

test("fix2 1: a bare Claude agent's name passes through unchanged while native peer messaging is on", async () => {
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

test("fix2 1: without native peer messaging, a bare Claude agent's name is sent through comms", async () => {
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

test("fix2 1: on the native route, an agent registered after the last ListAgents resolves, and after a rename only the new name does", async () => {
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

test("fix2 1: on the fallback route, an agent registered after the last ListAgents resolves, and after a rename only the new name does", async () => {
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
  test(`fix2 1: on the ${route} route, a failed comms resolve passes the call through unchanged`, async () => {
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

test("fix2 1: comms: and uds: addresses never call resolve", async () => {
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

test("fix2 1: the core's resolve returns the exact-name agent as list shows it, and null otherwise", async () => {
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

test("fix2 1: comms resolve reads JSON on stdin and prints the core's answer", async () => {
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

test("fix2 1: comms help lists resolve", async () => {
  let stdout = "";
  const exitCode = await runCli(["help"], { stdin: (async function* () {})(), signal: new AbortController().signal,
    stdout: text => { stdout += text; }, stderr: () => {} }, { connect: async () => { throw new Error("help must not connect"); },
    platform: undefined as never });
  expect(exitCode).toBe(0);
  expect(stdout).toMatch(/^ {2}resolve\s+\S/m);
});

// Fixes 2 and 3: the Pi card pads body lines by one space and says Ctrl+O once.

async function withPi(run: (fake: FakePi) => void | Promise<void>) {
  await withRig(async rig => { await run((await rig.harness("pi")).fake as FakePi); });
}

const body = "Can you review the parser change in src/parse.ts before I merge it?\n\nThanks, codex.";
const message = detailsFor({ name: "codex-api", harness: "codex", cwd: "/Users/ed/src/api", id: "019a2b3c-4d5e-7f60-8a7b-1c2d3e4f5a6b", body });
const reply = { ...message, reply_to: "019a2b3b-0000-7000-8000-000000000001" };
const header = " From: codex-api (codex · /Users/ed/src/api) ";
const preview = (text: string) => text.replace(/\s+/g, " ").trim();
// A frame row for text of any width.
const framed = (text: string, inner: number) => `│${text}${" ".repeat(inner - visibleWidth(text))}│`;

test("fix2 2: collapsed card, exact lines at width 64, with the preview padded by one space and truncated", async () => {
  await withPi(fake => {
    expect(plain(renderLines(fake, commsMessage(message), 64))).toEqual([
      top(header, 62),
      row(" Can you review the parser change in src/parse.ts before I mer", 62),
      row(" To reply: comms_send to comms:codex-api · Ctrl+O to expand", 62),
      bottom(62),
    ]);
  });
});

test("fix2 2: expanded card, exact lines at width 48, with every body line padded by one space", async () => {
  await withPi(fake => {
    expect(plain(renderLines(fake, commsMessage(reply), 48, { expanded: true }))).toEqual([
      top(header, 46),
      row(" Can you review the parser change in", 46),
      row(" src/parse.ts before I merge it?", 46),
      row("", 46),
      row(" Thanks, codex.", 46),
      row("", 46),
      row(" To reply: comms_send to comms:codex-api", 46),
      row("", 46),
      row(" Reply to 019a2b3b", 46),
      bottom(46),
    ]);
  });
});

const paddedBodies: Record<string, string> = {
  representative: body,
  "wide characters": "漢字のテキスト🐾と絵文字 mixed with ascii 漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字",
  "whitespace runs and blank lines": "  leading\n\n\n   gaps   between\n trailing  \n",
};

for (const [bodyName, text] of Object.entries(paddedBodies)) {
  test(`fix2 2: ${bodyName} body lines start one space in at widths 42 to 160, wrapped to the inner width minus that space`, async () => {
    await withPi(fake => {
      for (const details of [{ ...message, body: text }, { ...reply, body: text }]) for (const width of [42, 46, 47, 48, 49, 50, 60, 64, 80, 100, 120, 160]) {
        const inner = width - 2;
        const context = `width ${width}${details.reply_to ? ", reply" : ""}`;
        const collapsed = plain(renderLines(fake, commsMessage(details), width));
        expect(collapsed[1], context).toBe(framed(stripTerminalSequences(truncateToWidth(` ${preview(text)}`, inner, "")), inner));
        expect(collapsed[2], context).toStartWith("│ To reply: ");

        const expanded = plain(renderLines(fake, commsMessage(details), width, { expanded: true }));
        const wrapped = wrapTextWithAnsi(text, inner - 1);
        expect(expanded.slice(1, 1 + wrapped.length), context).toEqual(wrapped.map(line => framed(stripTerminalSequences(` ${line}`), inner)));
        expect(expanded[1 + wrapped.length], context).toBe(framed("", inner));
        expect(expanded[2 + wrapped.length], context).toBe(framed(" To reply: comms_send to comms:codex-api", inner));
        expectWidths(collapsed, width);
        expectWidths(expanded, width);
      }
    });
  });
}

const sweepBodies: Record<string, string> = {
  ...paddedBodies,
  "ANSI escapes": "\x1b[31mred\x1b[0m then \x1b[1mbold\x1b[22m and \x1b[4munderlined text that keeps going for a while\x1b[24m",
  "a very long word": "x".repeat(300),
  "a long URL then wide text": `see https://example.com/${"segment/".repeat(40)} then 漢字漢字`,
  empty: "",
};
const sweepSenders: Record<string, CommsMessageDetails> = {
  short: message,
  long: { from: "comms:a-very-long-agent-name-that-goes-on-and-on", name: "a-very-long-agent-name-that-goes-on-and-on", harness: "claude",
    cwd: `/Users/ed/プロジェクト/深い/${"nested/".repeat(10)}`, id: message.id, reply_to: reply.reply_to, body: "" },
};
const sweepWidths = [...Array.from({ length: 38 }, (_, i) => i + 3), 47, 48, 49, 50, 64, 80, 99, 100, 101, 120, 160];

for (const [bodyName, text] of Object.entries(sweepBodies)) for (const [senderName, sender] of Object.entries(sweepSenders)) {
  test(`fix2 2: ${bodyName}, ${senderName} sender: the first body line starts one space in and every line keeps the width, widths 3 to 160`, async () => {
    await withPi(fake => {
      const sent = commsMessage({ ...sender, body: text });
      for (const width of sweepWidths) for (const expanded of [false, true]) for (const theme of [identityTheme, markerTheme]) {
        const lines = renderLines(fake, sent, width, { expanded, theme });
        const context = `width ${width}, ${expanded ? "expanded" : "collapsed"}`;
        expectWidths(lines, width);
        const visible = plain(lines);
        // The column after the left border; at width 3 the inner width is that one column.
        if (!expanded || width >= 4) expect(Array.from(visible[1]!)[1], `${context}: ${visible[1]}`).toBe(" ");
        expect(visible.at(-1), context).toBe(`╰${"─".repeat(width - 2)}╯`);
      }
    });
  });
}

test("fix2 2: padded body lines keep the text color, with a muted frame", async () => {
  await withPi(fake => {
    const collapsed = renderLines(fake, commsMessage(reply), 100, { theme: markerTheme });
    for (const line of collapsed) expectMutedFrame(line);
    expectColor(collapsed[1]!, "Can you review the parser change in src/parse.ts before I merge it? Thanks, codex.", "text");
    const expanded = renderLines(fake, commsMessage(reply), 50, { expanded: true, theme: markerTheme });
    for (const line of expanded) expectMutedFrame(line);
    expectColor(expanded[1]!, "Can you review the parser change in", "text");
    expectColor(expanded[2]!, "src/parse.ts before I merge it?", "text");
    expectColor(expanded[4]!, "Thanks, codex.", "text");
    expectWidths(collapsed, 100);
    expectWidths(expanded, 50);
  });
});

test("fix2 3: the collapsed header is the expanded header, without Ctrl+O expands", async () => {
  await withPi(fake => {
    for (const details of [message, reply, { ...sweepSenders.long!, body }]) for (const width of [40, 50, 64, 100, 120, 160, 300]) {
      const collapsed = renderLines(fake, commsMessage(details), width, { theme: markerTheme });
      const expanded = renderLines(fake, commsMessage(details), width, { expanded: true, theme: markerTheme });
      expect(plain(collapsed)[0], `width ${width}`).toBe(plain(expanded)[0]);
      expect(plain(collapsed)[0]).not.toContain("Ctrl+O");
      expect(plain(collapsed)[0]).not.toContain("expands");
    }
    const lines = renderLines(fake, commsMessage(reply), 100, { theme: markerTheme });
    expect(plain(lines)[0]).toBe(top(header, 98));
    expectColor(lines[0]!, header, "toolTitle");
  });
});

test("fix2 3: the collapsed footer still ends with Ctrl+O to expand, the card's only Ctrl+O", async () => {
  await withPi(fake => {
    expect(plain(renderLines(fake, commsMessage(message), 100))[2]).toBe(row(" To reply: comms_send to comms:codex-api · Ctrl+O to expand", 98));
    expect(plain(renderLines(fake, commsMessage(reply), 100))[2])
      .toBe(row(" To reply: comms_send to comms:codex-api · Reply to 019a2b3b · Ctrl+O to expand", 98));
    for (const details of [message, reply]) for (const width of [100, 120, 160]) {
      const collapsed = plain(renderLines(fake, commsMessage(details), width)).join("\n");
      expect(collapsed.match(/Ctrl\+O/g), `width ${width}`).toHaveLength(1);
      expect(collapsed.split("\n")[2]!.slice(1, -1).trimEnd()).toEndWith(" · Ctrl+O to expand");
      expect(plain(renderLines(fake, commsMessage(details), width, { expanded: true })).join("\n")).not.toContain("Ctrl+O");
    }
  });
});

// Fix 4: `comms attach` exits when the process that started it is gone.

async function* input(params: unknown) { yield JSON.stringify(params) + "\n"; }

// Runs `comms attach` as a mod would, with no abort unless the test asks for one.
function attach(rig: Rig, session: SessionRegistration) {
  const abort = new AbortController();
  const hello = deferred<HelloResult>();
  let stdout = "";
  const done = runCli(["attach"], { stdin: input({ versions: VERSION_RANGE, session }), signal: abort.signal, stderr: () => {},
    stdout: text => {
      stdout += text;
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      const packet = JSON.parse(stdout.slice(0, newline));
      if (packet.result) hello.resolve(packet.result as HelloResult); else hello.reject(new Error(stdout));
    } }, rig.cliRuntime());
  let exited = false;
  void done.then(() => { exited = true; });
  return { hello: hello.promise, done, exited: () => exited, abort: () => abort.abort() };
}

// Whether a promise settles within a generous bound, without depending on any real parent check.
const within = (promise: Promise<unknown>, ms = 1000) => Promise.race([promise.then(() => true), Bun.sleep(ms).then(() => false)]);

async function online(rig: Rig, session: SessionRegistration) {
  return (await rig.agents()).find(agent => agent.session_key === session.session_key)?.online;
}

test("fix2 4: comms attach closes its connection and exits once its parent is reported gone, and the session lists offline", async () => {
  await withRig(async rig => {
    const session = registration("claude");
    const child = attach(rig, session);
    expect((await child.hello).token).toBeString();
    expect(await online(rig, session)).toBe(true);
    const [watcher] = await eventually(() => rig.parentWatchers, watchers => expect(watchers).toHaveLength(1));
    await settle();
    expect(child.exited()).toBe(false);

    watcher!.gone();
    expect(await within(child.done)).toBe(true);
    const link = rig.links[helloRequests(rig, "claude", session.session_key)[0]!.connection]!;
    expect(link.client.destroyed).toBe(true);
    await eventually(() => online(rig, session), value => expect(value).toBe(false));
  });
});

test("fix2 4: an attach whose parent stays alive keeps running, and stops watching once it ends", async () => {
  await withRig(async rig => {
    const kept = registration("claude"), detached = registration("claude");
    const first = attach(rig, kept);
    await first.hello;
    const second = attach(rig, detached);
    const token = (await second.hello).token!;
    const watchers = await eventually(() => rig.parentWatchers, list => expect(list).toHaveLength(2));
    await settle();
    expect(first.exited()).toBe(false);
    expect(second.exited()).toBe(false);
    expect(await online(rig, kept)).toBe(true);
    expect(await online(rig, detached)).toBe(true);
    expect(watchers.map(watcher => watcher.stopped)).toEqual([false, false]);

    // Ending for another reason, an abort or the core closing the connection, stops the parent watch,
    // so nothing keeps a finished attach process alive.
    first.abort();
    expect(await within(first.done)).toBe(true);
    const result = await cli(rig, "detach", { token });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(await within(second.done)).toBe(true);
    expect(watchers.map(watcher => watcher.stopped)).toEqual([true, true]);
  });
});

test("fix2 4: a Claude session's attach exits once its parent is reported gone, and the session lists offline", async () => {
  await withRig(async rig => {
    const claude = await rig.harness("claude");
    const fake = claude.fake as FakeClaude;
    const [watcher] = await eventually(() => rig.parentWatchers, watchers => expect(watchers).toHaveLength(1));
    expect((await rig.agent("claude", claude.sessionId)).online).toBe(true);
    expect(fake.spawnResults).toHaveLength(1);
    expect(await within(fake.spawnResults[0]!, 50)).toBe(false);

    watcher!.gone();
    expect(await within(fake.spawnResults[0]!)).toBe(true);
    await eventually(() => rig.agent("claude", claude.sessionId), agent => expect(agent.online).toBe(false));
  });
});
