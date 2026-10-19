import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { COMMS_TOOLS, VERSION_RANGE, type Agent, type Harness } from "@cross-harness-comms/protocol";
import { createCodexAdapter } from "../adapters/codex/src/index.ts";
import { FakeClaude } from "./support/fakes/claude.ts";
import type { FakeCodex } from "./support/fakes/codex.ts";
import type { FakePi } from "./support/fakes/pi.ts";
import { attachToken } from "./support/claude.ts";
import { eventually, uuid, type Peer } from "./support/helpers.ts";
import { cli, helloRequests, registration, withRig, type HarnessSession, type Rig } from "./support/rig.ts";

// ALIASING-DESIGN.md and HANDOFF-ALIASES.md: an alias is the agent's one comms name, chosen from inside its session.
// `alias { token? | codex_thread?, name }` renames the caller and marks it chosen (`agents.aliased`). An online holder
// refuses with NAME_TAKEN naming its harness and folder; an offline holder falls back to a generated name, the way
// registration picks one, and keeps its mail. A Claude /clear hello names the identity it replaces (`replaces`, that
// identity's token); an aliased, offline identity on the same harness and host hands its alias to the new identity.
// Mail never moves with a name.

const ALIAS_TOOL = FakeClaude.toolName("comms_alias");

// The `aliased` flag as stored; tests read the database the way the token tests do.
function aliased(rig: Rig, id: string): number | undefined {
  const db = new Database(rig.databasePath, { readonly: true });
  try { return (db.query("SELECT aliased FROM agents WHERE id = ?").get(id) as { aliased: number } | null)?.aliased; }
  finally { db.close(); }
}

async function named(rig: Rig, id: string): Promise<Agent> {
  const agent = (await rig.agents()).find(a => a.id === id);
  expect(agent).toBeDefined();
  return agent!;
}

// An agent on its own wire connection, as an adapter registers.
async function join(rig: Rig, harness: Harness, cwd = "/projects/shared", host = "fixture-host", session_key = uuid()) {
  const peer = await rig.peer();
  const hello = await peer.register({ ...registration(harness, session_key, cwd), host });
  return { peer, agent: hello.agent, token: hello.token, session_key };
}
type Joined = Awaited<ReturnType<typeof join>>;

async function leave(rig: Rig, joined: Joined) {
  joined.peer.close();
  await eventually(() => rig.agents(), agents => expect(agents.find(a => a.id === joined.agent.id)?.online).toBe(false));
}

// The NAME_TAKEN refusal names the online holder's harness and folder.
function takenBy(error: unknown, harness: Harness, folder: string) {
  expect(error).toMatchObject({ data: { code: "NAME_TAKEN" } });
  expect((error as Error).message).toContain(harness);
  expect((error as Error).message).toContain(folder);
}

// The deliveries a wire peer received, by body.
const bodies = (peer: Peer) => peer.received.flatMap(packet => "method" in packet && packet.method === "deliver"
  ? [(packet.params as { message: { body: string } }).message.body] : []);

test("aliases: COMMS_TOOLS gives Pi and Codex comms_alias with a required name, beside comms_send and comms_list", () => {
  expect(COMMS_TOOLS.map(tool => tool.name as string)).toEqual(["comms_send", "comms_list", "comms_alias"]);
  const alias = COMMS_TOOLS.find(tool => tool.name === ("comms_alias" as string))!;
  expect(alias.inputSchema).toMatchObject({ type: "object", properties: { name: { type: "string" } }, required: ["name"] });
});

test("aliases: an agent takes an unheld name, is marked aliased, and sends and lookups by that name reach it", async () => {
  await withRig(async rig => {
    const target = await join(rig, "pi"), sender = await join(rig, "codex");
    expect(target.agent.name).toBe("pi-shared");
    expect(aliased(rig, target.agent.id)).toBe(0);
    const result = await target.peer.request("alias", { token: target.token, name: "planner" });
    expect(result).toMatchObject({ id: target.agent.id, name: "planner" });
    expect(await named(rig, target.agent.id)).toMatchObject({ name: "planner", online: true });
    expect(aliased(rig, target.agent.id)).toBe(1);
    expect((await sender.peer.request("resolve", { name: "planner" })).agent).toMatchObject({ id: target.agent.id });
    expect((await sender.peer.request("resolve", { name: "pi-shared" })).agent).toBeNull();
    await sender.peer.request("send", { token: sender.token, id: uuid(), to: "comms:planner", body: "For the planner" });
    expect((await target.peer.deliveries.next()).message).toMatchObject({ recipient: target.agent.id, body: "For the planner" });
  });
});

