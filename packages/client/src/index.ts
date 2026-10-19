import type { Duplex } from "node:stream";
import { failure, VERSION_RANGE, type SessionRegistration, type SendParams } from "@cross-harness-comms/protocol";
import { readPackets, writePacket } from "./wire.ts";
export { readPackets, writePacket } from "./wire.ts";
import type { Delivery, HelloParams, HelloResult, MethodTable, RequestMethod } from "@cross-harness-comms/protocol";

export interface CommsClient {
  hello(params: HelloParams): Promise<HelloResult>;
  request<M extends RequestMethod>(method: M, params: MethodTable[M]["params"]): Promise<MethodTable[M]["result"]>;
  deliveries: AsyncIterable<Delivery>;
  close(): Promise<void>;
}

export function createClient(stream: Duplex, notification?: (method: string, params: unknown) => void): CommsClient {
  let sequence = 0, ended = false;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
  const queue: Delivery[] = [];
  const waiters: ((value: IteratorResult<Delivery>) => void)[] = [];
  const finish = () => {
    if (ended) return;
    ended = true;
    queue.length = 0;
    for (const request of pending.values()) request.reject(failure("DISCONNECTED"));
    pending.clear();
    for (const waiter of waiters.splice(0)) waiter({ done: true, value: undefined });
  };
  stream.on("end", finish);
  stream.on("close", finish);
  stream.on("error", finish);
  readPackets(stream, packet => {
    if ("method" in packet) {
      if (packet.method === "ping" && packet.id !== undefined) {
        writePacket(stream, { jsonrpc: "2.0", id: packet.id, result: {} });
        return;
      }
      notification?.(packet.method, packet.params);
      if (packet.method === "deliver") {
        const value = packet.params as Delivery;
        const waiter = waiters.shift();
        if (waiter) waiter({ done: false, value }); else queue.push(value);
      }
    } else if (typeof packet.id === "number") {
      const request = pending.get(packet.id);
      pending.delete(packet.id);
      if ("error" in packet) request?.reject(Object.assign(new Error(packet.error.message), packet.error));
      else request?.resolve(packet.result);
    }
  }, () => stream.destroy());
  const request: CommsClient["request"] = (method, params) => new Promise((resolve, reject) => {
    if (ended) { reject(failure("DISCONNECTED")); return; }
    const id = ++sequence;
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    try { writePacket(stream, { jsonrpc: "2.0", id, method, params }); }
    catch (error) { pending.delete(id); reject(error); }
  });
  return {
    hello: params => request("hello", params), request,
    deliveries: { [Symbol.asyncIterator]() { return { next() {
      if (queue.length) return Promise.resolve({ done: false as const, value: queue.shift()! });
      if (ended) return Promise.resolve({ done: true as const, value: undefined });
      return new Promise<IteratorResult<Delivery>>(resolve => waiters.push(resolve));
    } }; } },
    async close() { finish(); stream.destroy(); },
  };
}

// The connector owns transport creation; callers can supply sockets or in-memory streams.
export interface AdapterRuntime {
  ensure(): Promise<string>;
  connect(address: string): Promise<Duplex>;
  host: string;
  notice(text: string): void;
}

export interface AdapterHandle {
  close(): Promise<void>;
}

// A command's standard streams and cancellation: the comms CLI's, which `comms mcp` serves the Codex MCP server over.
export interface CommandIO {
  stdin: AsyncIterable<string>;
  stdout(text: string): void;
  stderr(text: string): void;
  signal: AbortSignal;
}

// Retries `call` once after an uncertain transport outcome, which the caller-minted ID makes safe.
// Application errors are definitive and must not trigger another attempt; `drop` forgets the failed connection.
export async function retryDisconnected<C, T>(connection: () => Promise<C>, call: (connection: C) => Promise<T>,
  drop: (connection: C) => Promise<void>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const current = await connection();
    try { return await call(current); }
    catch (error) {
      if (attempt || (error as { data?: { code?: string } }).data?.code !== "DISCONNECTED") throw error;
      await drop(current);
    }
  }
}

export interface SessionClient extends AdapterHandle {
  send(params: Omit<SendParams, "token">): Promise<MethodTable["send"]["result"]>;
  list(params?: { include_stale?: boolean }): Promise<MethodTable["list"]["result"]>;
}

// A session retains its token. Reconnect registers the same native identity and
// drains unacknowledged mail before processing newly arriving deliveries.
export async function connectSession(runtime: AdapterRuntime, session: SessionRegistration,
  accept: (delivery: Delivery) => Promise<void>): Promise<SessionClient> {
  let stopped = false;
  let heldToken: string | undefined;
  let current: { client: CommsClient; token: string } | undefined;
  let connecting: Promise<void> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const connect = (): Promise<void> => {
    if (stopped || current) return Promise.resolve();
    return connecting ??= (async () => {
    const client = createClient(await runtime.connect(await runtime.ensure()), method => {
      if (method === "session_replaced") {
        stopped = true;
        clearTimeout(retry);
        runtime.notice("This session connection was replaced by another attachment.");
      }
    });
    try {
      const hello = await client.hello({ versions: VERSION_RANGE, session, ...(heldToken ? { token: heldToken } : {}) });
      if (!hello.token) throw failure("INVALID_TOKEN");
      heldToken = hello.token;
      if (hello.notice) runtime.notice(hello.notice);
      if (stopped) { await client.close(); return; }
      const connection = { client, token: hello.token };
      current = connection;
      void (async () => {
        try {
          for await (const delivery of client.deliveries) {
            if (stopped) break;
            await accept(delivery);
            await client.request("ack", { token: connection.token, id: delivery.message.id });
          }
        } catch (error) { if (!stopped) runtime.notice(error instanceof Error ? error.message : "Delivery failed"); }
        finally {
          if (current === connection) current = undefined;
          await client.close();
          if (!stopped) schedule();
        }
      })();
    } catch (error) { await client.close(); throw error; }
  })().finally(() => { connecting = undefined; });
  };
  const schedule = () => {
    if (stopped || retry || current) return;
    retry = setTimeout(() => {
      retry = undefined;
      void connect().catch(() => schedule());
    }, 100);
    retry.unref?.();
  };
  const ready = async () => {
    if (stopped) throw failure("DISCONNECTED");
    if (!current) await connect();
    if (!current) throw failure("DISCONNECTED");
    return current;
  };
  await connect();
  return {
    send: params => retryDisconnected(ready, async connection => {
      const result = await connection.client.request("send", { ...params, token: connection.token });
      if (result.notice) runtime.notice(result.notice);
      return result;
    }, async connection => {
      if (current === connection) current = undefined;
      await connection.client.close();
    }),
    async list(params = {}) {
      const result = await (await ready()).client.request("list", params);
      if (result.notice) runtime.notice(result.notice);
      return result;
    },
    async close() {
      stopped = true;
      clearTimeout(retry);
      await current?.client.close();
      await connecting?.catch(() => {});
    },
  };
}
