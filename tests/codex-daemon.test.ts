import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexDaemon } from "../packages/core/src/codex/daemon.ts";
import type { Platform } from "../packages/core/src/platform/platform.ts";

// A stand-in for Codex's app-server daemon: JSON-RPC over a WebSocket on a Unix socket.
function fakeHome() {
  // Short base path: macOS caps Unix socket paths at 104 bytes.
  const home = mkdtempSync("/tmp/cxh-");
  mkdirSync(join(home, "app-server-control"));
  mkdirSync(join(home, "app-server-daemon"));
  writeFileSync(join(home, "app-server-daemon", "daemon.pid"), JSON.stringify({ pid: 4242 }));
  const platform = { codexHome: () => home, processExecutable: async (pid: number) => pid === 4242 ? "/daemon/codex" : undefined } as unknown as Platform;
  return { home, platform };
}

test("codex daemon client lists loaded user threads with their cwd, across pages and large frames", async () => {
  const { home, platform } = fakeHome();
  const longCwd = "/projects/" + "x".repeat(70_000);
  const threads: Record<string, unknown> = {
    main: { cwd: longCwd, parentThreadId: null, ephemeral: false },
    worker: { cwd: "/projects/one", parentThreadId: "main", ephemeral: false },
    scratch: { cwd: "/projects/one", parentThreadId: null, ephemeral: true },
  };
  const server = Bun.serve({
    unix: join(home, "app-server-control", "app-server-control.sock"),
    fetch: (request, srv) => srv.upgrade(request) ? undefined : new Response("upgrade required", { status: 426 }),
    websocket: {
      message(ws, raw) {
        const request = JSON.parse(String(raw)) as { id?: number; method: string; params?: { cursor?: string; threadId?: string } };
        if (request.id === undefined) return;
        ws.send(JSON.stringify({ method: "account/updated", params: {} }));
        const result = request.method === "initialize" ? {}
          : request.method === "thread/loaded/list" ? (request.params?.cursor ? { data: ["worker", "scratch"], nextCursor: null } : { data: ["main"], nextCursor: "2" })
          : { thread: threads[request.params!.threadId!] };
        ws.send(JSON.stringify({ id: request.id, result }));
      },
    },
  });
  try {
    expect(await codexDaemon(platform)()).toEqual({ executable: "/daemon/codex", threads: [{ id: "main", cwd: longCwd }] });
  } finally { server.stop(true); rmSync(home, { recursive: true, force: true }); }
});

test("codex daemon client reports no daemon when nothing is listening", async () => {
  const { home, platform } = fakeHome();
  try { expect(await codexDaemon(platform, 200)()).toBeUndefined(); }
  finally { rmSync(home, { recursive: true, force: true }); }
});
