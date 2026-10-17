import { expect } from "bun:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { CommsMessageDetails, PiAPI, PiTheme } from "../adapters/pi/src/index.ts";
import type { FakePi } from "./fakes/pi.ts";

// The model-facing Markdown of a `comms_message` (ADR-017).
export function expectedContent(details: Omit<CommsMessageDetails, "from">): string {
  const replies = details.reply_to ? ` This replies to \`${details.reply_to}\`.` : "";
  return `**From ${details.name}** (${details.harness} · ${details.cwd})\n`
    + `Reply with comms_send to \`comms:${details.name}\` with reply_to \`${details.id}\`.${replies}\n\n${details.body}`;
}

export function detailsFor(fields: Omit<CommsMessageDetails, "from">): CommsMessageDetails {
  return { from: `comms:${fields.name}`, ...fields };
}

export function commsMessage(details: unknown): Parameters<PiAPI["sendMessage"]>[0] {
  const valid = details as CommsMessageDetails;
  return { customType: "comms_message", display: true, details,
    content: typeof valid?.name === "string" ? expectedContent(valid) : "fallback content" };
}

// Leaves text unchanged, so widths can be measured directly.
export const identityTheme: PiTheme = { fg: (_color, text) => text };

// Colors text with a distinct 256-color SGR code per theme color and resets the foreground after it,
// as Pi's themes do. Codes take no columns, so layout matches the identity theme.
const codes: Record<string, number> = { muted: 101, toolTitle: 102, text: 103, dim: 104 };
const colorByCode = new Map(Object.entries(codes).map(([color, code]) => [String(code), color]));
export const markerTheme: PiTheme = { fg: (color, text) => `\x1b[38;5;${codes[color] ?? 105}m${text}\x1b[39m` };

// Each visible character of a line with the theme color in effect, following terminal SGR semantics:
// a foreground or full reset ends the color, and other escape sequences leave it unchanged.
export function colored(line: string): { char: string; color: string | undefined }[] {
  const out: { char: string; color: string | undefined }[] = [];
  let color: string | undefined;
  for (let i = 0; i < line.length;) {
    const sgr = /^\x1b\[([0-9;]*)m/.exec(line.slice(i));
    if (sgr) {
      const code = sgr[1]!;
      if (code === "" || code === "0" || code === "39") color = undefined;
      else {
        const palette = /^38;5;(\d+)$/.exec(code);
        if (palette) color = colorByCode.get(palette[1]!) ?? "other";
      }
      i += sgr[0].length;
      continue;
    }
    const char = String.fromCodePoint(line.codePointAt(i)!);
    out.push({ char, color });
    i += char.length;
  }
  return out;
}

// Asserts every non-space character of `text`, found in the line's visible text, has `color`.
export function expectColor(line: string, text: string, color: string) {
  const chars = colored(line);
  const plain = chars.map(c => c.char);
  const target = Array.from(text);
  const start = plain.findIndex((_, i) => target.every((c, j) => plain[i + j] === c));
  expect(start, `"${text}" in "${plain.join("")}"`).toBeGreaterThanOrEqual(0);
  const found = chars.slice(start, start + target.length).filter(c => c.char.trim() !== "").map(c => c.color);
  expect(new Set(found), `color of "${text}"`).toEqual(new Set([color]));
}

// Asserts every frame glyph in the line is drawn in the theme's muted color.
export function expectMutedFrame(line: string) {
  const frame = colored(line).filter(c => "╭╮╰╯│─".includes(c.char));
  expect(frame.length).toBeGreaterThan(0);
  expect(new Set(frame.map(c => c.color)), `frame of "${stripTerminalSequences(line)}"`).toEqual(new Set(["muted"]));
}

export function plain(lines: string[]): string[] {
  return lines.map(line => stripTerminalSequences(line));
}

// Exact frame rows for an inner width, for text made only of one-column characters.
export const top = (header: string, inner: number) => `╭${header}${"─".repeat(inner - header.length)}╮`;
export const row = (text: string, inner: number) => `│${text}${" ".repeat(inner - text.length)}│`;
export const bottom = (inner: number) => `╰${"─".repeat(inner)}╯`;

export function rendererOf(fake: FakePi) {
  const renderer = fake.renderers.get("comms_message");
  expect(renderer, "comms_message renderer registered").toBeDefined();
  return renderer!;
}

// Renders a sent message through its registered renderer, as Pi does, and returns the lines.
export function renderLines(fake: FakePi, message: Parameters<PiAPI["sendMessage"]>[0], width: number,
  { expanded = false, theme = identityTheme }: { expanded?: boolean; theme?: PiTheme } = {}): string[] {
  rendererOf(fake);
  const component = fake.render(message, { expanded, outputPad: 1 }, theme);
  expect(component, "card component").toBeDefined();
  return component!.render(width);
}

export function expectWidths(lines: string[], width: number) {
  for (const line of lines) expect(visibleWidth(line), JSON.stringify(stripTerminalSequences(line))).toBe(width);
}
