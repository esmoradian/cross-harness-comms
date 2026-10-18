export type CodexRuntimeState = "unknown" | "notLoaded" | "idle" | "active" | "systemError";

export interface CodexThread {
  id: string;
  cwd: string;
  parentThreadId?: string | null;
  ephemeral?: boolean;
  active_at?: string;
  status?: { type: CodexRuntimeState };
}

export interface CodexSnapshot { executable: string; threads: CodexThread[] }

// Native notifications retain their method and params. The transport supplies
// executable/activity metadata and its own connect/disconnect observations.
export type CodexEvent =
  | { method: "thread/started" | "comms/daemon-discovered"; executable: string; params: { thread: CodexThread } }
  | { method: "thread/status/changed"; params: { threadId: string; status: { type: CodexRuntimeState; activeFlags?: string[] } }; active_at?: string }
  | { method: "thread/closed" | "thread/archived" | "thread/deleted"; params: { threadId: string } }
  | { method: "comms/daemon-snapshot"; executable: string; params: { threads: CodexThread[] } }
  | { method: "comms/daemon-disconnected" };
