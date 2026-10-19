// adapters/pi/src/index.ts
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// packages/protocol/src/index.ts
function resolveAddress(address, agents) {
  const scheme = /^([^:]*):/.exec(address)?.[1];
  if (scheme !== undefined && scheme !== "comms")
    throw failure("UNKNOWN_RECIPIENT", `No agent at ${address}`);
  const key = scheme === undefined ? address : address.slice(6), normal = normalizeName(key);
  const found = agents.find((agent) => agent.name === key) ?? agents.find((agent) => agent.id === key);
  if (found)
    return found;
  const sessions = agents.filter((agent) => agent.session_key === key);
  if (sessions.length > 1)
    throw failure("AMBIGUOUS_RECIPIENT");
  const named = sessions[0] ?? agents.find((agent) => agent.name === normal);
  if (named)
    return named;
  const matches = key.length >= 8 && /^[0-9a-f-]+$/.test(key) ? agents.filter((agent) => agent.id.startsWith(key)) : [];
  if (matches.length > 1)
    throw failure("AMBIGUOUS_RECIPIENT");
  if (!matches[0])
    throw failure("UNKNOWN_RECIPIENT", `No agent named ${key}`);
  return matches[0];
}
function normalizeName(text) {
  const trim = (value) => value.replace(/^[-/]+|[-/]+$/g, "");
  return trim(trim(text.toLowerCase().replace(/[^a-z0-9._/-]+/g, "-")).slice(0, 64)) || undefined;
}
var MAX_LINE_BYTES = 1024 * 1024;
var VERSION_RANGE = { min: 1, max: 1 };
function failure(code, message = code, rpcCode = -32000) {
  return Object.assign(new Error(message), { code: rpcCode, data: { code } });
}
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

// packages/client/src/wire.ts
function readPackets(stream, receive, invalid) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf(`
`)) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
        invalid(failure("INVALID_MESSAGE", "Protocol line exceeds 1 MB"));
        stream.destroy();
        return;
      }
      try {
        receive(JSON.parse(line));
      } catch (error) {
        invalid(error instanceof Error ? error : new Error("Invalid packet"));
      }
    }
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
      invalid(failure("INVALID_MESSAGE", "Protocol line exceeds 1 MB"));
      stream.destroy();
    }
  });
}
function writePacket(stream, packet) {
  const line = JSON.stringify(packet);
  if (Buffer.byteLength(line) > MAX_LINE_BYTES)
    throw failure("INVALID_MESSAGE", "Protocol line exceeds 1 MB");
  if (stream.destroyed || stream.writableEnded)
    throw failure("DISCONNECTED");
  stream.write(line + `
`);
}

