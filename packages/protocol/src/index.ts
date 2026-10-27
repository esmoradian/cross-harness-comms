// The release version of the core, CLI, and plugins; `comms ensure` replaces only an older core.
export const RELEASE_VERSION = "0.2.2";
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
  // Present in `list` for a non-Claude agent when the caller is a Claude session on the native route.
  claude_address?: string;
  // The agent's last activity, an ISO 8601 time, in every `list` result; optional because it was added within version 1.
  active_at?: string;
  // Computed when `list` or `resolve` answers; `online` means it is not "offline"; optional because it was added within version 1.
  presence?: "active" | "idle" | "offline";
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
  // The sender's working directory from its agent record; optional because it was added within version 1.
  cwd?: string;
}

interface VersionRange { min: number; max: number }
export interface HelloParams {
  versions: VersionRange;
  token?: string;
  // Absent for a one-shot CLI connection negotiating before token-authenticated commands.
  session?: SessionRegistration;
  // A Claude session's inbox socket and engine version, for the native inbox route.
  claude?: { inbox: string; version: string };
  // The token of the identity this session replaces, which Claude's adapter sends after /clear; the core moves that
  // identity's chosen name to a newly created one when it is offline on the same harness and host (additive within version 1).
  replaces?: string;
}
export interface HelloResult {
  version: number;
  agent?: Agent;
  token?: string;
  notice?: string;
}
export interface SendParams {
  // Either a session token, or an online Codex thread when sent by the Codex MCP server.
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
  // The recipient's agent name, presence, harness, and native session ID; optional because they were added within version 1.
  name?: string;
  online?: boolean;
  harness?: Harness;
  session_key?: string;
}
export interface MethodTable {
  ping: { params: Record<string, never>; result: Record<string, never> };
  shutdown: { params: Record<string, never>; result: { ok: true } };
  detach: { params: { token: string }; result: { ok: true } };
  rename: { params: { address: string; name: string }; result: Agent };
  // Sets the caller's own name and marks it chosen; an offline holder of the name falls back to a generated one,
  // and an online holder refuses with NAME_TAKEN (additive within version 1).
  name: { params: { token?: string; codex_thread?: string; name: string }; result: Agent };
  inspect: { params: { id: string }; result: Message };
  status: { params: Record<string, never>; result: { version: string; protocol: number } };
  codex_session_start: { params: { session: SessionRegistration; executable: string }; result: { agent: Agent } };
  codex_session_end: { params: { session_key: string }; result: { ok: true } };
  hello: { params: HelloParams; result: HelloResult };
  send: { params: SendParams; result: SendResult };
  deliver: { params: Delivery; result: never };
  ack: { params: { token: string; id: string }; result: { id: string; state: "acked" } };
  // A Claude session acknowledging the native inbox line sent from the reply socket `from`.
  native_ack: { params: { token: string; from: string }; result: { id: string } };
  // `include_stale` also returns agents offline for more than a day, and `hidden` counts those left out, of which
  // `hidden_claude` are Claude agents (additive within version 1).
  list: { params: { token?: string; include_stale?: boolean }; result: { agents: Agent[]; notice?: string; hidden?: number; hidden_claude?: number } };
  // The one agent whose name is exactly `name`, with the fields `list` gives the caller, or null;
  // `skip_claude` answers null for a Claude agent (additive within version 1).
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

interface ConversionStep {
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

// Claude-style text for harnesses that show messages as plain text. Codex replies with
// comms_send and reply_to; Claude's adapter fills in reply_to for its SendMessage.
export function formatMessage(delivery: Delivery, receiver: "codex" | "claude"): string {
  const { message, from } = delivery;
  const hint = receiver === "codex" ? `Reply with comms_send to ${from} with reply_to ${message.id}.` : `Reply with SendMessage to ${from}.`;
  const replies = message.reply_to ? ` This replies to ${message.reply_to}.` : "";
  return `Message from @${addressName(from)} (another agent, through comms):\n${message.body}\n\n${hint}${replies}`;
}

// Lookups try an exact name, an agent ID, a harness session ID, the normalized name, then an ID prefix.
export function resolveAddress(address: string, agents: readonly Agent[]): Agent {
  // A plain name or ID means `comms:`; any other scheme is not ours.
  const scheme = /^([^:]*):/.exec(address)?.[1];
  if (scheme !== undefined && scheme !== "comms") throw failure("UNKNOWN_RECIPIENT", `No agent at ${address}`);
  const key = scheme === undefined ? address : address.slice(6), normal = normalizeName(key);
  const found = agents.find(agent => agent.name === key) ?? agents.find(agent => agent.id === key);
  if (found) return found;
  const sessions = agents.filter(agent => agent.session_key === key);
  if (sessions.length > 1) throw failure("AMBIGUOUS_RECIPIENT");
  const named = sessions[0] ?? agents.find(agent => agent.name === normal);
  if (named) return named;
  const matches = key.length >= 8 && /^[0-9a-f-]+$/.test(key)
    ? agents.filter(agent => agent.id.startsWith(key)) : [];
  if (matches.length > 1) throw failure("AMBIGUOUS_RECIPIENT");
  if (!matches[0]) throw failure("UNKNOWN_RECIPIENT", `No agent named ${key}`);
  return matches[0];
}

// A comms name: 1-64 of `[a-z0-9._/-]`, not starting or ending with `/`; the core also refuses UUID-like names.
export const NAME_RULE = /^(?!\/)[a-z0-9._/-]{1,64}(?<!\/)$/;

// Text such as a Pi session name as a comms name: lowercased, runs of other characters as `-`, `-` and `/` trimmed
// from both ends, and cut to 64; trimmed again after the cut so it never ends in `/`. Undefined when nothing is left.
export function normalizeName(text: string): string | undefined {
  const trim = (value: string) => value.replace(/^[-/]+|[-/]+$/g, "");
  return trim(trim(text.toLowerCase().replace(/[^a-z0-9._/-]+/g, "-")).slice(0, 64)) || undefined;
}


// Claude Code's peer-message inbox line. The formats we speak are compiled in.
export const CLAUDE_INBOX_VERSIONS: readonly number[] = [1];
export const CLAUDE_NATIVE_MIN_VERSION = "2.1.289";

interface ClaudeInboxLine {
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

// The tools Pi and Codex give their models, with one wording for both.
export const COMMS_TOOLS = [
  { name: "comms_send", description: "Send a message to a comms address. Reply with reply_to set to the message ID.", inputSchema: {
    type: "object", properties: {
      to: { type: "string", description: "Recipient name, ID, or comms:<name>" },
      text: { type: "string" }, reply_to: { type: "string" },
    }, required: ["to", "text"], additionalProperties: false,
  } },
  { name: "comms_list", description: "List cross-harness agents and their presence.", inputSchema: {
    type: "object", properties: { all: { type: "boolean", description: "Also list agents offline for more than a day" } },
  } },
  { name: "comms_name", description: "Choose this session's comms name, which other agents send to as comms:<name>.", inputSchema: {
    type: "object", properties: { name: { type: "string", description: "1-64 lowercase letters, digits, dots, underscores, hyphens, or slashes, not starting or ending with a slash" } },
    required: ["name"], additionalProperties: false,
  } },
] as const;

// What comms_list returns: each agent with the address to send it to.
export const listedAgents = (agents: readonly Agent[]) => agents.map(agent => ({ ...agent, address: `comms:${agent.name}` }));

// An agent's last activity relative to `time`, in whole units: `last active now`, then minutes, hours, and days.
export function activeAgo(agent: Agent, time: number): string {
  const minutes = Math.floor((time - Date.parse(agent.active_at ?? agent.last_seen)) / 60_000);
  if (minutes < 1) return "last active now";
  if (minutes < 60) return `last active ${minutes}m ago`;
  return minutes < 1440 ? `last active ${Math.floor(minutes / 60)}h ago` : `last active ${Math.floor(minutes / 1440)}d ago`;
}

// The line agent-facing lists end with when `list` left out stale agents.
export const hiddenLine = (hidden: number) => `${hidden} offline agent${hidden === 1 ? "" : "s"} not shown`;

// An agent's name from its `comms:` address.
export const addressName = (address: string) => address.replace(/^comms:/, "");

// A UUIDv7 from pure JavaScript and the global random source, so the Claude mod sandbox and Node can both use it.
export function messageId(milliseconds: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = Math.floor(milliseconds);
  for (let index = 5; index >= 0; index--) { bytes[index] = timestamp % 256; timestamp = Math.floor(timestamp / 256); }
  bytes[6] = 0x70 | (bytes[6]! & 15);
  bytes[8] = 0x80 | (bytes[8]! & 63);
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Compares the first three numeric parts of two versions; a missing part counts as 0, and an
// unreadable one makes the result NaN, which every comparison with 0 rejects.
export function compareVersions(a: string, b: string): number {
  const part = (version: string, index: number) => parseInt(version.split(".")[index] || "0", 10);
  for (let index = 0; index < 3; index++) {
    const difference = part(a, index) - part(b, index);
    if (difference !== 0) return difference;
  }
  return 0;
}

// Splits buffered stream text into its complete lines and the unterminated rest.
export function splitLines(buffer: string): { lines: string[]; rest: string } {
  const lines = buffer.split("\n");
  return { lines, rest: lines.pop()! };
}
