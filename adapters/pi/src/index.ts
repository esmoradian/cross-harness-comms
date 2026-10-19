import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connectSession, type SessionClient } from "@cross-harness-comms/client";
import { localRuntime } from "@cross-harness-comms/client/runtime";
import { activeAgo, addressName, COMMS_TOOLS, hiddenLine, messageId, sendSummary, type Harness } from "@cross-harness-comms/protocol";
import { renderCommsMessage } from "./card.ts";
import type { AdapterHandle, AdapterRuntime } from "@cross-harness-comms/client";
import type { Component } from "@earendil-works/pi-tui";

// Structural subset of Pi 0.85.1 extension types. See tests/SOURCES.md.
export interface PiContext {
  cwd: string;
  sessionManager: { getSessionId(): string };
}
// A command handler's context: Pi's ExtensionCommandContext, of which only `ui.notify` is used.
export interface PiCommandContext extends PiContext {
  ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
}
export interface PiToolResult {
  content: { type: "text"; text: string }[];
  details: unknown;
}
export interface PiTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute(id: string, params: Record<string, unknown>, signal: AbortSignal | undefined,
    onUpdate: ((result: PiToolResult) => void) | undefined, ctx: PiContext): Promise<PiToolResult>;
}
// A custom message as Pi passes it to a message renderer.
export interface PiCustomMessage {
  role: "custom";
  customType: string;
  content: string | { type: string; text?: string }[];
  display: boolean;
  details?: unknown;
  timestamp: number;
}
export interface PiTheme {
  fg(color: string, text: string): string;
}
export interface PiMessageRenderOptions {
  expanded: boolean;
  outputPad: number;
}
export type PiMessageRenderer = (message: PiCustomMessage, options: PiMessageRenderOptions, theme: PiTheme) => Component | undefined;

// The `details` of a `comms_message`, which the card renders (ADR-017).
export interface CommsMessageDetails {
  // The sender's `comms:` address, and `name` is that address without `comms:`.
  from: string;
  name: string;
  harness: Harness;
  cwd: string;
  id: string;
  reply_to?: string;
  body: string;
}

export interface PiAPI {
  registerTool(tool: PiTool): void;
  registerCommand(name: string, options: { description?: string; handler(args: string, ctx: PiCommandContext): Promise<void> }): void;
  registerMessageRenderer(customType: string, renderer: PiMessageRenderer): void;
  on(event: "session_start" | "session_shutdown",
    handler: (event: { type: string; reason?: string }, ctx: PiContext) => void | Promise<void>): void;
  sendMessage(message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }): void;
}

export function registerPi(pi: PiAPI, runtime: AdapterRuntime): AdapterHandle {
  let session: SessionClient | undefined;
  let nativeId: string | undefined;
  const close = async () => { const previous = session; session = undefined; nativeId = undefined; await previous?.close(); };
  pi.on("session_start", async (_event, ctx) => {
    await close();
    nativeId = ctx.sessionManager.getSessionId();
    session = await connectSession(runtime, { harness: "pi", session_key: nativeId, host: runtime.host, cwd: ctx.cwd }, async delivery => {
      const { message, from, harness } = delivery;
      const name = addressName(from), cwd = delivery.cwd ?? "";
      const details: CommsMessageDetails = { from, name, harness, cwd, id: message.id, ...(message.reply_to ? { reply_to: message.reply_to } : {}), body: message.body };
      // Pi Intercom's Markdown, without a tag or authority note; the card draws `details` (ADR-017).
      const replies = message.reply_to ? ` This replies to \`${message.reply_to}\`.` : "";
      const content = `**From ${name}** (${harness} · ${cwd})\nReply with comms_send to \`${from}\` with reply_to \`${message.id}\`.${replies}\n\n${message.body}`;
      // Starts a turn when Pi is idle and steers a busy session.
      pi.sendMessage({ customType: "comms_message", content, display: true, details }, { triggerTurn: true, deliverAs: "steer" });
    });
  });
  pi.on("session_shutdown", close);
  pi.registerMessageRenderer("comms_message", (message, options, theme) => renderCommsMessage(message.details, options.expanded, theme));
  for (const { name, description, inputSchema } of COMMS_TOOLS) pi.registerTool({
    name, label: name === "comms_send" ? "Send agent message" : "List agents", description, parameters: inputSchema,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!session || ctx.sessionManager.getSessionId() !== nativeId) throw new Error("Session is not connected");
      const result = name === "comms_list" ? await session.list({ include_stale: params.all === true }) : await session.send({
        id: messageId(Date.now()), to: params.to as string, body: params.text as string,
        ...(typeof params.reply_to === "string" ? { reply_to: params.reply_to } : {}),
      });
      const text = "agents" in result ? [
        ...result.agents.map(a => [a.name, a.harness, a.presence, activeAgo(a, Date.now()), a.cwd, `comms:${a.name}`].join(" · ")),
        ...(result.hidden ? [hiddenLine(result.hidden)] : []),
      ].join("\n") : sendSummary(result);
      return { content: [{ type: "text", text }], details: result };
    },
  });
  return { close };
}

export default function extension(pi: PiAPI): void {
  const bundled = fileURLToPath(new URL("../bin/comms", import.meta.url));
  registerPi(pi, localRuntime(existsSync(bundled) ? bundled : "comms"));
}
