import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { watchCodexDaemon as watch } from "../packages/core/codex-daemon.ts";
import type { CodexEvent } from "../packages/core/codex-events.ts";
import type { Platform } from "../packages/core/platform/platform.ts";
import { eventually } from "./helpers.ts";

function fixture(duringRead?: (send: (event: unknown) => void) => void) {
  const home = mkdtempSync("/tmp/cxe-");
  mkdirSync(join(home, "app-server-control"));
  mkdirSync(join(home, "app-server-daemon"));
  writeFileSync(join(home, "app-server-daemon", "daemon.pid"), JSON.stringify({ pid: 4242 }));
  const platform = { codexHome: () => home, processExecutable: async () => "/daemon/codex" } as unknown as Platform;
  const requests: string[] = [];
  let peer: { send(data: string): unknown; close(): unknown } | undefined;
  let connections = 0;
  const server = Bun.serve({
    unix: join(home, "app-server-control", "app-server-control.sock"),
    fetch: (request, srv) => srv.upgrade(request) ? undefined : new Response("upgrade required", { status: 426 }),
    websocket: {
      open(ws) { peer = ws; connections++; },
      message(ws, raw) {
        const request = JSON.parse(String(raw)) as { id?: number; method: string };
        requests.push(request.method);
        if (request.id === undefined) return;
        const result = request.method === "initialize" ? {}
          : request.method === "thread/loaded/list" ? { data: ["existing"], nextCursor: null }
          : { thread: { id: "existing", cwd: "/projects/shared", parentThreadId: null, ephemeral: false, status: { type: "idle" } } };
        if (request.method === "thread/read") duringRead?.(event => ws.send(JSON.stringify(event)));
        ws.send(JSON.stringify({ id: request.id, result }));
      },
    },
  });
  return { platform, requests, connections: () => connections,
    send: (event: unknown) => peer!.send(JSON.stringify(event)), disconnect: () => peer!.close(),
    close() { server.stop(true); rmSync(home, { recursive: true, force: true }); } };
}

test("codex events transport: one snapshot, then a persistent notification stream without snapshot polling", async () => {
  const f = fixture(), abort = new AbortController();
  let events: AsyncIterator<CodexEvent> | undefined;
  try {
    events = watch(f.platform, { signal: abort.signal, retryMs: 5, timeoutMs: 200 })[Symbol.asyncIterator]();
    const snapshot = await events.next();
    expect(snapshot.value).toMatchObject({ method: "comms/daemon-snapshot", executable: "/daemon/codex",
      params: { threads: [{ id: "existing", cwd: "/projects/shared" }] } });
    const next = events.next();
    // A request deadline must not become an idle-connection deadline.
    const timer = setTimeout(() => f.send({ method: "thread/started", params: {
      thread: { id: "fresh", cwd: "/projects/fresh", parentThreadId: null, ephemeral: false } } }), 300);
    try {
      expect((await next).value).toMatchObject({ method: "thread/started", executable: "/daemon/codex",
        params: { thread: { id: "fresh", cwd: "/projects/fresh" } } });
    } finally { clearTimeout(timer); }
    expect(f.requests.filter(method => method === "thread/loaded/list")).toHaveLength(1);
    expect(f.connections()).toBe(1);
  } finally { abort.abort(); await events?.return?.(); f.close(); }
});

test("codex events transport: notifications arriving during the snapshot are retained", async () => {
  const f = fixture(send => send({ method: "thread/status/changed", params: { threadId: "existing", status: { type: "notLoaded" } } }));
  const abort = new AbortController();
  let events: AsyncIterator<CodexEvent> | undefined;
  try {
    events = watch(f.platform, { signal: abort.signal, retryMs: 5, timeoutMs: 200 })[Symbol.asyncIterator]();
    expect((await events.next()).value.method).toBe("comms/daemon-snapshot");
    expect((await events.next()).value).toMatchObject({ method: "thread/status/changed",
      params: { threadId: "existing", status: { type: "notLoaded" } } });
  } finally { abort.abort(); await events?.return?.(); f.close(); }
});

test("codex events transport: reconnect emits disconnect and takes exactly one new snapshot", async () => {
  const f = fixture(), abort = new AbortController();
  let events: AsyncIterator<CodexEvent> | undefined;
  try {
    events = watch(f.platform, { signal: abort.signal, retryMs: 5, timeoutMs: 200 })[Symbol.asyncIterator]();
    await events.next();
    f.disconnect();
    expect((await events.next()).value).toEqual({ method: "comms/daemon-disconnected" });
    expect((await events.next()).value.method).toBe("comms/daemon-snapshot");
    expect(f.connections()).toBe(2);
    expect(f.requests.filter(method => method === "thread/loaded/list")).toHaveLength(2);
    const done = events.next();
    abort.abort();
    expect((await done).done).toBe(true);
    await eventually(() => f.connections(), n => expect(n).toBe(2));
  } finally { abort.abort(); await events?.return?.(); f.close(); }
});

test("codex events transport: a resumed thread missing from the snapshot gets one metadata read, not another catalog poll", async () => {
  const f = fixture(), abort = new AbortController();
  let events: AsyncIterator<CodexEvent> | undefined;
  try {
    events = watch(f.platform, { signal: abort.signal, retryMs: 5, timeoutMs: 200 })[Symbol.asyncIterator]();
    await events.next();
    f.send({ method: "thread/status/changed", params: { threadId: "resumed", status: { type: "idle" } } });
    expect((await events.next()).value).toMatchObject({ method: "comms/daemon-discovered", executable: "/daemon/codex",
      params: { thread: { id: "resumed", cwd: "/projects/shared" } } });
    expect((await events.next()).value).toMatchObject({ method: "thread/status/changed", params: { threadId: "resumed" } });
    f.send({ method: "thread/status/changed", params: { threadId: "resumed", status: { type: "active", activeFlags: [] } } });
    expect((await events.next()).value.method).toBe("thread/status/changed");
    expect(f.requests.filter(method => method === "thread/read")).toHaveLength(2);
    expect(f.requests.filter(method => method === "thread/loaded/list")).toHaveLength(1);
  } finally { abort.abort(); await events?.return?.(); f.close(); }
});
