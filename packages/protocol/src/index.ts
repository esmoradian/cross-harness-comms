// The release version of the core, CLI, and plugins; `comms ensure` replaces only an older core.
export const RELEASE_VERSION = "0.1.14";
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
  // Present in `list` for a non-Claude agent when the caller is a Claude session on the native route (ADR-016).
  claude_address?: string;
  // The agent's last activity, an ISO 8601 time, in every `list` result; optional because it was added within version 1 (ADR-005, ADR-018).
  active_at?: string;
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
  // The sender's working directory from its agent record; optional because it was added within version 1 (ADR-005, ADR-017).
  cwd?: string;
}

export interface VersionRange { min: number; max: number }
export interface HelloParams {
  versions: VersionRange;
  token?: string;
  // Absent for a one-shot CLI connection negotiating before token-authenticated commands.
  session?: SessionRegistration;
  // A Claude session's inbox socket and engine version, for the native inbox route (ADR-016).
  claude?: { inbox: string; version: string };
}
export interface HelloResult {
  version: number;
  agent?: Agent;
  token?: string;
  notice?: string;
}
export interface SendParams {
  // Either a session token, or an online Codex thread when sent by the Codex MCP server (ADR-014).
  token?: string;
  codex_thread?: string;
  id: string;
  to: string;
  body: string;
  reply_to?: string;
}
export interface SendResult {
  id: string;
  state: "queued" | "delivered" | "acked";
  notice?: string;
  // The recipient's agent name and presence; optional because they were added within version 1 (ADR-005, ADR-018).
  name?: string;
  online?: boolean;
}
export interface MethodTable {
  ping: { params: Record<string, never>; result: Record<string, never> };
  shutdown: { params: Record<string, never>; result: { ok: true } };
  detach: { params: { token: string }; result: { ok: true } };
  rename: { params: { address: string; name: string }; result: Agent };
  inspect: { params: { id: string }; result: Message };
  status: { params: Record<string, never>; result: { version: string; protocol: number } };
  codex_session_start: { params: { session: SessionRegistration; executable: string }; result: { agent: Agent } };
  codex_session_end: { params: { session_key: string }; result: { ok: true } };
  hello: { params: HelloParams; result: HelloResult };
  send: { params: SendParams; result: SendResult };
  deliver: { params: Delivery; result: never };
  ack: { params: { token: string; id: string }; result: { id: string; state: "acked" } };
  // A Claude session acknowledging the native inbox line sent from the reply socket `from` (ADR-016).
  native_ack: { params: { token: string; from: string }; result: { id: string } };
  list: { params: { token?: string }; result: { agents: Agent[]; notice?: string } };
  // The one agent whose name is exactly `name`, with the fields `list` gives the caller, or null;
  // `skip_claude` answers null for a Claude agent (ADR-005, additive).
  resolve: { params: { token?: string; name: string; skip_claude?: boolean }; result: { agent: Agent | null } };
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

// Claude-style text for harnesses that show messages as plain text (ADR-018). Codex replies with
// comms_send and reply_to; Claude's adapter fills in reply_to for its SendMessage.
export function formatMessage(delivery: Delivery, receiver: "codex" | "claude"): string {
  const { message, from } = delivery;
  const hint = receiver === "codex" ? `Reply with comms_send to ${from} with reply_to ${message.id}.` : `Reply with SendMessage to ${from}.`;
  const replies = message.reply_to ? ` This replies to ${message.reply_to}.` : "";
  return `Message from @${from.replace(/^comms:/, "")} (another agent, through comms):\n${message.body}\n\n${hint}${replies}`;
}

export function resolveAddress(address: string, agents: readonly Agent[]): Agent {
  if (!address.startsWith("comms:")) throw failure("UNKNOWN_RECIPIENT");
  const key = address.slice(6);
  const exact = agents.find(agent => agent.name === key || agent.id === key);
  if (exact) return exact;
  const matches = key.length >= 8 && /^[0-9a-f-]+$/.test(key)
    ? agents.filter(agent => agent.id.startsWith(key)) : [];
  if (matches.length > 1) throw failure("AMBIGUOUS_RECIPIENT");
  if (!matches[0]) throw failure("UNKNOWN_RECIPIENT");
  return matches[0];
}


// Claude Code's peer-message inbox line (ADR-016). The formats we speak are compiled in.
export const CLAUDE_INBOX_VERSIONS: readonly number[] = [1];
export const CLAUDE_NATIVE_MIN_VERSION = "2.1.289";

export interface ClaudeInboxLine {
  msgV: number;
  msg_id: string;
  // The sender's `uds:` address.
  from: string;
  // The element's `from-name` attribute.
  from_name: string;
  // The unescaped message body.
  body: string;
}

// Claude escapes only a literal closing tag in a body, as `<\/cross-session-message>`.
// One more backslash on any `<` + backslashes + `/cross-session-message>` keeps that and makes it reversible.
const escapeInboxBody = (body: string) => body.replace(/<(\\*)\/cross-session-message>/g, "<\\$1/cross-session-message>");
const unescapeInboxBody = (body: string) => body.replace(/<\\(\\*)\/cross-session-message>/g, "<$1/cross-session-message>");
const INBOX_ELEMENT = /^<cross-session-message((?: [a-z-]+="[^"]*")*)>\n([\s\S]*)\n<\/cross-session-message>$/;

// Writes one inbox line, without its trailing newline, stamped as sent by this plugin.
export function formatClaudeInboxLine(line: { msg_id: string; from: string; from_name: string; body: string }): string {
  const content = `<cross-session-message from="${line.from}" from-name="${line.from_name}" from-mode="prompting">\n${escapeInboxBody(line.body)}\n</cross-session-message>`;
  return JSON.stringify({ msgV: 1, msg_id: line.msg_id, type: "user", message: { role: "user", content }, priority: "next", from: line.from,
    from_plugin: "cross-harness-comms" });
}

// Reads one inbox line, or returns undefined when it is not a peer-message line.
export function parseClaudeInboxLine(line: string): ClaudeInboxLine | undefined {
  let value: { msgV?: unknown; msg_id?: unknown; type?: unknown; from?: unknown; message?: { role?: unknown; content?: unknown } };
  try { value = JSON.parse(line); } catch { return undefined; }
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.msgV !== "number" || typeof value.msg_id !== "string"
    || !value.msg_id || typeof value.from !== "string" || value.type !== "user" || value.message?.role !== "user"
    || typeof value.message.content !== "string") return undefined;
  const element = INBOX_ELEMENT.exec(value.message.content);
  if (!element) return undefined;
  const from_name = / from-name="([^"]*)"/.exec(element[1]!)?.[1] ?? "";
  return { msgV: value.msgV, msg_id: value.msg_id, from: value.from, from_name, body: unescapeInboxBody(element[2]!) };
}

