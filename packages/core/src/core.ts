import type { Duplex } from "node:stream";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { basename } from "node:path";
import type { CodexEvent } from "./codex/events.ts";
import { readPackets, writePacket } from "@cross-harness-comms/client";
import { DEFAULT_POLICY, NAME_RULE, RELEASE_VERSION, convert, failure, negotiate, resolveAddress, MAX_LINE_BYTES, CLAUDE_NATIVE_MIN_VERSION,
  compareVersions, messageId, type Agent, type Delivery, type Message, type SessionRegistration, type VersionPolicy, type WirePacket, type RpcError } from "@cross-harness-comms/protocol";
import { hash, openStore, type AgentRow, type Store } from "./store.ts";
import { claudeRoute } from "./claude.ts";
import { codexThreads, type Run, type CodexSteer } from "./codex/threads.ts";

export interface Core {
  attach(stream: Duplex): void;
  close(): Promise<void>;
}

export interface Connection {
  stream: Duplex;
  version?: number;
  agent?: string;
  token?: string;
  requests: Promise<void>;
  closeAfterResponse?: boolean;
  pings: Map<string, (responsive: boolean) => void>;
  // A Claude session's inbox socket, whether the native route is on, and its unacknowledged line.
  inbox?: string;
  native?: boolean;
  inflight?: { id: string; from: string; timer?: ReturnType<typeof setTimeout> };
}

// What the Claude route and Codex threads share with the core.
export interface Context {
  store: Store;
  // The connection of each registered agent that is attached now.
  live: Map<string, Connection>;
  closed: boolean;
  now: () => number;
  touch(agent: string, time?: number): void;
  // `chosen` creates a new agent with that chosen name instead of a generated one.
  upsert(session: SessionRegistration, tokenHash?: string, chosen?: string): Agent;
  delivery(message: Message): Delivery;
  deliver(message: Message): void;
  accept(id: string, sender: string, recipient: string, body: string, reply_to?: string): void;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("INVALID_PARAMS", "Expected an object", -32602);
  return value as Record<string, unknown>;
};
const string = (value: unknown): string => {
  if (typeof value !== "string" || !value.length) throw failure("INVALID_PARAMS", "Expected a nonempty string", -32602);
  return value;
};

const validName = (value: unknown): string => {
  const name = string(value);
  if (!NAME_RULE.test(name) || /^[0-9a-f-]{8,}$/.test(name))
    throw failure("INVALID_NAME", "Use 1-64 lowercase letters, digits, dots, underscores, hyphens, or slashes, not starting or ending with a slash; UUID-like names are reserved");
  return name;
};

function registration(value: unknown): SessionRegistration {
  const fields = object(value);
  if (!["pi", "claude", "codex"].includes(String(fields.harness))) throw failure("INVALID_PARAMS", "Unknown harness", -32602);
  return { harness: fields.harness as SessionRegistration["harness"], session_key: string(fields.session_key),
    host: string(fields.host), cwd: string(fields.cwd) };
}

