import { activeAgo, COMMS_TOOLS, formatMessage, hiddenLine, messageId, splitLines, VERSION_RANGE, sendSummary, type Agent, type Delivery, type HelloResult, type MethodTable, type SendResult, type WirePacket } from "@cross-harness-comms/protocol";
import type { ClaudeAPI, ClaudeOn, ProcessRunResult, ToolEvent, ToolResult } from "./api.ts";

type Options = { binary: string; host: string };

interface ClaudeState {
  binary: string;
  token: string | undefined;
  // The newest token the core issued, kept after session.end clears `token`, so the hello after /clear names the identity it replaces.
  lastToken: string | undefined;
  sessionId: string | undefined;
  generation: number;
  nativePeers: boolean;
  connecting: Promise<void> | undefined;
  disconnect: ((token: string | undefined) => Promise<void>) | undefined;
  pendingReplies: Map<string, string[]>;
  received: Set<string>;
  seenNatively: Set<string>;
  sends: Map<string, Promise<unknown>>;
}

// Claude's validator allows passing $ only to helpers declared at module scope.
// `name` is the CLI command, with its arguments after it.
function comms($: ClaudeAPI, state: ClaudeState, name: string | readonly string[], params?: unknown): Promise<ProcessRunResult> {
  return $.process.run([state.binary, ...[name].flat()], params === undefined ? {} : { stdin: JSON.stringify(params) + "\n" });
}

// A command whose result the tools read: failures carry the exit code, and a notice is shown.
async function command($: ClaudeAPI, state: ClaudeState, name: string | readonly string[], params?: unknown): Promise<unknown> {
  const response = await comms($, state, name, params);
  if (response.exitCode) throw Object.assign(new Error(response.stderr.trim() || `comms ${[name].flat()[0]} failed`), { exitCode: response.exitCode });
  const result = JSON.parse(response.stdout) as { notice?: string };
  if (result.notice) {
    try { $.ui!.log(result.notice); } catch { /* Minimal embedding host has no UI. */ }
  }
  return result;
}

function remove(ids: string[] | undefined, id: string): void {
  const index = ids?.indexOf(id) ?? -1;
  if (index >= 0) ids!.splice(index, 1);
}

// Record before starting the turn: that turn can immediately reply.
function expectReply(state: ClaudeState, delivery: Delivery): void {
  if (state.received.has(delivery.message.id)) return;
  state.received.add(delivery.message.id);
  const pending = state.pendingReplies.get(delivery.from) ?? [];
  pending.push(delivery.message.id);
  state.pendingReplies.set(delivery.from, pending);
}

// The generation is the only ownership value. Take the credentials before awaiting, so a newer start keeps its own.
async function closeClaude(state: ClaudeState): Promise<void> {
  state.generation++;
  const { token, disconnect } = state;
  state.token = undefined;
  state.disconnect = undefined;
  await disconnect?.(token);
}

// Answers false once `run` no longer owns the connection, so the attach loop ends.
async function deliver($: ClaudeAPI, state: ClaudeState, run: number, delivery: Delivery): Promise<boolean> {
  if (state.seenNatively.has(delivery.message.id)) {
    if (state.token && run === state.generation) await comms($, state, "ack", { token: state.token, id: delivery.message.id });
    return true;
  }
  expectReply(state, delivery);
  const accepted = await $.prompt.submit({ text: formatMessage(delivery, "claude") });
  if (run !== state.generation) return false;
  if ("drop" in accepted) {
    state.received.delete(delivery.message.id);
    remove(state.pendingReplies.get(delivery.from), delivery.message.id);
  }
  if ("text" in accepted && state.token) {
    const ack = await comms($, state, "ack", { token: state.token, id: delivery.message.id });
    if (ack.exitCode) throw new Error(ack.stderr || "Acknowledgement failed");
  }
  return true;
}

