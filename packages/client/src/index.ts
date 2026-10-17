import type { Duplex } from "node:stream";
import type { Delivery, HelloParams, HelloResult, MethodTable, RequestMethod } from "@cross-harness-comms/protocol";

export interface CommsClient {
  hello(params: HelloParams): Promise<HelloResult>;
  request<M extends RequestMethod>(method: M, params: MethodTable[M]["params"]): Promise<MethodTable[M]["result"]>;
  deliveries: AsyncIterable<Delivery>;
  close(): Promise<void>;
}

export function createClient(stream: Duplex): CommsClient {
  throw new Error("not implemented");
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
