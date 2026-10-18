import type { Component } from "@earendil-works/pi-tui";
import type { PiAPI, PiContext, PiMessageRenderer, PiMessageRenderOptions, PiTheme, PiTool, PiToolResult } from "../../../adapters/pi/src/index.ts";

export class FakePi implements PiAPI {
  readonly calls: { method: string; args: unknown[] }[] = [];
  readonly tools = new Map<string, PiTool>();
  // Message renderers by custom type; Pi keeps one per type, so a later registration replaces an earlier one.
  readonly renderers = new Map<string, PiMessageRenderer>();
  readonly incoming: { message: Parameters<PiAPI["sendMessage"]>[0]; options: Parameters<PiAPI["sendMessage"]>[1] }[] = [];
  readonly userMessages: unknown[] = [];
  private handlers = new Map<string, Parameters<PiAPI["on"]>[1][]>();
  readonly context: PiContext;
  constructor(sessionId: string, cwd: string) {
    this.context = { cwd, sessionManager: { getSessionId: () => {
      this.calls.push({ method: "sessionManager.getSessionId", args: [] });
      return sessionId;
    } } };
  }
  registerTool(tool: PiTool) {
    this.calls.push({ method: "registerTool", args: [tool] });
    this.tools.set(tool.name, tool);
  }
  registerMessageRenderer(customType: string, renderer: PiMessageRenderer) {
    this.calls.push({ method: "registerMessageRenderer", args: [customType, renderer] });
    this.renderers.set(customType, renderer);
  }
  // Calls the renderer registered for a sent message's custom type with the CustomMessage Pi builds from it.
  // Unlike Pi, this does not catch a throwing renderer, so tests see the error instead of Pi's fallback.
  render(message: Parameters<PiAPI["sendMessage"]>[0], options: PiMessageRenderOptions, theme: PiTheme): Component | undefined {
    const renderer = this.renderers.get(message.customType);
    if (!renderer) throw new Error(`Pi message renderer not registered: ${message.customType}`);
    return renderer({ role: "custom", ...message, timestamp: 1_760_000_000_000 }, options, theme);
  }
  on(event: Parameters<PiAPI["on"]>[0], handler: Parameters<PiAPI["on"]>[1]) {
    this.calls.push({ method: "on", args: [event, handler] });
    this.handlers.set(event, [...this.handlers.get(event) ?? [], handler]);
  }
  async emit(event: "session_start" | "session_shutdown", reason = "startup") {
    this.calls.push({ method: event, args: [{ type: event, reason }, this.context] });
    for (const handler of this.handlers.get(event) ?? []) await handler({ type: event, reason }, this.context);
  }
  sendMessage(message: Parameters<PiAPI["sendMessage"]>[0], options?: Parameters<PiAPI["sendMessage"]>[1]) {
    this.calls.push({ method: "sendMessage", args: [message, options] });
    this.incoming.push({ message, options });
  }
  sendUserMessage(...args: unknown[]) {
    this.calls.push({ method: "sendUserMessage", args });
    this.userMessages.push(args);
  }
  async tool(name: string, args: Record<string, unknown>): Promise<PiToolResult> {
    this.calls.push({ method: "tool.execute", args: [name, args] });
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Pi tool not registered: ${name}`);
    return tool.execute(`fake-tool-call-${this.calls.length}`, args, undefined, undefined, this.context);
  }
}