export const MAX_LINE_BYTES = 1024 * 1024;
export const VERSION_RANGE: VersionRange = { min: 1, max: 1 };
export const DEFAULT_POLICY: VersionPolicy = {
  latest: 1, versions: { 1: { status: "supported" } }, steps: [],
};

export function failure(code: string, message = code, rpcCode = -32000): Error & RpcError {
  return Object.assign(new Error(message), { code: rpcCode, data: { code } });
}

export function negotiate(range: VersionRange, policy: VersionPolicy): number {
  if (!range || !Number.isInteger(range.min) || !Number.isInteger(range.max) || range.min > range.max)
    throw failure("INVALID_PARAMS", "Invalid version range", -32602);
  const available = Object.keys(policy.versions).map(Number).filter(v => policy.versions[v]?.status !== "removed");
  const version = available.filter(v => v >= range.min && v <= range.max).sort((a, b) => b - a)[0];
  if (version === undefined) throw failure("INCOMPATIBLE_PROTOCOL",
    range.max < Math.min(...available) ? "INCOMPATIBLE_PROTOCOL: update the adapter" : "INCOMPATIBLE_PROTOCOL: update the core");
  return version;
}

export function convert(packet: WirePacket, from: number, to: number, policy: VersionPolicy): WirePacket {
  while (from !== to) {
    const up = from < to;
    const step = policy.steps.find(s => up ? s.from === from && s.to === from + 1 : s.to === from && s.from === from - 1);
    if (!step) throw failure("INCOMPATIBLE_PROTOCOL", `Missing conversion from version ${from}`);
    packet = up ? step.up(packet) : step.down(packet);
    from = up ? step.to : step.from;
  }
  return packet;
}

// Follows the recipient's presence: an online Codex thread's message is still queued for `codex queue`.
export function sendSummary(result: SendResult): string {
  const name = result.name ?? result.id;
  return result.online ?? result.state !== "queued" ? `Sent to ${name}.` : `Queued for ${name}, which is offline; it gets the message when it reconnects.`;
}

export const SEND_SCHEMA = {
  type: "object", properties: {
    to: { type: "string", description: "Recipient comms address" },
    text: { type: "string" }, reply_to: { type: "string" },
  }, required: ["to", "text"], additionalProperties: false,
};
