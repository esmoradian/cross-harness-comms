// packages/protocol/src/index.ts
function formatMessage(delivery, receiver) {
  const { message, from } = delivery;
  const hint = receiver === "codex" ? `Reply with comms_send to ${from} with reply_to ${message.id}.` : `Reply with SendMessage to ${from}.`;
  const replies = message.reply_to ? ` This replies to ${message.reply_to}.` : "";
  return `Message from @${addressName(from)} (another agent, through comms):
${message.body}

${hint}${replies}`;
}
var MAX_LINE_BYTES = 1024 * 1024;
var VERSION_RANGE = { min: 1, max: 1 };
function sendSummary(result) {
  const name = result.name ?? result.id;
  return result.online ?? result.state !== "queued" ? `Sent to ${name}.` : `Queued for ${name}, which is offline; it gets the message when it reconnects.`;
}
var COMMS_TOOLS = [
  { name: "comms_send", description: "Send a message to a comms address. Reply with reply_to set to the message ID.", inputSchema: {
    type: "object",
    properties: {
      to: { type: "string", description: "Recipient name, ID, or comms:<name>" },
      text: { type: "string" },
      reply_to: { type: "string" }
    },
    required: ["to", "text"],
    additionalProperties: false
  } },
  { name: "comms_list", description: "List cross-harness agents and their presence.", inputSchema: {
    type: "object",
    properties: { all: { type: "boolean", description: "Also list agents offline for more than a day" } }
  } },
  { name: "comms_name", description: "Choose this session's comms name, which other agents send to as comms:<name>.", inputSchema: {
    type: "object",
    properties: { name: { type: "string", description: "1-64 lowercase letters, digits, dots, underscores, hyphens, or slashes, not starting or ending with a slash" } },
    required: ["name"],
    additionalProperties: false
  } }
];
function activeAgo(agent, time) {
  const minutes = Math.floor((time - Date.parse(agent.active_at ?? agent.last_seen)) / 60000);
  if (minutes < 1)
    return "last active now";
  if (minutes < 60)
    return `last active ${minutes}m ago`;
  return minutes < 1440 ? `last active ${Math.floor(minutes / 60)}h ago` : `last active ${Math.floor(minutes / 1440)}d ago`;
}
var hiddenLine = (hidden) => `${hidden} offline agent${hidden === 1 ? "" : "s"} not shown`;
var addressName = (address) => address.replace(/^comms:/, "");
function messageId(milliseconds) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = Math.floor(milliseconds);
  for (let index = 5;index >= 0; index--) {
    bytes[index] = timestamp % 256;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = 112 | bytes[6] & 15;
  bytes[8] = 128 | bytes[8] & 63;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function splitLines(buffer) {
  const lines = buffer.split(`
`);
  return { lines, rest: lines.pop() };
}

// adapters/claude/src/index.ts
function comms($, state, name, params) {
  return $.process.run([state.binary, ...[name].flat()], params === undefined ? {} : { stdin: JSON.stringify(params) + `
` });
}
async function command($, state, name, params) {
  const response = await comms($, state, name, params);
  if (response.exitCode)
    throw Object.assign(new Error(response.stderr.trim() || `comms ${[name].flat()[0]} failed`), { exitCode: response.exitCode });
  const result = JSON.parse(response.stdout);
  if (result.notice) {
    try {
      $.ui.log(result.notice);
    } catch {}
  }
  return result;
}
function remove(ids, id) {
  const index = ids?.indexOf(id) ?? -1;
  if (index >= 0)
    ids.splice(index, 1);
}
function expectReply(state, delivery) {
  if (state.received.has(delivery.message.id))
    return;
  state.received.add(delivery.message.id);
  const pending = state.pendingReplies.get(delivery.from) ?? [];
  pending.push(delivery.message.id);
  state.pendingReplies.set(delivery.from, pending);
}
async function closeClaude(state) {
  state.generation++;
  const { token, disconnect } = state;
  state.token = undefined;
  state.disconnect = undefined;
  await disconnect?.(token);
}
async function deliver($, state, run, delivery) {
  if (state.seenNatively.has(delivery.message.id)) {
    if (state.token && run === state.generation)
      await comms($, state, "ack", { token: state.token, id: delivery.message.id });
    return true;
  }
  expectReply(state, delivery);
  const accepted = await $.prompt.submit({ text: formatMessage(delivery, "claude") });
  if (run !== state.generation)
    return false;
  if ("drop" in accepted) {
    state.received.delete(delivery.message.id);
    remove(state.pendingReplies.get(delivery.from), delivery.message.id);
  }
  if ("text" in accepted && state.token) {
    const ack = await comms($, state, "ack", { token: state.token, id: delivery.message.id });
    if (ack.exitCode)
      throw new Error(ack.stderr || "Acknowledgement failed");
  }
  return true;
}
async function startClaude($, state, options) {
  const { pendingReplies, received, seenNatively, sends } = state;
  const { sessionId: previousSession, token: previousToken } = state;
  const closing = closeClaude(state);
  const run = state.generation;
  const owned = () => {
    if (run !== state.generation)
      throw new Error("comms session changed");
  };
  await closing;
  owned();
  const notice = async (text) => {
    try {
      $.ui.log(text);
    } catch {
      await $.prompt.submit({ text });
    }
  };
  state.disconnect = async (token) => {
    if (token)
      await comms($, state, "detach", { token }).catch(() => {});
  };
  const sessionId = await $.session.id();
  owned();
  state.sessionId = sessionId;
  if (state.sessionId === previousSession)
    state.token = previousToken;
  else {
    pendingReplies.clear();
    received.clear();
    seenNatively.clear();
    sends.clear();
  }
  const session = { harness: "claude", session_key: state.sessionId, cwd: await $.session.cwd(), host: options.host };
  if (state.binary === "comms")
    state.binary = `${$.plugin.root}/bin/comms`;
  const inbox = await $.env.get("CLAUDE_CODE_MESSAGING_SOCKET");
  owned();
  state.nativePeers = !!inbox;
  const claude = inbox ? { inbox, version: (await $.session.version()).version } : undefined;
  const ensure = await $.process.run([state.binary, "ensure"]);
  if (ensure.exitCode)
    throw new Error(ensure.stderr || "comms ensure failed");
  owned();
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const replaces = state.sessionId !== previousSession ? state.lastToken : undefined;
  const attach = async () => {
    if (run !== state.generation) {
      rejectReady(new Error("comms session changed"));
      return;
    }
    let initialized = false;
    try {
      const child = $.process.spawn({ argv: [state.binary, "attach"], input: JSON.stringify({ versions: VERSION_RANGE, session, ...state.token ? { token: state.token } : {}, ...replaces ? { replaces } : {}, ...claude ? { claude } : {} }) + `
` });
      let buffer = "";
      for await (const chunk of child) {
        if (run !== state.generation)
          break;
        if (chunk.stream === "stderr") {
          await notice(chunk.text);
          continue;
        }
        const { lines, rest } = splitLines(buffer + chunk.text);
        buffer = rest;
        for (const line of lines) {
          if (run !== state.generation)
            break;
          const packet = JSON.parse(line);
          if ("error" in packet)
            throw new Error(packet.error.message);
          if ("result" in packet) {
            const hello = packet.result;
            if (hello.token) {
              state.token = hello.token;
              state.lastToken = hello.token;
              if (hello.notice)
                await notice(hello.notice);
              initialized = true;
              resolveReady();
            }
          } else if (packet.method === "session_replaced") {
            state.generation++;
            state.token = undefined;
            await notice("This session connection was replaced by another attachment.");
          } else if (packet.method === "deliver") {
            if (!await deliver($, state, run, packet.params))
              return;
          }
        }
      }
      if (!initialized)
        throw new Error(run === state.generation ? "comms attach ended before registration" : "comms session changed");
    } catch (error) {
      rejectReady(error);
      if (initialized && run === state.generation)
        await notice(error instanceof Error ? error.message : "comms attach failed");
    } finally {
      if (run === state.generation) {
        try {
          $.clock.after(250, attach);
        } catch {}
      }
    }
  };
  try {
    $.clock.after(0, attach);
  } catch {
    attach();
  }
  await ready;
}
async function ensureClaude($, state, options) {
  for (;; ) {
    const id = await $.session.id();
    if (!state.connecting) {
      if (state.token && state.sessionId === id)
        return;
      break;
    }
    await state.connecting.catch(() => {});
  }
  const connecting = startClaude($, state, options);
  state.connecting = connecting;
  try {
    await connecting;
  } finally {
    if (state.connecting === connecting)
      state.connecting = undefined;
  }
}
function named(native, address, name) {
  const result = "result" in native ? native.result : null;
  if (result?.success !== true || typeof result.display !== "string")
    return native;
  return { result: { ...result, display: result.display.split(address).join(name), message: `Submitted to ${name} through comms.` } };
}
async function replyName($, state, address) {
  if (!/\/9\d{9}\.sock$/.test(address))
    return;
  try {
    const { agents } = await command($, state, "list", state.token ? { token: state.token } : undefined);
    return agents.find((agent) => agent.claude_address === address)?.name;
  } catch {
    return;
  }
}
async function sendMessage($, state, event, next) {
  if (typeof event.to !== "string")
    return next(event);
  if (event.agentId) {
    const listed = await $.agent.list().then((agents) => agents.some((agent) => agent.id === event.agentId)).catch(() => false);
    if (!listed)
      return next(event);
  }
  let address = event.to;
  if (!address.startsWith("comms:") && !address.startsWith("uds:")) {
    let agent = null;
    try {
      const found = await command($, state, "resolve", { ...state.token ? { token: state.token } : {}, name: address, ...state.nativePeers ? { skip_claude: true } : {} });
      agent = found.agent ?? null;
    } catch {}
    if (!agent)
      return next(event);
    if (agent.claude_address)
      return named(await next({ ...event, to: agent.claude_address }), agent.claude_address, agent.name);
    address = `comms:${agent.name}`;
  }
  if (!address.startsWith("comms:")) {
    const native = await next(event);
    const name = await replyName($, state, address);
    return name ? named(native, address, name) : native;
  }
  if (!state.token || await $.session.id() !== state.sessionId)
    return { deny: "comms session is not connected" };
  const run = state.generation;
  const previous = state.sends.get(address) ?? Promise.resolve();
  const send = previous.catch(() => {}).then(async () => {
    if (run !== state.generation || !state.token)
      throw new Error("comms session changed");
    const pending = state.pendingReplies.get(address);
    const reply_to = pending?.at(-1);
    const id = messageId(await $.clock.now());
    const params = { token: state.token, id, to: address, body: event.message, ...reply_to ? { reply_to } : {} };
    let result;
    try {
      result = await command($, state, "send", params);
    } catch (error) {
      if (error.exitCode === 2)
        throw error;
      if (run !== state.generation)
        throw new Error("comms session changed");
      result = await command($, state, "send", params);
    }
    if (reply_to)
      remove(pending, reply_to);
    return result;
  });
  state.sends.set(address, send);
  try {
    const result = await send;
    return { result: { success: true, message: sendSummary(result) } };
  } catch (error) {
    return { deny: error instanceof Error ? error.message : "Message failed" };
  } finally {
    if (state.sends.get(address) === send)
      state.sends.delete(address);
  }
}
async function listAgents($, state, event, next) {
  const native = await next(event);
  if ("deny" in native)
    return native;
  const result = await command($, state, "list", { ...state.token ? { token: state.token } : {}, include_stale: false });
  const original = native.result;
  if (!original || typeof original.listing !== "string")
    return native;
  const header = /^Peer sessions \((\d+)\):/m;
  const peerSection = header.test(original.listing);
  const shown = result.agents.filter((a) => a.harness !== "claude" || !peerSection && a.session_key !== state.sessionId);
  const time = await $.clock.now();
  const hidden = (result.hidden ?? 0) - (peerSection ? result.hidden_claude ?? 0 : 0);
  const extra = shown.map((a) => peerSection ? `  ${a.name}  ·  ${a.harness}  ·  ${a.presence}  ·  ${activeAgo(a, time)}  ·  ${a.cwd}  ·  send to ${a.claude_address ?? `comms:${a.name}`}` : `comms:${a.name} (${a.harness}, ${a.presence}, ${activeAgo(a, time)}, ${a.cwd})`);
  if (!extra.length && !hidden)
    return native;
  const listing = original.listing.replace(header, (_, count) => `Peer sessions (${Number(count) + extra.length}):`);
  return { result: { ...original, listing: [listing, ...extra, ...hidden ? [hiddenLine(hidden)] : []].join(`
`) } };
}
async function chooseName($, state, name) {
  if (!state.token || await $.session.id() !== state.sessionId)
    throw new Error("comms session is not connected");
  const agent = await command($, state, ["name", name], { token: state.token });
  return `This session is now comms:${agent.name}.`;
}
var NAME_TOOL = COMMS_TOOLS.find((tool) => tool.name === "comms_name");
function registerClaude(on, options) {
  const state = {
    binary: options.binary,
    token: undefined,
    lastToken: undefined,
    sessionId: undefined,
    generation: 0,
    nativePeers: false,
    connecting: undefined,
    disconnect: undefined,
    pendingReplies: new Map,
    received: new Set,
    seenNatively: new Set,
    sends: new Map
  };
  const close = () => closeClaude(state);
  on("session.start", async ($, event, next) => {
    try {
      await $.command.register({ name: "comms-name", description: "Choose this session's comms name", argumentHint: "<name>" });
      await $.tool.register({ name: NAME_TOOL.name, description: NAME_TOOL.description, inputSchema: NAME_TOOL.inputSchema });
    } catch {}
    await ensureClaude($, state, options);
    return next(event);
  });
  on("session.end", async (_$, event, next) => {
    await close();
    return next(event);
  });
  on("classic.SessionStart", async ($, event, next) => {
    await ensureClaude($, state, options);
    return next(event);
  });
  on("session.receive", async ($, event, next) => {
    const run = state.generation;
    const queued = await next(event);
    const origin = event.origin;
    if (origin.kind !== "peer" || origin.plugin !== "cross-harness-comms" || queued.consumed !== undefined || !state.token || run !== state.generation)
      return queued;
    const from = /^<cross-session-message from="([^"]*)"/.exec(event.text)?.[1];
    if (!from)
      return queued;
    const ack = await comms($, state, "native-ack", { token: state.token, from }).catch(() => {
      return;
    });
    if (ack && !ack.exitCode && run === state.generation) {
      try {
        state.seenNatively.add(JSON.parse(ack.stdout).id);
      } catch {}
    }
    return queued;
  });
  on("command.run", async ($, event, next) => {
    if (event.command !== "comms-name")
      return next(event);
    const name = event.args.trim();
    if (!name)
      return { text: "Usage: /comms-name <name>" };
    try {
      return { text: await chooseName($, state, name) };
    } catch (error) {
      return { text: error instanceof Error ? error.message : "Naming failed" };
    }
  });
  on("tool.call", async ($, event, next) => {
    if (event.tool === `mcp__${$.plugin.name}__${NAME_TOOL.name}`) {
      try {
        return { result: await chooseName($, state, String(event.name)) };
      } catch (error) {
        return { deny: error instanceof Error ? error.message : "Naming failed" };
      }
    }
    if (event.tool === "SendMessage")
      return sendMessage($, state, event, next);
    return event.tool === "ListAgents" ? listAgents($, state, event, next) : next(event);
  });
  return { close };
}
function register(on) {
  registerClaude(on, { binary: "comms", host: "localhost" });
}
export {
  registerClaude,
  register
};
