import { hostname } from "node:os";
import { failure, formatMessage, type Agent, type Message, type SessionRegistration } from "@cross-harness-comms/protocol";
import type { CodexEvent, CodexRuntimeState, CodexThread } from "./events.ts";
import type { Context } from "../core.ts";

export type Run = (argv: readonly string[]) => Promise<{ exitCode: number; stderr?: string }>;

// shortcut: no timeout on `codex queue`; a hung command stalls only that thread's deliveries.
const spawn: Run = async argv => {
  const child = Bun.spawn([...argv], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  return { exitCode: await child.exited, stderr: await new Response(child.stderr).text() };
};

type Lifecycle = { executable: string; runtime_state: CodexRuntimeState; ended: number; ended_at: number | null; daemon_owned: number };

// Codex threads: their start and end from hooks and from the app-server daemon's events (ADR-015, ADR-019),
// and delivery through `codex queue`.
export function codexThreads(ctx: Context, run: Run = spawn, events?: AsyncIterable<CodexEvent>) {
  const { store } = ctx, { db } = store;
  const chains = new Map<string, Promise<void>>();
  // The daemon's `thread_unload_delay_secs` from its latest connection's snapshot, or Codex's default 1800.
  let unloadDelaySecs = 1800;
  const lifecycle = (agent: string) => db.query("SELECT executable, runtime_state, ended, ended_at, daemon_owned FROM codex_lifecycle WHERE agent = ?")
    .get(agent) as Lifecycle | null;
  const offline = (agent: string) => db.query("DELETE FROM codex_threads WHERE agent = ?").run(agent);
  // The Codex MCP server acts for whichever online thread its call names (ADR-014).
  const sender = (thread: string) => {
    const agent = store.agentBySession("codex", thread);
    if (!agent || !store.codexThread(agent.id)) throw failure("UNKNOWN_SESSION", "Codex thread has not started a comms session");
    return agent.id;
  };
  const deliver = (message: Message) => {
    const chain = (chains.get(message.recipient) ?? Promise.resolve()).then(async () => {
      if (ctx.closed) return;
      const thread = store.codexThread(message.recipient);
      const current = store.message(message.id);
      if (!thread || !current || current.state === "acked") return;
      store.markDelivered(message.id);
      const text = formatMessage(ctx.delivery({ ...message, state: "delivered" }), "codex");
      const result = await run([thread.executable, "queue", "--thread", thread.session_key, "--message", text]).catch(() => ({ exitCode: 1 }));
      if (ctx.closed) return;
      // Codex accepting the queued message is the ACK; a refusal means the thread is gone.
      if (result.exitCode === 0) store.markAcked(message.id);
      else offline(message.recipient);
    });
    chains.set(message.recipient, chain.catch(() => {}));
  };
  const activate = (agent: string, executable: string) => {
    db.query("INSERT OR REPLACE INTO codex_threads (agent, executable) VALUES (?, ?)").run(agent, executable);
    for (const message of store.pending(agent)) deliver(message);
  };
  const start = (session: SessionRegistration, executable: string): Agent => {
    const agent = ctx.upsert(session);
    db.query(`INSERT INTO codex_lifecycle (agent, executable, runtime_state) VALUES (?, ?, 'idle')
      ON CONFLICT(agent) DO UPDATE SET executable = excluded.executable, runtime_state = 'idle', ended = 0, ended_at = NULL`).run(agent.id, executable);
    activate(agent.id, executable);
    return agent;
  };
  const end = (thread: string, ended = true, state: CodexRuntimeState = "unknown") => {
    const agent = store.agentBySession("codex", thread);
    if (!agent) return;
    db.query(`INSERT INTO codex_lifecycle (agent, executable, runtime_state, ended, ended_at) VALUES (?, 'codex', ?, ?, ?)
      ON CONFLICT(agent) DO UPDATE SET runtime_state = excluded.runtime_state,
        ended = CASE WHEN excluded.ended = 1 THEN 1 ELSE codex_lifecycle.ended END,
        ended_at = CASE WHEN excluded.ended = 1 THEN excluded.ended_at ELSE codex_lifecycle.ended_at END`)
      .run(agent.id, state, ended ? 1 : 0, ended ? ctx.now() : null);
    offline(agent.id);
    store.seen(agent.id, ctx.now());
  };
  const nativeActivity = (agent: string, time?: string) => {
    if (time && Number.isFinite(Date.parse(time))) ctx.touch(agent, Date.parse(time));
  };
  const discover = (thread: CodexThread, executable: string, snapshot: boolean) => {
    if (thread.parentThreadId || thread.ephemeral) return;
    const existing = store.agentBySession("codex", thread.id);
    const agent = existing ?? ctx.upsert({ harness: "codex", session_key: thread.id, host: hostname(), cwd: thread.cwd });
    const previous = lifecycle(agent.id);
    // A duplicate creation event and a recovery snapshot cannot undo an end.
    const state = previous && (previous.ended || (!snapshot && existing)) ? previous.runtime_state : (thread.status?.type ?? "idle");
    db.query(`INSERT INTO codex_lifecycle (agent, executable, runtime_state, daemon_owned) VALUES (?, ?, ?, 1)
      ON CONFLICT(agent) DO UPDATE SET executable = excluded.executable, daemon_owned = 1,
        runtime_state = CASE WHEN codex_lifecycle.ended = 1 THEN codex_lifecycle.runtime_state ELSE excluded.runtime_state END`)
      .run(agent.id, executable, state);
    if (!previous?.ended && (!existing || snapshot)) {
      if (state === "notLoaded" || state === "systemError") end(thread.id, false, state);
      else activate(agent.id, executable);
    }
    nativeActivity(agent.id, thread.active_at);
  };
  const daemonOffline = (except = new Set<string>()) => {
    const owned = db.query(`SELECT a.session_key FROM codex_lifecycle c JOIN agents a ON a.id = c.agent WHERE c.daemon_owned = 1`)
      .all() as { session_key: string }[];
    for (const { session_key } of owned) if (!except.has(session_key)) end(session_key, false);
  };
  const event = (event: CodexEvent) => {
    switch (event.method) {
      case "thread/started": discover(event.params.thread, event.executable, false); break;
      case "comms/daemon-discovered": discover(event.params.thread, event.executable, true); break;
      case "comms/daemon-snapshot": {
        unloadDelaySecs = event.params.unload_delay_secs ?? 1800;
        const threads = event.params.threads.filter(thread => !thread.parentThreadId && !thread.ephemeral);
        daemonOffline(new Set(threads.map(thread => thread.id)));
        for (const thread of threads) discover(thread, event.executable, true);
        break;
      }
      case "comms/daemon-disconnected": daemonOffline(); break;
      case "thread/closed": end(event.params.threadId, false, "notLoaded"); break;
      case "thread/archived": case "thread/deleted": end(event.params.threadId); break;
      case "thread/status/changed": {
        const agent = store.agentBySession("codex", event.params.threadId);
        if (!agent) break; // A status is not a new identity or a creation event.
        const previous = lifecycle(agent.id);
        if (!previous) break;
        // Native events may have waited in the transport's discovery buffer
        // while a hook ended this session on a different core connection.
        if (previous.ended && previous.ended_at !== null && event.active_at && Date.parse(event.active_at) <= previous.ended_at) break;
        const state = event.params.status.type;
        if (state === "notLoaded" || state === "systemError") { end(agent.session_key, false, state); break; }
        const resumed = previous.runtime_state === "notLoaded" && (state === "idle" || state === "active");
        db.query("UPDATE codex_lifecycle SET runtime_state = ?, ended = ?, ended_at = ?, daemon_owned = 1 WHERE agent = ?")
          .run(state, resumed ? 0 : previous.ended, resumed ? null : previous.ended_at, agent.id);
        if ((!previous.ended || resumed) && (state === "idle" || state === "active")) activate(agent.id, previous.executable);
        nativeActivity(agent.id, event.active_at);
        break;
      }
    }
  };
  // Daemon presence must be reconciled before dispatching mail after a restart.
  // Hook-only sessions keep their existing restart behavior.
  if (events) db.exec("DELETE FROM codex_threads WHERE agent IN (SELECT agent FROM codex_lifecycle WHERE daemon_owned = 1)");
  const iterator = events?.[Symbol.asyncIterator]();
  const task = iterator ? (async () => {
    try {
      while (!ctx.closed) {
        const next = await iterator.next();
        if (ctx.closed) break;
        if (next.done) { daemonOffline(); break; }
        event(next.value);
      }
    } catch (error) {
      if (!ctx.closed) { daemonOffline(); console.error("Codex lifecycle stream failed:", error); }
    }
  })() : undefined;
  // Resume deliveries to Codex threads that were online when the core last stopped.
  for (const agent of store.codexOnline()) for (const message of store.pending(agent)) deliver(message);
  const close = async () => {
    await iterator?.return?.();
    await task;
  };
  return { sender, deliver, start, end, close, unloadDelaySecs: () => unloadDelaySecs };
}
