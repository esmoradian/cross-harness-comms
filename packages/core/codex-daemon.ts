import { connect } from "node:net";
import { readFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { RELEASE_VERSION } from "@cross-harness-comms/protocol";
import type { CodexEvent, CodexRuntimeState, CodexSnapshot, CodexThread } from "./codex-events.ts";
import type { Platform } from "./platform/platform.ts";

interface Notification { method: string; params?: unknown; emittedAtMs?: number }

// Codex's local app-server protocol is JSON-RPC over a Unix WebSocket.
function frame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4), length = payload.length;
  const head = length < 126 ? Buffer.from([0x80 | opcode, 0x80 | length])
    : length < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, length >> 8, length & 255])
    : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(length)); return b; })()]);
  return Buffer.concat([head, mask, payload.map((byte, index) => byte ^ mask[index % 4]!)]);
}

class Notifications implements AsyncIterable<Notification> {
  private values: Notification[] = [];
  private waiter: ((value: IteratorResult<Notification>) => void) | undefined;
  private ended = false;
  push(value: Notification) {
    if (this.ended) return;
    if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter({ done: false, value }); }
    else this.values.push(value);
  }
  end() {
    this.ended = true;
    this.waiter?.({ done: true, value: undefined });
    this.waiter = undefined;
  }
  [Symbol.asyncIterator](): AsyncIterator<Notification> {
    return { next: () => {
      const value = this.values.shift();
      if (value) return Promise.resolve({ done: false, value });
      if (this.ended) return Promise.resolve({ done: true, value: undefined });
      return new Promise(resolve => { this.waiter = resolve; });
    } };
  }
}

async function open(address: string, timeoutMs: number, signal?: AbortSignal) {
  const socket = connect(address), notifications = new Notifications();
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let sequence = 0, buffer = Buffer.alloc(0), message: Buffer[] = [], messageBytes = 0, upgraded = false, ended = false;
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const fail = (error: Error) => {
    if (ended) return;
    ended = true;
    clearTimeout(handshakeTimer);
    signal?.removeEventListener("abort", abort);
    readyReject(error);
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
    notifications.end();
    socket.destroy();
  };
  const abort = () => fail(new Error("Codex daemon observation cancelled"));
  const handshakeTimer = setTimeout(() => fail(new Error("Codex daemon handshake timed out")), timeoutMs);
  const key = randomBytes(16).toString("base64");
  socket.on("error", fail);
  socket.on("close", () => fail(new Error("Codex daemon closed the connection")));
  socket.on("data", (chunk: Buffer) => {
    try {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) { if (buffer.length > 16384) throw new Error("Oversized WebSocket handshake"); return; }
        const headers = buffer.subarray(0, end).toString();
        const accept = /^Sec-WebSocket-Accept:\s*(\S+)/im.exec(headers)?.[1];
        const expected = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
        if (!headers.startsWith("HTTP/1.1 101") || accept !== expected) throw new Error("Codex daemon refused the WebSocket upgrade");
        upgraded = true;
        clearTimeout(handshakeTimer);
        buffer = buffer.subarray(end + 4);
        readyResolve();
      }
      while (buffer.length >= 2) {
        let length = buffer[1]! & 127, offset = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        if (length > 16 * 1024 * 1024 || messageBytes + length > 16 * 1024 * 1024) throw new Error("Oversized Codex daemon frame");
        if (buffer[1]! & 128) throw new Error("Masked server WebSocket frame");
        if (buffer.length < offset + length) return;
        const fin = (buffer[0]! & 0x80) !== 0, opcode = buffer[0]! & 15, payload = buffer.subarray(offset, offset + length);
        buffer = buffer.subarray(offset + length);
        if (opcode === 9) { socket.write(frame(10, payload)); continue; }
        if (opcode === 8) { fail(new Error("Codex daemon closed the WebSocket")); return; }
        if (opcode !== 0 && opcode !== 1) continue;
        message.push(payload); messageBytes += payload.length;
        if (!fin) continue;
        const packet = JSON.parse(Buffer.concat(message).toString()) as {
          id?: number; method?: string; params?: unknown; emittedAtMs?: number; result?: unknown; error?: { message: string };
        };
        message = []; messageBytes = 0;
        const request = typeof packet.id === "number" ? pending.get(packet.id) : undefined;
        if (request) {
          pending.delete(packet.id!); clearTimeout(request.timer);
          if (packet.error) request.reject(new Error(packet.error.message)); else request.resolve(packet.result);
        } else if (typeof packet.method === "string") notifications.push(packet as Notification);
      }
    } catch (error) { fail(error instanceof Error ? error : new Error("Invalid Codex daemon packet")); }
  });
  socket.once("connect", () => socket.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  await ready;
  const send = (value: unknown) => {
    if (ended) throw new Error("Codex daemon connection is closed");
    socket.write(frame(1, Buffer.from(JSON.stringify(value))));
  };
  return {
    request: <T>(method: string, params: unknown) => new Promise<T>((resolve, reject) => {
      if (ended) { reject(new Error("Codex daemon connection is closed")); return; }
      const id = ++sequence;
      const timer = setTimeout(() => fail(new Error(`Codex daemon request timed out: ${method}`)), timeoutMs);
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try { send({ jsonrpc: "2.0", id, method, params }); } catch (error) { fail(error as Error); }
    }),
    notify: (method: string) => send({ jsonrpc: "2.0", method }), notifications,
    close: () => fail(new Error("Codex daemon connection closed")),
  };
}

