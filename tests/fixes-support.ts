import { runCli } from "@cross-harness-comms/core/cli";
import type { Harness, SessionRegistration, WirePacket } from "@cross-harness-comms/protocol";
import { expect } from "bun:test";
import { deferred, eventually, uuid } from "./helpers.ts";
import { FakeClaude } from "./fakes/claude.ts";
import type { HarnessSession, Rig } from "./rig.ts";

async function* input(params: unknown) { yield JSON.stringify(params) + "\n"; }

export async function cli(rig: Rig, command: string, params: unknown) {
  let stdout = "", stderr = "";
  const exitCode = await runCli([command], {
    stdin: input(params), signal: new AbortController().signal,
    stdout: text => { stdout += text; }, stderr: text => { stderr += text; },
  }, rig.cliRuntime());
  return { exitCode, stdout, stderr };
}

// This is the same CLI handler an agent's shell invokes, with process I/O held in memory.
export function shellAttach(rig: Rig, session: SessionRegistration, token?: string) {
  const abort = new AbortController();
  const response = deferred<WirePacket | { exitCode: number; stderr: string }>();
  let buffer = "", stderr = "";
  const done = runCli(["attach"], {
    stdin: input({ versions: { min: 1, max: 1 }, session, ...(token === undefined ? {} : { token }) }),
    signal: abort.signal, stderr: text => { stderr += text; },
    stdout: text => {
      buffer += text;
      const newline = buffer.indexOf("\n");
      if (newline >= 0) response.resolve(JSON.parse(buffer.slice(0, newline)) as WirePacket);
    },
  }, rig.cliRuntime());
  void done.then(exitCode => response.resolve({ exitCode, stderr }), response.reject);
  return { response: response.promise, async close() { abort.abort(); await done; } };
}

export function helloRequests(rig: Rig, harness: Harness, session_key: string) {
  return rig.traffic.filter(entry => {
    if (entry.direction !== "to-core" || !("method" in entry.packet) || entry.packet.method !== "hello") return false;
    const params = entry.packet.params as { session?: SessionRegistration };
    return params.session?.harness === harness && params.session.session_key === session_key;
  });
}

export function sendRequests(rig: Rig) {
  return rig.traffic.flatMap(entry => entry.direction === "to-core" && "method" in entry.packet && entry.packet.method === "send"
    ? [entry.packet.params as { id?: string; token?: string; body: string; reply_to?: string; to: string }] : []);
}

export async function receive(rig: Rig, from: HarnessSession, to: HarnessSession, text: string) {
  const count = to.incoming().length;
  await from.send(`comms:${to.agent.name}`, text);
  await eventually(to.incoming, messages => expect(messages).toHaveLength(count + 1));
  const message = rig.rows().at(-1)!;
  await rig.state(message.id, "acked");
  return message;
}

// Claude's native tool has no reply_to parameter. No envelope is synthesized by this driver.
export async function claudeSend(session: HarnessSession, to: string, message: string) {
  const result = await (session.fake as FakeClaude).tool({ tool: "SendMessage", tool_use_id: uuid(), to, message });
  expect(result).not.toHaveProperty("deny");
  return result;
}