async function startClaude($: ClaudeAPI, state: ClaudeState, options: Options): Promise<void> {
  const { pendingReplies, received, seenNatively, sends } = state;
  const previousSession = state.sessionId, previousToken = state.token;
  const closing = closeClaude(state);
  // closeClaude bumps the generation synchronously, so this run owns the one after it.
  const run = state.generation;
  const owned = () => { if (run !== state.generation) throw new Error("comms session changed"); };
  await closing;
  owned();
  const notice = async (text: string) => {
    try { $.ui!.log(text); }
    catch { await $.prompt.submit({ text }); }
  };
  state.disconnect = async token => {
    if (token) await comms($, state, "detach", { token }).catch(() => {});
  };
  const sessionId = await $.session.id();
  owned();
  state.sessionId = sessionId;
  if (state.sessionId === previousSession) state.token = previousToken;
  else { pendingReplies.clear(); received.clear(); seenNatively.clear(); sends.clear(); }
  const session = { harness: "claude", session_key: state.sessionId, cwd: await $.session.cwd(), host: options.host };
  // Mods get no CLAUDE_PLUGIN_ROOT; $.plugin.root is the plugin's directory.
  if (state.binary === "comms") state.binary = `${$.plugin.root}/bin/comms`;
  // Claude's inbox socket, which the core writes native peer lines to (ADR-016).
  const inbox = await $.env!.get("CLAUDE_CODE_MESSAGING_SOCKET");
  owned();
  state.nativePeers = !!inbox;
  const claude = inbox ? { inbox, version: (await $.session.version!()).version } : undefined;
  const ensure = await $.process.run([state.binary, "ensure"]);
  if (ensure.exitCode) throw new Error(ensure.stderr || "comms ensure failed");
  owned();
  let resolveReady!: () => void, rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const replaces = state.sessionId !== previousSession ? state.lastToken : undefined;
  const attach = async () => {
    // A retry or first run that fires after the session changed spawns nothing.
    if (run !== state.generation) { rejectReady(new Error("comms session changed")); return; }
    let initialized = false;
    try {
      const child = $.process.spawn({ argv: [state.binary, "attach"], input: JSON.stringify({ versions: VERSION_RANGE, session, ...(state.token ? { token: state.token } : {}), ...(replaces ? { replaces } : {}), ...(claude ? { claude } : {}) }) + "\n" });
      let buffer = "";
      for await (const chunk of child) {
        if (run !== state.generation) break;
        if (chunk.stream === "stderr") { await notice(chunk.text); continue; }
        const { lines, rest } = splitLines(buffer + chunk.text);
        buffer = rest;
        for (const line of lines) {
          if (run !== state.generation) break;
          const packet = JSON.parse(line) as WirePacket;
          if ("error" in packet) throw new Error(packet.error.message);
          if ("result" in packet) {
            const hello = packet.result as HelloResult;
            if (hello.token) {
              state.token = hello.token;
              state.lastToken = hello.token;
              if (hello.notice) await notice(hello.notice);
              initialized = true;
              resolveReady();
            }
          } else if (packet.method === "session_replaced") {
            state.generation++;
            state.token = undefined;
            await notice("This session connection was replaced by another attachment.");
          } else if (packet.method === "deliver") {
            if (!await deliver($, state, run, packet.params as Delivery)) return;
          }
        }
      }
      if (!initialized) throw new Error(run === state.generation ? "comms attach ended before registration" : "comms session changed");
    } catch (error) {
      rejectReady(error);
      if (initialized && run === state.generation) await notice(error instanceof Error ? error.message : "comms attach failed");
    } finally {
      if (run === state.generation) {
        try { $.clock!.after(250, attach); } catch { /* The embedding host owns restart. */ }
      }
    }
  };
  // The real host supplies clock so background work survives the start event.
  // Minimal embedders may run the asynchronous stream directly.
  try { $.clock!.after(0, attach); } catch { void attach(); }
  await ready;
}

async function ensureClaude($: ClaudeAPI, state: ClaudeState, options: Options): Promise<void> {
  // Re-read the ID after every wait, and check then install with no await between, so only one waiter starts.
  for (;;) {
    const id = await $.session.id();
    if (!state.connecting) {
      if (state.token && state.sessionId === id) return;
      break;
    }
    await state.connecting.catch(() => {});
  }
  const connecting = startClaude($, state, options);
  state.connecting = connecting;
  try { await connecting; }
  finally { if (state.connecting === connecting) state.connecting = undefined; }
}

// Claude draws a SendMessage row from `display` alone, and the model reads `message` (SEND-NAME-FINDINGS.md),
// so on the native route only `display` names the recipient instead of its reply socket.
function named(native: ToolResult, address: string, name: string): ToolResult {
  const result = "result" in native ? native.result as { display?: unknown } | null : null;
  if (typeof result?.display !== "string") return native;
  return { result: { ...result, display: result.display.split(address).join(name) } };
}

