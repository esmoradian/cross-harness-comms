import type { CodexRuntime, McpCall, SessionStartInput } from "../../adapters/codex/src/index.ts";

export class FakeCodex {
  readonly calls: { method: string; args: unknown[] }[] = [];
  readonly commands: (readonly string[])[] = [];
  readonly requests: McpCall[] = [];
  readonly hooks: SessionStartInput[] = [];
  acceptGate: Promise<void> = Promise.resolve();
  exitCode = 0;
  constructor(readonly threadId: string, readonly cwd: string, readonly parentPid: number) {}
  run: CodexRuntime["run"] = async argv => {
    this.calls.push({ method: "run", args: [argv] });
    this.commands.push(argv);
    await this.acceptGate;
    return { exitCode: this.exitCode, stdout: "", stderr: this.exitCode ? "queue refused" : "" };
  };
  sessionStart(): SessionStartInput {
    const input: SessionStartInput = { hook_event_name: "SessionStart", session_id: this.threadId,
      cwd: this.cwd, source: "startup", model: "fixture-model" };
    this.calls.push({ method: "SessionStart", args: [input] });
    this.hooks.push(input);
    return input;
  }
  request(name: string, args: Record<string, unknown>, metadata: unknown = { thread_id: this.threadId, session_id: "fixture-turn-session" }): McpCall {
    const request: McpCall = {
      jsonrpc: "2.0", id: this.requests.length + 1, method: "tools/call",
      params: { name, arguments: args, ...(metadata === null ? {} : { _meta: { "x-codex-turn-metadata": metadata } }) },
    };
    this.calls.push({ method: "tools/call", args: [request] });
    this.requests.push(request);
    return request;
  }
}