// packages/client/src/index.ts
function createClient(stream, notification) {
  let sequence = 0, ended = false;
  const pending = new Map;
  const queue = [];
  const waiters = [];
  const finish = () => {
    if (ended)
      return;
    ended = true;
    queue.length = 0;
    for (const request2 of pending.values())
      request2.reject(failure("DISCONNECTED"));
    pending.clear();
    for (const waiter of waiters.splice(0))
      waiter({ done: true, value: undefined });
  };
  stream.on("end", finish);
  stream.on("close", finish);
  stream.on("error", finish);
  readPackets(stream, (packet) => {
    if ("method" in packet) {
      if (packet.method === "ping" && packet.id !== undefined) {
        writePacket(stream, { jsonrpc: "2.0", id: packet.id, result: {} });
        return;
      }
      notification?.(packet.method, packet.params);
      if (packet.method === "deliver") {
        const value = packet.params;
        const waiter = waiters.shift();
        if (waiter)
          waiter({ done: false, value });
        else
          queue.push(value);
      }
    } else if (typeof packet.id === "number") {
      const request2 = pending.get(packet.id);
      pending.delete(packet.id);
      if ("error" in packet)
        request2?.reject(Object.assign(new Error(packet.error.message), packet.error));
      else
        request2?.resolve(packet.result);
    }
  }, () => stream.destroy());
  const request = (method, params) => new Promise((resolve, reject) => {
    if (ended) {
      reject(failure("DISCONNECTED"));
      return;
    }
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    try {
      writePacket(stream, { jsonrpc: "2.0", id, method, params });
    } catch (error) {
      pending.delete(id);
      reject(error);
    }
  });
  return {
    hello: (params) => request("hello", params),
    request,
    deliveries: { [Symbol.asyncIterator]() {
      return { next() {
        if (queue.length)
          return Promise.resolve({ done: false, value: queue.shift() });
        if (ended)
          return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => waiters.push(resolve));
      } };
    } },
    async close() {
      finish();
      stream.destroy();
    }
  };
}
async function retryDisconnected(connection, call, drop) {
  for (let attempt = 0;; attempt++) {
    const current = await connection();
    try {
      return await call(current);
    } catch (error) {
      if (attempt || error.data?.code !== "DISCONNECTED")
        throw error;
      await drop(current);
    }
  }
}
async function connectSession(runtime, session, accept) {
  let stopped = false;
  let heldToken;
  let current;
  let connecting;
  let retry;
  const connect = () => {
    if (stopped || current)
      return Promise.resolve();
    return connecting ??= (async () => {
      const client = createClient(await runtime.connect(await runtime.ensure()), (method) => {
        if (method === "session_replaced") {
          stopped = true;
          clearTimeout(retry);
          runtime.notice("This session connection was replaced by another attachment.");
        }
      });
      try {
        const hello = await client.hello({ versions: VERSION_RANGE, session, ...heldToken ? { token: heldToken } : {} });
        if (!hello.token)
          throw failure("INVALID_TOKEN");
        heldToken = hello.token;
        if (hello.notice)
          runtime.notice(hello.notice);
        if (stopped) {
          await client.close();
          return;
        }
        const connection = { client, token: hello.token };
        current = connection;
        (async () => {
          try {
            for await (const delivery of client.deliveries) {
              if (stopped)
                break;
              await accept(delivery);
              await client.request("ack", { token: connection.token, id: delivery.message.id });
            }
          } catch (error) {
            if (!stopped)
              runtime.notice(error instanceof Error ? error.message : "Delivery failed");
          } finally {
            if (current === connection)
              current = undefined;
            await client.close();
            if (!stopped)
              schedule();
          }
        })();
      } catch (error) {
        await client.close();
        throw error;
      }
    })().finally(() => {
      connecting = undefined;
    });
  };
  const schedule = () => {
    if (stopped || retry || current)
      return;
    retry = setTimeout(() => {
      retry = undefined;
      connect().catch(() => schedule());
    }, 100);
    retry.unref?.();
  };
  const ready = async () => {
    if (stopped)
      throw failure("DISCONNECTED");
    if (!current)
      await connect();
    if (!current)
      throw failure("DISCONNECTED");
    return current;
  };
  await connect();
  return {
    send: (params) => retryDisconnected(ready, async (connection) => {
      const result = await connection.client.request("send", { ...params, token: connection.token });
      if (result.notice)
        runtime.notice(result.notice);
      return result;
    }, async (connection) => {
      if (current === connection)
        current = undefined;
      await connection.client.close();
    }),
    async list(params = {}) {
      const result = await (await ready()).client.request("list", params);
      if (result.notice)
        runtime.notice(result.notice);
      return result;
    },
    async name(name) {
      const connection = await ready();
      return connection.client.request("name", { token: connection.token, name });
    },
    async close() {
      stopped = true;
      clearTimeout(retry);
      await current?.client.close();
      await connecting?.catch(() => {});
    }
  };
}

// packages/client/src/runtime.ts
import { connect } from "node:net";
import { hostname } from "node:os";
import { spawn } from "node:child_process";
async function runProcess(argv, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (text) => {
      stdout += text;
    });
    child.stderr.setEncoding("utf8").on("data", (text) => {
      stderr += text;
    });
    child.on("error", reject);
    child.stdin.on("error", () => {});
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });
}
function localRuntime(binary = "comms") {
  return {
    host: hostname(),
    notice: (text) => process.stderr.write(text + `
`),
    async ensure() {
      const result = await runProcess([binary, "ensure"]);
      if (result.exitCode)
        throw new Error(result.stderr.trim() || "comms ensure failed");
      return result.stdout.trim();
    },
    connect: (address) => new Promise((resolve, reject) => {
      const socket = connect(address);
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.off("error", reject);
        resolve(socket);
      });
    })
  };
}

// adapters/pi/src/card.ts
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

