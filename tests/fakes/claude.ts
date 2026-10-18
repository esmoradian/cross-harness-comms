import { createServer, type Server } from "node:net";
import { runCli, type CliRuntime } from "@cross-harness-comms/core/cli";
import type { ClaudeAPI, ClaudeOn, HookStream, ProcessRunInit, ProcessRunResult, ProcessSpawnChunk, ProcessSpawnRequest, ProcessSpawnResult, PromptInput,
  SessionReceiveInput, SessionReceiveOrigin, SessionReceiveResult, SessionVersion, StartEvent, ToolEvent, ToolResult } from "../../adapters/claude/src/api.ts";
import { deferred, Queue } from "../helpers.ts";

type ToolHandler = ($: ClaudeAPI, event: ToolEvent, next: (event: ToolEvent) => Promise<ToolResult>) => Promise<ToolResult>;
type StartHandler = ($: ClaudeAPI, event: StartEvent, next: (event: StartEvent) => Promise<{ cwd: string }>) => Promise<{ cwd: string }>;
type ReceiveHandler = ($: ClaudeAPI, event: SessionReceiveInput, next: (event: SessionReceiveInput) => Promise<SessionReceiveResult>) => Promise<SessionReceiveResult>;

// What Claude Code 2.1.289's $.session.version() resolved in a real session on 2026-10-17.
export const CLAUDE_VERSION: SessionVersion = { version: "2.1.289", base: "2.1.289", builtAt: "2026-10-03T19:21:39Z" };

// A Claude session's inbox socket (CLAUDE_CODE_MESSAGING_SOCKET). Like Claude Code 2.1.289,
// it reads newline-terminated JSON lines, never writes back, and hands each line to the session.
// `hold` swallows lines without running the session's hooks; `release()` runs them later.
export class FakeClaudeInbox {
  readonly lines: string[] = [];
  readonly connections: { data: string; ended: boolean }[] = [];
  hold = false;
  private held: string[] = [];
  private server: Server | undefined;
  constructor(readonly path: string, private readonly receive?: (line: string) => Promise<unknown>) {}
  listen(): Promise<void> {
    const server = createServer(socket => {
      const connection = { data: "", ended: false };
      this.connections.push(connection);
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        connection.data += chunk;
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          this.lines.push(line);
          if (this.hold) this.held.push(line);
          else void this.receive?.(line);
        }
      });
      socket.on("end", () => { connection.ended = true; });
      socket.on("error", () => {});
    });
    this.server = server;
    return new Promise((resolve, reject) => { server.once("error", reject); server.listen(this.path, () => resolve()); });
  }
  async release() {
    this.hold = false;
    for (const line of this.held.splice(0)) await this.receive?.(line);
  }
  close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    return new Promise(resolve => { if (server) server.close(() => resolve()); else resolve(); });
  }
}

export class FakeClaude {
  readonly calls: { method: string; args: unknown[] }[] = [];
  readonly incoming: PromptInput[] = [];
  readonly runs: { argv: readonly string[]; init?: ProcessRunInit }[] = [];
  readonly spawns: ProcessSpawnRequest[] = [];
  readonly nativeCalls: ToolEvent[] = [];
  readonly processOutput: { stream: string; text: string; command: string }[] = [];
  readonly completedRuns: { argv: readonly string[]; stdin?: string; result: ProcessRunResult }[] = [];
  // Inbound deliveries the session.receive chain let through, and every chain's answer.
  readonly queued: string[] = [];
  readonly receipts: { input: SessionReceiveInput; result: SessionReceiveResult }[] = [];
  inbox: FakeClaudeInbox | undefined;
  readonly api: ClaudeAPI & { clock: {
    now(): Promise<number>;
    sleep(ms: number, options?: { signal?: AbortSignal }): Promise<void>;
    after(delay: number, callback: () => void | Promise<void>): { cancel(): void };
  } };
  static readonly pluginRoot = "/fake/plugins/cross-harness-comms";
  readonly on: ClaudeOn;
  acceptGate: Promise<void> = Promise.resolve();
  nativeResult: ToolResult = { result: "native message accepted" };
  nativeListing = "Native Claude peers\nworker [native-ref]";
  // When set, $.clock.now() resolves this epoch time instead of the real clock.
  time: number | undefined;
  loseNextSendReceipt = false;
  readonly backgroundErrors: unknown[] = [];
  private timers: { delay: number; callback: () => void | Promise<void>; cancelled: boolean }[] = [];
  private toolHandlers: ToolHandler[] = [];
  private startHandlers: StartHandler[] = [];
  private receiveHandlers: ReceiveHandler[] = [];
  private attachHold: ReturnType<typeof deferred<void>> | undefined;
  private aborters: AbortController[] = [];