type DaemonClient = Awaited<ReturnType<typeof open>>;
const states = new Set<CodexRuntimeState>(["notLoaded", "idle", "active", "systemError"]);
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined;
const isoTime = (value: unknown, scale = 1): string | undefined => typeof value === "number" && Number.isFinite(value)
  && Math.abs(value * scale) <= 8.64e15 ? new Date(value * scale).toISOString() : undefined;
function threadMetadata(value: unknown): CodexThread | undefined {
  const thread = record(value);
  if (!thread || typeof thread.id !== "string" || typeof thread.cwd !== "string" || thread.parentThreadId || thread.ephemeral) return;
  const active_at = isoTime(thread.recencyAt ?? thread.updatedAt, 1000);
  const type = record(thread.status)?.type as CodexRuntimeState;
  return { id: thread.id, cwd: thread.cwd, ...(active_at ? { active_at } : {}), ...(states.has(type) ? { status: { type } } : {}) };
}
async function initialize(client: DaemonClient) {
  await client.request("initialize", { clientInfo: { name: "cross_harness_comms", title: "Cross-Harness Comms", version: RELEASE_VERSION },
    capabilities: { experimentalApi: true } });
  client.notify("initialized");
}
async function snapshot(client: DaemonClient, platform: Platform): Promise<CodexSnapshot> {
  const threads: CodexThread[] = [];
  let cursor: string | null = null;
  const cursors = new Set<string>();
  do {
    const page: { data: string[]; nextCursor: string | null } = await client.request("thread/loaded/list", cursor ? { cursor } : {});
    for (const id of page.data) {
      // A thread can disappear between listing and reading it.
      const response = await client.request<{ thread: unknown }>("thread/read", { threadId: id }).catch(() => undefined);
      const thread = threadMetadata({ ...record(response?.thread), id });
      if (thread) threads.push(thread);
    }
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error("Repeated Codex thread cursor");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  const owner = JSON.parse(await readFile(join(platform.codexHome(), "app-server-daemon", "daemon.pid"), "utf8")) as { pid: number };
  return { executable: await platform.processExecutable(owner.pid) ?? "codex", threads };
}

// One-shot metadata lookup. Production never schedules
// it repeatedly: the persistent observer below snapshots only when connecting.
export function codexDaemon(platform: Platform, timeoutMs = 2000): () => Promise<CodexSnapshot | undefined> {
  return async () => {
    let client: DaemonClient | undefined;
    try {
      client = await open(join(platform.codexHome(), "app-server-control", "app-server-control.sock"), timeoutMs);
      await initialize(client);
      return await snapshot(client, platform);
    } catch { return undefined; }
    finally { client?.close(); }
  };
}

function notificationEvent(notification: Notification, executable: string): CodexEvent | undefined {
  const params = record(notification.params);
  if (!params) return;
  if (notification.method === "thread/started") {
    const thread = threadMetadata(params.thread);
    return thread ? { method: "thread/started", executable, params: { thread } } : undefined;
  }
  if (typeof params.threadId !== "string") return;
  if (notification.method === "thread/status/changed") {
    const type = record(params.status)?.type as CodexRuntimeState;
    if (!states.has(type)) return;
    const active_at = isoTime(notification.emittedAtMs);
    return { method: "thread/status/changed", params: { threadId: params.threadId, status: { type } }, ...(active_at ? { active_at } : {}) };
  }
  if (["thread/closed", "thread/archived", "thread/deleted"].includes(notification.method)) {
    return { method: notification.method as "thread/closed" | "thread/archived" | "thread/deleted", params: { threadId: params.threadId } };
  }
}
function retry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}

export function watchCodexDaemon(platform: Platform, options: { signal?: AbortSignal; retryMs?: number; timeoutMs?: number } = {}): AsyncIterable<CodexEvent> {
  async function* observe(signal: AbortSignal): AsyncGenerator<CodexEvent> {
    let disconnected = false, delay = options.retryMs ?? 1000;
    while (!signal.aborted) {
      let client: DaemonClient | undefined;
      try {
        client = await open(join(platform.codexHome(), "app-server-control", "app-server-control.sock"), options.timeoutMs ?? 2000, signal);
        await initialize(client);
        const initial = await snapshot(client, platform);
        if (signal.aborted) return;
        disconnected = false; delay = options.retryMs ?? 1000;
        const known = new Set(initial.threads.map(thread => thread.id));
        yield { method: "comms/daemon-snapshot", executable: initial.executable, params: { threads: initial.threads } };
        for await (const notification of client.notifications) {
          if (signal.aborted) return;
          const event = notificationEvent(notification, initial.executable);
          if (event?.method === "thread/started") known.add(event.params.thread.id);
          if (event?.method === "thread/status/changed" && !known.has(event.params.threadId)) {
            // Resume need not emit thread/started, and it can race discovery.
            // Resolve only this event's ID, without rereading the catalog.
            const id = event.params.threadId;
            const response = await client.request<{ thread: unknown }>("thread/read", { threadId: id }).catch(() => undefined);
            const thread = threadMetadata({ ...record(response?.thread), id });
            if (!thread) continue;
            known.add(id);
            yield { method: "comms/daemon-discovered", executable: initial.executable, params: { thread } };
          }
          if (event) yield event;
        }
      } catch { /* Reconnect below; hooks remain usable while the daemon is absent. */ }
      finally { client?.close(); }
      if (signal.aborted) return;
      if (!disconnected) { disconnected = true; yield { method: "comms/daemon-disconnected" }; }
      await retry(delay, signal);
      delay = Math.min(delay * 2, 30000);
    }
  }
  return { [Symbol.asyncIterator]() {
    const cancel = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, cancel.signal]) : cancel.signal;
    const iterator = observe(signal);
    return { next: () => iterator.next(), return: async () => { cancel.abort(); return await iterator.return(undefined); } };
  } };
}
