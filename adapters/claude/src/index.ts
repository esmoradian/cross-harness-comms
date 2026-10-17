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

export function registerClaude(on: ClaudeOn, options: { binary: string; host: string }): { close(): Promise<void> } {
  let token: string | undefined;
  let sessionId: string | undefined;
  let stopped = false;
  let generation = 0;
  const pendingReplies = new Map<string, string[]>();
  const received = new Set<string>();
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
    else { pendingReplies.clear(); received.clear(); sends.clear(); }
    const session = { harness: "claude", session_key: sessionId, cwd: await $.session.cwd(), host: options.host };
    if (options.binary === "comms") {
      try {
        const root = await $.env!.get("CLAUDE_PLUGIN_ROOT");
        if (root) options.binary = root + "/bin/comms";
      } catch { /* Embedded callers can pass an explicit binary. */ }
    }
    const ensure = await $.process.run([options.binary, "ensure"]);
    if (ensure.exitCode) throw new Error(ensure.stderr || "comms ensure failed");
    let resolveReady!: () => void, rejectReady!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const attach = async () => {
      let initialized = false;
      try {
        const child = $.process.spawn({ argv: [options.binary, "attach"], input: JSON.stringify({ versions: VERSION_RANGE, session, ...(token ? { token } : {}) }) + "\n" });
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
              // Record before starting the turn: that turn can immediately reply.
              if (!received.has(delivery.message.id)) {
                received.add(delivery.message.id);
                const pending = pendingReplies.get(delivery.from) ?? [];
                pending.push(delivery.message.id);
                pendingReplies.set(delivery.from, pending);
              }
              const accepted = await $.prompt.submit({ text: formatMessage(delivery) });
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
  on("tool.call", async ($, event, next) => {
    const command = async (name: string, params?: unknown): Promise<unknown> => {
      const response = await $.process.run([options.binary, name], params === undefined ? {} : { stdin: JSON.stringify(params) + "\n" });
      if (response.exitCode) throw new Error(response.stderr.trim() || `comms ${name} failed`);
      const result = JSON.parse(response.stdout) as { notice?: string };
      if (result.notice) {
        try { $.ui!.log(result.notice); } catch { /* Minimal embedding host has no UI. */ }
      }
      return result;
    };
    if (event.tool === "SendMessage") {
      if (typeof event.to !== "string" || !event.to.startsWith("comms:")) return next(event);
      if (!token || await $.session.id() !== sessionId) return { deny: "comms session is not connected" };
      const address = event.to;
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
        catch {
          // A failed subprocess may have committed before losing stdout.
          // Retry once with the same ID, text, credentials, and correlation.
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
    const result = await command("list") as { agents: Agent[] };
    // Deduplicate only when a native entry actually exposes the exact session ID.
    const original = native.result as { listing?: unknown };
    if (!original || typeof original.listing !== "string") return native;
    const listing = original.listing;
    const extra = result.agents.filter(a => a.session_key !== sessionId || a.harness !== "claude")
      .filter(a => a.harness !== "claude" || !listing.includes(a.session_key))
      .map(a => `comms:${a.name} (${a.harness}, ${a.online ? "online" : "offline"}, ${a.cwd})`);
    if (!extra.length) return native;
    return { result: { ...original, listing: original.listing + "\n" + extra.join("\n") } };
  });
  return { close };
}

export function register(on: ClaudeOn): void {
  registerClaude(on, { binary: "comms", host: "localhost" });
}
