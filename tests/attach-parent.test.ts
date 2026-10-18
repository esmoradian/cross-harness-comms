import { expect, test } from "bun:test";
import type { HelloResult, SessionRegistration } from "@cross-harness-comms/protocol";
import type { FakeClaude } from "./support/fakes/claude.ts";
import { eventually, settle } from "./support/helpers.ts";
import { attach, cli, helloRequests, registration, withRig, type Rig } from "./support/rig.ts";

// `comms attach` exits when the process that started it is gone.

async function hello(child: ReturnType<typeof attach>): Promise<HelloResult> {
  const packet = await child.response;
  expect(packet).toHaveProperty("result");
  return (packet as { result: HelloResult }).result;
}

// Whether a promise settles within a generous bound, without depending on any real parent check.
const within = (promise: Promise<unknown>, ms = 1000) => Promise.race([promise.then(() => true), Bun.sleep(ms).then(() => false)]);

async function online(rig: Rig, session: SessionRegistration) {
  return (await rig.agents()).find(agent => agent.session_key === session.session_key)?.online;
}

test("comms attach closes its connection and exits once its parent is reported gone, and the session lists offline", async () => {
  await withRig(async rig => {
    const session = registration("claude");
    const child = attach(rig, session);
    expect((await hello(child)).token).toBeString();
    expect(await online(rig, session)).toBe(true);
    const [watcher] = await eventually(() => rig.parentWatchers, watchers => expect(watchers).toHaveLength(1));
    await settle();
    expect(child.exited()).toBe(false);

    watcher!.gone();
    expect(await within(child.done)).toBe(true);
    const link = rig.links[helloRequests(rig, "claude", session.session_key)[0]!.connection]!;
    expect(link.client.destroyed).toBe(true);
    await eventually(() => online(rig, session), value => expect(value).toBe(false));
  });
});

test("an attach whose parent stays alive keeps running, and stops watching once it ends", async () => {
  await withRig(async rig => {
    const kept = registration("claude"), detached = registration("claude");
    const first = attach(rig, kept);
    await hello(first);
    const second = attach(rig, detached);
    const token = (await hello(second)).token!;
    const watchers = await eventually(() => rig.parentWatchers, list => expect(list).toHaveLength(2));
    await settle();
    expect(first.exited()).toBe(false);
    expect(second.exited()).toBe(false);
    expect(await online(rig, kept)).toBe(true);
    expect(await online(rig, detached)).toBe(true);
    expect(watchers.map(watcher => watcher.stopped)).toEqual([false, false]);

    // Ending for another reason, an abort or the core closing the connection, stops the parent watch,
    // so nothing keeps a finished attach process alive.
    first.abort();
    expect(await within(first.done)).toBe(true);
    const result = await cli(rig, "detach", { token });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(await within(second.done)).toBe(true);
    expect(watchers.map(watcher => watcher.stopped)).toEqual([true, true]);
  });
});

test("a Claude session's attach exits once its parent is reported gone, and the session lists offline", async () => {
  await withRig(async rig => {
    const claude = await rig.harness("claude");
    const fake = claude.fake as FakeClaude;
    const [watcher] = await eventually(() => rig.parentWatchers, watchers => expect(watchers).toHaveLength(1));
    expect((await rig.agent("claude", claude.sessionId)).online).toBe(true);
    expect(fake.spawnResults).toHaveLength(1);
    expect(await within(fake.spawnResults[0]!, 50)).toBe(false);

    watcher!.gone();
    expect(await within(fake.spawnResults[0]!)).toBe(true);
    await eventually(() => rig.agent("claude", claude.sessionId), agent => expect(agent.online).toBe(false));
  });
});
