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

// NAMING-DESIGN.md and HANDOFF-NAMES.md: a chosen name is the agent's one comms name, set from inside its session.
// `name { token? | codex_thread?, name }` renames the caller and marks it chosen (`agents.name_chosen`). An online holder
// refuses with NAME_TAKEN naming its harness and folder; an offline holder falls back to a generated name, the way
// registration picks one, and keeps its mail. A Claude /clear hello names the identity it replaces (`replaces`, that
// identity's token); an offline identity with a chosen name, on the same harness and host, hands that name to the new identity.
// Mail never moves with a name.

const NAME_TOOL = FakeClaude.toolName("comms_name");

// The `name_chosen` flag as stored; tests read the database the way the token tests do.
function nameChosen(rig: Rig, id: string): number | undefined {
  const db = new Database(rig.databasePath, { readonly: true });
  try { return (db.query("SELECT name_chosen FROM agents WHERE id = ?").get(id) as { name_chosen: number } | null)?.name_chosen; }
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

test("names: COMMS_TOOLS gives Pi and Codex comms_name with a required name, beside comms_send and comms_list", () => {
  expect(COMMS_TOOLS.map(tool => tool.name as string)).toEqual(["comms_send", "comms_list", "comms_name"]);
  const nameTool = COMMS_TOOLS.find(tool => tool.name === ("comms_name" as string))!;
  expect(nameTool.inputSchema).toMatchObject({ type: "object", properties: { name: { type: "string" } }, required: ["name"] });
});

test("names: an agent takes an unheld name, is marked as chosen, and sends and lookups by that name reach it", async () => {
  await withRig(async rig => {
    const target = await join(rig, "pi"), sender = await join(rig, "codex");
    expect(target.agent.name).toBe("pi-shared");
    expect(nameChosen(rig, target.agent.id)).toBe(0);
    const result = await target.peer.request("name", { token: target.token, name: "planner" });
    expect(result).toMatchObject({ id: target.agent.id, name: "planner" });
    expect(await named(rig, target.agent.id)).toMatchObject({ name: "planner", online: true });
    expect(nameChosen(rig, target.agent.id)).toBe(1);
    expect((await sender.peer.request("resolve", { name: "planner" })).agent).toMatchObject({ id: target.agent.id });
    expect((await sender.peer.request("resolve", { name: "pi-shared" })).agent).toBeNull();
    await sender.peer.request("send", { token: sender.token, id: uuid(), to: "comms:planner", body: "For the planner" });
    expect((await target.peer.deliveries.next()).message).toMatchObject({ recipient: target.agent.id, body: "For the planner" });
  });
});

test("names: COMMS_TOOLS describes comms_name's name with the slash the name rule allows", () => {
  const nameTool = COMMS_TOOLS.find(tool => tool.name === ("comms_name" as string))! as { inputSchema: { properties: { name: { description?: string } } } };
  expect(nameTool.inputSchema.properties.name.description).toMatch(/slash|`\/`|"\/"/);
});

// HANDOFF-PI-LIVE-SUBAGENTS: names may contain `/`, so Pi session names such as `<group>/<tab label>` can be comms names.
// The rule is 1 to 64 of lowercase letters, digits, `.`, `_`, `-`, and `/`, not starting or ending with `/`, and not UUID-like.

const SLASH_NAMES = ["misc/w1", "a/b/c", "misc/my-worker.v2_x", `${"a".repeat(31)}/${"b".repeat(32)}`];

test("names: a name with `/` inside is accepted by name and rename, up to 64 characters, and lookups by it reach the agent", async () => {
  await withRig(async rig => {
    const caller = await join(rig, "pi"), other = await join(rig, "codex");
    for (const name of SLASH_NAMES) {
      expect(await caller.peer.request("name", { token: caller.token, name }), name).toMatchObject({ id: caller.agent.id, name });
      expect((await other.peer.request("resolve", { name })).agent, name).toMatchObject({ id: caller.agent.id });
    }
    expect(SLASH_NAMES.at(-1)).toHaveLength(64);
    const renamed = await cli(rig, ["rename", `comms:${other.agent.name}`, "team/reviewer"]);
    expect(renamed.exitCode, renamed.stderr).toBe(0);
    expect((await named(rig, other.agent.id)).name).toBe("team/reviewer");
    await caller.peer.request("send", { token: caller.token, id: uuid(), to: "comms:team/reviewer", body: "For the reviewer" });
    expect((await other.peer.deliveries.next()).message).toMatchObject({ recipient: other.agent.id, body: "For the reviewer" });
  });
});

test("names: a name outside the name rule is refused with INVALID_NAME and the name stays", async () => {
  await withRig(async rig => {
    const caller = await join(rig, "pi");
    for (const name of ["Planner", "has space", "x".repeat(65), "0190abcd-1234-7000", "/misc", "misc/", "/", "/misc/w1/",
      "Misc/W1", "misc/w 1", "misc\\w1", `misc/${"x".repeat(60)}`]) {
      await expect(caller.peer.request("name", { token: caller.token, name })).rejects.toMatchObject({ data: { code: "INVALID_NAME" } });
    }
    await expect(caller.peer.request("name", { name: "planner" })).rejects.toMatchObject({ data: { code: "INVALID_TOKEN" } });
    for (const name of ["/misc", "misc/", "Misc/W1"]) {
      await expect(caller.peer.request("rename", { address: `comms:${caller.agent.name}`, name }), name).rejects.toMatchObject({ data: { code: "INVALID_NAME" } });
    }
    expect((await named(rig, caller.agent.id)).name).toBe("pi-shared");
    expect(nameChosen(rig, caller.agent.id)).toBe(0);
  });
});

test("names: a name an online agent holds is refused with NAME_TAKEN naming that agent's harness and folder", async () => {
  await withRig(async rig => {
    const claude = await join(rig, "claude", "/projects/api-service");
    await claude.peer.request("name", { token: claude.token, name: "planner" });
    const codex = await rig.harness("codex", undefined, "/projects/codex-work");
    expect((await cli(rig, ["rename", `comms:${codex.agent.name}`, "reviewer"])).exitCode).toBe(0);
    const caller = await join(rig, "pi");
    takenBy(await caller.peer.request("name", { token: caller.token, name: "planner" }).catch(error => error), "claude", "api-service");
    // An online Codex thread counts as online through its hooks, not a connection.
    takenBy(await caller.peer.request("name", { token: caller.token, name: "reviewer" }).catch(error => error), "codex", "codex-work");
    expect((await named(rig, claude.agent.id)).name).toBe("planner");
    expect((await named(rig, codex.agent.id)).name).toBe("reviewer");
    expect((await named(rig, caller.agent.id)).name).toBe("pi-shared");
    expect(nameChosen(rig, caller.agent.id)).toBe(0);
  });
});

test("names: taking a name from an offline holder gives the holder a generated name, and its queued mail stays with it, never reaching the new holder", async () => {
  await withRig(async rig => {
    const holder = await join(rig, "pi", "/projects/old"), sender = await join(rig, "codex");
    await holder.peer.request("name", { token: holder.token, name: "planner" });
    await leave(rig, holder);
    await sender.peer.request("send", { token: sender.token, id: uuid(), to: "comms:planner", body: "For the old planner" });
    const queued = rig.rows()[0]!;
    expect(queued).toMatchObject({ recipient: holder.agent.id, state: "queued" });

    const caller = await join(rig, "claude", "/projects/new");
    expect(await caller.peer.request("name", { token: caller.token, name: "planner" })).toMatchObject({ id: caller.agent.id, name: "planner" });
    expect(await named(rig, holder.agent.id)).toMatchObject({ name: "pi-old", online: false });
    expect(nameChosen(rig, holder.agent.id)).toBe(0);
    expect(nameChosen(rig, caller.agent.id)).toBe(1);
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

test("names: an offline holder falls back to the first free generated name, as registration picks one", async () => {
  await withRig(async rig => {
    const first = await join(rig, "pi"), second = await join(rig, "pi");
    expect([first.agent.name, second.agent.name]).toEqual(["pi-shared", "pi-shared-2"]);
    await second.peer.request("name", { token: second.token, name: "planner" });
    await leave(rig, second);
    const caller = await join(rig, "codex");
    await caller.peer.request("name", { token: caller.token, name: "planner" });
    expect((await named(rig, second.agent.id)).name).toBe("pi-shared-2");
    expect((await named(rig, first.agent.id)).name).toBe("pi-shared");
  });
});

test("names: a Claude hello replacing an offline Claude identity with a chosen name on the same host moves the name to the new identity, and no mail moves", async () => {
  await withRig(async rig => {
    const before = await join(rig, "claude"), sender = await join(rig, "pi", "/projects/sender");
    await before.peer.request("name", { token: before.token, name: "planner" });
    await leave(rig, before);
    await sender.peer.request("send", { token: sender.token, id: uuid(), to: "comms:planner", body: "Before the clear" });
    const queued = rig.rows()[0]!;

    const after = await rig.peer();
    const hello = await after.request("hello", { versions: VERSION_RANGE, session: registration("claude"), replaces: before.token });
    expect(hello.agent).toMatchObject({ name: "planner" });
    expect(hello.agent!.id).not.toBe(before.agent.id);
    expect((await named(rig, before.agent.id)).name).toMatch(/^claude-shared(-\d+)?$/);
    expect(nameChosen(rig, hello.agent!.id)).toBe(1);
    expect(nameChosen(rig, before.agent.id)).toBe(0);
    expect(rig.rows()).toMatchObject([{ id: queued.id, recipient: before.agent.id, state: "queued" }]);

    await sender.peer.request("send", { token: sender.token, id: uuid(), to: "comms:planner", body: "After the clear" });
    expect((await after.deliveries.next()).message).toMatchObject({ recipient: hello.agent!.id, body: "After the clear" });
    expect(bodies(after)).toEqual(["After the clear"]);
  });
});

test("names: nothing moves when the replaced identity has a generated name, is online, on another harness or host, unknown, or the hello resumes an existing identity", async () => {
  await withRig(async rig => {
    const hello = async (replaces: string, session = registration("claude")) => {
      const peer = await rig.peer();
      return (await peer.request("hello", { versions: VERSION_RANGE, session, replaces })).agent!;
    };
    // Generated name: it stays, and the new identity gets its own.
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
      await holder.peer.request("name", { token: holder.token, name });
      if (offline) await leave(rig, holder);
      const fresh = await hello(holder.token);
      expect(fresh.name, label).not.toBe(name);
      expect((await named(rig, holder.agent.id)).name, label).toBe(name);
      expect(nameChosen(rig, holder.agent.id), label).toBe(1);
    }

    expect((await hello("not-a-token")).name).toMatch(/^claude-shared/);

    // A resumed identity keeps its own name; only a newly created identity takes the chosen name.
    const holder = await join(rig, "claude");
    await holder.peer.request("name", { token: holder.token, name: "kept" });
    await leave(rig, holder);
    const existing = await join(rig, "claude", "/projects/existing");
    await leave(rig, existing);
    const resumed = await hello(holder.token, registration("claude", existing.session_key, "/projects/existing"));
    expect(resumed).toMatchObject({ id: existing.agent.id, name: "claude-existing" });
    expect((await named(rig, holder.agent.id)).name).toBe("kept");
  });
});

test("names: the migration adds name_chosen with every existing name unchosen, so a Claude /clear leaves their names", async () => {
  await withRig(async rig => {
    const before = await join(rig, "claude");
    await before.peer.request("name", { token: before.token, name: "planner" });
    const other = await join(rig, "pi");
    await rig.restart(() => {
      // A database from before chosen names: the same agents and names, no name_chosen column.
      const db = new Database(rig.databasePath);
      try { db.exec("ALTER TABLE agents DROP COLUMN name_chosen"); }
      finally { db.close(); }
    });
    const db = new Database(rig.databasePath, { readonly: true });
    try { expect((db.query("PRAGMA table_info(agents)").all() as { name: string }[]).map(column => column.name)).toContain("name_chosen"); }
    finally { db.close(); }
    expect([nameChosen(rig, before.agent.id), nameChosen(rig, other.agent.id)]).toEqual([0, 0]);
    const after = await rig.peer();
    const hello = await after.request("hello", { versions: VERSION_RANGE, session: registration("claude"), replaces: before.token });
    expect(hello.agent!.name).not.toBe("planner");
    expect((await named(rig, before.agent.id)).name).toBe("planner");
  });
});

test("names: comms name <name> reads the session token on stdin", async () => {
  await withRig(async rig => {
    const caller = await join(rig, "pi"), holder = await join(rig, "claude", "/projects/api-service");
    await holder.peer.request("name", { token: holder.token, name: "reviewer" });
    const result = await cli(rig, ["name", "planner"], { token: caller.token });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ id: caller.agent.id, name: "planner" });
    expect(result.stdout).not.toContain(caller.token);
    const taken = await cli(rig, ["name", "reviewer"], { token: caller.token });
    expect(taken.exitCode).toBe(2);
    expect(taken.stderr).toContain("claude");
    expect(taken.stderr).toContain("api-service");
    expect((await cli(rig, ["name"], { token: caller.token })).exitCode).toBe(1);
  });
});

// Claude: a `/comms-name <name>` slash command and a model-callable `comms_name` tool, both declared at session start.

async function claudeName(fake: FakeClaude, name: string) {
  return fake.tool({ tool: NAME_TOOL, tool_use_id: uuid(), name });
}

test("names: Claude declares /comms-name and a comms_name tool at session start", async () => {
  await withRig(async rig => {
    const fake = (await rig.harness("claude")).fake as FakeClaude;
    expect(fake.registeredCommands).toEqual([expect.objectContaining({ name: "comms-name" })]);
    expect(fake.registeredTools).toEqual([expect.objectContaining({ name: "comms_name",
      inputSchema: expect.objectContaining({ properties: { name: expect.objectContaining({ type: "string" }) }, required: ["name"] }) })]);
  });
});

test("names: Claude's /comms-name sets the session's name and answers with its address, or the refusal", async () => {
  await withRig(async rig => {
    const claude = await rig.harness("claude");
    const fake = claude.fake as FakeClaude;
    expect((await fake.command("comms-name", "planner")).text).toContain("comms:planner");
    expect(await named(rig, claude.agent.id)).toMatchObject({ name: "planner", online: true });
    expect(nameChosen(rig, claude.agent.id)).toBe(1);
    const holder = await rig.harness("pi", undefined, "/projects/review-desk");
    expect((await cli(rig, ["rename", `comms:${holder.agent.name}`, "reviewer"])).exitCode).toBe(0);
    const refused = (await fake.command("comms-name", "reviewer")).text ?? "";
    expect(refused).toContain("pi");
    expect(refused).toContain("review-desk");
    expect((await named(rig, claude.agent.id)).name).toBe("planner");
  });
});

test("names: Claude's model sets its name with comms_name, and a refusal is denied with the reason", async () => {
  await withRig(async rig => {
    const claude = await rig.harness("claude");
    const fake = claude.fake as FakeClaude;
    // A plain string, the shape Claude Code accepts for a registered tool (HANDOFF-FIXES-3 fix 1).
    expect(await claudeName(fake, "planner")).toEqual({ result: expect.stringContaining("comms:planner") });
    expect((await named(rig, claude.agent.id)).name).toBe("planner");
    const holder = await rig.harness("pi", undefined, "/projects/review-desk");
    expect((await cli(rig, ["rename", `comms:${holder.agent.name}`, "reviewer"])).exitCode).toBe(0);
    const refused = await claudeName(fake, "reviewer");
    expect(refused).toHaveProperty("deny");
    expect("deny" in refused && refused.deny).toContain("review-desk");
    expect(fake.nativeCalls).toEqual([]);
  });
});

test("names: the fake checks a registered tool's answer as Claude Code does: a string, content blocks, or undefined, never an object", async () => {
  await withRig(async rig => {
    const fake = new FakeClaude(uuid(), "/projects/shared", rig.cliRuntime());
    try {
      await fake.api.tool!.register({ name: "probe", description: "Probe" });
      const probe = FakeClaude.toolName("probe");
      let answer: unknown;
      fake.on("tool.call", async (_$, event, next) => event.tool === probe ? { result: answer } : next(event));
      const call = () => fake.tool({ tool: probe, tool_use_id: uuid() });
      for (const accepted of ["Done.", [{ type: "text", text: "Done." }], undefined]) {
        answer = accepted;
        expect(await call()).toEqual({ result: accepted });
      }
      // The first is the shape the 0.1.24 adapter answered comms_name with.
      for (const rejected of [{ success: true, message: "Done." }, 42, [{ text: "No type" }]]) {
        answer = rejected;
        await expect(call()).rejects.toThrow(`tool.call step resolved ${probe} with a result that does not match its output shape`);
      }
      // Built-in tools keep their own structured results.
      expect(await fake.tool({ tool: "ListAgents", tool_use_id: uuid() })).toEqual({ result: { listing: fake.nativeListing } });
    } finally { fake.close(); }
  });
});

test("names: Claude /clear moves the chosen name to the new identity, its hello names the replaced one, and the old identity keeps its mail", async () => {
  await withRig(async rig => {
    const claude = await rig.harness("claude"), pi = await rig.harness("pi");
    const fake = claude.fake as FakeClaude;
    await claudeName(fake, "planner");
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
    // The chosen name still answers from the replacement session.
    expect(JSON.stringify(await claudeName(fake, "planner"))).toContain("comms:planner");
  });
});

test("names: Claude /clear leaves a generated name alone", async () => {
  await withRig(async rig => {
    const claude = await rig.harness("claude");
    const fake = claude.fake as FakeClaude;
    const nextId = uuid();
    await fake.clear(nextId);
    expect((await named(rig, claude.agent.id)).name).toBe("claude-shared");
    expect((await rig.agent("claude", nextId)).name).toBe("claude-shared-2");
  });
});

test("names: Claude resume of the same session keeps its identity and chosen name", async () => {
  await withRig(async rig => {
    const claude = await rig.harness("claude");
    const fake = claude.fake as FakeClaude;
    await fake.command("comms-name", "planner");
    await fake.end("resume");
    await fake.classicStart("resume");
    await eventually(() => rig.agent("claude", fake.sessionId), agent => expect(agent.online).toBe(true));
    expect(await rig.agent("claude", fake.sessionId)).toMatchObject({ id: claude.agent.id, name: "planner" });
    expect(nameChosen(rig, claude.agent.id)).toBe(1);
  });
});

// Pi: the shared comms_name tool and a /comms-name command (Pi Intercom owns /alias).

test("names: Pi's comms_name tool sets the session's name and answers with its address; a held name throws the refusal", async () => {
  await withRig(async rig => {
    const pi = await rig.harness("pi");
    const fake = pi.fake as FakePi;
    const result = await fake.tool("comms_name", { name: "planner" });
    expect(result.content[0]!.text).toContain("comms:planner");
    expect((await named(rig, pi.agent.id)).name).toBe("planner");
    const holder = await join(rig, "claude", "/projects/api-service");
    await holder.peer.request("name", { token: holder.token, name: "reviewer" });
    const error = await fake.tool("comms_name", { name: "reviewer" }).catch(caught => caught as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("claude");
    expect((error as Error).message).toContain("api-service");
    expect((await named(rig, pi.agent.id)).name).toBe("planner");
  });
});

test("names: Pi's /comms-name command sets the name and notifies its address, and a refusal notifies an error", async () => {
  await withRig(async rig => {
    const pi = await rig.harness("pi");
    const fake = pi.fake as FakePi;
    expect(fake.commands.has("alias")).toBe(false);
    await fake.command("comms-name", "planner");
    expect(fake.notifications).toEqual([expect.objectContaining({ message: expect.stringContaining("comms:planner") })]);
    expect(fake.notifications[0]!.type).not.toBe("error");
    expect((await named(rig, pi.agent.id)).name).toBe("planner");
    const holder = await join(rig, "claude", "/projects/api-service");
    await holder.peer.request("name", { token: holder.token, name: "reviewer" });
    await fake.command("comms-name", "reviewer");
    expect(fake.notifications[1]).toMatchObject({ type: "error", message: expect.stringContaining("api-service") });
  });
});

test("names: a new Pi session in the same folder starts with a generated name", async () => {
  await withRig(async rig => {
    const first = await rig.harness("pi");
    await (first.fake as FakePi).tool("comms_name", { name: "planner" });
    await first.close();
    const next = await rig.harness("pi");
    expect(next.agent.id).not.toBe(first.agent.id);
    expect(next.agent.name).toBe("pi-shared");
    expect(nameChosen(rig, next.agent.id)).toBe(0);
    expect(await named(rig, first.agent.id)).toMatchObject({ name: "planner", online: false });
  });
});

// Codex: the shared comms_name tool through the MCP server, acting as the thread its `_meta` names.

async function codexName(rig: Rig, session: HarnessSession, name: string) {
  const adapter = createCodexAdapter(rig.runtime());
  try { return await adapter.toolsCall((session.fake as FakeCodex).request("comms_name", { name })); }
  finally { await adapter.close(); }
}

test("names: Codex's comms_name tool sets the thread's name and answers with its address; a held name is an error result", async () => {
  await withRig(async rig => {
    const codex = await rig.harness("codex");
    const result = await codexName(rig, codex, "planner");
    expect(result.isError).toBeFalsy();
    expect(result.content.map(item => item.text).join("\n")).toContain("comms:planner");
    expect((await named(rig, codex.agent.id)).name).toBe("planner");
    expect(nameChosen(rig, codex.agent.id)).toBe(1);
    const holder = await join(rig, "pi", "/projects/review-desk");
    await holder.peer.request("name", { token: holder.token, name: "reviewer" });
    const refused = await codexName(rig, codex, "reviewer");
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("pi");
    expect(refused.content[0]!.text).toContain("review-desk");
  });
});

test("names: a new Codex thread in the same folder starts with a generated name", async () => {
  await withRig(async rig => {
    const first = await rig.harness("codex");
    await codexName(rig, first, "planner");
    await first.close();
    const next = await rig.harness("codex");
    expect(next.agent.name).toBe("codex-shared");
    expect(nameChosen(rig, next.agent.id)).toBe(0);
    expect(await named(rig, first.agent.id)).toMatchObject({ name: "planner", online: false });
  });
});

test("names: bare-name and comms: sends from every harness reach a chosen name", async () => {
  await withRig(async rig => {
    const target = await rig.harness("pi");
    await (target.fake as FakePi).tool("comms_name", { name: "planner" });
    const claude = await rig.harness("claude"), codex = await rig.harness("codex", undefined, "/projects/codex");
    expect(await (claude.fake as FakeClaude).tool({ tool: "SendMessage", tool_use_id: uuid(), to: "planner", message: "From Claude by bare name" }))
      .toEqual({ result: { success: true, message: "Sent to planner." } });
    expect((await codex.send("comms:planner", "From Codex")) as { content: { text: string }[] }).toMatchObject({ content: [{ text: "Sent to planner." }] });
    await eventually(target.incoming, texts => expect(texts).toHaveLength(2));
    expect(rig.rows().map(row => [row.recipient, row.body])).toEqual([
      [target.agent.id, "From Claude by bare name"], [target.agent.id, "From Codex"]]);
  });
});

test("names: sends to a name with `/` from every harness reach it, including Claude's SendMessage by bare name", async () => {
  await withRig(async rig => {
    const target = await rig.harness("pi", undefined, "/projects/target");
    await (target.fake as FakePi).tool("comms_name", { name: "misc/w1" });
    const claude = await rig.harness("claude"), codex = await rig.harness("codex", undefined, "/projects/codex");
    const pi = await rig.harness("pi", undefined, "/projects/sender");
    expect(await (claude.fake as FakeClaude).tool({ tool: "SendMessage", tool_use_id: uuid(), to: "misc/w1", message: "From Claude by bare name" }))
      .toEqual({ result: { success: true, message: "Sent to misc/w1." } });
    expect(await (claude.fake as FakeClaude).tool({ tool: "SendMessage", tool_use_id: uuid(), to: "comms:misc/w1", message: "From Claude" }))
      .toEqual({ result: { success: true, message: "Sent to misc/w1." } });
    expect((await codex.send("comms:misc/w1", "From Codex")) as { content: { text: string }[] }).toMatchObject({ content: [{ text: "Sent to misc/w1." }] });
    expect((await codex.send("misc/w1", "From Codex by plain name")) as { content: { text: string }[] }).toMatchObject({ content: [{ text: "Sent to misc/w1." }] });
    expect(await pi.send("misc/w1", "From Pi")).toMatchObject({ content: [{ text: "Sent to misc/w1." }] });
    expect(await pi.send("comms:misc/w1", "From Pi with comms:")).toMatchObject({ content: [{ text: "Sent to misc/w1." }] });
    await eventually(target.incoming, texts => expect(texts).toHaveLength(6));
    expect(rig.rows().map(row => [row.recipient, row.body])).toEqual([
      [target.agent.id, "From Claude by bare name"], [target.agent.id, "From Claude"], [target.agent.id, "From Codex"],
      [target.agent.id, "From Codex by plain name"], [target.agent.id, "From Pi"], [target.agent.id, "From Pi with comms:"]]);
  });
});

test("names: a sender named with `/` is shown by that name, and every harness replies to it by the address its message gave", async () => {
  await withRig(async rig => {
    const sender = await rig.harness("pi", undefined, "/projects/sender");
    await (sender.fake as FakePi).tool("comms_name", { name: "misc/w1" });
    for (const harness of ["pi", "claude", "codex"] as Harness[]) {
      const receiver = await rig.harness(harness, undefined, `/projects/${harness}-receiver`);
      await sender.send(`comms:${receiver.agent.name}`, `Hello ${harness}`);
      await eventually(receiver.incoming, texts => expect(texts).toHaveLength(1));
      expect(receiver.incoming()[0], harness).toContain("misc/w1");
      const before = sender.incoming().length;
      await receiver.send("comms:misc/w1", `Reply from ${harness}`, harness === "claude" ? undefined : rig.rows().at(-1)!.id);
      await eventually(sender.incoming, texts => expect(texts).toHaveLength(before + 1));
      expect(rig.rows().at(-1), harness).toMatchObject({ recipient: sender.agent.id, body: `Reply from ${harness}` });
    }
  });
});

// Plain names (HANDOFF-FIXES-3 fix 2): the core takes an address without a scheme as a comms name or ID, so Pi and Codex
// reach the names their lists and message headers show. Any other scheme still fails, and an unknown address is named in the error.

// What a refused comms_send told the model: Pi throws the core's error, and Codex answers an error result with its message.
async function refusedSend(sender: HarnessSession, to: string): Promise<string> {
  if (sender.harness === "pi") {
    const error = await sender.send(to, "Anyone there?").then(() => undefined, (caught: Error) => caught);
    expect(error, to).toMatchObject({ data: { code: "UNKNOWN_RECIPIENT" } });
    return error!.message;
  }
  const result = await sender.send(to, "Anyone there?") as { isError?: boolean; content: { text: string }[] };
  expect(result.isError, to).toBe(true);
  return result.content.map(item => item.text).join("\n");
}

for (const harness of ["pi", "codex"] as Harness[]) {
  test(`plain names: ${harness}'s comms_send reaches a chosen name and a generated name given without comms:`, async () => {
    await withRig(async rig => {
      const chosen = await join(rig, "pi", "/projects/target"), generated = await join(rig, "pi", "/projects/plain");
      await chosen.peer.request("name", { token: chosen.token, name: "planner" });
      expect(generated.agent.name).toBe("pi-plain");
      const sender = await rig.harness(harness, undefined, "/projects/sender");
      for (const [to, target] of [["planner", chosen], ["pi-plain", generated]] as const) {
        expect(JSON.stringify(await sender.send(to, `For ${to}`)), to).toContain(`Sent to ${to}.`);
        expect((await target.peer.deliveries.next()).message).toMatchObject({ recipient: target.agent.id, body: `For ${to}` });
      }
      expect(rig.rows().map(row => row.recipient)).toEqual([chosen.agent.id, generated.agent.id]);
    });
  });

  test(`plain names: ${harness}'s comms_send to an unknown plain name fails with UNKNOWN_RECIPIENT naming it, other schemes still fail, and nothing is stored`, async () => {
    await withRig(async rig => {
      const target = await join(rig, "pi", "/projects/target");
      await target.peer.request("name", { token: target.token, name: "planner" });
      const sender = await rig.harness(harness, undefined, "/projects/sender");
      expect(await refusedSend(sender, "nobody")).toContain("nobody");
      for (const to of ["uds:x", "uds:planner", "http:planner", `other:${target.agent.id}`]) await refusedSend(sender, to);
      expect(rig.rows()).toEqual([]);
      expect(bodies(target.peer)).toEqual([]);
    });
  });
}

test("plain names: comms rename takes a plain name or ID as the address, and another scheme still fails", async () => {
  await withRig(async rig => {
    const agent = await join(rig, "pi");
    for (const [address, name] of [["pi-shared", "planner"], [agent.agent.id, "reviewer"]] as [string, string][]) {
      const result = await cli(rig, ["rename", address, name]);
      expect(result.exitCode, result.stderr).toBe(0);
      expect((await named(rig, agent.agent.id)).name).toBe(name);
    }
    expect((await cli(rig, ["rename", "uds:reviewer", "other"])).exitCode).not.toBe(0);
    expect((await named(rig, agent.agent.id)).name).toBe("reviewer");
  });
});

test("plain names: comms_send's to says a name and comms:<name> both work", () => {
  const description: string = COMMS_TOOLS[0].inputSchema.properties.to.description;
  expect(description).toContain("comms:<name>");
  expect(description.replace("comms:<name>", "")).toMatch(/\bname\b/);
});