test("aliases: a name outside the name rule is refused with INVALID_NAME and the name stays", async () => {
  await withRig(async rig => {
    const caller = await join(rig, "pi");
    for (const name of ["Planner", "has space", "x".repeat(65), "0190abcd-1234-7000"]) {
      await expect(caller.peer.request("alias", { token: caller.token, name })).rejects.toMatchObject({ data: { code: "INVALID_NAME" } });
    }
    await expect(caller.peer.request("alias", { name: "planner" })).rejects.toMatchObject({ data: { code: "INVALID_TOKEN" } });
    expect((await named(rig, caller.agent.id)).name).toBe("pi-shared");
    expect(aliased(rig, caller.agent.id)).toBe(0);
  });
});

test("aliases: a name an online agent holds is refused with NAME_TAKEN naming that agent's harness and folder", async () => {
  await withRig(async rig => {
    const claude = await join(rig, "claude", "/projects/api-service");
    await claude.peer.request("alias", { token: claude.token, name: "planner" });
    const codex = await rig.harness("codex", undefined, "/projects/codex-work");
    expect((await cli(rig, ["rename", `comms:${codex.agent.name}`, "reviewer"])).exitCode).toBe(0);
    const caller = await join(rig, "pi");
    takenBy(await caller.peer.request("alias", { token: caller.token, name: "planner" }).catch(error => error), "claude", "api-service");
    // An online Codex thread counts as online through its hooks, not a connection.
    takenBy(await caller.peer.request("alias", { token: caller.token, name: "reviewer" }).catch(error => error), "codex", "codex-work");
    expect((await named(rig, claude.agent.id)).name).toBe("planner");
    expect((await named(rig, codex.agent.id)).name).toBe("reviewer");
    expect((await named(rig, caller.agent.id)).name).toBe("pi-shared");
    expect(aliased(rig, caller.agent.id)).toBe(0);
  });
});

test("aliases: taking a name from an offline holder gives the holder a generated name, and its queued mail stays with it, never reaching the new holder", async () => {
  await withRig(async rig => {
    const holder = await join(rig, "pi", "/projects/old"), sender = await join(rig, "codex");
    await holder.peer.request("alias", { token: holder.token, name: "planner" });
    await leave(rig, holder);
    await sender.peer.request("send", { token: sender.token, id: uuid(), to: "comms:planner", body: "For the old planner" });
    const queued = rig.rows()[0]!;
    expect(queued).toMatchObject({ recipient: holder.agent.id, state: "queued" });

    const caller = await join(rig, "claude", "/projects/new");
    expect(await caller.peer.request("alias", { token: caller.token, name: "planner" })).toMatchObject({ id: caller.agent.id, name: "planner" });
    expect(await named(rig, holder.agent.id)).toMatchObject({ name: "pi-old", online: false });
    expect(aliased(rig, holder.agent.id)).toBe(0);
    expect(aliased(rig, caller.agent.id)).toBe(1);
    expect(rig.rows()).toMatchObject([{ id: queued.id, recipient: holder.agent.id, state: "queued" }]);

    await sender.peer.request("send", { token: sender.token, id: uuid(), to: "comms:planner", body: "For the new planner" });
    expect((await caller.peer.deliveries.next()).message.body).toBe("For the new planner");
    expect(bodies(caller.peer)).toEqual(["For the new planner"]);

    // The old holder, resumed under its generated name, gets its own mail.
    const resumed = await rig.peer();
    const hello = await resumed.register(registration("pi", holder.session_key, "/projects/old"), VERSION_RANGE, holder.token);
    expect(hello.agent).toMatchObject({ id: holder.agent.id, name: "pi-old" });
    const delivery = await resumed.deliveries.next();
    expect(delivery.message).toMatchObject({ id: queued.id, body: "For the old planner" });
    expect(delivery.from).toBe(`comms:${sender.agent.name}`);
    expect(bodies(caller.peer)).toEqual(["For the new planner"]);
  });
});

