import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connectSession, type SessionClient } from "@cross-harness-comms/client";
import { localRuntime } from "@cross-harness-comms/client/runtime";
import { activeAgo, addressName, COMMS_TOOLS, hiddenLine, messageId, normalizeName, resolveAddress, sendSummary, type Harness } from "@cross-harness-comms/protocol";
import { renderCommsMessage } from "./card.ts";
import type { AdapterHandle, AdapterRuntime } from "@cross-harness-comms/client";
import type { Component } from "@earendil-works/pi-tui";

// Structural subset of Pi 0.85.1 extension types.
export interface PiContext {
  cwd: string;
  sessionManager: { getSessionId(): string };
}
// An event or command handler's context: Pi's ExtensionContext or ExtensionCommandContext, of which only `ui.notify` is used.
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

// The `details` of a `comms_message`, which the card renders.
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
  on(event: "session_start" | "session_shutdown" | "session_info_changed",
    handler: (event: { type: string; reason?: string; name?: string | undefined }, ctx: PiCommandContext) => void | Promise<void>): void;
  // Pi's extension event bus, which the outbox listens on.
  events: { emit(channel: string, data: unknown): void; on(channel: string, handler: (data: unknown) => void): () => void };
  getSessionName(): string | undefined;
  sendMessage(message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }): void;
}

const OUTBOX_REQUEST = "comms:outbox-request", OUTBOX_RESULT = "comms:outbox-result";

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
      // Pi Intercom's Markdown, without a tag or authority note; the card draws `details`.
      const replies = message.reply_to ? ` This replies to \`${message.reply_to}\`.` : "";
      const content = `**From ${name}** (${harness} · ${cwd})\nReply with comms_send to \`${from}\` with reply_to \`${message.id}\`.${replies}\n\n${message.body}`;
      // Starts a turn when Pi is idle and steers a busy session.
      pi.sendMessage({ customType: "comms_message", content, display: true, details }, { triggerTurn: true, deliverAs: "steer" });
    });
    await followSessionName(ctx);
  });
  pi.on("session_shutdown", close);
  // The Pi session name, normalized, is this session's chosen comms name.
  const followSessionName = async (ctx: PiCommandContext) => {
    const name = normalizeName(pi.getSessionName() ?? "");
    if (!name || !session || ctx.sessionManager.getSessionId() !== nativeId) return;
    try { await session.name(name); }
    catch (error) { ctx.ui.notify(`Comms kept its name instead of ${name}: ${error instanceof Error ? error.message : "naming failed"}`, "warning"); }
  };
  pi.on("session_info_changed", (_event, ctx) => followSessionName(ctx));
  const chooseName = async (name: string, ctx: PiContext) => {
    if (!session || ctx.sessionManager.getSessionId() !== nativeId) throw new Error("Session is not connected");
    return `This session is now comms:${(await session.name(name)).name}.`;
  };
  // Pi Intercom owns /alias.
  pi.registerCommand("comms-name", { description: "Choose this session's comms name", async handler(args, ctx) {
    if (!args.trim()) { ctx.ui.notify("Usage: /comms-name <name>", "error"); return; }
    try { ctx.ui.notify(await chooseName(args.trim(), ctx), "info"); }
    catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Naming failed", "error"); }
  } });
  pi.registerMessageRenderer("comms_message", (message, options, theme) => renderCommsMessage(message.details, options.expanded, theme));
  for (const { name, description, inputSchema } of COMMS_TOOLS) pi.registerTool({
    name, label: { comms_send: "Send agent message", comms_list: "List agents", comms_name: "Choose comms name" }[name], description, parameters: inputSchema,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (name === "comms_name") {
        const text = await chooseName(params.name as string, ctx);
        return { content: [{ type: "text", text }], details: {} };
      }
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
  pi.events.on(OUTBOX_REQUEST, data => { void outbox(data); });
  // Pi Intercom 0.13.0's outbox v1 on comms' own events, so other extensions send as this session without a tool call.
  const used = new Set<string>();
  const outbox = async (data: unknown) => {
    const request = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
    const { requestId, extensionId, extensionName, to, message } = request;
    // Without version 1 the request is not ours, and without a requestId it cannot be answered.
    if (request.version !== 1 || typeof requestId !== "string" || !requestId) return;
    const answer = (status: string, fields: { code?: string; messageId?: string; detail?: string }) =>
      pi.events.emit(OUTBOX_RESULT, { version: 1, requestId, status, ...fields,
        ...(typeof extensionId === "string" ? { extensionId } : {}), ...(typeof extensionName === "string" ? { extensionName } : {}) });
    const text = (value: unknown) => typeof value === "string" && !!value.trim();
    if (!text(extensionId) || !text(extensionName) || !text(to) || typeof message !== "string")
      return answer("failed", { code: "invalid_request", detail: "Expected nonempty extensionId, extensionName, and to, and a string message" });
    if (used.has(requestId)) return answer("failed", { code: "duplicate_request", detail: "This requestId was already answered" });
    used.add(requestId);
    const current = session;
    if (!current) return answer("failed", { code: "session_unavailable", detail: "This session is not connected to comms" });
    try {
      const { agents } = await current.list({ include_stale: true });
      let target;
      try { target = resolveAddress(to as string, agents); }
      catch (error) {
        const code = (error as { data?: { code?: string } }).data?.code === "AMBIGUOUS_RECIPIENT" ? "target_ambiguous" : "target_not_found";
        return answer("blocked", { code, detail: error instanceof Error ? error.message : code });
      }
      if (target.harness === "pi" && target.session_key === nativeId) return answer("blocked", { code: "self_target", detail: "That address is this session" });
      // Sent by ID, so the message reaches the agent checked above even if a name moves meanwhile.
      const result = await current.send({ id: messageId(Date.now()), to: target.id, body: message as string });
      answer("sent", { messageId: result.id, detail: sendSummary(result) });
    } catch (error) {
      answer("failed", { code: "delivery_failed", detail: error instanceof Error ? error.message : "Delivery failed" });
    }
  };
  return { close };
}

export default function extension(pi: PiAPI): void {
  const bundled = fileURLToPath(new URL("../bin/comms", import.meta.url));
  registerPi(pi, localRuntime(existsSync(bundled) ? bundled : "comms"));
}
