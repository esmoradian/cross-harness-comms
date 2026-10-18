import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { expect } from "bun:test";
import { VERSION_RANGE, type Agent, type Delivery, type SessionRegistration } from "@cross-harness-comms/protocol";
import { CLAUDE_VERSION, FakeClaude, type FakeClaudeInbox } from "./fakes/claude.ts";
import { eventually, uuid, type Peer } from "./helpers.ts";
import { cli, registration, type HarnessSession, type NativeClaudeOptions, type Rig } from "./rig.ts";

export const REPLY_SOCKET = /^9\d{9}\.sock$/;

// Claude Code 2.1.289 escapes only the literal closing tag in a peer message's body.
export function claudeEscape(body: string) {
  return body.replaceAll("</cross-session-message>", "<\\/cross-session-message>");
}

// A peer-message line as Claude's own SendMessage writes it to a `uds:` address: no
// from_plugin, and possibly a hop-chain attribute (its value here is a placeholder).
export function claudeLine(options: { from: string; body: string; msg_id?: string; msgV?: number; fromName?: string }) {
  const { from, body, msg_id = randomUUID(), msgV = 1, fromName = "Planner session" } = options;
  const content = `<cross-session-message from="${from}" from-name="${fromName}" from-mode="prompting" hop-chain="1">\n${claudeEscape(body)}\n</cross-session-message>`;
  return JSON.stringify({ msgV, msg_id, type: "user", message: { role: "user", content }, priority: "next", from });
}

// Writes one line to a Unix socket and closes the connection, as Claude does. Only a failure
// to connect rejects: a receiver may close early on a line it refuses.
export function post(path: string, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let connected = false;
    const socket = connect(path, () => { connected = true; socket.end(line + "\n"); });
    socket.on("error", error => { if (!connected) reject(error); });
    socket.on("close", () => resolve());
    socket.resume();
  });
}

export function connectable(path: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect(path, () => { socket.destroy(); resolve(true); });
    socket.on("error", () => resolve(false));
  });
}

export async function inboxLine(inbox: FakeClaudeInbox, index: number) {
  const lines = await eventually(() => inbox.lines, lines => expect(lines.length).toBeGreaterThan(index));
  return JSON.parse(lines[index]!) as { msgV: number; msg_id: string; type: string; message: { role: string; content: string };
    priority: string; from: string; from_plugin?: string };
}

// The socket path behind a `uds:` address.
export function socketPath(address: string) {
  expect(address).toStartWith("uds:");
  return address.slice(4);
}

// A Claude session driven on the wire, with an inbox that records lines and runs no hooks.
export async function nativePeer(rig: Rig, options: { version?: string; session?: SessionRegistration; token?: string; inbox?: string; listen?: boolean } = {}) {
  const path = options.inbox ?? rig.inboxPath();
  const inbox = options.listen === false ? undefined : await rig.inbox(path);
  const peer = await rig.peer();
  const session = options.session ?? registration("claude");
  const hello = await peer.request("hello", { versions: VERSION_RANGE, session, ...(options.token ? { token: options.token } : {}),
    claude: { inbox: path, version: options.version ?? CLAUDE_VERSION.version } });
  return { peer, inbox, path, session, agent: hello.agent!, token: hello.token! };
}

export function deliveries(peer: Peer): Delivery[] {
  return peer.received.flatMap(packet => "method" in packet && packet.method === "deliver" ? [packet.params as Delivery] : []);
}

export async function listWithToken(rig: Rig, token: string): Promise<Agent[]> {
  const result = await cli(rig, "list", { token });
  expect(result.exitCode).toBe(0);
  return (JSON.parse(result.stdout) as { agents: Agent[] }).agents;
}

export async function claudeAddress(rig: Rig, token: string, agent: string) {
  const agents = await listWithToken(rig, token);
  const address = agents.find(a => a.id === agent)?.claude_address;
  expect(address).toBeString();
  return address!;
}

// The session token Claude's attach process received, from its private stdout.
export function attachToken(fake: FakeClaude): string {
  const output = fake.processOutput.filter(p => p.command === "attach" && p.stream === "stdout").map(p => p.text).join("");
  const hello = output.trim().split("\n").map(line => JSON.parse(line)).find(p => p.result?.token);
  expect(hello?.result.token).toBeString();
  return hello.result.token as string;
}

export function runsOf(fake: FakeClaude, command: string) {
  return fake.runs.filter(run => run.argv[1] === command);
}

// Claude Code's native ListAgents output when its own peer messaging is on.
export const peerSessions = "This session is Cross-harness communications naming [2a1458] ...\n\nPeer sessions (1):\n  comms-test-8b [c14715]  ·  interactive  ·  idle  ·  started 45m ago";

// A Claude session whose native route is on: an inbox socket and, unless `version` says otherwise, a tested Claude version (ADR-016).
export async function nativeClaude(rig: Rig, options: NativeClaudeOptions = {}) {
  const session = await rig.harness("claude", undefined, undefined, { claude: options });
  return { session, fake: session.fake as FakeClaude };
}

// Claude's native tool has no reply_to parameter. No envelope is synthesized by this driver.
export async function claudeSend(session: HarnessSession, to: string, message: string) {
  const result = await (session.fake as FakeClaude).tool({ tool: "SendMessage", tool_use_id: uuid(), to, message });
  expect(result).not.toHaveProperty("deny");
  return result;
}