test("aliases: an offline holder falls back to the first free generated name, as registration picks one", async () => {
  await withRig(async rig => {
    const first = await join(rig, "pi"), second = await join(rig, "pi");
    expect([first.agent.name, second.agent.name]).toEqual(["pi-shared", "pi-shared-2"]);
    await second.peer.request("alias", { token: second.token, name: "planner" });
    await leave(rig, second);
    const caller = await join(rig, "codex");
    await caller.peer.request("alias", { token: caller.token, name: "planner" });
    expect((await named(rig, second.agent.id)).name).toBe("pi-shared-2");
    expect((await named(rig, first.agent.id)).name).toBe("pi-shared");
  });
});

test("aliases: a Claude hello replacing an aliased, offline Claude identity on the same host moves the alias to the new identity, and no mail moves", async () => {
  await withRig(async rig => {
    const before = await join(rig, "claude"), sender = await join(rig, "pi", "/projects/sender");
    await before.peer.request("alias", { token: before.token, name: "planner" });
    await leave(rig, before);
    await sender.peer.request("send", { token: sender.token, id: uuid(), to: "comms:planner", body: "Before the clear" });
    const queued = rig.rows()[0]!;

    const after = await rig.peer();
    const hello = await after.request("hello", { versions: VERSION_RANGE, session: registration("claude"), replaces: before.token });
    expect(hello.agent).toMatchObject({ name: "planner" });
    expect(hello.agent!.id).not.toBe(before.agent.id);
    expect((await named(rig, before.agent.id)).name).toMatch(/^claude-shared(-\d+)?$/);
    expect(aliased(rig, hello.agent!.id)).toBe(1);
    expect(aliased(rig, before.agent.id)).toBe(0);
    expect(rig.rows()).toMatchObject([{ id: queued.id, recipient: before.agent.id, state: "queued" }]);

    await sender.peer.request("send", { token: sender.token, id: uuid(), to: "comms:planner", body: "After the clear" });
    expect((await after.deliveries.next()).message).toMatchObject({ recipient: hello.agent!.id, body: "After the clear" });
    expect(bodies(after)).toEqual(["After the clear"]);
  });
});

test("aliases: nothing moves when the replaced identity is unaliased, online, on another harness or host, unknown, or the hello resumes an existing identity", async () => {
  await withRig(async rig => {
    const hello = async (replaces: string, session = registration("claude")) => {
      const peer = await rig.peer();
      return (await peer.request("hello", { versions: VERSION_RANGE, session, replaces })).agent!;
    };
    // Unaliased: its generated name stays, and the new identity gets its own.
    const plain = await join(rig, "claude", "/projects/plain");
    await leave(rig, plain);
    expect((await hello(plain.token, registration("claude", uuid(), "/projects/plain"))).name).toBe("claude-plain-2");
    expect((await named(rig, plain.agent.id)).name).toBe("claude-plain");

    const cases: [string, () => Promise<{ holder: Joined; offline: boolean }>][] = [
      ["online", async () => ({ holder: await join(rig, "claude"), offline: false })],
      ["another harness", async () => ({ holder: await join(rig, "pi"), offline: true })],
      ["another host", async () => ({ holder: await join(rig, "claude", "/projects/shared", "other-host"), offline: true })],
    ];
    for (const [label, start] of cases) {
      const { holder, offline } = await start();
      const name = `held-${label.replace(/ /g, "-")}`;
      await holder.peer.request("alias", { token: holder.token, name });
      if (offline) await leave(rig, holder);
      const fresh = await hello(holder.token);
      expect(fresh.name, label).not.toBe(name);
      expect((await named(rig, holder.agent.id)).name, label).toBe(name);
      expect(aliased(rig, holder.agent.id), label).toBe(1);
    }

    expect((await hello("not-a-token")).name).toMatch(/^claude-shared/);

    // A resumed identity keeps its own name; only a newly created identity takes the alias.
    const holder = await join(rig, "claude");
    await holder.peer.request("alias", { token: holder.token, name: "kept" });
    await leave(rig, holder);
    const existing = await join(rig, "claude", "/projects/existing");
    await leave(rig, existing);
    const resumed = await hello(holder.token, registration("claude", existing.session_key, "/projects/existing"));
    expect(resumed).toMatchObject({ id: existing.agent.id, name: "claude-existing" });
    expect((await named(rig, holder.agent.id)).name).toBe("kept");
  });
});

