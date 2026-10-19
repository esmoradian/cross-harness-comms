import { expect, test } from "bun:test";
import type { Harness } from "@cross-harness-comms/protocol";
import type { PiToolResult } from "../adapters/pi/src/index.ts";
import type { McpResult } from "../adapters/codex/src/index.ts";
import { eventually, uuid } from "./support/helpers.ts";
import { registration, withRig, type HarnessSession, type Rig } from "./support/rig.ts";

// The core fills the recipient's agent name into SendResult, additive within protocol version 1, and every
// harness's send tool names the recipient instead of the message ID.

const sent = (name: string) => `Sent to ${name}.`;
const queued = (name: string) => `Queued for ${name}, which is offline; it gets the message when it reconnects.`;

test("send result: the core names the recipient for online and offline recipients, by name or ID address", async () => {
  await withRig(async rig => {
    const sender = await rig.peer(), online = await rig.peer(), away = await rig.peer();
    const a = await sender.register(registration("pi", uuid(), "/projects/web"));
    const b = await online.register(registration("codex", uuid(), "/projects/api"));
    const c = await away.register(registration("pi", uuid(), "/projects/away"));
    away.close();
    await eventually(() => rig.agents(), list => expect(list.find(x => x.id === c.agent.id)?.online).toBe(false));
    for (const to of [`comms:${b.agent.name}`, `comms:${b.agent.id}`]) {
      const result = await sender.request("send", { token: a.token, id: uuid(), to, body: "hello" });
      expect(result).toMatchObject({ name: "codex-api" });
    }
    const result = await sender.request("send", { token: a.token, id: uuid(), to: `comms:${c.agent.name}`, body: "later" });
    expect(result).toMatchObject({ name: "pi-away", state: "queued" });
  });
});

// The summary text each harness's send tool returns.
async function summary(session: HarnessSession, to: string): Promise<unknown> {
  const result = await session.send(to, "Can you take a look?");
  if (session.harness === "pi") return (result as PiToolResult).content;
  if (session.harness === "codex") {
    expect((result as McpResult).isError).not.toBe(true);
    return (result as McpResult).content;
  }
  return result;
}

function expected(harness: Harness, text: string): unknown {
  return harness === "claude" ? { result: { success: true, message: text } } : [{ type: "text", text }];
}

async function recipients(rig: Rig) {
  const pi = await rig.harness("pi", uuid(), "/projects/near");
  const codex = await rig.harness("codex", uuid(), "/projects/api");
  const away = await rig.harness("pi", uuid(), "/projects/away");
  await away.close();
  await eventually(() => rig.agents(), list => expect(list.find(x => x.id === away.agent.id)?.online).toBe(false));
  return { pi, codex, away };
}

for (const harness of ["pi", "codex", "claude"] as Harness[]) {
  test(`send result: ${harness}'s send tool says Sent to an online recipient, including a Codex thread`, async () => {
    await withRig(async rig => {
      const sender = await rig.harness(harness, uuid(), "/projects/shared");
      const { pi, codex } = await recipients(rig);
      expect(await summary(sender, `comms:${pi.agent.name}`)).toEqual(expected(harness, sent("pi-near")));
      expect(await summary(sender, `comms:${codex.agent.name}`)).toEqual(expected(harness, sent("codex-api")));
    });
  });

  test(`send result: ${harness}'s send tool says Queued for an offline recipient`, async () => {
    await withRig(async rig => {
      const sender = await rig.harness(harness, uuid(), "/projects/shared");
      const { away } = await recipients(rig);
      expect(await summary(sender, `comms:${away.agent.name}`)).toEqual(expected(harness, queued("pi-away")));
      expect(rig.rows().at(-1)!.state).toBe("queued");
    });
  });
}
