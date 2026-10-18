import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { CommsMessageDetails } from "../adapters/pi/src/index.ts";
import { FakePi } from "./fakes/pi.ts";
import { bottom, commsMessage, detailsFor, expectColor, expectMutedFrame, expectWidths, identityTheme, markerTheme, plain,
  rendererOf, renderLines, row, top } from "./pi-card-support.ts";
import { withRig } from "./rig.ts";

// The ADR-017 card, rendered through the renderer the Pi adapter registers, as Pi calls it.

async function withPi(run: (fake: FakePi) => void | Promise<void>) {
  await withRig(async rig => { await run((await rig.harness("pi")).fake as FakePi); });
}

const body = "Can you review the parser change in src/parse.ts before I merge it?\n\nThanks, codex.";
const message = detailsFor({ name: "codex-api", harness: "codex", cwd: "/Users/ed/src/api", id: "019a2b3c-4d5e-7f60-8a7b-1c2d3e4f5a6b", body });
const reply = { ...message, reply_to: "019a2b3b-0000-7000-8000-000000000001" };

test("pi card collapsed: exact lines at width 100", async () => {
  await withPi(fake => {
    expect(plain(renderLines(fake, commsMessage(message), 100))).toEqual([
      top(" From: codex-api (codex · /Users/ed/src/api) ", 98),
      row(" Can you review the parser change in src/parse.ts before I merge it? Thanks, codex.", 98),
      row(" To reply: comms_send to comms:codex-api · Ctrl+O to expand", 98),
      bottom(98),
    ]);
  });
});

test("pi card collapsed reply: exact lines at width 100", async () => {
  await withPi(fake => {
    expect(plain(renderLines(fake, commsMessage(reply), 100))).toEqual([
      top(" From: codex-api (codex · /Users/ed/src/api) ", 98),
      row(" Can you review the parser change in src/parse.ts before I merge it? Thanks, codex.", 98),
      row(" To reply: comms_send to comms:codex-api · Reply to 019a2b3b · Ctrl+O to expand", 98),
      bottom(98),
    ]);
  });
});

test("pi card expanded: exact lines at width 50, with the body wrapped to the inner width minus its one-space pad", async () => {
  await withPi(fake => {
    expect(plain(renderLines(fake, commsMessage(message), 50, { expanded: true }))).toEqual([
      top(" From: codex-api (codex · /Users/ed/src/api) ", 48),
      row(" Can you review the parser change in", 48),
      row(" src/parse.ts before I merge it?", 48),
      row("", 48),
      row(" Thanks, codex.", 48),
      row("", 48),
      row(" To reply: comms_send to comms:codex-api", 48),
      bottom(48),
    ]);
  });
});

test("pi card expanded reply: exact lines at width 50", async () => {
  await withPi(fake => {
    expect(plain(renderLines(fake, commsMessage(reply), 50, { expanded: true }))).toEqual([
      top(" From: codex-api (codex · /Users/ed/src/api) ", 48),
      row(" Can you review the parser change in", 48),
      row(" src/parse.ts before I merge it?", 48),
      row("", 48),
      row(" Thanks, codex.", 48),
      row("", 48),
      row(" To reply: comms_send to comms:codex-api", 48),
      row("", 48),
      row(" Reply to 019a2b3b", 48),
      bottom(48),
    ]);
  });
});

test("pi card collapsed colors: muted frame, toolTitle header, text preview, dim hint", async () => {
  await withPi(fake => {
    const lines = renderLines(fake, commsMessage(reply), 100, { theme: markerTheme });
    expect(lines).toHaveLength(4);
    for (const line of lines) expectMutedFrame(line);
    expectColor(lines[0]!, " From: codex-api (codex · /Users/ed/src/api) ", "toolTitle");
    expectColor(lines[1]!, "Can you review the parser change in src/parse.ts before I merge it? Thanks, codex.", "text");
    expectColor(lines[2]!, " To reply: comms_send to comms:codex-api · Reply to 019a2b3b · Ctrl+O to expand", "dim");
    expectWidths(lines, 100);
  });
});

test("pi card expanded colors: muted frame, toolTitle header, text body, dim reply lines", async () => {
  await withPi(fake => {
    const lines = renderLines(fake, commsMessage(reply), 50, { expanded: true, theme: markerTheme });
    expect(lines).toHaveLength(10);
    for (const line of lines) expectMutedFrame(line);
    expectColor(lines[0]!, " From: codex-api (codex · /Users/ed/src/api) ", "toolTitle");
    expectColor(lines[1]!, "Can you review the parser change in", "text");
    expectColor(lines[2]!, "src/parse.ts before I merge it?", "text");
    expectColor(lines[4]!, "Thanks, codex.", "text");
    expectColor(lines[6]!, " To reply: comms_send to comms:codex-api", "dim");
    expectColor(lines[8]!, " Reply to 019a2b3b", "dim");
    expectWidths(lines, 50);
  });
});

