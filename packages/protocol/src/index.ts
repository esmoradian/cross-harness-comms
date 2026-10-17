export type Harness = "pi" | "claude" | "codex";

export interface SessionRegistration {
  harness: Harness;
  session_key: string;
  host: string;
  cwd: string;
}

export interface Agent extends SessionRegistration {
  id: string;
  name: string;
  last_seen: string;
  online: boolean;
}

export interface Message {
  id: string;
  sender: string;
  recipient: string;
  reply_to?: string;
  body: string;
  created_at: string;
  state: "queued" | "delivered" | "acked";
}

export interface Delivery {
  message: Message;
  from: string;
  harness: Harness;
}

export interface VersionRange { min: number; max: number }
export interface HelloParams {
  versions: VersionRange;
  // Absent for a one-shot CLI connection negotiating before token-authenticated commands.
  session?: SessionRegistration;
}
export interface HelloResult {
  version: number;
  agent?: Agent;
  token?: string;
  notice?: string;
}
export interface SendParams {
  token: string;
  id: string;
  to: string;
  body: string;
  reply_to?: string;
}
export interface SendResult { id: string; state: "queued" | "delivered" | "acked"; notice?: string }
export interface MethodTable {
  hello: { params: HelloParams; result: HelloResult };
  send: { params: SendParams; result: SendResult };
  deliver: { params: Delivery; result: never };
  ack: { params: { token: string; id: string }; result: { id: string; state: "acked" } };
  list: { params: Record<string, never>; result: { agents: Agent[]; notice?: string } };
}
export type RequestMethod = Exclude<keyof MethodTable, "deliver">;
export interface RpcError {
  code: number;
  message: string;
  data?: { code: string; [key: string]: unknown };
}
export type WirePacket =
  | { jsonrpc: "2.0"; id?: string | number; method: string; params: unknown }
  | { jsonrpc: "2.0"; id: string | number; result: unknown }
  | { jsonrpc: "2.0"; id: string | number | null; error: RpcError };

export interface ConversionStep {
  from: number;
  to: number;
  up(packet: WirePacket): WirePacket;
  down(packet: WirePacket): WirePacket;
}
export interface VersionPolicy {
  latest: number;
  versions: Record<number, { status: "supported" | "deprecated" | "removed"; notice?: string }>;
  steps: readonly ConversionStep[];
}

export function formatMessage(delivery: Delivery): string {
  throw new Error("not implemented");
}

export function resolveAddress(address: string, agents: readonly Agent[]): Agent {
  throw new Error("not implemented");
}
