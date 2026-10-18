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
// `$.session.version()`: the engine's full version, its release base, and build time.
export interface SessionVersion { version: string; base?: string; builtAt?: string }
// `session.receive`: one inbound delivery before it is queued. `event` is omitted from this subset.
export type SessionReceiveOrigin =
  | { kind: "bridge" | "task-notification" | "scheduled-trigger" | "peer-send-message" | "projects-relay" | "slack-ping" | "unclassified" }
  | { kind: "peer" | "coordinator"; plugin?: string }
  | { kind: "peer" | "coordinator"; plugin?: string; teammate: string; isVerified: boolean };
export interface SessionReceiveInput { origin: SessionReceiveOrigin; text: string; agentId?: string }
export type SessionReceiveResult = { text: string; consumed?: undefined } | { consumed: string; text?: undefined };
export interface ClaudeAPI {
  plugin: { name: string; root: string };
  env?: { get(name: string): Promise<string | undefined> };
  ui?: { log(text: string): void };
  clock?: { now(): Promise<number>; after(delay: number, callback: () => void | Promise<void>): { cancel(): void } };
  session: { id(): Promise<string>; cwd(): Promise<string>; version?(): Promise<SessionVersion> };
  prompt: { submit(input: PromptInput): Promise<{ text: string } | { drop: string }> };
  process: {
    run(argv: readonly string[], init?: ProcessRunInit): Promise<ProcessRunResult>;
    spawn(request: ProcessSpawnRequest): HookStream<ProcessSpawnChunk, ProcessSpawnResult>;
  };
}
export interface StartEvent { cwd: string; surface: null; isInteractive: boolean }
export interface EndEvent { reason: "clear" | "resume" | "logout" | "prompt_input_exit" | "other"; sessionId: string; resume: { id: string } }
export interface ClassicStartEvent { hook_event_name: "SessionStart"; session_id: string; cwd: string; source: "startup" | "resume" | "clear" | "compact" | "fork" }
export interface ClaudeOn {
  (name: "session.end", handler: ($: ClaudeAPI, event: EndEvent,
    next: (event: EndEvent) => Promise<{ sessionId: string }>) => Promise<{ sessionId: string }>): void;
  (name: "classic.SessionStart", handler: ($: ClaudeAPI, event: ClassicStartEvent,
    next: (event: ClassicStartEvent) => Promise<unknown>) => Promise<unknown>): void;
  (name: "tool.call", handler: ($: ClaudeAPI, event: ToolEvent,
    next: (event: ToolEvent) => Promise<ToolResult>) => Promise<ToolResult>): void;
  (name: "session.start", handler: ($: ClaudeAPI, event: StartEvent,
    next: (event: StartEvent) => Promise<{ cwd: string }>) => Promise<{ cwd: string }>): void;
  (name: "session.receive", handler: ($: ClaudeAPI, event: SessionReceiveInput,
    next: (event: SessionReceiveInput) => Promise<SessionReceiveResult>) => Promise<SessionReceiveResult>): void;
}
