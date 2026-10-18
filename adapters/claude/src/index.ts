import { formatMessage, VERSION_RANGE, sendSummary, type Agent, type Delivery, type HelloResult, type SendResult, type WirePacket } from "@cross-harness-comms/protocol";
import type { ClaudeOn } from "./api.ts";

// Pure JavaScript plus the mod's documented random source. The timestamp is
// supplied by $.clock.now(), so no Node APIs enter the sandbox bundle.
function messageId(milliseconds: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = Math.floor(milliseconds);
  for (let index = 5; index >= 0; index--) { bytes[index] = timestamp % 256; timestamp = Math.floor(timestamp / 256); }
  bytes[6] = 0x70 | (bytes[6]! & 15);
  bytes[8] = 0x80 | (bytes[8]! & 63);
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// An agent's last activity relative to now, in whole units: `active now`, then minutes, hours, and days (ADR-018).
function activeAgo(agent: Agent, time: number): string {
  const minutes = Math.floor((time - Date.parse(agent.active_at ?? agent.last_seen)) / 60_000);
  if (minutes < 1) return "active now";
  if (minutes < 60) return `active ${minutes}m ago`;
  return minutes < 1440 ? `active ${Math.floor(minutes / 60)}h ago` : `active ${Math.floor(minutes / 1440)}d ago`;
}

export function registerClaude(on: ClaudeOn, options: { binary: string; host: string }): { close(): Promise<void> } {
  let token: string | undefined;
  let sessionId: string | undefined;
  let stopped = false;
  let generation = 0;
  const pendingReplies = new Map<string, string[]>();
  const received = new Set<string>();
  // Messages the native inbox route already delivered, so their fallback copies are only acknowledged.
  const seenNatively = new Set<string>();
  // Whether Claude's own peer messaging is on, which this session shows by reporting an inbox socket
  // at start; bare names of Claude agents are then left to it.
  let nativePeers = false;
  const sends = new Map<string, Promise<unknown>>();
  let disconnect: (() => Promise<void>) | undefined;
  const close = async () => {
    stopped = true;
    generation++;
    await disconnect?.();
    disconnect = undefined;
    token = undefined;
  };
  on("session.start", async ($, event, next) => {
    const previousSession = sessionId, previousToken = token;
    await close();
    stopped = false;
    const notice = async (text: string) => {
      try { $.ui!.log(text); }
      catch { await $.prompt.submit({ text }); }
    };
    disconnect = async () => {
      if (token) await $.process.run([options.binary, "detach"], { stdin: JSON.stringify({ token }) + "\n" }).catch(() => {});
    };
    const run = generation;
    sessionId = await $.session.id();
    if (sessionId === previousSession) token = previousToken;
    else { pendingReplies.clear(); received.clear(); seenNatively.clear(); sends.clear(); }
    const session = { harness: "claude", session_key: sessionId, cwd: await $.session.cwd(), host: options.host };
    // Mods get no CLAUDE_PLUGIN_ROOT; $.plugin.root is the plugin's directory.
    if (options.binary === "comms") options.binary = `${$.plugin.root}/bin/comms`;
    // Claude's inbox socket, which the core writes native peer lines to (ADR-016).
    const inbox = await $.env!.get("CLAUDE_CODE_MESSAGING_SOCKET");
    nativePeers = !!inbox;
    const claude = inbox ? { inbox, version: (await $.session.version!()).version } : undefined;
    const ensure = await $.process.run([options.binary, "ensure"]);
    if (ensure.exitCode) throw new Error(ensure.stderr || "comms ensure failed");
    let resolveReady!: () => void, rejectReady!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const attach = async () => {
      let initialized = false;
      try {
        const child = $.process.spawn({ argv: [options.binary, "attach"], input: JSON.stringify({ versions: VERSION_RANGE, session, ...(token ? { token } : {}), ...(claude ? { claude } : {}) }) + "\n" });
        let buffer = "";
        for await (const chunk of child) {
          if (stopped || run !== generation) break;
          if (chunk.stream === "stderr") { await notice(chunk.text); continue; }
          buffer += chunk.text;
          let end: number;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const packet = JSON.parse(buffer.slice(0, end)) as WirePacket;
            buffer = buffer.slice(end + 1);
            if ("error" in packet) throw new Error(packet.error.message);
            if ("result" in packet) {
              const hello = packet.result as HelloResult;
              if (hello.token) {
                token = hello.token;
                if (hello.notice) await notice(hello.notice);
                initialized = true;
                resolveReady();
              }
            } else if (packet.method === "session_replaced") {
              stopped = true;
              token = undefined;
              await notice("This session connection was replaced by another attachment.");
            } else if (packet.method === "deliver") {
              const delivery = packet.params as Delivery;
              if (seenNatively.has(delivery.message.id)) {
                if (token && !stopped) await $.process.run([options.binary, "ack"], { stdin: JSON.stringify({ token, id: delivery.message.id }) + "\n" });
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
              if (stopped || run !== generation) return;
              if ("drop" in accepted) {
                received.delete(delivery.message.id);
                const pending = pendingReplies.get(delivery.from);
                const index = pending?.indexOf(delivery.message.id) ?? -1;
                if (index >= 0) pending!.splice(index, 1);
              }
              if ("text" in accepted && token && !stopped) {
                const ack = await $.process.run([options.binary, "ack"], { stdin: JSON.stringify({ token, id: delivery.message.id }) + "\n" });
                if (ack.exitCode) throw new Error(ack.stderr || "Acknowledgement failed");
              }
            }
          }
        }
        if (!initialized) throw new Error("comms attach ended before registration");
      } catch (error) {
        rejectReady(error);
        if (initialized && !stopped) await notice(error instanceof Error ? error.message : "comms attach failed");
      } finally {
        if (!stopped && run === generation) {
          try { $.clock!.after(250, attach); } catch { /* The embedding host owns restart. */ }
        }
      }
    };
    // The real host supplies clock so background work survives the start event.
    // Minimal embedders may run the asynchronous stream directly.
    try { $.clock!.after(0, attach); } catch { void attach(); }
    await ready;
    return next(event);
  });
  on("session.receive", async ($, event, next) => {
    const queued = await next(event);
    const origin = event.origin as { kind: string; plugin?: string };
    if (origin.kind !== "peer" || origin.plugin !== "cross-harness-comms" || queued.consumed !== undefined || !token) return queued;
    // The element's `from` is the reply socket the core wrote from; ACK it so the core sends the next line.
    const from = /^<cross-session-message from="([^"]*)"/.exec(event.text)?.[1];
    if (!from) return queued;
    const ack = await $.process.run([options.binary, "native-ack"], { stdin: JSON.stringify({ token, from }) + "\n" }).catch(() => undefined);
    if (ack && !ack.exitCode) {
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
      let address = event.to;
      if (!address.startsWith("comms:") && !address.startsWith("uds:")) {
        // A bare name is looked up in the core on every call, so names the user typed or a message
        // carried work before any ListAgents and follow renames. Anything the core cannot answer
        // stays Claude's: native subagents, teammates, and peers are never broken by comms.
        let agent: Agent | null = null;
        try {
          const found = await command("resolve", { ...(token ? { token } : {}), name: address, ...(nativePeers ? { skip_claude: true } : {}) }) as { agent?: Agent | null };
          agent = found.agent ?? null;
        } catch { /* A failed lookup passes the call through. */ }
        if (!agent) return next(event);
        if (agent.claude_address) return next({ ...event, to: agent.claude_address });
        address = `comms:${agent.name}`;
      }
      if (!address.startsWith("comms:")) return next(event);
      if (!token || await $.session.id() !== sessionId) return { deny: "comms session is not connected" };
      const run = generation;
      // Serialize logical sends to one address, so concurrent replies consume
      // different pending messages. New tool calls still mint distinct IDs.
      const previous = sends.get(address) ?? Promise.resolve();
      const send = previous.catch(() => {}).then(async () => {
        if (stopped || run !== generation || !token) throw new Error("comms session changed");
        const pending = pendingReplies.get(address);
        const reply_to = pending?.at(-1);
        const id = messageId(await $.clock!.now());
        const params = { token, id, to: address, body: event.message, ...(reply_to ? { reply_to } : {}) };
        let result: SendResult;
        try { result = await command("send", params) as SendResult; }
        catch (error) {
          // A failed subprocess may have committed before losing stdout.
          // Retry once with the same ID, text, credentials, and correlation,
          // unless the core definitely rejected the send (exit 2).
          if ((error as { exitCode?: number }).exitCode === 2) throw error;
          if (stopped || run !== generation) throw new Error("comms session changed");
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
    const result = await command("list", token ? { token } : undefined) as { agents: Agent[] };
    const original = native.result as { listing?: unknown };
    if (!original || typeof original.listing !== "string") return native;
    // Native peer messaging lists Claude peers by short refs rather than session IDs,
    // so when it is on, Claude peers stay native and only other harnesses are added.
    const header = /^Peer sessions \((\d+)\):/m;
    const peerSection = header.test(original.listing);
    const shown = result.agents.filter(a => a.harness !== "claude" || (!peerSection && a.session_key !== sessionId));
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