const bodies: Record<string, string> = {
  representative: body,
  "wide characters": "漢字のテキスト🐾と絵文字 mixed with ascii 漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字",
  "ANSI escapes": "\x1b[31mred\x1b[0m then \x1b[1mbold\x1b[22m and \x1b[4munderlined text that keeps going for a while\x1b[24m",
  "a very long word": "x".repeat(300),
  "a long URL then wide text": `see https://example.com/${"segment/".repeat(40)} then 漢字漢字`,
  "whitespace runs and blank lines": "  leading\n\n\n   gaps   between\n trailing  \n",
  empty: "",
};
const senders: Record<string, Omit<CommsMessageDetails, "body">> = {
  short: { from: "comms:codex-api", name: "codex-api", harness: "codex", cwd: "/Users/ed/src/api", id: message.id },
  long: { from: "comms:a-very-long-agent-name-that-goes-on-and-on", name: "a-very-long-agent-name-that-goes-on-and-on", harness: "claude",
    cwd: `/Users/ed/プロジェクト/深い/${"nested/".repeat(10)}`, id: message.id, reply_to: reply.reply_to },
};
const widths = [...Array.from({ length: 38 }, (_, i) => i + 3), 47, 48, 49, 50, 64, 80, 99, 100, 101, 120, 160];

for (const [bodyName, text] of Object.entries(bodies)) for (const [senderName, sender] of Object.entries(senders)) {
  test(`pi card width invariant: ${bodyName}, ${senderName} sender, widths 3 to 160, both states and themes`, async () => {
    await withPi(fake => {
      const sent = commsMessage({ ...sender, body: text });
      for (const width of widths) for (const expanded of [false, true]) for (const theme of [identityTheme, markerTheme]) {
        const lines = renderLines(fake, sent, width, { expanded, theme });
        const context = `width ${width}, ${expanded ? "expanded" : "collapsed"}`;
        if (!expanded) expect(lines, context).toHaveLength(4);
        expect(lines.length, context).toBeGreaterThanOrEqual(3);
        expectWidths(lines, width);
        const visible = plain(lines);
        expect(visible[0]!.startsWith("╭") && visible[0]!.endsWith("╮"), `${context}: ${visible[0]}`).toBe(true);
        for (const middle of visible.slice(1, -1)) expect(middle.startsWith("│") && middle.endsWith("│"), `${context}: ${middle}`).toBe(true);
        expect(visible.at(-1), context).toBe(`╰${"─".repeat(width - 2)}╯`);
      }
    });
  });
}

test("pi card below width 3 renders one line naming the sender, truncated to the width", async () => {
  await withPi(fake => {
    for (const expanded of [false, true]) for (const width of [0, 1, 2]) {
      const lines = renderLines(fake, commsMessage(reply), width, { expanded });
      expect(lines).toHaveLength(1);
      expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(width);
      const text = stripTerminalSequences(lines[0]!);
      expect("From codex-api".startsWith(text) || /^[.…]*$/.test(text), JSON.stringify(text)).toBe(true);
    }
    expect(plain(renderLines(fake, commsMessage(reply), 0))).toEqual([""]);
  });
});

test("pi card renders correctly when the same component is rendered at several widths and invalidated", async () => {
  await withPi(fake => {
    rendererOf(fake);
    for (const expanded of [false, true]) {
      const fresh = (width: number) => renderLines(fake, commsMessage(reply), width, { expanded });
      const component = fake.render(commsMessage(reply), { expanded, outputPad: 1 }, identityTheme)!;
      expect(component).toBeDefined();
      for (const width of [100, 30, 50, 7, 100]) expect(component.render(width)).toEqual(fresh(width));
      component.invalidate();
      expect(component.render(42)).toEqual(fresh(42));
      expect(component.render(100)).toEqual(fresh(100));
    }
  });
});

const malformed: [string, unknown][] = [
  ["missing details", undefined],
  ["null details", null],
  ["string details", "comms:codex-api"],
  ["number details", 42],
  ["array details", [message]],
  ["empty object", {}],
  ...(["name", "harness", "cwd", "body"] as const).map(field => {
    const { [field]: _omitted, ...rest } = message;
    return [`details without ${field}`, rest] as [string, unknown];
  }),
  ["a non-string name", { ...message, name: 7 }],
  ["a non-string cwd", { ...message, cwd: { path: "/Users/ed/src/api" } }],
  ["a non-string body", { ...message, body: null }],
  ["a non-string reply_to", { ...message, reply_to: 42 }],
];

test("pi renderer returns undefined for missing or malformed details, so Pi shows the content", async () => {
  await withPi(fake => {
    const renderer = rendererOf(fake);
    for (const [name, details] of malformed) for (const expanded of [false, true]) {
      const sent = { customType: "comms_message", content: "**From codex-api** (codex · /Users/ed/src/api)", display: true,
        ...(details === undefined ? {} : { details }) };
      expect(renderer({ role: "custom", ...sent, timestamp: 1 }, { expanded, outputPad: 1 }, identityTheme), name).toBeUndefined();
    }
    const valid = renderer({ role: "custom", ...commsMessage(message), timestamp: 1 }, { expanded: false, outputPad: 1 }, identityTheme);
    expect(valid?.render(80)).toHaveLength(4);
  });
});

test("the card lives in its own Pi adapter file that keeps Pi Intercom's MIT notice", () => {
  const directory = join(import.meta.dir, "../adapters/pi/src");
  const sources = readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter(file => file.endsWith(".ts") && file !== "index.ts")
    .map(file => readFileSync(join(directory, file), "utf8"));
  const card = sources.filter(source => source.includes("Copyright (c) 2026 Nico Bailon") && source.includes("MIT")
    && /from\s+["']@earendil-works\/pi-tui["']/.test(source));
  expect(card.length, "an adapter file other than index.ts drawing with pi-tui under Pi Intercom's MIT notice").toBeGreaterThanOrEqual(1);
});