// The comms agent owning a reply socket (`9` and nine digits); Claude's own peer sockets cost no lookup.
async function replyName($: ClaudeAPI, state: ClaudeState, address: string): Promise<string | undefined> {
  if (!/\/9\d{9}\.sock$/.test(address)) return undefined;
  try {
    const { agents } = await command($, state, "list", state.token ? { token: state.token } : undefined) as { agents: Agent[] };
    return agents.find(agent => agent.claude_address === address)?.name;
  } catch { /* A failed lookup keeps Claude's row. */ return undefined; }
}

async function sendMessage($: ClaudeAPI, state: ClaudeState, event: Extract<ToolEvent, { tool: "SendMessage" }>, next: (event: ToolEvent) => Promise<ToolResult>): Promise<ToolResult> {
  if (typeof event.to !== "string") return next(event);
  if (event.agentId) {
    // Internal model forks inherit tool schemas but cannot use tools. Leave
    // their calls to Claude's permission path instead of sending as main.
    const listed = await $.agent.list().then(agents => agents.some(agent => agent.id === event.agentId)).catch(() => false);
    if (!listed) return next(event);
  }
  let address = event.to;
  if (!address.startsWith("comms:") && !address.startsWith("uds:")) {
    // A bare name is looked up in the core on every call, so names the user typed or a message
    // carried work before any ListAgents and follow renames. Anything the core cannot answer
    // stays Claude's: native subagents, teammates, and peers are never broken by comms.
    let agent: Agent | null = null;
    try {
      const found = await command($, state, "resolve", { ...(state.token ? { token: state.token } : {}), name: address, ...(state.nativePeers ? { skip_claude: true } : {}) }) as { agent?: Agent | null };
      agent = found.agent ?? null;
    } catch { /* A failed lookup passes the call through. */ }
    if (!agent) return next(event);
    if (agent.claude_address) return named(await next({ ...event, to: agent.claude_address }), agent.claude_address, agent.name);
    address = `comms:${agent.name}`;
  }
  if (!address.startsWith("comms:")) {
    const native = await next(event);
    const name = await replyName($, state, address);
    return name ? named(native, address, name) : native;
  }
  if (!state.token || await $.session.id() !== state.sessionId) return { deny: "comms session is not connected" };
  const run = state.generation;
  // Serialize logical sends to one address, so concurrent replies consume
  // different pending messages. New tool calls still mint distinct IDs.
  const previous = state.sends.get(address) ?? Promise.resolve();
  const send = previous.catch(() => {}).then(async () => {
    if (run !== state.generation || !state.token) throw new Error("comms session changed");
    const pending = state.pendingReplies.get(address);
    const reply_to = pending?.at(-1);
    const id = messageId(await $.clock!.now());
    const params = { token: state.token, id, to: address, body: event.message, ...(reply_to ? { reply_to } : {}) };
    let result: SendResult;
    try { result = await command($, state, "send", params) as SendResult; }
    catch (error) {
      // A failed subprocess may have committed before losing stdout.
      // Retry once with the same ID, text, credentials, and correlation,
      // unless the core definitely rejected the send (exit 2).
      if ((error as { exitCode?: number }).exitCode === 2) throw error;
      if (run !== state.generation) throw new Error("comms session changed");
      result = await command($, state, "send", params) as SendResult;
    }
    if (reply_to) remove(pending, reply_to);
    return result;
  });
  state.sends.set(address, send);
  try {
    const result = await send;
    return { result: { success: true, message: sendSummary(result) } };
  } catch (error) { return { deny: error instanceof Error ? error.message : "Message failed" }; }
  finally { if (state.sends.get(address) === send) state.sends.delete(address); }
}

async function listAgents($: ClaudeAPI, state: ClaudeState, event: ToolEvent, next: (event: ToolEvent) => Promise<ToolResult>): Promise<ToolResult> {
  const native = await next(event);
  if ("deny" in native) return native;
  const result = await command($, state, "list", { ...(state.token ? { token: state.token } : {}), include_stale: false }) as MethodTable["list"]["result"];
  const original = native.result as { listing?: unknown };
  if (!original || typeof original.listing !== "string") return native;
  // Native peer messaging lists Claude peers by short refs rather than session IDs,
  // so when it is on, Claude peers stay native and only other harnesses are added.
  const header = /^Peer sessions \((\d+)\):/m;
  const peerSection = header.test(original.listing);
  const shown = result.agents.filter(a => a.harness !== "claude" || (!peerSection && a.session_key !== state.sessionId));
  const time = await $.clock!.now();
  // Under the native header Claude agents are never comms rows, so their hidden ones are not counted either.
  const hidden = (result.hidden ?? 0) - (peerSection ? result.hidden_claude ?? 0 : 0);
  const extra = shown
    // Under the native header, rows match native peers; on the native route, Claude
    // sends to a reply socket with its own SendMessage.
    .map(a => peerSection
      ? `  ${a.name}  ·  ${a.harness}  ·  ${a.presence}  ·  ${activeAgo(a, time)}  ·  ${a.cwd}  ·  send to ${a.claude_address ?? `comms:${a.name}`}`
      : `comms:${a.name} (${a.harness}, ${a.presence}, ${activeAgo(a, time)}, ${a.cwd})`);
  if (!extra.length && !hidden) return native;
  const listing = original.listing.replace(header, (_, count: string) => `Peer sessions (${Number(count) + extra.length}):`);
  return { result: { ...original, listing: [listing, ...extra, ...(hidden ? [hiddenLine(hidden)] : [])].join("\n") } };
}

