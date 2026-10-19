import type { Component } from "@earendil-works/pi-tui";
import type { PiAPI, PiCommandContext, PiMessageRenderer, PiMessageRenderOptions, PiTheme, PiTool, PiToolResult } from "../../../adapters/pi/src/index.ts";

// The events the fake emits, with the fields Pi 0.85.1 gives each (`SessionStartEvent`, `SessionShutdownEvent`,
// `SessionInfoChangedEvent` in `dist/core/extensions/types.d.ts`).
export type FakePiEvent = "session_start" | "session_shutdown" | "session_info_changed";
type Handler = (event: { type: string; reason?: string; name?: string | undefined }, ctx: PiCommandContext) => void | Promise<void>;

// One entry of the fake's agent loop, in the order Pi would put it in the session.
export type TimelineEntry = { kind: "tool_start" | "tool_end"; tool: string } | { kind: "message"; customType: string };

export class FakePi implements PiAPI {
  readonly calls: { method: string; args: unknown[] }[] = [];
  readonly tools = new Map<string, PiTool>();
  // Slash commands by name, and each `ctx.ui.notify` a command or event handler made.
  readonly commands = new Map<string, Parameters<PiAPI["registerCommand"]>[1]>();
  readonly notifications: { message: string; type?: "info" | "warning" | "error" }[] = [];
  // Message renderers by custom type; Pi keeps one per type, so a later registration replaces an earlier one.
  readonly renderers = new Map<string, PiMessageRenderer>();
  readonly incoming: { message: Parameters<PiAPI["sendMessage"]>[0]; options: Parameters<PiAPI["sendMessage"]>[1] }[] = [];
  readonly userMessages: unknown[] = [];
  // Pi's shared extension event bus, `pi.events` (`EventBus` in `dist/core/event-bus.d.ts`); `emitted` records every emit.
  readonly emitted: { channel: string; data: unknown }[] = [];
  readonly events = {
    emit: (channel: string, data: unknown) => {
      this.emitted.push({ channel, data });
      // Like Pi's EventEmitter: listeners run synchronously in order, and an async listener's rejection is only logged.
      for (const handler of [...this.listeners.get(channel) ?? []]) void (async () => { await handler(data); })().catch(() => {});
    },
    on: (channel: string, handler: (data: unknown) => void): (() => void) => {
      this.calls.push({ method: "events.on", args: [channel, handler] });
      this.listeners.set(channel, [...this.listeners.get(channel) ?? [], handler]);
      return () => this.listeners.set(channel, (this.listeners.get(channel) ?? []).filter(h => h !== handler));
    },
  };
  // The agent loop: `streaming` while a tool runs, steer and follow-up messages held until it ends.
  readonly timeline: TimelineEntry[] = [];
  private streaming = false;
  private held: { customType: string }[] = [];
  private listeners = new Map<string, ((data: unknown) => void)[]>();
  private handlers = new Map<string, Handler[]>();
  private sessionName: string | undefined;
  // The last `session_info_changed` dispatch, so a test can wait for its handlers.
  private infoChanged: Promise<void> = Promise.resolve();
  readonly context: PiCommandContext;
  // `sessionName` is the name Pi already has at session start, as with `pi -n <name>` or a resumed named session.
  constructor(sessionId: string, cwd: string, options: { sessionName?: string } = {}) {
    this.sessionName = options.sessionName;
    this.context = { cwd, sessionManager: { getSessionId: () => {
      this.calls.push({ method: "sessionManager.getSessionId", args: [] });
      return sessionId;
    } }, ui: { notify: (message, type) => {
      this.notifications.push({ message, ...(type ? { type } : {}) });
    } } };
  }
  registerTool(tool: PiTool) {
    this.calls.push({ method: "registerTool", args: [tool] });
    this.tools.set(tool.name, tool);
  }
  registerCommand(name: string, options: Parameters<PiAPI["registerCommand"]>[1]) {
    this.calls.push({ method: "registerCommand", args: [name, options] });
    this.commands.set(name, options);
  }
  // Runs `/<name> <args>` as Pi does: the handler gets the text after the name and a context whose `ui.notify` is recorded.
  async command(name: string, args: string): Promise<void> {
    this.calls.push({ method: "command", args: [name, args] });
    const command = this.commands.get(name);
    if (!command) throw new Error(`Pi command not registered: ${name}`);
    await command.handler(args, this.context);
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
  on(event: string, handler: Handler) {
    this.calls.push({ method: "on", args: [event, handler] });
    this.handlers.set(event, [...this.handlers.get(event) ?? [], handler]);
  }
  async emit(event: FakePiEvent, reason = "startup") {
    const payload = event === "session_info_changed" ? { type: event, name: this.getSessionName() } : { type: event, reason };
    this.calls.push({ method: event, args: [payload, this.context] });
    for (const handler of this.handlers.get(event) ?? []) await handler(payload, this.context);
  }
  // `pi.getSessionName()`: the latest name, trimmed, or undefined when unset or cleared (`SessionManager.getSessionName`).
  getSessionName(): string | undefined {
    this.calls.push({ method: "getSessionName", args: [] });
    return this.sessionName?.trim() || undefined;
  }
  // `pi.setSessionName(name)`: Pi stores the name with line breaks turned into spaces and trimmed, then fires
  // `session_info_changed` without waiting for its handlers (`AgentSession.setSessionName`); `renamed()` waits for them.
  setSessionName(name: string) {
    this.calls.push({ method: "setSessionName", args: [name] });
    this.sessionName = name.replace(/[\r\n]+/g, " ").trim();
    this.infoChanged = this.emit("session_info_changed");
  }
  renamed(): Promise<void> { return this.infoChanged; }
  sendMessage(message: Parameters<PiAPI["sendMessage"]>[0], options?: Parameters<PiAPI["sendMessage"]>[1]) {
    this.calls.push({ method: "sendMessage", args: [message, options] });
    this.incoming.push({ message, options });
    // While streaming, `steer` (the default) and `followUp` wait for the running tool calls; `nextTurn` waits for a prompt.
    if (!this.streaming) this.timeline.push({ kind: "message", customType: message.customType });
    else if (options?.deliverAs !== "nextTurn") this.held.push({ customType: message.customType });
  }
  // Starts a tool call in a streaming turn and returns the function that finishes it, after which the held messages arrive.
  toolRunning(tool = "bash"): () => void {
    this.streaming = true;
    this.timeline.push({ kind: "tool_start", tool });
    return () => {
      this.timeline.push({ kind: "tool_end", tool });
      for (const message of this.held.splice(0)) this.timeline.push({ kind: "message", ...message });
      this.streaming = false;
    };
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
