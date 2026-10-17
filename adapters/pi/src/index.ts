import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connectSession, messageId, type SessionClient } from "@cross-harness-comms/client";
import { localRuntime } from "@cross-harness-comms/client/runtime";
import { formatMessage, sendSummary, SEND_SCHEMA, type Harness } from "@cross-harness-comms/protocol";
import type { AdapterHandle, AdapterRuntime } from "@cross-harness-comms/client";
import type { Component } from "@earendil-works/pi-tui";

// Structural subset of Pi 0.85.1 extension types. See tests/SOURCES.md.
export interface PiContext {
  cwd: string;
  sessionManager: { getSessionId(): string };
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
      pi.sendMessage({ customType: "cross-harness-message", content: formatMessage(delivery), display: true },
        { triggerTurn: true, deliverAs: "followUp" });
    });
  });
  pi.on("session_shutdown", close);
  for (const name of ["comms_send", "comms_list"]) pi.registerTool({
    name, label: name === "comms_send" ? "Send agent message" : "List agents",
    description: name === "comms_send" ? "Send to a comms address. Reply with reply_to set to the message ID." : "List cross-harness agents and their presence.",
    parameters: name === "comms_send" ? SEND_SCHEMA : { type: "object", properties: {} },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!session || ctx.sessionManager.getSessionId() !== nativeId) throw new Error("Session is not connected");
      const result = name === "comms_list" ? await session.list() : await session.send({
        id: messageId(), to: params.to as string, body: params.text as string,
        ...(typeof params.reply_to === "string" ? { reply_to: params.reply_to } : {}),
      });
      const text = "agents" in result ? JSON.stringify(result.agents.map(agent => ({ ...agent, address: `comms:${agent.name}` }))) : sendSummary(result);
      return { content: [{ type: "text", text }], details: result };
    },
  });
  return { close };
}

export default function extension(pi: PiAPI): void {
  const bundled = fileURLToPath(new URL("../bin/comms", import.meta.url));
  registerPi(pi, localRuntime(existsSync(bundled) ? bundled : "comms"));
}