  // `env` is the session's environment; Claude Code sets CLAUDE_CODE_MESSAGING_SOCKET in it.
  readonly env: Record<string, string>;
  version: SessionVersion;

  constructor(readonly sessionId: string, readonly cwd: string, runtime: CliRuntime,
    options: { env?: Record<string, string>; version?: SessionVersion } = {}) {
    this.env = { ...options.env };
    this.version = options.version ?? CLAUDE_VERSION;
    this.on = ((name: string, handler: ToolHandler | StartHandler | ReceiveHandler) => {
      this.calls.push({ method: "on", args: [name, handler] });
      if (name === "tool.call") this.toolHandlers.push(handler as ToolHandler);
      else if (name === "session.start") this.startHandlers.push(handler as StartHandler);
      else if (name === "session.receive") this.receiveHandlers.push(handler as ReceiveHandler);
      else throw new Error(`Unsupported fake hook: ${name}`);
    }) as ClaudeOn;
    this.api = {
      env: { get: async name => { this.calls.push({ method: "env.get", args: [name] }); return this.env[name]; } },
      clock: {
        now: async () => { this.calls.push({ method: "clock.now", args: [] }); return this.time ?? Date.now(); },
        sleep: async (ms, options) => {
          this.calls.push({ method: "clock.sleep", args: [ms, options] });
          if (options?.signal?.aborted) throw options.signal.reason;
        },
        after: (delay, callback) => {
          this.calls.push({ method: "clock.after", args: [delay, callback] });
          const timer = { delay, callback, cancelled: false };
          if (delay === 0) queueMicrotask(() => this.fire(timer));
          else this.timers.push(timer);
          return { cancel: () => { timer.cancelled = true; } };
        },
      },
      // Installed-build types: $.plugin.root is the plugin's absolute directory.
      plugin: { name: "cross-harness-comms", root: FakeClaude.pluginRoot },
      session: {
        id: async () => { this.calls.push({ method: "session.id", args: [] }); return sessionId; },
        cwd: async () => { this.calls.push({ method: "session.cwd", args: [] }); return cwd; },
        version: async () => { this.calls.push({ method: "session.version", args: [] }); return { ...this.version }; },
      },
      prompt: { submit: async (input) => {
        this.calls.push({ method: "prompt.submit", args: [input] });
        this.incoming.push(input);
        await this.acceptGate;
        return { text: input.text };
      } },
      process: {
        run: async (argv, init) => {
          this.calls.push({ method: "process.run", args: [argv, init] });
          this.runs.push({ argv, ...(init ? { init } : {}) });
          let stdout = "", stderr = "";
          const abort = new AbortController();
          this.aborters.push(abort);
          const exitCode = await runCli(argv.slice(1), {
            stdin: textInput(init?.stdin), signal: abort.signal,
            stdout: text => { stdout += text; this.processOutput.push({ stream: "stdout", text, command: argv[1]! }); },
            stderr: text => { stderr += text; this.processOutput.push({ stream: "stderr", text, command: argv[1]! }); },
          }, runtime);
          let result: ProcessRunResult = { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false };
          if (argv[1] === "send" && exitCode === 0 && this.loseNextSendReceipt) {
            this.loseNextSendReceipt = false;
            result = { exitCode: 1, stdout: "", stderr: "DISCONNECTED: send receipt lost", isStdoutTruncated: false, isStderrTruncated: false };
          }
          this.completedRuns.push({ argv, ...(init?.stdin === undefined ? {} : { stdin: init.stdin }), result });
          return result;
        },
        spawn: request => {
          this.calls.push({ method: "process.spawn", args: [request] });
          this.spawns.push(request);
          const abort = new AbortController();
          this.aborters.push(abort);
          type Event = { chunk: ProcessSpawnChunk } | { done: ProcessSpawnResult } | { error: unknown };
          const events = new Queue<Event>();
          const result = deferred<ProcessSpawnResult>();
          // Consumers may await .result or iterate. Both must see failures without unhandled rejections.
          void result.promise.catch(() => {});
          const output = (stream: "stdout" | "stderr", text: string) => {
            this.processOutput.push({ stream, text, command: request.argv[1]! });
            // Host chunks are not lines. Split through protocol field names deliberately.
            for (let i = 0; i < text.length; i += 7) events.push({ chunk: { stream, text: text.slice(i, i + 7) } });
          };
          void (async () => {
            try {
              const code = await runCli(request.argv.slice(1), {
                stdin: textInput(request.input), signal: abort.signal,
                stdout: text => output("stdout", text), stderr: text => output("stderr", text),
              }, runtime);
              const done = { code, signal: null };
              result.resolve(done); events.push({ done });
            } catch (error) { result.reject(error); events.push({ error }); }
          })();
          const attach = request.argv[1] === "attach";
          const fake = this;
          const generator = (async function* () {
            try {
              for (;;) {
                const event = await events.next();
                // The host may hand over a child's output late; tests hold attach output to order it.
                while (attach && fake.attachHold) await fake.attachHold.promise;
                if ("error" in event) throw event.error;
                if ("done" in event) return event.done;
                yield event.chunk;
              }
            } finally { abort.abort(); }
          })();
          return Object.assign(generator, { result: result.promise }) as HookStream<ProcessSpawnChunk, ProcessSpawnResult>;
        },
      },
    };
  }