export function createCore(options: { databasePath: string; protocol?: VersionPolicy; onShutdown?: () => void; pingTimeoutMs?: number; run?: Run;
  codexEvents?: AsyncIterable<CodexEvent>; codexSteer?: CodexSteer; nativeAckMs?: number; now?: () => number }): Core {
  const policy = options.protocol ?? DEFAULT_POLICY;
  const store = openStore(options.databasePath), { db } = store;
  const pingTimeoutMs = options.pingTimeoutMs ?? 2000;
  if (!Number.isFinite(pingTimeoutMs) || pingTimeoutMs < 0) { db.close(); throw new Error("Invalid ping timeout"); }
  const connections = new Set<Connection>();
  const live = new Map<string, Connection>();
  const registrations = new Map<string, Promise<unknown>>();
  // Each agent's last activity in epoch milliseconds, kept in memory only; it never moves backward.
  const activity = new Map<string, number>();
  // An agent row with its presence and activity, as every listing shows it. A loaded Codex thread with no
  // activity for the daemon's unload delay has a window open, so that delay separates active from idle.
  const present = (agent: AgentRow, codexOnline: boolean): Agent => {
    const active = activity.get(agent.id), online = live.has(agent.id) || codexOnline;
    const active_at = active === undefined ? agent.last_seen : new Date(active).toISOString();
    const threshold = (agent.harness === "codex" ? codex.unloadDelaySecs() : 1800) * 1000;
    const presence = !online ? "offline" : ctx.now() - Date.parse(active_at) <= threshold ? "active" : "idle";
    return { ...agent, online, active_at, presence };
  };
  // Offline for more than a day, which agent-facing lists leave out.
  const stale = (agent: Agent) => !agent.online && ctx.now() - Date.parse(agent.last_seen) > 86_400_000;
  const agents = (): Agent[] => {
    const codex = store.codexOnline();
    return store.agents().map(agent => present(agent, codex.has(agent.id)));
  };
  const packet = (connection: Connection, value: WirePacket) => writePacket(connection.stream,
    convert(value, policy.latest, connection.version ?? policy.latest, policy));
  const detach = (connection: Connection) => {
    connections.delete(connection);
    clearTimeout(connection.inflight?.timer);
    for (const finish of connection.pings.values()) finish(false);
    const agent = connection.agent;
    if (agent && live.get(agent) === connection) {
      live.delete(agent);
      if (!ctx.closed) db.transaction(() => {
        store.seen(agent, ctx.now());
        db.query("DELETE FROM connected_sessions WHERE agent = ?").run(agent);
      })();
    }
  };
  // Retention: old offline agents are removed, and their names are held, for 30 days each.
  const retained = () => new Date(ctx.now() - 30 * 86_400_000).toISOString();
  const released = (name: string) => !!db.query("SELECT 1 FROM released_names WHERE name = ? AND released_at >= ?").get(name, retained());
  const refuseReleased = (name: string) => {
    if (released(name)) throw failure("NAME_TAKEN", `${name} was released recently by a removed agent and is held for 30 days`);
  };
  // The first free `<harness>-<folder>` name, with `-2`, `-3` suffixes.
  const generatedName = (harness: string, cwd: string) => {
    const base = `${harness}-${basename(cwd) || "session"}`.toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 64);
    let name = base, suffix = 1;
    while (store.agentNamed(name) || released(name)) { const tail = `-${++suffix}`; name = base.slice(0, 64 - tail.length) + tail; }
    return name;
  };
  // Removes each offline agent with a generated name last seen more than 30 days ago, unless mail it sent still
  // waits for an agent that stays, with every message to or from it and its Codex rows, and tombstones its name.
  const sweep = () => {
    const cutoff = retained();
    db.query("DELETE FROM released_names WHERE released_at < ?").run(cutoff);
    const removed = new Set((db.query(`SELECT id FROM agents WHERE last_seen < ? AND name_chosen = 0
      AND id NOT IN (SELECT agent FROM codex_threads)`).all(cutoff) as { id: string }[])
      .map(row => row.id).filter(id => !live.has(id) && !codex.onlineBeforeStart(id)));
    if (!removed.size) return;
    const waiting = db.query("SELECT sender, recipient FROM messages WHERE state != 'acked' AND sender IN (SELECT value FROM json_each(?))")
      .all(JSON.stringify([...removed])) as { sender: string; recipient: string }[];
    // An agent kept for its mail keeps the agents whose mail waits for it in turn.
    for (let changed = true; changed;) {
      changed = false;
      for (const { sender, recipient } of waiting) if (removed.has(sender) && !removed.has(recipient)) { removed.delete(sender); changed = true; }
    }
    if (!removed.size) return;
    const ids = "(SELECT value FROM json_each(?1))", mail = `sender IN ${ids} OR recipient IN ${ids}`;
    // Foreign keys have no cascades, so references go before the rows they point at.
    db.transaction((list: string) => {
      db.query(`UPDATE messages SET reply_to = NULL WHERE reply_to IN (SELECT id FROM messages WHERE ${mail})`).run(list);
      db.query(`DELETE FROM messages WHERE ${mail}`).run(list);
      db.query(`DELETE FROM codex_threads WHERE agent IN ${ids}`).run(list);
      db.query(`DELETE FROM codex_lifecycle WHERE agent IN ${ids}`).run(list);
      db.query(`DELETE FROM connected_sessions WHERE agent IN ${ids}`).run(list);
      db.query(`INSERT OR REPLACE INTO released_names SELECT name, ?2 FROM agents WHERE id IN ${ids}`).run(list, new Date(ctx.now()).toISOString());
      db.query(`DELETE FROM agents WHERE id IN ${ids}`).run(list);
    })(JSON.stringify([...removed]));
    for (const id of removed) activity.delete(id);
    claude.forget(removed);
    codex.forget(removed);
  };
  // An offline agent gives up its name for a generated one; its mail stays with it.
  const release = (agent: AgentRow) =>
    db.query("UPDATE agents SET name = ?, name_chosen = 0 WHERE id = ?").run(generatedName(agent.harness, agent.cwd), agent.id);
  const online = (id: string) => live.has(id) || !!store.codexThread(id);
  const authenticated = (params: Record<string, unknown>) => {
    const agent = store.agentWithToken(params.token);
    if (!agent) throw failure("INVALID_TOKEN");
    return agent;
  };
  const ctx: Context = {
    store, live, closed: false, now: options.now ?? Date.now,
    touch: (agent, time = ctx.now()) => { activity.set(agent, Math.max(activity.get(agent) ?? time, time)); },
    delivery: message => {
      const sender = store.agentById(message.sender)!;
      return { message, from: `comms:${sender.name}`, harness: sender.harness, cwd: sender.cwd };
    },
    deliver: message => {
      if (message.state === "acked") return;
      const connection = live.get(message.recipient);
      if (!connection) { if (store.codexThread(message.recipient)) codex.deliver(message); return; }
      if (connection.native && store.agentById(message.sender)?.harness !== "claude") { claude.deliver(connection, message); return; }
      try {
        // State is committed before writing to the stream. Reconnect retries both
        // queued and delivered records, including a write interrupted by a crash.
        store.markDelivered(message.id);
        packet(connection, { jsonrpc: "2.0", method: "deliver", params: ctx.delivery({ ...message, state: "delivered" }) });
      } catch { detach(connection); connection.stream.destroy(); }
    },
    // Stores a new message and delivers it, refusing one whose delivery line would exceed the limit.
    accept: (id, sender, recipient, body, reply_to) => {
      const message: Message = { id, sender, recipient, body, created_at: new Date().toISOString(), state: "queued", ...(reply_to ? { reply_to } : {}) };
      // Reserve the longest valid sender name and persisted nullable reply field,
      // so a later rename or replay cannot make an accepted message undeliverable.
      const envelope = { ...ctx.delivery(message), from: "comms:" + "x".repeat(64),
        message: { ...message, state: "delivered", reply_to: reply_to ?? null } };
      if (Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", method: "deliver", params: envelope })) > MAX_LINE_BYTES)
        throw failure("INVALID_MESSAGE", "Delivery line exceeds 1 MB");
      db.query("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, sender, recipient, reply_to ?? null, body, message.created_at, message.state);
      ctx.touch(sender);
      ctx.deliver(message);
    },
    // Creates or refreshes an agent, which counts as its activity; a token hash is replaced only when given.
    upsert: (session, tokenHash, chosen) => {
      const now = new Date(ctx.now()).toISOString();
      const agent = store.agentBySession(session.harness, session.session_key);
      if (agent) {
        db.query("UPDATE agents SET host = ?, cwd = ?, last_seen = ? WHERE id = ?").run(session.host, session.cwd, now, agent.id);
        if (tokenHash) db.query("UPDATE agents SET token_hash = ? WHERE id = ?").run(tokenHash, agent.id);
        ctx.touch(agent.id);
        return present({ ...agent, ...session, last_seen: now }, true);
      }
      // A new agent runs the sweep first, so a name it releases is not generated again.
      sweep();
      const name = chosen ?? generatedName(session.harness, session.cwd);
      const id = messageId(Date.now());
      db.query("INSERT INTO agents (id, harness, session_key, host, name, cwd, last_seen, token_hash, name_chosen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, session.harness, session.session_key, session.host, name, session.cwd, now, tokenHash ?? null, chosen ? 1 : 0);
      if (session.harness !== "claude") claude.openReplySockets();
      ctx.touch(id);
      return present({ ...session, id, name, last_seen: now }, true);
    },
  };
  const claude = claudeRoute(ctx, options.nativeAckMs ?? 5000);
  const ping = (connection: Connection): Promise<boolean> => new Promise(resolve => {
    if (connection.stream.destroyed || connection.stream.writableEnded) { resolve(false); return; }
    const id = "ping:" + messageId(Date.now());
    const timer = setTimeout(() => finish(false), pingTimeoutMs);
    const finish = (responsive: boolean) => {
      if (!connection.pings.delete(id)) return;
      clearTimeout(timer);
      resolve(responsive);
    };
    connection.pings.set(id, finish);
    try { packet(connection, { jsonrpc: "2.0", id, method: "ping", params: {} }); }
    catch { finish(false); }
  });
  const register = async (input: SessionRegistration, connection: Connection, suppliedToken: unknown, replaces: unknown): Promise<Agent> => {
    const session = registration(input);
    const key = JSON.stringify([session.harness, session.session_key]);
    const previousRegistration = registrations.get(key) ?? Promise.resolve();
    const pending = previousRegistration.catch(() => {}).then(async () => {
      if (ctx.closed || connection.stream.destroyed) throw failure("DISCONNECTED");
      const existing = store.agentBySession(session.harness, session.session_key);
      const stored = existing ? db.query("SELECT token_hash FROM agents WHERE id = ?").get(existing.id) as { token_hash: string | null } : undefined;
      const suppliedHash = typeof suppliedToken === "string" ? hash(suppliedToken) : undefined;
      const matches = !!stored?.token_hash && !!suppliedHash && timingSafeEqual(Buffer.from(stored.token_hash), Buffer.from(suppliedHash));
      const previous = existing ? live.get(existing.id) : undefined;
      if (previous && !matches) {
        const responsive = await ping(previous);
        if (ctx.closed || connection.stream.destroyed) throw failure("DISCONNECTED");
        if (live.get(existing!.id) === previous && responsive) throw failure("SESSION_IN_USE", "Live session requires its current token");
        // A failed liveness check relinquishes the old connection before issuing
        // new credentials. Registrations for this native session are serialized.
      }
      const token = matches ? suppliedToken as string : randomBytes(32).toString("hex");
      // After Claude's /clear, a new identity takes the chosen name of the offline one it replaces on the same harness and host.
      const replacedId = existing ? undefined : store.agentWithToken(replaces);
      const replaced = replacedId ? store.agentById(replacedId) : null;
      const moves = replaced && replaced.harness === session.harness && replaced.host === session.host
        && store.nameChosen(replaced.id) && !online(replaced.id);
      const agent = db.transaction(() => {
        if (moves) release(replaced);
        return ctx.upsert(session, hash(token), moves ? replaced.name : undefined);
      })();
      if (previous) {
        detach(previous);
        try { packet(previous, { jsonrpc: "2.0", method: "session_replaced", params: {} }); previous.stream.end(); }
        catch { previous.stream.destroy(); }
      }
      connection.agent = agent.id;
      connection.token = token;
      db.query("INSERT OR IGNORE INTO connected_sessions (agent) VALUES (?)").run(agent.id);
      live.set(agent.id, connection);
      return agent;
    });
    registrations.set(key, pending);
    try { return await pending; }
    finally { if (registrations.get(key) === pending) registrations.delete(key); }
  };
  const handle = async (connection: Connection, method: string, raw: unknown): Promise<unknown> => {
    const params = object(raw ?? {});
    if (method === "hello") {
      if (connection.version !== undefined) throw failure("INVALID_REQUEST", "hello already completed", -32600);
      connection.version = negotiate(params.versions as { min: number; max: number }, policy);
      if (params.claude !== undefined) {
        const { inbox, version } = object(params.claude);
        connection.inbox = string(inbox);
        connection.native = compareVersions(string(version), CLAUDE_NATIVE_MIN_VERSION) >= 0;
      }
      const agent = params.session ? await register(object(params.session) as unknown as SessionRegistration, connection, params.token, params.replaces) : undefined;
      if (agent && connection.native) claude.openReplySockets();
      const notice = policy.versions[connection.version]?.notice;
      return { version: connection.version, ...(agent ? { agent, token: connection.token } : {}), ...(notice ? { notice } : {}) };
    }
    if (connection.version === undefined) throw failure("HELLO_REQUIRED");
    switch (method) {
      case "codex_session_start": {
        const session = registration(params.session);
        if (session.harness !== "codex") throw failure("INVALID_PARAMS", "Not a Codex session", -32602);
        return { agent: codex.start(session, string(params.executable)) };
      }
      case "codex_session_end": codex.end(string(params.session_key)); return { ok: true };
      case "list": {
        const all = agents(), hidden = params.include_stale === true ? [] : all.filter(stale);
        return { agents: all.filter(agent => !hidden.includes(agent)).map(claude.addressing(params.token)),
          hidden: hidden.length, hidden_claude: hidden.filter(agent => agent.harness === "claude").length };
      }
      case "resolve": {
        // Exact names only, never addresses or IDs; `skip_claude` leaves Claude agents to Claude's own messaging.
        const row = store.agentNamed(string(params.name)), agent = row && present(row, !!store.codexThread(row.id));
        if (!agent || (params.skip_claude === true && agent.harness === "claude")) return { agent: null };
        return { agent: claude.addressing(params.token)(agent) };
      }
      case "send": {
        const sender = params.codex_thread === undefined ? authenticated(params) : codex.sender(string(params.codex_thread));
        const id = string(params.id);
        if (!uuid.test(id) || typeof params.body !== "string") throw failure("INVALID_MESSAGE");
        const target = resolveAddress(string(params.to), agents()), recipient = target.id;
        const to = { name: target.name, online: target.online, harness: target.harness, session_key: target.session_key };
        const reply_to = params.reply_to === undefined ? undefined : string(params.reply_to);
        if (reply_to && !store.message(reply_to)) throw failure("INVALID_MESSAGE", "Unknown reply_to message");
        const existing = store.message(id);
        if (existing) {
          if (existing.sender !== sender || existing.recipient !== recipient || existing.body !== params.body || (existing.reply_to ?? undefined) !== reply_to)
            throw failure("INVALID_MESSAGE", "Message ID already belongs to different content");
          return { id, state: existing.state, ...to };
        }
        ctx.accept(id, sender, recipient, params.body, reply_to);
        return { id, state: store.message(id)!.state, ...to };
      }
      case "ack": {
        const recipient = authenticated(params), id = string(params.id);
        const message = store.message(id);
        if (!message) throw failure("INVALID_MESSAGE", "Unknown message");
        if (message.recipient !== recipient) throw failure("FORBIDDEN");
        if (message.state === "queued") throw failure("INVALID_MESSAGE", "Message has not been delivered");
        store.markAcked(id);
        ctx.touch(recipient);
        return { id, state: "acked" };
      }
      case "native_ack": {
        const agent = authenticated(params), from = string(params.from);
        const id = claude.ack(agent, from);
        if (id === undefined) throw failure("INVALID_MESSAGE", "No native message in flight from that address");
        return { id };
      }
      case "detach": {
        const agent = authenticated(params);
        const owner = live.get(agent);
        if (owner) {
          detach(owner);
          if (owner === connection) connection.closeAfterResponse = true;
          else owner.stream.end();
        }
        return { ok: true };
      }
      case "rename": {
        const agent = resolveAddress(string(params.address), agents()), name = validName(params.name);
        const holder = store.agentNamed(name);
        if (holder && holder.id !== agent.id) throw failure("NAME_TAKEN");
        refuseReleased(name);
        db.query("UPDATE agents SET name = ? WHERE id = ?").run(name, agent.id);
        return { ...agent, name };
      }
      case "name": {
        const id = params.codex_thread === undefined ? authenticated(params) : codex.sender(string(params.codex_thread));
        const name = validName(params.name), holder = store.agentNamed(name);
        const taken = holder && holder.id !== id ? holder : undefined;
        if (taken && online(taken.id))
          throw failure("NAME_TAKEN", `${name} is taken by an online ${taken.harness} agent in ${basename(taken.cwd) || taken.cwd}`);
        refuseReleased(name);
        db.transaction(() => {
          if (taken) release(taken);
          db.query("UPDATE agents SET name = ?, name_chosen = 1 WHERE id = ?").run(name, id);
        })();
        return present(store.agentById(id)!, !!store.codexThread(id));
      }
      case "inspect": {
        const message = store.message(string(params.id));
        if (!message) throw failure("INVALID_MESSAGE", "Unknown message");
        return message;
      }
      case "shutdown": {
        if (!options.onShutdown) throw failure("METHOD_NOT_FOUND");
        setTimeout(options.onShutdown, 20);
        return { ok: true };
      }
      case "status": return { version: RELEASE_VERSION, protocol: policy.latest };
      default: throw failure("METHOD_NOT_FOUND", "Method not found", -32601);
    }
  };
  // Connections left by a crash were online until the core stopped, even when quiet for months.
  // Give them a fresh retention period before sweeping; ordinary offline sessions keep their age.
  db.transaction(() => {
    db.query("UPDATE agents SET last_seen = ? WHERE id IN (SELECT agent FROM connected_sessions)").run(new Date(ctx.now()).toISOString());
    db.exec("DELETE FROM connected_sessions");
  })();
  const codex = codexThreads(ctx, options.run, options.codexEvents, options.codexSteer);
  sweep();
  return {
    attach(stream) {
      if (ctx.closed) { stream.destroy(); return; }
      const connection: Connection = { stream, requests: Promise.resolve(), pings: new Map() };
      connections.add(connection);
      stream.on("end", () => { detach(connection); stream.end(); });
      stream.on("close", () => detach(connection));
      stream.on("error", () => detach(connection));
      readPackets(stream, wire => {
        // Ping replies must bypass the request queue, which may itself be waiting
        // for a registration check. Only a response from the pinged socket counts.
        if (wire && wire.jsonrpc === "2.0" && !("method" in wire) && typeof wire.id === "string") {
          connection.pings.get(wire.id)?.("result" in wire);
          return;
        }
        connection.requests = connection.requests.then(async () => {
          if (ctx.closed || stream.destroyed || stream.writableEnded) return;
          let id: string | number | null = null;
          try {
            if (!wire || typeof wire !== "object" || wire.jsonrpc !== "2.0" || !("method" in wire) || typeof wire.method !== "string")
              throw failure("INVALID_REQUEST", "Invalid JSON-RPC request", -32600);
            id = wire.id ?? null;
            if (id !== null && typeof id !== "string" && typeof id !== "number") throw failure("INVALID_REQUEST", "Invalid request ID", -32600);
            const request = connection.version !== undefined ? convert(wire, connection.version, policy.latest, policy) : wire;
            if (!("method" in request)) throw failure("INVALID_REQUEST");
            const result = await handle(connection, request.method, request.params);
            if (id !== null) packet(connection, { jsonrpc: "2.0", id, result });
            // end() flushes the response already written before closing a self-detaching socket.
            if (connection.closeAfterResponse) stream.end();
            if (request.method === "hello" && connection.agent) for (const message of store.pending(connection.agent)) ctx.deliver(message);
          } catch (error) {
            const rpc = error as Partial<RpcError>;
            // Never echo request data or tokens, including malformed input.
            const response: RpcError = { code: typeof rpc.code === "number" ? rpc.code : -32603, message: rpc.data ? rpc.message! : "Internal error", ...(rpc.data ? { data: rpc.data } : {}) };
            try { packet(connection, { jsonrpc: "2.0", id, error: response }); } catch { stream.destroy(); }
          }
        });
      }, error => {
        const rpc = error as Partial<RpcError>;
        try { writePacket(stream, { jsonrpc: "2.0", id: null, error: { code: rpc.code ?? -32700, message: rpc.data ? error.message : "Parse error", ...(rpc.data ? { data: rpc.data } : {}) } }); }
        catch { stream.destroy(); }
      });
    },
    async close() {
      if (ctx.closed) return;
      // Agents online until now were seen now, so the next start's sweep does not count the downtime against them.
      db.transaction(() => {
        for (const agent of live.keys()) store.seen(agent, ctx.now());
        db.exec("DELETE FROM connected_sessions");
      })();
      ctx.closed = true;
      await codex.close();
      claude.close();
      for (const connection of connections) { detach(connection); connection.stream.destroy(); }
      connections.clear(); live.clear(); db.close();
    },
  };
}
