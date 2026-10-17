# Harness fake sources and test contract

These unit fakes reproduce only the host APIs the adapters use.
They record calls and delegate transport to product code; they do not route messages or maintain mailboxes themselves.
The first-pass scaffold used throwing exports; the current suite also specifies the first prototype's review fixes.

## Pi

Source: [Pi extension documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md), checked against the installed 0.85.1 copy under `/opt/homebrew/Cellar/pi-coding-agent/0.85.1/libexec/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`.
Relevant sections are `session_start`, `session_shutdown`, `pi.registerTool`, `pi.sendMessage`, `pi.registerMessageRenderer`, and Custom UI (Message and Entry Rendering, Theme Colors).

- Registration uses `pi.on(event, handler)` and `pi.registerTool(definition)`.
- The tool executes with `(toolCallId, params, signal, onUpdate, ctx)`.
- Identity comes from `ctx.sessionManager.getSessionId()`.
- `pi.sendMessage(message, options)` accepts a custom message and returns void, so acceptance is a successful synchronous call.
- Incoming deliveries use `{ triggerTurn: true, deliverAs: "steer" }`: `steer` queues the message while Pi is streaming, and `triggerTurn` starts a turn when Pi is idle (ADR-017).
- `parameters` is deliberately opaque in the structural subset; the fake does not claim to validate or implement TypeBox schemas.
- The `sendUserMessage` recorder detects accidental use of the user channel.

### Message renderer and card (ADR-017)

Sources: the installed Pi 0.85.1 declarations in `dist/core/extensions/types.d.ts` (`MessageRenderer`, `MessageRenderOptions`, `registerMessageRenderer`, `sendMessage`) and `dist/core/messages.d.ts` (`CustomMessage`), Pi's own caller `dist/modes/interactive/components/custom-message.js`, the bundled `@earendil-works/pi-tui` 0.85.1 (`Component` in `dist/tui.d.ts`; `truncateToWidth`, `visibleWidth`, `wrapTextWithAnsi`, and `stripTerminalSequences` in `dist/utils.d.ts`), all under `/opt/homebrew/Cellar/pi-coding-agent/0.85.1/libexec/lib/node_modules/@earendil-works/pi-coding-agent/`, and Pi Intercom 0.13.0 at `~/.pi/agent/npm/node_modules/pi-intercom/` (`ui/inline-message.ts`, and in `index.ts` `sendIncomingMessage` and the `intercom_message` renderer).

- `registerMessageRenderer(customType, renderer)` keeps one renderer per custom type; the fake records each in `renderers` by type.
- Pi calls a renderer as `(message, { expanded, outputPad }, theme)`, where `message` is the `CustomMessage` built from the sent message, `{ role: "custom", customType, content, display, details, timestamp }`.
  `fake.render` builds the same object; the fixed timestamp stands in for Pi's `Date.now()`.
- Pi rebuilds the component when Ctrl+O toggles `expanded`, so each state is a separate renderer call.
- A renderer returning `undefined` makes Pi draw `content` itself; Pi also catches a throwing renderer and falls back.
  The fake does not catch, so a renderer that throws fails the test instead of passing as a fallback.
- `theme.fg(color, text)` returns colored text; the structural subset declares only `fg`, the one theme method the card uses.
  The identity theme returns text unchanged; the marker theme wraps it in a distinct 256-color SGR code per color and a `39` foreground reset, as Pi's themes emit SGR codes, so widths match the identity theme and tests read each character's color.
- Widths are measured with pi-tui's own `visibleWidth`, and visible text with `stripTerminalSequences`.
- `@earendil-works/pi-tui` 0.85.1 is a root dev dependency for types and tests; Pi provides it to extensions at runtime, so the built extension imports it instead of bundling it.
- Pi Intercom's card draws a rounded frame with `muted` borders, a `toolTitle` header that adds ` Ctrl+O expands ` when collapsed, a `text` body, and `dim` metadata; the exact lines in the tests follow its layout with comms fields in place of Pi Intercom's.

## Claude Code