  async start() {
    const event: StartEvent = { cwd: this.cwd, surface: null, isInteractive: false };
    this.calls.push({ method: "session.start", args: [event] });
    const dispatch = async (i: number, e: StartEvent): Promise<{ cwd: string }> => {
      const hook = this.startHandlers[i];
      return hook ? hook(this.api, e, next => dispatch(i + 1, next)) : { cwd: e.cwd };
    };
    return dispatch(0, event);
  }
  async tool(event: ToolEvent): Promise<ToolResult> {
    this.calls.push({ method: "tool.call", args: [event] });
    const dispatch = async (i: number, e: ToolEvent): Promise<ToolResult> => {
      const hook = this.toolHandlers[i];
      if (hook) return hook(this.api, e, next => dispatch(i + 1, next));
      this.nativeCalls.push(e);
      return e.tool === "ListAgents" ? { result: { listing: this.nativeListing } } : this.nativeResult;
    };
    return dispatch(0, event);
  }
  // Runs the session.receive chain as Claude Code does for an inbound delivery.
  // The innermost `next` queues the delivery and resolves `{ text }`.
  async receive(input: SessionReceiveInput): Promise<SessionReceiveResult> {
    this.calls.push({ method: "session.receive", args: [input] });
    const dispatch = async (i: number, e: SessionReceiveInput): Promise<SessionReceiveResult> => {
      const hook = this.receiveHandlers[i];
      if (hook) return hook(this.api, e, next => dispatch(i + 1, next));
      this.queued.push(e.text);
      return { text: e.text };
    };
    const result = await dispatch(0, input);
    this.receipts.push({ input, result });
    return result;
  }
  // A line posted to the inbox socket reaches session.receive as a peer delivery whose text is
  // the line's `message.content` verbatim, and whose origin names the sending plugin when it has one.
  private async receiveLine(line: string) {
    let parsed: { message?: { content?: unknown }; from_plugin?: unknown };
    try { parsed = JSON.parse(line); } catch { return; }
    if (typeof parsed?.message?.content !== "string") return;
    const origin: SessionReceiveOrigin = typeof parsed.from_plugin === "string" ? { kind: "peer", plugin: parsed.from_plugin } : { kind: "peer" };
    await this.receive({ origin, text: parsed.message.content }).catch(error => { this.backgroundErrors.push(error); });
  }
  async listenInbox(path: string): Promise<FakeClaudeInbox> {
    const inbox = new FakeClaudeInbox(path, line => this.receiveLine(line));
    await inbox.listen();
    this.inbox = inbox;
    return inbox;
  }
  holdAttachOutput() { this.attachHold ??= deferred<void>(); }
  releaseAttachOutput() {
    const hold = this.attachHold;
    this.attachHold = undefined;
    hold?.resolve();
  }
  private fire(timer: { callback: () => void | Promise<void>; cancelled: boolean }) {
    if (!timer.cancelled) void Promise.resolve().then(timer.callback).catch(error => this.backgroundErrors.push(error));
  }
  runScheduled() {
    for (const timer of this.timers.splice(0)) this.fire(timer);
  }
  close() {
    for (const timer of this.timers) timer.cancelled = true;
    this.releaseAttachOutput();
    for (const abort of this.aborters) abort.abort();
    void this.inbox?.close();
  }
}

async function* textInput(text?: string) { if (text !== undefined) yield text; }
