import { expect, test } from "bun:test";
import { watchCodexDaemon as watch } from "../packages/core/src/codex/daemon.ts";
import type { CodexEvent } from "../packages/core/src/codex/events.ts";
import { fakeCodexDaemon } from "./support/fakes/codex-daemon.ts";
import { eventually } from "./support/helpers.ts";

// One loaded thread, "existing"; `duringRead` runs before each thread/read answer.
function fixture(duringRead?: (send: (event: unknown) => void) => void) {
  return fakeCodexDaemon((request, send) => {
    if (request.method === "thread/loaded/list") return { data: ["existing"], nextCursor: null };
    duringRead?.(send);
    return { thread: { id: "existing", cwd: "/projects/shared", parentThreadId: null, ephemeral: false, status: { type: "idle" } } };
  });
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
