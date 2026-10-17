import type { Duplex } from "node:stream";
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import { readPackets, writePacket, messageId } from "@cross-harness-comms/client";
import { DEFAULT_POLICY, convert, failure, negotiate, resolveAddress, MAX_LINE_BYTES,
  type Agent, type Message, type SessionRegistration, type VersionPolicy, type WirePacket, type RpcError } from "@cross-harness-comms/protocol";

export interface Core {
  attach(stream: Duplex): void;
  close(): Promise<void>;
}

interface Connection { stream: Duplex; version?: number; agent?: string; token?: string }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("INVALID_PARAMS", "Expected an object", -32602);
  return value as Record<string, unknown>;
};
const string = (value: unknown): string => {
  if (typeof value !== "string" || !value.length) throw failure("INVALID_PARAMS", "Expected a nonempty string", -32602);
  return value;
};

function registration(value: unknown): SessionRegistration {
  const fields = object(value);
  if (!["pi", "claude", "codex"].includes(String(fields.harness))) throw failure("INVALID_PARAMS", "Unknown harness", -32602);
  return { harness: fields.harness as SessionRegistration["harness"], session_key: string(fields.session_key),
    host: string(fields.host), cwd: string(fields.cwd) };
}

export function createCore(options: { databasePath: string; protocol?: VersionPolicy; onShutdown?: () => void }): Core {
  const policy = options.protocol ?? DEFAULT_POLICY;
  const db = new Database(options.databasePath, { create: true });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, harness TEXT NOT NULL, session_key TEXT NOT NULL,
      host TEXT NOT NULL, name TEXT NOT NULL UNIQUE, cwd TEXT NOT NULL, last_seen TEXT NOT NULL,
      UNIQUE(harness, session_key));
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, sender TEXT NOT NULL REFERENCES agents(id), recipient TEXT NOT NULL REFERENCES agents(id),
      reply_to TEXT REFERENCES messages(id), body TEXT NOT NULL, created_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('queued','delivered','acked')));
    CREATE INDEX IF NOT EXISTS mailbox ON messages(recipient, state);`);
  let closed = false;
  const connections = new Set<Connection>();
  const live = new Map<string, Connection>();
  const tokens = new Map<string, string>();
  const codexSessions = new Map<number, SessionRegistration>();
  const watchers = new Map<number, Connection>();
  const agents = (): Agent[] => (db.query("SELECT * FROM agents ORDER BY rowid").all() as Omit<Agent, "online">[])
    .map(agent => ({ ...agent, online: live.has(agent.id) }));
  const packet = (connection: Connection, value: WirePacket) => writePacket(connection.stream,
    convert(value, policy.latest, connection.version ?? policy.latest, policy));
  const detach = (connection: Connection) => {
    connections.delete(connection);
    for (const [pid, watcher] of watchers) if (watcher === connection) { watchers.delete(pid); codexSessions.delete(pid); }
    if (connection.token) tokens.delete(connection.token);
    if (connection.agent && live.get(connection.agent) === connection) {
      live.delete(connection.agent);
      if (!closed) db.query("UPDATE agents SET last_seen = ? WHERE id = ?").run(new Date().toISOString(), connection.agent);
    }
  };
  const authenticated = (params: Record<string, unknown>) => {
    const agent = typeof params.token === "string" ? tokens.get(params.token) : undefined;
    if (!agent) throw failure("INVALID_TOKEN");
    return agent;
  };
  const delivery = (message: Message) => {
    const sender = agents().find(a => a.id === message.sender)!;
    return { message, from: `comms:${sender.name}`, harness: sender.harness };
  };
  const deliver = (message: Message) => {
    const connection = live.get(message.recipient);
    if (!connection || message.state === "acked") return;
    try {
      // State is committed before writing to the stream. Reconnect retries both
      // queued and delivered records, including a write interrupted by a crash.
      db.query("UPDATE messages SET state = 'delivered' WHERE id = ? AND state = 'queued'").run(message.id);
      packet(connection, { jsonrpc: "2.0", method: "deliver", params: delivery({ ...message, state: "delivered" }) });
    } catch { detach(connection); connection.stream.destroy(); }
  };
  const register = (input: SessionRegistration, connection: Connection): Agent => {
    const session = registration(input);
    let agent = agents().find(a => a.harness === session.harness && a.session_key === session.session_key);
    const now = new Date().toISOString();
    if (!agent) {
      const base = `${session.harness}-${basename(session.cwd) || "session"}`.toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 64);
      let name = base, suffix = 1;
      const names = new Set(agents().map(a => a.name));
      while (names.has(name)) { const tail = `-${++suffix}`; name = base.slice(0, 64 - tail.length) + tail; }
      const id = messageId();
      db.query("INSERT INTO agents VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, session.harness, session.session_key, session.host, name, session.cwd, now);
      agent = { ...session, id, name, last_seen: now, online: true };
    } else {
      db.query("UPDATE agents SET host = ?, cwd = ?, last_seen = ? WHERE id = ?").run(session.host, session.cwd, now, agent.id);
      agent = { ...agent, ...session, last_seen: now, online: true };
    }
    const previous = live.get(agent.id);
    if (previous) {
      detach(previous);
      try { packet(previous, { jsonrpc: "2.0", method: "session_replaced", params: {} }); previous.stream.end(); }
      catch { previous.stream.destroy(); }
    }
    connection.agent = agent.id;
    connection.token = randomBytes(32).toString("hex");
    tokens.set(connection.token, agent.id);
    live.set(agent.id, connection);
    return agent;
  };
  const handle = (connection: Connection, method: string, raw: unknown): unknown => {
    const params = object(raw ?? {});
    if (method === "hello") {
      if (connection.version !== undefined) throw failure("INVALID_REQUEST", "hello already completed", -32600);
      connection.version = negotiate(params.versions as { min: number; max: number }, policy);
      const agent = params.session ? register(object(params.session) as unknown as SessionRegistration, connection) : undefined;
      const notice = policy.versions[connection.version]?.notice;
      return { version: connection.version, ...(agent ? { agent, token: connection.token } : {}), ...(notice ? { notice } : {}) };
    }
    if (connection.version === undefined) throw failure("HELLO_REQUIRED");
    switch (method) {
      case "codex_start": {
        const pid = params.pid;
        if (!Number.isSafeInteger(pid) || (pid as number) <= 0) throw failure("INVALID_PARAMS");
        const session = registration(params.session);
        if (session.harness !== "codex") throw failure("INVALID_PARAMS");
        codexSessions.set(pid as number, session);
        const watcher = watchers.get(pid as number);
        if (watcher) packet(watcher, { jsonrpc: "2.0", method: "codex_session", params: session });
        return { ok: true };
      }
      case "codex_watch": {
        const pid = params.pid;
        if (!Number.isSafeInteger(pid) || (pid as number) <= 0) throw failure("INVALID_PARAMS");
        const previous = watchers.get(pid as number);
        if (previous && previous !== connection) throw failure("FORBIDDEN", "Process already has an MCP connection");
        watchers.set(pid as number, connection);
        return { session: codexSessions.get(pid as number) };
      }
      case "list": return { agents: agents() };
      case "send": {
        const sender = authenticated(params);
        const id = string(params.id);
        if (!uuid.test(id) || typeof params.body !== "string") throw failure("INVALID_MESSAGE");
        const recipient = resolveAddress(string(params.to), agents()).id;
        const reply_to = params.reply_to === undefined ? undefined : string(params.reply_to);
        if (reply_to && !db.query("SELECT id FROM messages WHERE id = ?").get(reply_to)) throw failure("INVALID_MESSAGE", "Unknown reply_to message");
        const existing = db.query("SELECT * FROM messages WHERE id = ?").get(id) as Message | null;
        if (existing) {
          if (existing.sender !== sender || existing.recipient !== recipient || existing.body !== params.body || (existing.reply_to ?? undefined) !== reply_to)
            throw failure("INVALID_MESSAGE", "Message ID already belongs to different content");
          return { id, state: existing.state };
        }
        const message: Message = { id, sender, recipient, body: params.body, created_at: new Date().toISOString(), state: "queued", ...(reply_to ? { reply_to } : {}) };
        // Reserve the longest valid sender name and persisted nullable reply field,
        // so a later rename or replay cannot make an accepted message undeliverable.
        const envelope = { ...delivery(message), from: "comms:" + "x".repeat(64),
          message: { ...message, state: "delivered", reply_to: reply_to ?? null } };
        if (Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", method: "deliver", params: envelope })) > MAX_LINE_BYTES)
          throw failure("INVALID_MESSAGE", "Delivery line exceeds 1 MB");
        db.query("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, sender, recipient, reply_to ?? null, message.body, message.created_at, message.state);
        deliver(message);
        return db.query("SELECT id, state FROM messages WHERE id = ?").get(id);
      }
      case "ack": {
        const recipient = authenticated(params), id = string(params.id);
        const message = db.query("SELECT * FROM messages WHERE id = ?").get(id) as Message | null;
        if (!message) throw failure("INVALID_MESSAGE", "Unknown message");
        if (message.recipient !== recipient) throw failure("FORBIDDEN");
        if (message.state === "queued") throw failure("INVALID_MESSAGE", "Message has not been delivered");
        db.query("UPDATE messages SET state = 'acked' WHERE id = ?").run(id);
        return { id, state: "acked" };
      }
      case "detach": {
        const agent = authenticated(params);
        const owner = live.get(agent);
        if (owner) { detach(owner); queueMicrotask(() => owner.stream.end()); }
        return { ok: true };
      }
      case "rename": {
        const agent = resolveAddress(string(params.address), agents()), name = string(params.name);
        if (!/^[a-z0-9._-]{1,64}$/.test(name) || /^[0-9a-f-]{8,}$/.test(name)) throw failure("INVALID_NAME", "Use 1-64 lowercase letters, digits, dots, underscores or hyphens; UUID-like names are reserved");
        if (agents().some(a => a.name === name && a.id !== agent.id)) throw failure("NAME_TAKEN");
        db.query("UPDATE agents SET name = ? WHERE id = ?").run(name, agent.id);
        return { ...agent, name };
      }
      case "inspect": {
        const message = db.query("SELECT * FROM messages WHERE id = ?").get(string(params.id));
        if (!message) throw failure("INVALID_MESSAGE", "Unknown message");
        return message;
      }
      case "shutdown": {
        if (!options.onShutdown) throw failure("METHOD_NOT_FOUND");
        setTimeout(options.onShutdown, 20);
        return { ok: true };
      }
      case "status": return { version: "0.1.0", protocol: policy.latest };
      default: throw failure("METHOD_NOT_FOUND", "Method not found", -32601);
    }
  };
  return {
    attach(stream) {
      if (closed) { stream.destroy(); return; }
      const connection: Connection = { stream };
      connections.add(connection);
      stream.on("end", () => { detach(connection); stream.end(); });
      stream.on("close", () => detach(connection));
      stream.on("error", () => detach(connection));
      readPackets(stream, wire => {
        let id: string | number | null = null;
        try {
          if (!wire || typeof wire !== "object" || wire.jsonrpc !== "2.0" || !("method" in wire) || typeof wire.method !== "string")
            throw failure("INVALID_REQUEST", "Invalid JSON-RPC request", -32600);
          id = wire.id ?? null;
          if (id !== null && typeof id !== "string" && typeof id !== "number") throw failure("INVALID_REQUEST", "Invalid request ID", -32600);
          const request = connection.version !== undefined ? convert(wire, connection.version, policy.latest, policy) : wire;
          if (!("method" in request)) throw failure("INVALID_REQUEST");
          const result = handle(connection, request.method, request.params);
          if (id !== null) packet(connection, { jsonrpc: "2.0", id, result });
          if (request.method === "hello" && connection.agent) {
            for (const message of db.query("SELECT * FROM messages WHERE recipient = ? AND state != 'acked' ORDER BY rowid").all(connection.agent) as Message[]) deliver(message);
          }
        } catch (error) {
          const rpc = error as Partial<RpcError>;
          // Never echo request data or tokens, including malformed input.
          const response: RpcError = { code: typeof rpc.code === "number" ? rpc.code : -32603, message: rpc.data ? rpc.message! : "Internal error", ...(rpc.data ? { data: rpc.data } : {}) };
          try { packet(connection, { jsonrpc: "2.0", id, error: response }); } catch { stream.destroy(); }
        }
      }, error => {
        const rpc = error as Partial<RpcError>;
        try { writePacket(stream, { jsonrpc: "2.0", id: null, error: { code: rpc.code ?? -32700, message: rpc.data ? error.message : "Parse error", ...(rpc.data ? { data: rpc.data } : {}) } }); }
        catch { stream.destroy(); }
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const connection of connections) connection.stream.destroy();
      connections.clear(); live.clear(); tokens.clear(); db.close();
    },
  };
}
