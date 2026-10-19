import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { Agent, Harness, Message } from "@cross-harness-comms/protocol";

// An agent as stored, without the presence and activity a listing adds.
export type AgentRow = Omit<Agent, "online">;
export type Store = ReturnType<typeof openStore>;

export const hash = (token: string) => createHash("sha256").update(token).digest("hex");

// The core's SQLite database and the queries more than one part of the core runs.
export function openStore(path: string) {
  const db = new Database(path, { create: true });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, harness TEXT NOT NULL, session_key TEXT NOT NULL,
      host TEXT NOT NULL, name TEXT NOT NULL UNIQUE, cwd TEXT NOT NULL, last_seen TEXT NOT NULL, token_hash TEXT,
      UNIQUE(harness, session_key));
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, sender TEXT NOT NULL REFERENCES agents(id), recipient TEXT NOT NULL REFERENCES agents(id),
      reply_to TEXT REFERENCES messages(id), body TEXT NOT NULL, created_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('queued','delivered','acked')));
    CREATE INDEX IF NOT EXISTS mailbox ON messages(recipient, state);
    CREATE TABLE IF NOT EXISTS connected_sessions (agent TEXT PRIMARY KEY REFERENCES agents(id));
    CREATE TABLE IF NOT EXISTS codex_threads (agent TEXT PRIMARY KEY REFERENCES agents(id), executable TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS codex_lifecycle (
      agent TEXT PRIMARY KEY REFERENCES agents(id), executable TEXT NOT NULL,
      runtime_state TEXT NOT NULL, ended INTEGER NOT NULL DEFAULT 0, ended_at INTEGER, daemon_owned INTEGER NOT NULL DEFAULT 0);`);
  // Chosen names came later; existing names stay unchosen. No index, key, or check, so the column stays droppable.
  const agentColumns = db.query("PRAGMA table_info(agents)").all() as { name: string }[];
  if (!agentColumns.some(column => column.name === "name_chosen")) db.exec("ALTER TABLE agents ADD COLUMN name_chosen INTEGER NOT NULL DEFAULT 0");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS agent_token ON agents(token_hash)");
  // Retention: the sweep finds old agents and their undelivered mail by index, and holds removed names.
  db.exec(`CREATE INDEX IF NOT EXISTS agent_last_seen ON agents(last_seen);
    CREATE INDEX IF NOT EXISTS outbox ON messages(sender, state);
    CREATE TABLE IF NOT EXISTS released_names (name TEXT PRIMARY KEY, released_at TEXT NOT NULL);`);
  const agentFields = "SELECT id, harness, session_key, host, name, cwd, last_seen FROM agents";
  return {
    db,
    agents: () => db.query(`${agentFields} ORDER BY rowid`).all() as AgentRow[],
    // Single-agent reads go through the primary key and the unique indexes.
    agentById: (id: string) => db.query(`${agentFields} WHERE id = ?`).get(id) as AgentRow | null,
    agentBySession: (harness: Harness, sessionKey: string) =>
      db.query(`${agentFields} WHERE harness = ? AND session_key = ?`).get(harness, sessionKey) as AgentRow | null,
    agentNamed: (name: string) => db.query(`${agentFields} WHERE name = ?`).get(name) as AgentRow | null,
    nameChosen: (id: string) => (db.query("SELECT name_chosen FROM agents WHERE id = ?").get(id) as { name_chosen: number } | null)?.name_chosen === 1,
    agentWithToken: (token: unknown) => typeof token === "string"
      ? (db.query("SELECT id FROM agents WHERE token_hash = ?").get(hash(token)) as { id: string } | null)?.id : undefined,
    // `time` is the core's clock, so presence and the stale rule measure on one clock.
    seen: (agent: string, time: number) => db.query("UPDATE agents SET last_seen = ? WHERE id = ?").run(new Date(time).toISOString(), agent),
    message: (id: string) => db.query("SELECT * FROM messages WHERE id = ?").get(id) as Message | null,
    pending: (agent: string) => db.query("SELECT * FROM messages WHERE recipient = ? AND state != 'acked' ORDER BY rowid").all(agent) as Message[],
    // State is committed before a message is handed over; only a queued message becomes delivered.
    markDelivered: (id: string) => db.query("UPDATE messages SET state = 'delivered' WHERE id = ? AND state = 'queued'").run(id),
    markAcked: (id: string) => db.query("UPDATE messages SET state = 'acked' WHERE id = ?").run(id),
    // Runtime availability of Codex threads, separate from the durable identity and lifecycle record.
    codexOnline: () => new Set((db.query("SELECT agent FROM codex_threads").all() as { agent: string }[]).map(row => row.agent)),
    codexThread: (agent: string) => db.query("SELECT t.executable, a.session_key FROM codex_threads t JOIN agents a ON a.id = t.agent WHERE t.agent = ?")
      .get(agent) as { executable: string; session_key: string } | null,
  };
}