Source: [generate mod types for the installed build](https://code.claude.com/docs/en/plugins/mods/create#get-the-types-for-your-build), using the generated declarations for installed Claude Code 2.1.289:

- `internal/probes/claude-mod/.claude-plugin/types/claude-code/index.d.ts`
- `internal/probes/claude-mod/.claude-plugin/types/claude-code-tools/index.d.ts`
- `internal/probes/claude-mod/hooks/register.js`

The structural subset in `adapters/claude/src/api.ts` is handwritten, not an edited generated file.
The older temporary declaration snapshot lacks `process.spawn` and is not the binding source.

- `tool.call` events have flat fields such as `{ tool, tool_use_id, to, message }`, not a nested `arguments` object.
- `SendMessage` has `to`, `message`, optional `summary`, and optional `notify_when_idle`; its result type is `unknown`.
- `ListAgents` returns `{ listing: string }`, not structured agent records.
- `$.session.id()` and `$.session.cwd()` return promises.
- `$.prompt.submit({ text })` keeps the mod origin; `asUser?: true` would opt into user attribution and must be absent.
- `$.process.run(argv, { stdin })` accepts stdin and returns `exitCode`, `stdout`, `stderr`, and two truncation flags.
- `$.process.spawn({ argv, input })` uses `input`, not `stdin`, and returns an async generator with a `.result` promise.
- Spawn chunks are `{ stream, text }`; they are not necessarily complete protocol lines.
- Generated globals include `crypto.getRandomValues`, `crypto.randomUUID`, and `performance.now`.
- `$.clock.now()` returns `Promise<number>` with epoch milliseconds; `$.clock.after(delay, callback)` returns a cancellation handle.

On 2026-10-17 the installed Claude Code 2.1.289 validator accepted isolated mods using `crypto.getRandomValues(new Uint8Array(16))`, `crypto.randomUUID()`, and `await $.clock.now()`.
Separate probes using `Date.now()`, `Math.random()`, and `performance.now()` also passed validation.
These checks establish validator acceptance, not execution in a real session.
Prefer cryptographic randomness for UUID entropy; `crypto.randomUUID()` alone yields UUIDv4, and `performance.now()` is not an epoch timestamp.
The fixed mod must generate UUIDv7 before invoking the CLI, rather than ask the CLI to generate it.
The fake exposes the source-checked host clock and uses Bun's available Web Crypto globals; it does not invent a `$.crypto` namespace.
Delayed fake-clock callbacks advance explicitly in reconnect tests so they do not depend on a 250 ms wall-clock delay.

The fake intentionally splits output into seven-character chunks.
Both process methods call the actual `runCli` export in process, including `ensure`, `attach`, `send`, and `ack`.
No real subprocess is launched.
The fake implements neither the engine's permission dialogs nor its native message transport.
Native path tests check the exact event and result objects passed through middleware.

### Native inbox (ADR-016)

Sources: the observations of interactive Claude Code 2.1.289 sessions on 2026-10-17 quoted in `internal/HANDOFF-CLAUDE-INBOX.md`, the probes `internal/probes/claude-inbox/inbox-listen.ts`, `internal/probes/claude-inbox/inbox-post.ts`, `internal/probes/claude-inbox-mod/hooks/register.js`, and `internal/probes/claude-inbox-mod/post.ts`, and the generated declarations in `internal/probes/claude-mod/.claude-plugin/types/claude-code/index.d.ts` (`env`, `session.version`, `SessionVersion`, `session.receive`, `SessionReceiveInput`, `SessionReceiveOrigin`, `SessionReceiveResult`).

- `$.env.get(name)` resolves the variable's value or `undefined`; the fake sets only `CLAUDE_CODE_MESSAGING_SOCKET`, and only for a native session.
- `$.session.version()` resolves `{ version, base, builtAt }`; the default is the observed `{ version: "2.1.289", base: "2.1.289", builtAt: "2026-10-03T19:21:39Z" }`.
- `on("session.receive", handler)` hooks receive `{ origin, text }` and call `next(e)`, which resolves `{ text }` once the delivery is queued; a hook may answer `{ consumed }` instead.
  The fake's innermost `next` records the text in `queued`, and every chain's answer in `receipts`.
- The inbox is a real Unix socket named like a PID (`2xxxx.sock`) in a short `/tmp/cc-*` directory standing in for `/tmp/cc-socks`, as `inbox-listen.ts` listens.
- It reads newline-terminated JSON lines, records each line and each connection's bytes and end, and never writes back on the connection.
- Each line reaches `session.receive` with `origin` `{ kind: "peer", plugin: from_plugin }`, or `{ kind: "peer" }` without `from_plugin`, and `text` equal to `message.content` verbatim, as observed for lines posted with `"from_plugin": "cross-harness-comms"`; `msg_id` is not exposed.
- `hold` makes the inbox swallow lines without running the hooks, standing in for a session that never acknowledges; `release()` runs them later, standing in for a late delivery.
- `holdAttachOutput()` delays the attach child's output chunks, since the host does not promise when a child's output reaches the mod; it orders a late native delivery before the comms fallback copy.
- Claude's own replies are simulated by writing one line in the observed format to a reply socket and closing the connection: no `from_plugin`, and a `hop-chain` attribute whose value is a placeholder, since only its presence was observed.
- Bodies are escaped as observed: only the literal `</cross-session-message>` becomes `<\/cross-session-message>`.
- The fake does not implement Claude's own `SendMessage`, its rendering of peer messages, or its session registry for `ListAgents`; the native listing stays the fixed text in `nativeListing`.

## Codex

Sources: `internal/probes/codex-mcp/server.mjs`, the session-binding observations in `internal/ARCHITECTURE.md`, and the installed Codex CLI 0.162.1 `codex queue --help` output.
The retained probe server records JSON-RPC `tools/call` requests and their `_meta` values.
The observed SessionStart input is preserved in the local research log `/private/tmp/cross-harness-deep.6XoooY/codex-identity3.log`.

- MCP calls carry `{ jsonrpc, id, method: "tools/call", params: { name, arguments, _meta } }`.
- `_meta["x-codex-turn-metadata"].thread_id` identifies the caller; `session_id` is a separate field.
- SessionStart input contains `hook_event_name`, `session_id`, `cwd`, and `source`, with optional transcript/model/permission fields.
- A parent PID is process context, not a fabricated field in the hook input.
- Queue arguments are exactly `codex queue --thread <id> --message <text>`.
- The fake gates process completion so tests can distinguish starting delivery from successful acceptance.

The upstream [Codex dynamic MCP bridge](https://github.com/openai/codex/blob/main/codex-rs/tui/src/dynamic_tools_mcp.rs) accepts object and JSON-string turn metadata.
This first fixture uses the object form; accepting both forms is compatible with its public `unknown` metadata value.
Matching the hook's parent PID to the MCP parent's PID still needs a real integration probe.
The fake models that accepted design assumption without claiming the launch topology was verified.

## Narrow choices for the first specification

- Pi and Codex tool names are `comms_send` and `comms_list`.
- Claude sends native `message` text literally, including `comms-reply:` prefixes.
  The adapter selects the most recent received message from that exact address that has not yet been replied to.
  A successful reply consumes that pending message once; older pending messages remain eligible, and state is separate per receiving session.
  Unmarked recipients pass through untouched.
- Wrapper reply instructions mention setting `reply_to` only if the send tool has that field.
- Claude's native listing remains text; this suite tests appending comms peers but does not fabricate native session IDs for deduplication.
- Formatting lives in the I/O-free protocol package so Claude can share it without importing Node.
- `hello` without `session` negotiates only and creates no agent or presence.
  It lets one-shot CLI connections authenticate `send` or `ack` with the live attachment's token without creating a second session attachment.
- `attach` reads `HelloParams` from stdin and writes JSON-RPC response and notification lines.
  `send` and `ack` read their protocol parameter objects from stdin and write result JSON, without echoing the token.
- A reconnect carries its held credential as a top-level `hello.token`, including `spawn.input` for Claude's attachment.
  This is stdin, not an argument or environment variable.
- Before refusing an uncredentialed live-session claim, the core sends a correlated JSON-RPC `ping` request; a peer answers with the same request ID and an empty result object.
  The CLI attachment must handle this for Claude because its stdin is closed after initial registration.
- The core option `pingTimeoutMs` is passed structurally by the test rig until Part 2 declares and implements it.
  The stale-connection test uses zero; responsive-peer tests use 100 ms.
- The persisted credential column is named `agents.token_hash`; tests leave the hash algorithm unspecified and reject plaintext in both the database and WAL.
  The handoff explicitly allows wrong-token claims while offline, a row omitted from ADR-013's table, so tests cover rotation in that case too.
- One lost send receipt within a logical tool invocation is retried with the original UUIDv7 and unchanged content.
  Separate invocations, even with identical text, receive distinct IDs.
  Pi and Codex tests drop a committed core receipt and close the in-memory transport; Claude tests lose successful subprocess output after the actual CLI has committed the send.
  Neither fault injector implements routing, storage, or retry logic.
- JSON-RPC application failures carry a symbolic `error.data.code`; the suite does not allocate numeric application error codes.
  Missing/invalid credentials use `INVALID_TOKEN`, and acknowledging another recipient's message uses `FORBIDDEN`.
- Unknown identity fields cannot override native session identity or token ownership.
- Codex errors at the MCP tool boundary use `isError: true` and explain the missing `thread_id`.
- Pi's custom message type is `comms_message`, with Markdown `content` in place of the shared wrapper (ADR-017).
  Claude omits `asUser`; Codex has only a text queue interface, so provenance comes from the shared wrapper.
- Synthetic protocol versions 100 and 101 exercise older wire shapes while storing the canonical current message shape.
  They are fixtures, not planned release versions; production starts at version 1 with no conversion steps.
- The SQLite assertions use the documented table and column names and stored insertion order.
  They check committed visibility and restart persistence, not power-loss behavior or fsync policy.

Only the native inbox tests listen on sockets: the fake Claude inbox and the core's reply sockets are real Unix sockets in a temporary `/tmp/cc-*` directory, removed with the rig.
No real harnesses, model servers, installation/download behavior, or cross-machine transports are exercised.
