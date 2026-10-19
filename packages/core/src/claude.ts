import { connect, createServer, type Server, type Socket } from "node:net";
import { rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { CLAUDE_INBOX_VERSIONS, MAX_LINE_BYTES, formatClaudeInboxLine, parseClaudeInboxLine, splitLines,
  type Agent, type Message } from "@cross-harness-comms/protocol";
import type { Connection, Context } from "./core.ts";

// Claude mints its own message IDs, of any UUID version.
const anyUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A reply socket is named like Claude's `<pid>.sock`, with ten digits starting at 9 so it is never a PID,
// and derived from the agent so its `uds:` address survives core restarts.
const replyPath = (directory: string, agent: string) =>
  `${directory}/9${String(parseInt(createHash("sha256").update(agent).digest("hex").slice(0, 12), 16) % 1e9).padStart(9, "0")}.sock`;

// The native Claude route (ADR-016): messages written to a Claude session's inbox socket, and replies read
// from a reply socket per non-Claude agent, falling back to `deliver` packets.
export function claudeRoute(ctx: Context, nativeAckMs: number) {
  const { store, live } = ctx;
  const replyServers = new Map<string, { server: Server; agent: string }>();
  // One native line is in flight per Claude session; the next is written after its ACK.
  const deliver = (connection: Connection, message: Message) => {
    if (connection.inflight) return;
    const sender = store.agentById(message.sender)!;
    const from = `uds:${replyPath(dirname(connection.inbox!), sender.id)}`;
    store.markDelivered(message.id);
    connection.inflight = { id: message.id, from, timer: setTimeout(() => fallback(connection), nativeAckMs) };
    let connected = false;
    const socket = connect(connection.inbox!, () => {
      connected = true;
      socket.end(formatClaudeInboxLine({ msg_id: message.id, from, from_name: sender.name, body: message.body }) + "\n");
    });
    socket.on("error", () => { if (!connected) fallback(connection); });
  };
  // A missing ACK or an unreachable inbox turns the native route off for this attachment and
  // resends the in-flight and queued messages as `deliver` packets; messages already handed over
  // as packets wait for their ACK or a reconnect. The in-flight record stays for a late ACK.
  const fallback = (connection: Connection) => {
    const inflight = connection.inflight;
    if (!inflight?.timer) return;
    clearTimeout(inflight.timer);
    delete inflight.timer;
    connection.native = false;
    if (connection.agent && live.get(connection.agent) === connection)
      for (const message of store.pending(connection.agent)) if (message.id === inflight.id || message.state === "queued") ctx.deliver(message);
  };
  // A native ACK names the reply socket the in-flight line came from; the next queued message follows it.
  const ack = (agent: string, from: string) => {
    const connection = live.get(agent), inflight = connection?.inflight;
    if (!connection || !inflight || inflight.from !== from) return undefined;
    clearTimeout(inflight.timer);
    delete connection.inflight;
    store.markAcked(inflight.id);
    ctx.touch(agent);
    if (connection.native) for (const message of store.pending(agent)) if (message.state === "queued") ctx.deliver(message);
    return inflight.id;
  };
  // While a native Claude session is attached, every non-Claude agent has a reply socket in its inbox directory.
  const openReplySockets = () => {
    const directories = new Set([...live.values()].flatMap(c => c.native && c.inbox ? [dirname(c.inbox)] : []));
    for (const directory of directories) for (const agent of store.agents()) {
      const path = replyPath(directory, agent.id);
      if (agent.harness === "claude" || replyServers.has(path)) continue;
      rmSync(path, { force: true });
      const server = createServer(socket => readReplies(socket, agent.id));
      server.on("error", () => { if (replyServers.get(path)?.server === server) replyServers.delete(path); });
      server.listen(path);
      replyServers.set(path, { server, agent: agent.id });
    }
  };
  const readReplies = (socket: Socket, recipient: string) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      // shortcut: a line this long cannot fit the delivery limit; drop the connection rather than buffer it.
      if (buffer.length > 2 * MAX_LINE_BYTES) { socket.destroy(); return; }
      const { lines, rest } = splitLines(buffer);
      buffer = rest;
      for (const line of lines) receiveReply(recipient, line);
    });
    socket.on("end", () => { if (buffer) receiveReply(recipient, buffer); });
  };
  // A Claude session's own SendMessage to a reply socket becomes a message from its agent.
  const receiveReply = (recipient: string, text: string) => {
    const line = ctx.closed ? undefined : parseClaudeInboxLine(text);
    const owner = line && [...live.values()].find(c => c.inbox && `uds:${c.inbox}` === line.from);
    if (!line || !owner?.agent || !anyUuid.test(line.msg_id)) return;
    if (!CLAUDE_INBOX_VERSIONS.includes(line.msgV)) owner.native = false;
    if (store.message(line.msg_id)) return;
    const unanswered = store.db.query(`SELECT id FROM messages m WHERE sender = ? AND recipient = ?
      AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.reply_to = m.id) ORDER BY rowid DESC LIMIT 1`).get(recipient, owner.agent) as { id: string } | null;
    try { ctx.accept(line.msg_id, owner.agent, recipient, line.body, unanswered?.id); }
    catch { /* Over the delivery size limit: dropped. */ }
  };
  // How an agent appears to the caller holding `token`: a Claude caller on the native route sees
  // each other harness's reply socket as its `claude_address`.
  const addressing = (token: unknown): (agent: Agent) => Agent => {
    const caller = store.agentWithToken(token);
    const connection = caller ? live.get(caller) : undefined;
    const directory = connection?.native && connection.inbox ? dirname(connection.inbox) : undefined;
    return agent => directory && agent.harness !== "claude" ? { ...agent, claude_address: `uds:${replyPath(directory, agent.id)}` } : agent;
  };
  const close = () => {
    for (const { server } of replyServers.values()) server.close();
    replyServers.clear();
  };
  // Removed agents lose their reply sockets; closing one also unlinks its path.
  const forget = (agents: Set<string>) => {
    for (const [path, { server, agent }] of replyServers) if (agents.has(agent)) { server.close(); replyServers.delete(path); }
  };
  return { deliver, ack, openReplySockets, addressing, close, forget };
}
