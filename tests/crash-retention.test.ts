import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { Database } from "bun:sqlite";
import { Peer, eventually, uuid } from "./support/helpers.ts";
import { registration } from "./support/rig.ts";

for (const harness of ["pi", "claude"] as const) test(`retention: a quiet ${harness} session survives SIGKILL with its identity, token, and pending inbox`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "comms-crash-"));
  const t0 = Date.parse("2030-01-01T00:00:00Z"), after = t0 + 31 * 86_400_000;
  const peers: Peer[] = [];
  let process: ReturnType<typeof Bun.spawn> | undefined;
  const start = async (now: number) => {
    writeFileSync(join(directory, "clock"), String(now));
    const child = Bun.spawn([Bun.which("bun")!, join(import.meta.dir, "support/core-process.ts"), directory], { stdout: "pipe", stderr: "inherit" });
    process = child;
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toContain("ready");
  };
  const peer = async () => {
    const p = new Peer(connect(join(directory, "core.sock")));
    peers.push(p);
    return p;
  };
  try {
    await start(t0);
    const quiet = await peer(), sender = await peer(), offline = await peer(), observer = await peer();
    const session = registration(harness, uuid(), "/projects/quiet");
    const old = await quiet.register(session);
    const from = await sender.register(registration("pi", uuid(), "/projects/sender"));
    const gone = await offline.register(registration("pi", uuid(), "/projects/gone"));
    await observer.request("hello", { versions: { min: 1, max: 1 } });
    offline.close();
    await eventually(() => observer.request("list", {}), list => expect(list.agents.find(a => a.id === gone.agent.id)?.online).toBe(false));
    const id = uuid();
    await sender.request("send", { id, token: from.token, to: old.agent.id, body: "Keep my incoming mail" });
    expect((await quiet.deliveries.next()).message.id).toBe(id);
    // Advance the clock while still attached, then crash without a shutdown callback.
    writeFileSync(join(directory, "clock"), String(after));
    process!.kill("SIGKILL");
    await process!.exited;
    for (const p of peers) p.stream.destroy();
    await start(after);
    const watch = await peer();
    await watch.request("hello", { versions: { min: 1, max: 1 } });
    const agents = (await watch.request("list", {})).agents;
    expect(agents.find(a => a.id === old.agent.id)?.name).toBe(old.agent.name);
    expect(agents.some(a => a.id === gone.agent.id)).toBe(false);
    const resumed = await peer();
    const hello = await resumed.register(session, undefined, old.token);
    expect(hello.agent.id).toBe(old.agent.id);
    expect(hello.token).toBe(old.token);
    expect((await resumed.deliveries.next()).message).toMatchObject({ id, body: "Keep my incoming mail" });
    await resumed.request("ack", { token: hello.token, id });
    const db = new Database(join(directory, "comms.sqlite"), { readonly: true });
    try {
      expect(db.query("SELECT state FROM messages WHERE id = ?").get(id)).toEqual({ state: "acked" });
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { db.close(); }
  } finally {
    for (const p of peers) p.stream.destroy();
    if (process) { process.kill("SIGTERM"); await process.exited; }
    rmSync(directory, { recursive: true, force: true });
  }
});
