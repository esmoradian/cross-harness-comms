import { expect, test } from "bun:test";
import { steerCodexThread, watchCodexDaemon } from "../packages/core/src/codex/daemon.ts";
import type { CodexEvent } from "../packages/core/src/codex/events.ts";
import type { Platform } from "../packages/core/src/platform/platform.ts";
import { fakeCodexDaemon, type DaemonRequest } from "./support/fakes/codex-daemon.ts";

// The first event of a fresh watch: its snapshot, or the disconnect when no daemon answers.
async function first(platform: Platform): Promise<CodexEvent> {
  const events = watchCodexDaemon(platform, { retryMs: 5, timeoutMs: 200 })[Symbol.asyncIterator]();
  try { return (await events.next()).value; }
  finally { await events.return?.(); }
}

test("codex daemon snapshot lists loaded user threads with their cwd, across pages and large frames", async () => {
  const longCwd = "/projects/" + "x".repeat(70_000);
  const threads: Record<string, unknown> = {
    main: { cwd: longCwd, parentThreadId: null, ephemeral: false },
    worker: { cwd: "/projects/one", parentThreadId: "main", ephemeral: false },
    scratch: { cwd: "/projects/one", parentThreadId: null, ephemeral: true },
  };
  const daemon = fakeCodexDaemon((request, send) => {
    send({ method: "account/updated", params: {} });
    return request.method === "thread/loaded/list" ? (request.params?.cursor ? { data: ["worker", "scratch"], nextCursor: null } : { data: ["main"], nextCursor: "2" })
      : { thread: threads[request.params!.threadId!] };
  });
  try {
    expect(await first(daemon.platform)).toEqual({ method: "comms/daemon-snapshot", executable: "/daemon/codex", params: { threads: [{ id: "main", cwd: longCwd }] } });
  } finally { daemon.close(); }
});

test("codex daemon watch reports a disconnect when nothing is listening", async () => {
  expect(await first({ codexHome: () => "/nonexistent/codex" } as unknown as Platform)).toEqual({ method: "comms/daemon-disconnected" });
});

// A daemon whose thread `main` has one latest turn; `steer` answers `turn/steer`.
function turns(status: string, steer: (request: DaemonRequest) => unknown = request => ({ turnId: request.params!.expectedTurnId })) {
  const steers: DaemonRequest[] = [];
  const daemon = fakeCodexDaemon(request => {
    if (request.method === "thread/turns/list") return { data: [{ id: "turn-2", status }] };
    steers.push(request);
    return steer(request);
  });
  return { daemon, steers };
}

test("codex daemon steers the thread's in-progress turn with the message", async () => {
  const { daemon, steers } = turns("inProgress");
  try {
    expect(await steerCodexThread(daemon.platform, "main", "hello mid-turn", "message-1", { timeoutMs: 200 })).toBe(true);
    expect(steers.map(request => request.params)).toEqual([{ threadId: "main", expectedTurnId: "turn-2",
      clientUserMessageId: "message-1", input: [{ type: "text", text: "hello mid-turn" }] }]);
  } finally { daemon.close(); }
});

test("codex daemon does not steer a thread without an in-progress turn", async () => {
  const { daemon, steers } = turns("completed");
  try {
    expect(await steerCodexThread(daemon.platform, "main", "hello", "message-1", { timeoutMs: 200 })).toBe(false);
    expect(steers).toEqual([]);
  } finally { daemon.close(); }
});

test("codex daemon treats a steer rejected because the turn ended as safe to queue", async () => {
  const { daemon } = turns("inProgress", () => {
    throw Object.assign(new Error("expected active turn id `turn-2` but found `turn-3`"), { code: -32600 });
  });
  try {
    expect(await steerCodexThread(daemon.platform, "main", "hello", "message-1", { timeoutMs: 200 })).toBe(false);
  } finally { daemon.close(); }
});
