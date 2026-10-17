import type { AdapterHandle, AdapterRuntime } from "@cross-harness-comms/client";

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
export interface PiAPI {
  registerTool(tool: PiTool): void;
  on(event: "session_start" | "session_shutdown",
    handler: (event: { type: string; reason?: string }, ctx: PiContext) => void | Promise<void>): void;
  sendMessage(message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }): void;
}

export function registerPi(pi: PiAPI, runtime: AdapterRuntime): AdapterHandle {
  throw new Error("not implemented");
}

export default function extension(pi: PiAPI): void {
  throw new Error("not implemented");
}
