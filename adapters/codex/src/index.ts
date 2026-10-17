import type { AdapterRuntime } from "@cross-harness-comms/client";

export interface SessionStartInput {
  hook_event_name: "SessionStart";
  session_id: string;
  cwd: string;
  source: "startup" | "resume" | "clear";
  transcript_path?: string;
  model?: string;
  permission_mode?: string;
}
export interface McpCall {
  jsonrpc: "2.0";
  id: string | number;
  method: "tools/call";
  params: { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> };
}
export interface McpResult { content: { type: "text"; text: string }[]; isError?: boolean }
export interface CodexAdapter {
  sessionStart(input: SessionStartInput, process: { parentPid: number }): Promise<void>;
  toolsCall(request: McpCall): Promise<McpResult>;
  close(): Promise<void>;
}
export interface CodexRuntime extends AdapterRuntime {
  parentPid: number;
  run(argv: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}
export function createCodexAdapter(runtime: CodexRuntime): CodexAdapter {
  throw new Error("not implemented");
}