test("aliases: the migration adds aliased with every existing agent unaliased, so a Claude /clear leaves their names", async () => {
  await withRig(async rig => {
    const before = await join(rig, "claude");
    await before.peer.request("alias", { token: before.token, name: "planner" });
    const other = await join(rig, "pi");
    await rig.restart(() => {
      // A database from before aliases: the same agents and names, no aliased column.
      const db = new Database(rig.databasePath);
      try { db.exec("ALTER TABLE agents DROP COLUMN aliased"); }
      finally { db.close(); }
    });
    const db = new Database(rig.databasePath, { readonly: true });
    try { expect((db.query("PRAGMA table_info(agents)").all() as { name: string }[]).map(column => column.name)).toContain("aliased"); }
    finally { db.close(); }
    expect([aliased(rig, before.agent.id), aliased(rig, other.agent.id)]).toEqual([0, 0]);
    const after = await rig.peer();
    const hello = await after.request("hello", { versions: VERSION_RANGE, session: registration("claude"), replaces: before.token });
    expect(hello.agent!.name).not.toBe("planner");
    expect((await named(rig, before.agent.id)).name).toBe("planner");
  });
});

test("aliases: comms alias <name> reads the session token on stdin", async () => {
  await withRig(async rig => {
    const caller = await join(rig, "pi"), holder = await join(rig, "claude", "/projects/api-service");
    await holder.peer.request("alias", { token: holder.token, name: "reviewer" });
    const result = await cli(rig, ["alias", "planner"], { token: caller.token });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ id: caller.agent.id, name: "planner" });
    expect(result.stdout).not.toContain(caller.token);
    const taken = await cli(rig, ["alias", "reviewer"], { token: caller.token });
    expect(taken.exitCode).toBe(2);
    expect(taken.stderr).toContain("claude");
    expect(taken.stderr).toContain("api-service");
    expect((await cli(rig, ["alias"], { token: caller.token })).exitCode).toBe(1);
  });
});

// Claude: a `/comms-alias <name>` slash command and a model-callable `comms_alias` tool, both declared at session start.

async function claudeAlias(fake: FakeClaude, name: string) {
  return fake.tool({ tool: ALIAS_TOOL, tool_use_id: uuid(), name });
}

test("aliases: Claude declares /comms-alias and a comms_alias tool at session start", async () => {
  await withRig(async rig => {
    const fake = (await rig.harness("claude")).fake as FakeClaude;
    expect(fake.registeredCommands).toEqual([expect.objectContaining({ name: "comms-alias" })]);
    expect(fake.registeredTools).toEqual([expect.objectContaining({ name: "comms_alias",
      inputSchema: expect.objectContaining({ properties: { name: expect.objectContaining({ type: "string" }) }, required: ["name"] }) })]);
  });
});

test("aliases: Claude's /comms-alias sets the session's alias and answers with its address, or the refusal", async () => {
  await withRig(async rig => {
    const claude = await rig.harness("claude");
    const fake = claude.fake as FakeClaude;
    expect((await fake.command("comms-alias", "planner")).text).toContain("comms:planner");
    expect(await named(rig, claude.agent.id)).toMatchObject({ name: "planner", online: true });
    expect(aliased(rig, claude.agent.id)).toBe(1);
    const holder = await rig.harness("pi", undefined, "/projects/review-desk");
    expect((await cli(rig, ["rename", `comms:${holder.agent.name}`, "reviewer"])).exitCode).toBe(0);
    const refused = (await fake.command("comms-alias", "reviewer")).text ?? "";
    expect(refused).toContain("pi");
    expect(refused).toContain("review-desk");
    expect((await named(rig, claude.agent.id)).name).toBe("planner");
  });
});