class CommsCard {
  details;
  theme;
  collapsed;
  constructor(details, theme, collapsed) {
    this.details = details;
    this.theme = theme;
    this.collapsed = collapsed;
  }
  invalidate() {}
  render(width) {
    const { name, harness, cwd, body, reply_to } = this.details;
    const theme = this.theme;
    if (width < 3)
      return [truncateToWidth(`From ${name}`, width)];
    const inner = width - 2;
    const title = truncateToWidth(` From: ${name} (${harness} · ${cwd}) `, inner, "");
    const frame = (content) => {
      const text = truncateToWidth(content, inner, "");
      return theme.fg("muted", "│") + text + theme.fg("muted", `${" ".repeat(Math.max(0, inner - visibleWidth(text)))}│`);
    };
    const lines = [theme.fg("muted", "╭") + theme.fg("toolTitle", title) + theme.fg("muted", `${"─".repeat(Math.max(0, inner - visibleWidth(title)))}╮`)];
    const hint = `To reply: comms_send to comms:${name}`;
    const replyTo = reply_to ? `Reply to ${reply_to.slice(0, 8)}` : undefined;
    if (this.collapsed) {
      lines.push(frame(theme.fg("text", ` ${body.replace(/\s+/g, " ").trim()}`)));
      lines.push(frame(theme.fg("dim", ` ${[hint, ...replyTo ? [replyTo] : [], "Ctrl+O to expand"].join(" · ")}`)));
    } else {
      for (const line of wrapTextWithAnsi(body, Math.max(1, inner - 1)))
        lines.push(frame(theme.fg("text", ` ${line}`)));
      lines.push(frame(""));
      for (const line of wrapTextWithAnsi(theme.fg("dim", ` ${hint}`), inner))
        lines.push(frame(line));
      if (replyTo)
        lines.push(frame(""), frame(theme.fg("dim", ` ${replyTo}`)));
    }
    lines.push(theme.fg("muted", `╰${"─".repeat(inner)}╯`));
    return lines;
  }
}
function renderCommsMessage(details, expanded, theme) {
  if (!details || typeof details !== "object" || Array.isArray(details))
    return;
  const fields = details;
  if (["name", "harness", "cwd", "body"].some((key) => typeof fields[key] !== "string"))
    return;
  if (fields.reply_to !== undefined && typeof fields.reply_to !== "string")
    return;
  return new CommsCard(fields, theme, !expanded);
}

