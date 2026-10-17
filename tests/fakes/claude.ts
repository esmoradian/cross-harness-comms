import { runCli, type CliRuntime } from "@cross-harness-comms/core/cli";
import type { ClaudeAPI, ClaudeOn, HookStream, ProcessRunInit, ProcessSpawnChunk, ProcessSpawnRequest, ProcessSpawnResult, PromptInput, StartEvent, ToolEvent, ToolResult } from "../../adapters/claude/src/api.ts";
import { deferred, Queue } from "../helpers.ts";

type ToolHandler = ($: ClaudeAPI, event: ToolEvent, next: (event: ToolEvent) => Promise<ToolResult>) => Promise<ToolResult>;
type StartHandler = ($: ClaudeAPI, event: StartEvent, next: (event: StartEvent) => Promise<{ cwd: string }>) => Promise<{ cwd: string }>;

export class FakeClaude {
  readonly calls: { method: string; args: unknown[] }[] = [];
  readonly incoming: PromptInput[] = [];
  readonly runs: { argv: readonly string[]; init?: ProcessRunInit }[] = [];
  readonly spawns: ProcessSpawnRequest[] = [];
  readonly nativeCalls: ToolEvent[] = [];
  readonly processOutput: { stream: string; text: string; command: string }[] = [];
  readonly api: ClaudeAPI;
  readonly on: ClaudeOn;
  acceptGate: Promise<void> = Promise.resolve();
  nativeResult: ToolResult = { result: "native message accepted" };
  nativeListing = "Native Claude peers\nworker [native-ref]";
  private toolHandlers: ToolHandler[] = [];
  private startHandlers: StartHandler[] = [];
  private aborters: AbortController[] = [];

  constructor(readonly sessionId: string, readonly cwd: string, runtime: CliRuntime) {
    this.on = ((name: string, handler: ToolHandler | StartHandler) => {
      this.calls.push({ method: "on", args: [name, handler] });
      if (name === "tool.call") this.toolHandlers.push(handler as ToolHandler);
      else if (name === "session.start") this.startHandlers.push(handler as StartHandler);
      else throw new Error(`Unsupported fake hook: ${name}`);
    }) as ClaudeOn;
    this.api = {
      session: {
        id: async () => { this.calls.push({ method: "session.id", args: [] }); return sessionId; },
        cwd: async () => { this.calls.push({ method: "session.cwd", args: [] }); return cwd; },
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
          return { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false };
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
          const generator = (async function* () {
            try {
              for (;;) {
                const event = await events.next();
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
  close() { for (const abort of this.aborters) abort.abort(); }
}

async function* textInput(text?: string) { if (text !== undefined) yield text; }