test("aliases: Claude's model sets its alias with comms_alias, and a refusal is denied with the reason", async () => {
  await withRig(async rig => {
    const claude = await rig.harness("claude");
    const fake = claude.fake as FakeClaude;
    const result = await claudeAlias(fake, "planner");
    expect(result).not.toHaveProperty("deny");
    expect(JSON.stringify("result" in result ? result.result : null)).toContain("comms:planner");
    expect((await named(rig, claude.agent.id)).name).toBe("planner");
    const holder = await rig.harness("pi", undefined, "/projects/review-desk");
    expect((await cli(rig, ["rename", `comms:${holder.agent.name}`, "reviewer"])).exitCode).toBe(0);
    const refused = await claudeAlias(fake, "reviewer");
    expect(refused).toHaveProperty("deny");
    expect("deny" in refused && refused.deny).toContain("review-desk");
    expect(fake.nativeCalls).toEqual([]);
  });
});

test("aliases: Claude /clear moves the alias to the new identity, its hello names the replaced one, and the old identity keeps its mail", async () => {
  await withRig(async rig => {
    const claude = await rig.harness("claude"), pi = await rig.harness("pi");
    const fake = claude.fake as FakeClaude;
    await claudeAlias(fake, "planner");
    const oldToken = attachToken(fake), nextId = uuid();
    await fake.clear(nextId);
    const hello = helloRequests(rig, "claude", nextId)[0]!.packet as { params: { replaces?: string; token?: string } };
    expect(hello.params.replaces).toBe(oldToken);
    expect(hello.params).not.toHaveProperty("token");
    const current = await rig.agent("claude", nextId);
    expect(current).toMatchObject({ name: "planner", online: true });
    expect(current.id).not.toBe(claude.agent.id);
    expect(await named(rig, claude.agent.id)).toMatchObject({ online: false, name: expect.stringMatching(/^claude-shared(-\d+)?$/) });

    await pi.send("comms:planner", "For this window");
    await eventually(claude.incoming, texts => expect(texts).toHaveLength(1));
    expect(claude.incoming()[0]).toContain("For this window");
    expect(rig.rows().at(-1)).toMatchObject({ recipient: current.id });
    await pi.send(`comms:${claude.agent.id}`, "For the cleared identity");
    expect(rig.rows().at(-1)).toMatchObject({ recipient: claude.agent.id, state: "queued" });
    expect(claude.incoming()).toHaveLength(1);
    // The alias still answers from the replacement session.
    expect(JSON.stringify(await claudeAlias(fake, "planner"))).toContain("comms:planner");
  });
});

test("aliases: Claude /clear leaves an unaliased identity's generated name alone", async () => {
  await withRig(async rig => {
    const claude = await rig.harness("claude");
    const fake = claude.fake as FakeClaude;
    const nextId = uuid();
    await fake.clear(nextId);
    expect((await named(rig, claude.agent.id)).name).toBe("claude-shared");
    expect((await rig.agent("claude", nextId)).name).toBe("claude-shared-2");
  });
});

test("aliases: Claude resume of the same session keeps its identity and alias", async () => {
  await withRig(async rig => {
    const claude = await rig.harness("claude");
    const fake = claude.fake as FakeClaude;
    await fake.command("comms-alias", "planner");
    await fake.end("resume");
    await fake.classicStart("resume");
    await eventually(() => rig.agent("claude", fake.sessionId), agent => expect(agent.online).toBe(true));
    expect(await rig.agent("claude", fake.sessionId)).toMatchObject({ id: claude.agent.id, name: "planner" });
    expect(aliased(rig, claude.agent.id)).toBe(1);
  });
});

// Pi: the shared comms_alias tool and a /comms-alias command (Pi Intercom owns /alias).