// adapters/pi/src/index.ts
var OUTBOX_REQUEST = "comms:outbox-request";
var OUTBOX_RESULT = "comms:outbox-result";
function registerPi(pi, runtime) {
  let session;
  let nativeId;
  const close = async () => {
    const previous = session;
    session = undefined;
    nativeId = undefined;
    await previous?.close();
  };
  pi.on("session_start", async (_event, ctx) => {
    await close();
    nativeId = ctx.sessionManager.getSessionId();
    session = await connectSession(runtime, { harness: "pi", session_key: nativeId, host: runtime.host, cwd: ctx.cwd }, async (delivery) => {
      const { message, from, harness } = delivery;
      const name = addressName(from), cwd = delivery.cwd ?? "";
      const details = { from, name, harness, cwd, id: message.id, ...message.reply_to ? { reply_to: message.reply_to } : {}, body: message.body };
      const replies = message.reply_to ? ` This replies to \`${message.reply_to}\`.` : "";
      const content = `**From ${name}** (${harness} · ${cwd})
Reply with comms_send to \`${from}\` with reply_to \`${message.id}\`.${replies}

${message.body}`;
      pi.sendMessage({ customType: "comms_message", content, display: true, details }, { triggerTurn: true, deliverAs: "steer" });
    });
    await followSessionName(ctx);
  });
  pi.on("session_shutdown", close);
  const followSessionName = async (ctx) => {
    const name = normalizeName(pi.getSessionName() ?? "");
    if (!name || !session || ctx.sessionManager.getSessionId() !== nativeId)
      return;
    try {
      await session.name(name);
    } catch (error) {
      ctx.ui.notify(`Comms kept its name instead of ${name}: ${error instanceof Error ? error.message : "naming failed"}`, "warning");
    }
  };
  pi.on("session_info_changed", (_event, ctx) => followSessionName(ctx));
  const chooseName = async (name, ctx) => {
    if (!session || ctx.sessionManager.getSessionId() !== nativeId)
      throw new Error("Session is not connected");
    return `This session is now comms:${(await session.name(name)).name}.`;
  };
  pi.registerCommand("comms-name", { description: "Choose this session's comms name", async handler(args, ctx) {
    if (!args.trim()) {
      ctx.ui.notify("Usage: /comms-name <name>", "error");
      return;
    }
    try {
      ctx.ui.notify(await chooseName(args.trim(), ctx), "info");
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : "Naming failed", "error");
    }
  } });
  pi.registerMessageRenderer("comms_message", (message, options, theme) => renderCommsMessage(message.details, options.expanded, theme));
  for (const { name, description, inputSchema } of COMMS_TOOLS)
    pi.registerTool({
      name,
      label: { comms_send: "Send agent message", comms_list: "List agents", comms_name: "Choose comms name" }[name],
      description,
      parameters: inputSchema,
      async execute(_id, params, _signal, _onUpdate, ctx) {
        if (name === "comms_name") {
          const text2 = await chooseName(params.name, ctx);
          return { content: [{ type: "text", text: text2 }], details: {} };
        }
        if (!session || ctx.sessionManager.getSessionId() !== nativeId)
          throw new Error("Session is not connected");
        const result = name === "comms_list" ? await session.list({ include_stale: params.all === true }) : await session.send({
          id: messageId(Date.now()),
          to: params.to,
          body: params.text,
          ...typeof params.reply_to === "string" ? { reply_to: params.reply_to } : {}
        });
        const text = "agents" in result ? [
          ...result.agents.map((a) => [a.name, a.harness, a.presence, activeAgo(a, Date.now()), a.cwd, `comms:${a.name}`].join(" · ")),
          ...result.hidden ? [hiddenLine(result.hidden)] : []
        ].join(`
`) : sendSummary(result);
        return { content: [{ type: "text", text }], details: result };
      }
    });
  pi.events.on(OUTBOX_REQUEST, (data) => {
    outbox(data);
  });
  const used = new Set;
  const outbox = async (data) => {
    const request = data && typeof data === "object" ? data : {};
    const { requestId, extensionId, extensionName, to, message } = request;
    if (request.version !== 1 || typeof requestId !== "string" || !requestId)
      return;
    const answer = (status, fields) => pi.events.emit(OUTBOX_RESULT, {
      version: 1,
      requestId,
      status,
      ...fields,
      ...typeof extensionId === "string" ? { extensionId } : {},
      ...typeof extensionName === "string" ? { extensionName } : {}
    });
    const text = (value) => typeof value === "string" && !!value.trim();
    if (!text(extensionId) || !text(extensionName) || !text(to) || typeof message !== "string")
      return answer("failed", { code: "invalid_request", detail: "Expected nonempty extensionId, extensionName, and to, and a string message" });
    if (used.has(requestId))
      return answer("failed", { code: "duplicate_request", detail: "This requestId was already answered" });
    used.add(requestId);
    const current = session;
    if (!current)
      return answer("failed", { code: "session_unavailable", detail: "This session is not connected to comms" });
    try {
      const { agents } = await current.list({ include_stale: true });
      let target;
      try {
        target = resolveAddress(to, agents);
      } catch (error) {
        const code = error.data?.code === "AMBIGUOUS_RECIPIENT" ? "target_ambiguous" : "target_not_found";
        return answer("blocked", { code, detail: error instanceof Error ? error.message : code });
      }
      if (target.harness === "pi" && target.session_key === nativeId)
        return answer("blocked", { code: "self_target", detail: "That address is this session" });
      const result = await current.send({ id: messageId(Date.now()), to: target.id, body: message });
      answer("sent", { messageId: result.id, detail: sendSummary(result) });
    } catch (error) {
      answer("failed", { code: "delivery_failed", detail: error instanceof Error ? error.message : "Delivery failed" });
    }
  };
  return { close };
}
function extension(pi) {
  const bundled = fileURLToPath(new URL("../bin/comms", import.meta.url));
  registerPi(pi, localRuntime(existsSync(bundled) ? bundled : "comms"));
}
export {
  registerPi,
  extension as default
};
