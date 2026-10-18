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
- Two deliberate departures from Pi Intercom, decided in `internal/HANDOFF-FIXES-2.md` fixes 2 and 3, change the expected lines: every body line starts with one space, like the header and the `dim` lines, and expanded body text wraps to the inner width minus that space; and the collapsed header drops ` Ctrl+O expands `, so the footer's `Ctrl+O to expand` is the card's only mention.
- The padding tests use pi-tui's own `wrapTextWithAnsi` and `truncateToWidth` as the oracle for wrapped and truncated body text, since the card draws with them.

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
- `faults` makes `$.process.run` for one command answer with a given result, or reject with a given error, without running the CLI; the call is still recorded in `runs`.
  It stands in for a `comms` binary that cannot start, fails, or prints nothing, which the generated `ProcessRunResult` and a rejected promise can express.
- `spawnResults` keeps each spawned child's `.result` promise, so tests can tell when the `attach` child exits.
  The fake's `time`, when set, is what `$.clock.now()` resolves, so ListAgents' relative activity times are tested at exact boundaries (ADR-018).

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

### Bare names (HANDOFF-FIXES-2 fix 1)

- Every `SendMessage` whose `to` does not start with `comms:` or `uds:` is resolved with `comms resolve`, which reads `{ token?, name, skip_claude? }` as JSON on stdin like `comms list` and prints `{ agent }`.
- "Native peer messaging is on" is detected from `CLAUDE_CODE_MESSAGING_SOCKET` at session start.
  The `Peer sessions (N):` section controls where comms peers are appended in `ListAgents`, not whether bare-name resolution skips native Claude peers.

## Parent watch (HANDOFF-FIXES-2 fix 4)

- The platform module's `watchParent(onGone)` calls `onGone` once the process that started this one is gone and returns a function that stops watching.
- The rig's platform records each call in `parentWatchers`; a test calls `gone()` to report the parent gone, and `stopped` shows whether the CLI stopped watching.
  No real process tree is read and no test waits on the once-a-second check.
- On Unix, gone means the parent PID differs from the one seen at start.
  Checked on 2026-10-17 with Bun 1.3.13 on macOS: `process.ppid` is a getter, and a child whose parent shell exited read the shell's PID at start and `1` a second later.

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

### Messages, reply approval, and activity (ADR-018)

Sources: the observations of Codex 0.162.1 sessions with the 0.163.0 app-server daemon on 2026-10-17 quoted in `internal/HANDOFF-CODEX.md`, and the app-server schema generated with `codex app-server generate-json-schema` from the installed Codex CLI 0.162.1 into a temporary directory, with `CODEX_HOME` pointing at a temporary path.

- The queued text is checked exactly in the `codex queue --thread <id> --message <text>` argument; the fake still records arguments only.
- `Thread` in `v2/ThreadReadResponse.json` has a required `updatedAt` and a nullable `recencyAt`, both Unix seconds ("used for thread recency ordering"); the fake daemon in `tests/activity.test.ts` answers `thread/read` with both and changes them between one-shot metadata reads.
- Codex reads plugin MCP tool approval from `$CODEX_HOME/config.toml`, or `~/.codex/config.toml`, under `[plugins."cross-harness-comms@comms-local".mcp_servers.comms.tools.comms_send]` with `approval_mode = "approve"`, as observed; `tests/install-codex.test.ts` points both the platform's `codexHome()` and `CODEX_HOME` at a temporary directory and checks the file with Bun's built-in `Bun.TOML.parse`.
- The other keys in the config fixtures are only content to preserve; their Codex meaning is not claimed.
- The core's clock for activity times is the structural `now` option, epoch milliseconds, passed through the rig like `pingTimeoutMs` was.

