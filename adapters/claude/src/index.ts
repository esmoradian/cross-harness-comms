import type { ClaudeOn } from "./api.ts";

export function registerClaude(on: ClaudeOn, options: { binary: string; host: string }): { close(): Promise<void> } {
  throw new Error("not implemented");
}

export function register(on: ClaudeOn): void {
  throw new Error("not implemented");
}
