import { formatMessage, messageId, splitLines, VERSION_RANGE, sendSummary, type Agent, type Delivery, type HelloResult, type SendResult, type WirePacket } from "@cross-harness-comms/protocol";
import type { ClaudeAPI, ClaudeOn } from "./api.ts";

// An agent's last activity relative to now, in whole units: `active now`, then minutes, hours, and days (ADR-018).
function activeAgo(agent: Agent, time: number): string {
  const minutes = Math.floor((time - Date.parse(agent.active_at ?? agent.last_seen)) / 60_000);
  if (minutes < 1) return "active now";
  if (minutes < 60) return `active ${minutes}m ago`;
  return minutes < 1440 ? `active ${Math.floor(minutes / 60)}h ago` : `active ${Math.floor(minutes / 1440)}d ago`;
}

interface ClaudeState {
  token: string | undefined;
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

// The generation is the only ownership value. Take the credentials before awaiting, so a newer start keeps its own.
async function closeClaude(state: ClaudeState): Promise<void> {
  state.generation++;
  const { token, disconnect } = state;
  state.token = undefined;
  state.disconnect = undefined;
  await disconnect?.(token);
}

// Claude's validator allows passing $ only to helpers declared at module scope.
async function startClaude($: ClaudeAPI, state: ClaudeState, options: { binary: string; host: string }): Promise<void> {
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
    if (token) await $.process.run([options.binary, "detach"], { stdin: JSON.stringify({ token }) + "\n" }).catch(() => {});
  };
  const sessionId = await $.session.id();
  owned();
  state.sessionId = sessionId;
  if (state.sessionId === previousSession) state.token = previousToken;
  else { pendingReplies.clear(); received.clear(); seenNatively.clear(); sends.clear(); }
  const session = { harness: "claude", session_key: state.sessionId, cwd: await $.session.cwd(), host: options.host };
  // Mods get no CLAUDE_PLUGIN_ROOT; $.plugin.root is the plugin's directory.
  if (options.binary === "comms") options.binary = `${$.plugin.root}/bin/comms`;
  // Claude's inbox socket, which the core writes native peer lines to (ADR-016).
  const inbox = await $.env!.get("CLAUDE_CODE_MESSAGING_SOCKET");
  owned();
  state.nativePeers = !!inbox;
  const claude = inbox ? { inbox, version: (await $.session.version!()).version } : undefined;
  const ensure = await $.process.run([options.binary, "ensure"]);
  if (ensure.exitCode) throw new Error(ensure.stderr || "comms ensure failed");
  owned();
  let resolveReady!: () => void, rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const attach = async () => {
    // A retry or first run that fires after the session changed spawns nothing.
    if (run !== state.generation) { rejectReady(new Error("comms session changed")); return; }
    let initialized = false;
    try {
      const child = $.process.spawn({ argv: [options.binary, "attach"], input: JSON.stringify({ versions: VERSION_RANGE, session, ...(state.token ? { token: state.token } : {}), ...(claude ? { claude } : {}) }) + "\n" });
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
              if (hello.notice) await notice(hello.notice);
              initialized = true;
              resolveReady();
            }
          } else if (packet.method === "session_replaced") {
            state.generation++;
            state.token = undefined;
            await notice("This session connection was replaced by another attachment.");
          } else if (packet.method === "deliver") {
            const delivery = packet.params as Delivery;
            if (seenNatively.has(delivery.message.id)) {
              if (state.token && run === state.generation) await $.process.run([options.binary, "ack"], { stdin: JSON.stringify({ token: state.token, id: delivery.message.id }) + "\n" });
              continue;
            }
            // Record before starting the turn: that turn can immediately reply.
            if (!received.has(delivery.message.id)) {
              received.add(delivery.message.id);
              const pending = pendingReplies.get(delivery.from) ?? [];
              pending.push(delivery.message.id);
              pendingReplies.set(delivery.from, pending);
            }
            const accepted = await $.prompt.submit({ text: formatMessage(delivery, "claude") });
            if (run !== state.generation) return;
            if ("drop" in accepted) {
              received.delete(delivery.message.id);
              const pending = pendingReplies.get(delivery.from);
              const index = pending?.indexOf(delivery.message.id) ?? -1;
              if (index >= 0) pending!.splice(index, 1);
            }
            if ("text" in accepted && state.token) {
              const ack = await $.process.run([options.binary, "ack"], { stdin: JSON.stringify({ token: state.token, id: delivery.message.id }) + "\n" });
              if (ack.exitCode) throw new Error(ack.stderr || "Acknowledgement failed");
            }
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

async function ensureClaude($: ClaudeAPI, state: ClaudeState, options: { binary: string; host: string }): Promise<void> {
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

export function registerClaude(on: ClaudeOn, options: { binary: string; host: string }): { close(): Promise<void> } {
  const state: ClaudeState = { token: undefined, sessionId: undefined, generation: 0, nativePeers: false, connecting: undefined, disconnect: undefined,
    pendingReplies: new Map(), received: new Set(), seenNatively: new Set(), sends: new Map() };
  const { pendingReplies, seenNatively, sends } = state;
  const close = () => closeClaude(state);
  on("session.start", async ($, event, next) => {
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
    const ack = await $.process.run([options.binary, "native-ack"], { stdin: JSON.stringify({ token: state.token, from }) + "\n" }).catch(() => undefined);
    if (ack && !ack.exitCode && run === state.generation) {
      try { seenNatively.add((JSON.parse(ack.stdout) as { id: string }).id); } catch { /* No ID: nothing to deduplicate. */ }
    }
    return queued;
  });
  on("tool.call", async ($, event, next) => {
    const command = async (name: string, params?: unknown): Promise<unknown> => {
      const response = await $.process.run([options.binary, name], params === undefined ? {} : { stdin: JSON.stringify(params) + "\n" });
      if (response.exitCode) throw Object.assign(new Error(response.stderr.trim() || `comms ${name} failed`), { exitCode: response.exitCode });
      const result = JSON.parse(response.stdout) as { notice?: string };
      if (result.notice) {
        try { $.ui!.log(result.notice); } catch { /* Minimal embedding host has no UI. */ }
      }
      return result;
    };
    if (event.tool === "SendMessage") {
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
          const found = await command("resolve", { ...(state.token ? { token: state.token } : {}), name: address, ...(state.nativePeers ? { skip_claude: true } : {}) }) as { agent?: Agent | null };
          agent = found.agent ?? null;
        } catch { /* A failed lookup passes the call through. */ }
        if (!agent) return next(event);
        if (agent.claude_address) return next({ ...event, to: agent.claude_address });
        address = `comms:${agent.name}`;
      }
      if (!address.startsWith("comms:")) return next(event);
      if (!state.token || await $.session.id() !== state.sessionId) return { deny: "comms session is not connected" };
      const run = state.generation;
      // Serialize logical sends to one address, so concurrent replies consume
      // different pending messages. New tool calls still mint distinct IDs.
      const previous = sends.get(address) ?? Promise.resolve();
      const send = previous.catch(() => {}).then(async () => {
        if (run !== state.generation || !state.token) throw new Error("comms session changed");
        const pending = pendingReplies.get(address);
        const reply_to = pending?.at(-1);
        const id = messageId(await $.clock!.now());
        const params = { token: state.token, id, to: address, body: event.message, ...(reply_to ? { reply_to } : {}) };
        let result: SendResult;
        try { result = await command("send", params) as SendResult; }
        catch (error) {
          // A failed subprocess may have committed before losing stdout.
          // Retry once with the same ID, text, credentials, and correlation,
          // unless the core definitely rejected the send (exit 2).
          if ((error as { exitCode?: number }).exitCode === 2) throw error;
          if (run !== state.generation) throw new Error("comms session changed");
          result = await command("send", params) as SendResult;
        }
        if (reply_to && pending) {
          const index = pending.indexOf(reply_to);
          if (index >= 0) pending.splice(index, 1);
        }
        return result;
      });
      sends.set(address, send);
      try {
        const result = await send;
        return { result: { success: true, message: sendSummary(result) } };
      } catch (error) { return { deny: error instanceof Error ? error.message : "Message failed" }; }
      finally { if (sends.get(address) === send) sends.delete(address); }
    }
    if (event.tool !== "ListAgents") return next(event);
    const native = await next(event);
    if ("deny" in native) return native;
    const result = await command("list", state.token ? { token: state.token } : undefined) as { agents: Agent[] };
    const original = native.result as { listing?: unknown };
    if (!original || typeof original.listing !== "string") return native;
    // Native peer messaging lists Claude peers by short refs rather than session IDs,
    // so when it is on, Claude peers stay native and only other harnesses are added.
    const header = /^Peer sessions \((\d+)\):/m;
    const peerSection = header.test(original.listing);
    const shown = result.agents.filter(a => a.harness !== "claude" || (!peerSection && a.session_key !== state.sessionId));
    const time = await $.clock!.now();
    const extra = shown
      // Under the native header, rows match native peers; on the native route, Claude
      // sends to a reply socket with its own SendMessage.
      .map(a => peerSection
        ? `  ${a.name}  ·  ${a.harness}  ·  ${a.online ? "online" : "offline"}  ·  ${activeAgo(a, time)}  ·  ${a.cwd}  ·  send to ${a.claude_address ?? `comms:${a.name}`}`
        : `comms:${a.name} (${a.harness}, ${a.online ? "online" : "offline"}, ${activeAgo(a, time)}, ${a.cwd})`);
    if (!extra.length) return native;
    const listing = original.listing.replace(header, (_, count: string) => `Peer sessions (${Number(count) + extra.length}):`);
    return { result: { ...original, listing: listing + "\n" + extra.join("\n") } };
  });
  return { close };
}

export function register(on: ClaudeOn): void {
  registerClaude(on, { binary: "comms", host: "localhost" });
}