test("aliases: Pi's comms_alias tool sets the session's alias and answers with its address; a held name throws the refusal", async () => {
  await withRig(async rig => {
    const pi = await rig.harness("pi");
    const fake = pi.fake as FakePi;
    const result = await fake.tool("comms_alias", { name: "planner" });
    expect(result.content[0]!.text).toContain("comms:planner");
    expect((await named(rig, pi.agent.id)).name).toBe("planner");
    const holder = await join(rig, "claude", "/projects/api-service");
    await holder.peer.request("alias", { token: holder.token, name: "reviewer" });
    const error = await fake.tool("comms_alias", { name: "reviewer" }).catch(caught => caught as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("claude");
    expect((error as Error).message).toContain("api-service");
    expect((await named(rig, pi.agent.id)).name).toBe("planner");
  });
});

test("aliases: Pi's /comms-alias command sets the alias and notifies its address, and a refusal notifies an error", async () => {
  await withRig(async rig => {
    const pi = await rig.harness("pi");
    const fake = pi.fake as FakePi;
    expect(fake.commands.has("alias")).toBe(false);
    await fake.command("comms-alias", "planner");
    expect(fake.notifications).toEqual([expect.objectContaining({ message: expect.stringContaining("comms:planner") })]);
    expect(fake.notifications[0]!.type).not.toBe("error");
    expect((await named(rig, pi.agent.id)).name).toBe("planner");
    const holder = await join(rig, "claude", "/projects/api-service");
    await holder.peer.request("alias", { token: holder.token, name: "reviewer" });
    await fake.command("comms-alias", "reviewer");
    expect(fake.notifications[1]).toMatchObject({ type: "error", message: expect.stringContaining("api-service") });
  });
});

test("aliases: a new Pi session in the same folder starts unaliased with a generated name", async () => {
  await withRig(async rig => {
    const first = await rig.harness("pi");
    await (first.fake as FakePi).tool("comms_alias", { name: "planner" });
    await first.close();
    const next = await rig.harness("pi");
    expect(next.agent.id).not.toBe(first.agent.id);
    expect(next.agent.name).toBe("pi-shared");
    expect(aliased(rig, next.agent.id)).toBe(0);
    expect(await named(rig, first.agent.id)).toMatchObject({ name: "planner", online: false });
  });
});

// Codex: the shared comms_alias tool through the MCP server, acting as the thread its `_meta` names.

async function codexAlias(rig: Rig, session: HarnessSession, name: string) {
  const adapter = createCodexAdapter(rig.runtime());
  try { return await adapter.toolsCall((session.fake as FakeCodex).request("comms_alias", { name })); }
  finally { await adapter.close(); }
}

test("aliases: Codex's comms_alias tool sets the thread's alias and answers with its address; a held name is an error result", async () => {
  await withRig(async rig => {
    const codex = await rig.harness("codex");
    const result = await codexAlias(rig, codex, "planner");
    expect(result.isError).toBeFalsy();
    expect(result.content.map(item => item.text).join("\n")).toContain("comms:planner");
    expect((await named(rig, codex.agent.id)).name).toBe("planner");
    expect(aliased(rig, codex.agent.id)).toBe(1);
    const holder = await join(rig, "pi", "/projects/review-desk");
    await holder.peer.request("alias", { token: holder.token, name: "reviewer" });
    const refused = await codexAlias(rig, codex, "reviewer");
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("pi");
    expect(refused.content[0]!.text).toContain("review-desk");
  });
});

test("aliases: a new Codex thread in the same folder starts unaliased with a generated name", async () => {
  await withRig(async rig => {
    const first = await rig.harness("codex");
    await codexAlias(rig, first, "planner");
    await first.close();
    const next = await rig.harness("codex");
    expect(next.agent.name).toBe("codex-shared");
    expect(aliased(rig, next.agent.id)).toBe(0);
    expect(await named(rig, first.agent.id)).toMatchObject({ name: "planner", online: false });
  });
});

test("aliases: bare-name and comms: sends from every harness reach an alias", async () => {
  await withRig(async rig => {
    const target = await rig.harness("pi");
    await (target.fake as FakePi).tool("comms_alias", { name: "planner" });
    const claude = await rig.harness("claude"), codex = await rig.harness("codex", undefined, "/projects/codex");
    expect(await (claude.fake as FakeClaude).tool({ tool: "SendMessage", tool_use_id: uuid(), to: "planner", message: "From Claude by bare name" }))
      .toEqual({ result: { success: true, message: "Sent to planner." } });
    expect((await codex.send("comms:planner", "From Codex")) as { content: { text: string }[] }).toMatchObject({ content: [{ text: "Sent to planner." }] });
    await eventually(target.incoming, texts => expect(texts).toHaveLength(2));
    expect(rig.rows().map(row => [row.recipient, row.body])).toEqual([
      [target.agent.id, "From Claude by bare name"], [target.agent.id, "From Codex"]]);
  });
});
