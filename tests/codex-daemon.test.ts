import { expect, test } from "bun:test";
import { watchCodexDaemon } from "../packages/core/src/codex/daemon.ts";
import type { CodexEvent } from "../packages/core/src/codex/events.ts";
import type { Platform } from "../packages/core/src/platform/platform.ts";
import { fakeCodexDaemon } from "./support/fakes/codex-daemon.ts";

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
