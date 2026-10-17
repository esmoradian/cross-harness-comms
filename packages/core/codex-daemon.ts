import { connect, type Socket } from "node:net";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { RELEASE_VERSION } from "@cross-harness-comms/protocol";
import type { CodexSnapshot } from "./src/index.ts";
import type { Platform } from "./platform/platform.ts";

// Codex's app-server daemon speaks JSON-RPC over a WebSocket on a Unix socket.
// Only the client side of RFC 6455 that this needs: masked text frames out,
// unmasked text frames in (reassembled from continuations), pings answered.
function frame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4), length = payload.length;
  const head = length < 126 ? Buffer.from([0x80 | opcode, 0x80 | length])
    : length < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, length >> 8, length & 255])
    : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(length)); return b; })()]);
  return Buffer.concat([head, mask, payload.map((byte, index) => byte ^ mask[index % 4]!)]);
}

async function open(address: string, timeoutMs: number) {
  const socket: Socket = connect(address);
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let sequence = 0, buffer = Buffer.alloc(0), message: Buffer[] = [], upgraded = false;
  const fail = (error: Error) => { for (const request of pending.values()) request.reject(error); pending.clear(); socket.destroy(); };
  const timer = setTimeout(() => fail(new Error("Codex daemon timed out")), timeoutMs);
  socket.on("error", fail);
  socket.on("close", () => fail(new Error("Codex daemon closed the connection")));
  const ready = new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        if (!buffer.subarray(0, end).toString().startsWith("HTTP/1.1 101")) { reject(new Error("Codex daemon refused the WebSocket upgrade")); return; }
        upgraded = true;
        buffer = buffer.subarray(end + 4);
        resolve();
      }
      while (buffer.length >= 2) {
        let length = buffer[1]! & 127, offset = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        if (buffer.length < offset + length) return;
        const fin = (buffer[0]! & 0x80) !== 0, opcode = buffer[0]! & 15, payload = buffer.subarray(offset, offset + length);
        buffer = buffer.subarray(offset + length);
        if (opcode === 9) { socket.write(frame(10, payload)); continue; }
        if (opcode === 8) { socket.end(); return; }
        if (opcode !== 0 && opcode !== 1) continue;
        message.push(payload);
        if (!fin) continue;
        const text = Buffer.concat(message).toString();
        message = [];
        const packet = JSON.parse(text) as { id?: number; result?: unknown; error?: { message: string } };
        const request = typeof packet.id === "number" ? pending.get(packet.id) : undefined;
        if (!request) continue;
        pending.delete(packet.id!);
        if (packet.error) request.reject(new Error(packet.error.message)); else request.resolve(packet.result);
      }
    });
  });
  socket.once("connect", () => socket.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
  await ready;
  const send = (value: unknown) => socket.write(frame(1, Buffer.from(JSON.stringify(value))));
  return {
    request: <T>(method: string, params: unknown) => new Promise<T>((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      send({ jsonrpc: "2.0", id, method, params });
    }),
    notify: (method: string) => send({ jsonrpc: "2.0", method }),
    close: () => { clearTimeout(timer); socket.destroy(); },
  };
}

interface ThreadRead { thread: { cwd: string; parentThreadId: string | null; ephemeral: boolean } }

// Returns a snapshot reader for the core's Codex poll. Each call opens one short
// connection; thread details are read once per thread and cached while it stays loaded.
export function codexDaemon(platform: Platform, timeoutMs = 2000): () => Promise<CodexSnapshot | undefined> {
  const cwds = new Map<string, string | null>();
  return async () => {
    const home = platform.codexHome();
    let client: Awaited<ReturnType<typeof open>>;
    try { client = await open(join(home, "app-server-control", "app-server-control.sock"), timeoutMs); }
    catch { return undefined; }
    try {
      await client.request("initialize", { clientInfo: { name: "cross_harness_comms", title: "Cross-Harness Comms", version: RELEASE_VERSION } });
      client.notify("initialized");
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const page: { data: string[]; nextCursor: string | null } = await client.request("thread/loaded/list", cursor ? { cursor } : {});
        ids.push(...page.data);
        cursor = page.nextCursor;
      } while (cursor);
      for (const id of ids) {
        if (cwds.has(id)) continue;
        const { thread } = await client.request<ThreadRead>("thread/read", { threadId: id });
        // Subagent and ephemeral threads are Codex internals, not sessions to message.
        cwds.set(id, thread.parentThreadId || thread.ephemeral ? null : thread.cwd);
      }
      for (const id of cwds.keys()) if (!ids.includes(id)) cwds.delete(id);
      const daemon = JSON.parse(await readFile(join(home, "app-server-daemon", "daemon.pid"), "utf8")) as { pid: number };
      return {
        executable: await platform.processExecutable(daemon.pid) ?? "codex",
        threads: ids.flatMap(id => { const cwd = cwds.get(id); return cwd ? [{ id, cwd }] : []; }),
      };
    } catch { return undefined; }
    finally { client.close(); }
  };
}
