// The card Pi draws for a `comms_message`, adapted from Pi Intercom 0.13.0's
// `ui/inline-message.ts` (InlineMessageComponent).
//
// MIT License
//
// Copyright (c) 2026 Nico Bailon
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { CommsMessageDetails, PiTheme } from "./index.ts";

class CommsCard implements Component {
  constructor(private details: CommsMessageDetails, private theme: PiTheme, private collapsed: boolean) {}

  invalidate(): void {}

  render(width: number): string[] {
    const { name, harness, cwd, body, reply_to } = this.details;
    const theme = this.theme;
    if (width < 3) return [truncateToWidth(`From ${name}`, width)];
    const inner = width - 2;
    // Departures from Pi Intercom: the header has no ` Ctrl+O expands `, since the collapsed footer
    // already says it, and body lines start one space in, like the header and the dim lines.
    const title = truncateToWidth(` From: ${name} (${harness} · ${cwd}) `, inner, "");
    const frame = (content: string) => {
      const text = truncateToWidth(content, inner, "");
      return theme.fg("muted", "│") + text + theme.fg("muted", `${" ".repeat(Math.max(0, inner - visibleWidth(text)))}│`);
    };
    const lines = [theme.fg("muted", "╭") + theme.fg("toolTitle", title) + theme.fg("muted", `${"─".repeat(Math.max(0, inner - visibleWidth(title)))}╮`)];
    const hint = `To reply: comms_send to comms:${name}`;
    const replyTo = reply_to ? `Reply to ${reply_to.slice(0, 8)}` : undefined;
    if (this.collapsed) {
      lines.push(frame(theme.fg("text", ` ${body.replace(/\s+/g, " ").trim()}`)));
      lines.push(frame(theme.fg("dim", ` ${[hint, ...(replyTo ? [replyTo] : []), "Ctrl+O to expand"].join(" · ")}`)));
    } else {
      for (const line of wrapTextWithAnsi(body, Math.max(1, inner - 1))) lines.push(frame(theme.fg("text", ` ${line}`)));
      lines.push(frame(""));
      for (const line of wrapTextWithAnsi(theme.fg("dim", ` ${hint}`), inner)) lines.push(frame(line));
      if (replyTo) lines.push(frame(""), frame(theme.fg("dim", ` ${replyTo}`)));
    }
    lines.push(theme.fg("muted", `╰${"─".repeat(inner)}╯`));
    return lines;
  }
}

// Returns the card for well-formed details, or undefined so Pi shows the message content instead.
export function renderCommsMessage(details: unknown, expanded: boolean, theme: PiTheme): Component | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const fields = details as Record<string, unknown>;
  if (["name", "harness", "cwd", "body"].some(key => typeof fields[key] !== "string")) return undefined;
  if (fields.reply_to !== undefined && typeof fields.reply_to !== "string") return undefined;
  return new CommsCard(fields as unknown as CommsMessageDetails, theme, !expanded);
}
