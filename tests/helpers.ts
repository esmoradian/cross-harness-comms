import { Duplex } from "node:stream";
import { expect } from "bun:test";
import type { Delivery, HelloParams, HelloResult, MethodTable, RequestMethod, WirePacket } from "@cross-harness-comms/protocol";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export class Queue<T> {
  readonly values: T[] = [];
  private waiters: ReturnType<typeof deferred<T>>[] = [];
  push(value: T) {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(value);
    else this.values.push(value);
  }
  next(): Promise<T> {
    if (this.values.length) return Promise.resolve(this.values.shift()!);
    const waiter = deferred<T>();
    this.waiters.push(waiter);
    return waiter.promise;
  }
}

export function memoryPair(filterServerBytes?: (chunk: Buffer) => string): [Duplex, Duplex] {
  const a = new Duplex({
    allowHalfOpen: false,
    read() {},
    write(chunk, _encoding, done) { b.push(chunk); done(); },
    final(done) { b.push(null); done(); },
    destroy(error, done) { b.push(null); done(error); },
  });
  const b = new Duplex({
    allowHalfOpen: false,
    read() {},
    write(chunk, _encoding, done) {
      const output = filterServerBytes ? filterServerBytes(chunk) : chunk;
      if (output.length) a.push(output);
      done();
    },
    final(done) { a.push(null); done(); },
    destroy(error, done) { a.push(null); done(error); },
  });
  return [a, b];
}

export async function eventually<T>(read: () => T | Promise<T>, check: (value: T) => void): Promise<T> {
  const deadline = Date.now() + 1500;
  for (;;) {
    const value = await read();
    try { check(value); return value; }
    catch (error) {
      if (Date.now() >= deadline) throw error;
      await Bun.sleep(1);
    }
  }
}

// Resolves after every pending microtask has run, so callers already started reach their next real wait.
export function settle(): Promise<void> { return new Promise(resolve => setImmediate(resolve)); }

export function uuid(): string { return Bun.randomUUIDv7(); }
export const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// A wire driver, not a fake core/client. It only frames requests and correlates responses.
export class Peer {
  answerPings = true;
  readonly received: WirePacket[] = [];
  readonly deliveries = new Queue<Delivery>();
  private sequence = 0;
  private pending = new Map<number, ReturnType<typeof deferred<unknown>>>();
  private buffer = "";
  constructor(readonly stream: Duplex) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const packet = JSON.parse(this.buffer.slice(0, newline)) as WirePacket;
        this.buffer = this.buffer.slice(newline + 1);
        this.received.push(packet);
        if ("method" in packet) {
          if (packet.method === "ping" && packet.id !== undefined && this.answerPings) {
            this.stream.write(JSON.stringify({ jsonrpc: "2.0", id: packet.id, result: {} }) + "\n");
          }
          if (packet.method === "deliver") this.deliveries.push(packet.params as Delivery);
        } else if (typeof packet.id === "number") {
          const request = this.pending.get(packet.id);
          this.pending.delete(packet.id);
          if ("error" in packet) request?.reject(Object.assign(new Error(packet.error.message), packet.error));
          else request?.resolve(packet.result);
        }
      }
    });
  }
  raw(method: string, params: unknown): Promise<unknown> {
    const id = ++this.sequence;
    const result = deferred<unknown>();
    this.pending.set(id, result);
    this.stream.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return result.promise;
  }
  async request<M extends RequestMethod>(method: M, params: MethodTable[M]["params"]): Promise<MethodTable[M]["result"]> {
    return await this.raw(method, params) as MethodTable[M]["result"];
  }
  async register(session: NonNullable<HelloParams["session"]>, versions = { min: 1, max: 1 }, token?: string) {
    const params = { versions, session, ...(token === undefined ? {} : { token }) };
    const hello = await this.request("hello", params);
    expect(hello.agent).toBeDefined();
    expect(hello.token).toBeString();
    return hello as HelloResult & { agent: NonNullable<HelloResult["agent"]>; token: string };
  }
  close() { this.stream.end(); }
}
