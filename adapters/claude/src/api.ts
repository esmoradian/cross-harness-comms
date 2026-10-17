// Manually maintained subset of Claude Code 2.1.289 generated mod types.
// No Node imports: Claude mods run in the harness sandbox. See tests/SOURCES.md.
export interface ProcessRunInit { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number }
export interface ProcessRunResult {
  exitCode: number; stdout: string; stderr: string;
  isStdoutTruncated: boolean; isStderrTruncated: boolean;
}
export interface ProcessSpawnRequest { argv: readonly string[]; cwd?: string; env?: Record<string, string>; input?: string }
export interface ProcessSpawnChunk { stream: "stdout" | "stderr"; text: string }
export interface ProcessSpawnResult { code: number | null; signal: string | null }
export type HookStream<C, R> = AsyncGenerator<C, R> & { readonly result: Promise<R> };
export type ToolEvent = { tool_use_id: string; agentId?: string } & (
  | { tool: "SendMessage"; to: unknown; message: string; summary?: string; notify_when_idle?: boolean }
  | { tool: "ListAgents" }
);
export type ToolResult = { result: unknown } | { deny: string };
export interface PromptInput { text: string; asUser?: true }
export interface ClaudeAPI {
  session: { id(): Promise<string>; cwd(): Promise<string> };
  prompt: { submit(input: PromptInput): Promise<{ text: string } | { drop: string }> };
  process: {
    run(argv: readonly string[], init?: ProcessRunInit): Promise<ProcessRunResult>;
    spawn(request: ProcessSpawnRequest): HookStream<ProcessSpawnChunk, ProcessSpawnResult>;
  };
}
export interface StartEvent { cwd: string; surface: null; isInteractive: boolean }
export interface ClaudeOn {
  (name: "tool.call", handler: ($: ClaudeAPI, event: ToolEvent,
    next: (event: ToolEvent) => Promise<ToolResult>) => Promise<ToolResult>): void;
  (name: "session.start", handler: ($: ClaudeAPI, event: StartEvent,
    next: (event: StartEvent) => Promise<{ cwd: string }>) => Promise<{ cwd: string }>): void;
}
