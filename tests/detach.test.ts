import { expect, test } from "bun:test";
import { createClient } from "@cross-harness-comms/client";
import { VERSION_RANGE } from "@cross-harness-comms/protocol";
import { registration, withRig } from "./support/rig.ts";

test("self-detach returns success before closing the registered connection", async () => {
  await withRig(async rig => {
    const client = createClient(await rig.connect());
    try {
      const { agent, token } = await client.hello({ versions: VERSION_RANGE, session: registration("pi") });
      expect(await client.request("detach", { token: token! })).toEqual({ ok: true });
      expect((await client.deliveries[Symbol.asyncIterator]().next()).done).toBe(true);
      expect((await rig.agents()).find(a => a.id === agent!.id)?.online).toBe(false);
    } finally { await client.close(); }
  });
});

test("detaching another connection closes only the owner and leaves the caller usable", async () => {
  await withRig(async rig => {
    const owner = createClient(await rig.connect()), caller = createClient(await rig.connect());
    try {
      const { agent, token } = await owner.hello({ versions: VERSION_RANGE, session: registration("pi") });
      await caller.hello({ versions: VERSION_RANGE });
      expect(await caller.request("detach", { token: token! })).toEqual({ ok: true });
      expect((await owner.deliveries[Symbol.asyncIterator]().next()).done).toBe(true);
      expect((await caller.request("list", {})).agents.find(a => a.id === agent!.id)?.online).toBe(false);
      expect(await caller.request("detach", { token: token! })).toEqual({ ok: true });
    } finally { await Promise.all([owner.close(), caller.close()]); }
  });
});