// Sets this session's comms name and answers with its address; a refusal throws the core's reason.
async function chooseName($: ClaudeAPI, state: ClaudeState, name: string): Promise<string> {
  if (!state.token || await $.session.id() !== state.sessionId) throw new Error("comms session is not connected");
  const agent = await command($, state, ["name", name], { token: state.token }) as Agent;
  return `This session is now comms:${agent.name}.`;
}

const NAME_TOOL = COMMS_TOOLS.find(tool => tool.name === "comms_name")!;

export function registerClaude(on: ClaudeOn, options: Options): { close(): Promise<void> } {
  const state: ClaudeState = { binary: options.binary, token: undefined, lastToken: undefined, sessionId: undefined, generation: 0, nativePeers: false, connecting: undefined, disconnect: undefined,
    pendingReplies: new Map(), received: new Set(), seenNatively: new Set(), sends: new Map() };
  const close = () => closeClaude(state);
  on("session.start", async ($, event, next) => {
    // Declared once per process or mod load; session.start never fires for /clear.
    try {
      await $.command!.register({ name: "comms-name", description: "Choose this session's comms name", argumentHint: "<name>" });
      await $.tool!.register({ name: NAME_TOOL.name, description: NAME_TOOL.description, inputSchema: NAME_TOOL.inputSchema });
    } catch { /* A Claude Code without plugin commands and tools still connects. */ }
    await ensureClaude($, state, options);
    return next(event);
  });
  on("session.end", async (_$, event, next) => {
    await close();
    return next(event);
  });
  // /clear changes the native session ID without reloading the mod or firing session.start.
  on("classic.SessionStart", async ($, event, next) => {
    await ensureClaude($, state, options);
    return next(event);
  });
  on("session.receive", async ($, event, next) => {
    // A receive that completes after /clear must not ACK with, or record into, the replacement session.
    const run = state.generation;
    const queued = await next(event);
    const origin = event.origin as { kind: string; plugin?: string };
    if (origin.kind !== "peer" || origin.plugin !== "cross-harness-comms" || queued.consumed !== undefined || !state.token || run !== state.generation) return queued;
    // The element's `from` is the reply socket the core wrote from; ACK it so the core sends the next line.
    const from = /^<cross-session-message from="([^"]*)"/.exec(event.text)?.[1];
    if (!from) return queued;
    const ack = await comms($, state, "native-ack", { token: state.token, from }).catch(() => undefined);
    if (ack && !ack.exitCode && run === state.generation) {
      try { state.seenNatively.add((JSON.parse(ack.stdout) as { id: string }).id); } catch { /* No ID: nothing to deduplicate. */ }
    }
    return queued;
  });
  on("command.run", async ($, event, next) => {
    if (event.command !== "comms-name") return next(event);
    const name = event.args.trim();
    if (!name) return { text: "Usage: /comms-name <name>" };
    try { return { text: await chooseName($, state, name) }; }
    catch (error) { return { text: error instanceof Error ? error.message : "Naming failed" }; }
  });
  on("tool.call", async ($, event, next) => {
    if (event.tool === `mcp__${$.plugin.name}__${NAME_TOOL.name}`) {
      try { return { result: { success: true, message: await chooseName($, state, String((event as { name?: unknown }).name)) } }; }
      catch (error) { return { deny: error instanceof Error ? error.message : "Naming failed" }; }
    }
    if (event.tool === "SendMessage") return sendMessage($, state, event, next);
    return event.tool === "ListAgents" ? listAgents($, state, event, next) : next(event);
  });
  return { close };
}

export function register(on: ClaudeOn): void {
  registerClaude(on, { binary: "comms", host: "localhost" });
}