The upstream [Codex dynamic MCP bridge](https://github.com/openai/codex/blob/main/codex-rs/tui/src/dynamic_tools_mcp.rs) accepts object and JSON-string turn metadata.
This first fixture uses the object form; accepting both forms is compatible with its public `unknown` metadata value.
Matching the hook's parent PID to the MCP parent's PID still needs a real integration probe.
The fake models that accepted design assumption without claiming the launch topology was verified.

### Native lifecycle events

Sources: Codex 0.163.0 generated `ThreadStartedNotification` and `ThreadStatusChangedNotification` schemas and the 2026-10-18 06:18 UTC observer captures summarized in `internal/VALIDATION-RESULTS-2026-10-17.md`.
An independent daemon observer saw `thread/started` for a new unprompted thread; reopening an existing thread produced `notLoaded` then `idle` status notifications.

- `tests/codex-lifecycle.test.ts` specifies the agreed core lifecycle rules without implementing them.
- Its injection point is `codexEvents: AsyncIterable<CodexEvent>` on the core options.
  Entries retain native `method` and `params`; `thread/started` also carries the executable supplied by the transport, as daemon snapshots do today.
- `FakeCodexEvents` is a sequential notification source with a barrier after each consumed event, not a lifecycle reducer or fake core.
  It owns no session, presence, routing, or storage behavior.
- `thread/started` creates an identity before any hook; duplicate delivery preserves an existing identity and user-assigned name.
- `SessionStart` confirms that same identity; `SessionEnd` leaves its identity and mailbox intact while taking it offline.
- `notLoaded`, `idle`, and `active` describe an existing session and never remove its identity.
  `notLoaded` takes it offline; a later load to `idle` or `active` reuses that identity and drains queued mail.
- An `idle` or `active` notification alone cannot undo an explicit `SessionEnd`.
  A subsequent observed `notLoaded` to `idle` transition represents a new load and can reactivate the same session without a first prompt.
- A connect/reconnect snapshot recovers discovery, but cannot override an explicit end, including after core restart.
  Disconnect or absence from the next snapshot takes daemon-owned sessions offline while leaving hook-only sessions alone.
- `tests/codex-events-transport.test.ts` specifies `watchCodexDaemon(platform, { signal, retryMs, timeoutMs })` through the exported event transport.
  It uses a real temporary Unix WebSocket endpoint to check one snapshot per connection, persistent idle connections, buffered notifications during discovery, reconnect, cancellation, and event-triggered metadata discovery for a resumed ID absent from the snapshot.
- Core lifecycle tests do not open real sockets or harnesses; transport tests do not run real Codex or model turns.
  Neither specifies detach behavior.

## Claude lifecycle

Claude lifecycle tests use the generated 2.1.289 `SessionEndInput` and `ClassicEventOf` declarations, confirmed in the real 2.1.296 clear check.
`session.start` is per process or fresh mod load and never fires for `/clear`.
`session.end` reports the old ID and reason; `classic.SessionStart` reports the replacement native ID after clear.
The fake emits those events and changes its host session ID; registration, disconnect, tokens, and mailboxes remain product code.

## Detach

`tests/detach.test.ts` uses the real client and core over the rig's in-memory streams.
Self-detach must return `{ ok: true }` before ending the registered connection.
Detaching another connection must end the owner while leaving the caller usable, including repeated detach of an offline session.
The compiled-core probe in `internal/probes/validate-core.ts` covers self-detach over a real Unix socket, followed by offline queueing and recovery.

## Narrow choices for the first specification

- Pi and Codex tool names are `comms_send` and `comms_list`.
- Claude sends native `message` text literally, including `comms-reply:` prefixes.
  The adapter selects the most recent received message from that exact address that has not yet been replied to.
  A successful reply consumes that pending message once; older pending messages remain eligible, and state is separate per receiving session.
  Unmarked recipients pass through untouched.
- Codex's reply hint names `comms_send` and `reply_to`; Claude's fallback hint names `SendMessage` only, since the adapter fills in `reply_to` (ADR-018).
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
  Claude omits `asUser`; Codex has only a text queue interface, so provenance comes from the header naming another agent (ADR-018).
- Synthetic protocol versions 100 and 101 exercise older wire shapes while storing the canonical current message shape.
  They are fixtures, not planned release versions; production starts at version 1 with no conversion steps.
- The SQLite assertions use the documented table and column names and stored insertion order.
  They check committed visibility and restart persistence, not power-loss behavior or fsync policy.

The native inbox and daemon transport tests listen on temporary Unix sockets.
The fake Claude inbox and core reply sockets live in `/tmp/cc-*`, while daemon fixtures use `/tmp/cxh-*` and `/tmp/cxe-*`; each fixture removes its own directory.
No real harnesses, model servers, installation/download behavior, or cross-machine transports are exercised.
