# Harness fake sources and test contract

These unit fakes, in `tests/support/fakes/`, reproduce only the host APIs the adapters use.
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

Source: [generate mod types for the installed build](https://code.claude.com/docs/en/plugins/mods/create#get-the-types-for-your-build), using the generated `claude-code` and `claude-code-tools` declarations for installed Claude Code 2.1.289 in a probe mod, with its `hooks/register.js`; the probe mod has since been retired.

The structural subset in `adapters/claude/src/api.ts` is handwritten, not an edited generated file.
The older temporary declaration snapshot lacks `process.spawn` and is not the binding source.

- `tool.call` events have flat fields such as `{ tool, tool_use_id, to, message }`, not a nested `arguments` object.
- `agentId` identifies a child loop, including internal forks; `$.agent.list()` lists normal subagents/teammates, while engine-owned forks have IDs absent from that list (generated `AgentLoop` and `AgentInfo` declarations).
  A real Claude Code 2.1.296 `$.model.fork` probe on 2026-10-18 confirmed that an unlisted fork reached `tool.call`, the unguarded comms adapter sent under the main identity, and passing that same call downstream instead produced `A model fork cannot use tools` with no stored message.
  The native before/after evidence is in `/private/tmp/comms-routing-0RBCEU/` and `/private/tmp/comms-routing-G4WMpZ/`; `claude-agent-scope.test.ts` keeps this boundary and listed-subagent messaging covered.
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

Sources: the observations of interactive Claude Code 2.1.289 sessions on 2026-10-17 quoted in `internal/HANDOFF-CLAUDE-INBOX.md`, the since-retired probes that listened on and posted to a session's inbox socket and the probe mod that hooked `session.receive`, and the generated 2.1.289 `claude-code` declarations (`env`, `session.version`, `SessionVersion`, `session.receive`, `SessionReceiveInput`, `SessionReceiveOrigin`, `SessionReceiveResult`).

- `$.env.get(name)` resolves the variable's value or `undefined`; the fake sets only `CLAUDE_CODE_MESSAGING_SOCKET`, and only for a native session.
- `$.session.version()` resolves `{ version, base, builtAt }`; the default is the observed `{ version: "2.1.289", base: "2.1.289", builtAt: "2026-10-03T19:21:39Z" }`.
- `on("session.receive", handler)` hooks receive `{ origin, text }` and call `next(e)`, which resolves `{ text }` once the delivery is queued; a hook may answer `{ consumed }` instead.
  The fake's innermost `next` records the text in `queued`, and every chain's answer in `receipts`.
- The inbox is a real Unix socket named like a PID (`2xxxx.sock`) in a short `/tmp/cc-*` directory standing in for `/tmp/cc-socks`, as the inbox probe listened.
- It reads newline-terminated JSON lines, records each line and each connection's bytes and end, and never writes back on the connection.
- Each line reaches `session.receive` with `origin` `{ kind: "peer", plugin: from_plugin }`, or `{ kind: "peer" }` without `from_plugin`, and `text` equal to `message.content` verbatim, as observed for lines posted with `"from_plugin": "cross-harness-comms"`; `msg_id` is not exposed.
- `hold` makes the inbox swallow lines without running the hooks, standing in for a session that never acknowledges; `release()` runs them later, standing in for a late delivery.
- `holdAttachOutput()` delays the attach child's output chunks, since the host does not promise when a child's output reaches the mod; it orders a late native delivery before the comms fallback copy.
- Claude's own replies are simulated by writing one line in the observed format to a reply socket and closing the connection: no `from_plugin`, and a `hop-chain` attribute whose value is a placeholder, since only its presence was observed.
- Bodies are escaped as observed: only the literal `</cross-session-message>` becomes `<\/cross-session-message>`.
- The fake does not implement Claude's own `SendMessage`, its rendering of peer messages, or its session registry for `ListAgents`; the native listing stays the fixed text in `nativeListing`.

### Bare names (HANDOFF-FIXES-2 fix 1)

These are specified in `claude-resolve.test.ts`.

- Every `SendMessage` whose `to` does not start with `comms:` or `uds:` is resolved with `comms resolve`, which reads `{ token?, name, skip_claude? }` as JSON on stdin like `comms list` and prints `{ agent }`.
- "Native peer messaging is on" is detected from `CLAUDE_CODE_MESSAGING_SOCKET` at session start.
  The `Peer sessions (N):` section controls where comms peers are appended in `ListAgents`, not whether bare-name resolution skips native Claude peers.

### Send rows name the recipient (HANDOFF-SEND-NAME)

Source: the real Claude Code 2.1.296 probe in `internal/SEND-NAME-FINDINGS.md`, with its log in `/private/tmp/comms-sendname.aXtc/log.jsonl` and the generated `ToolResult` render props, whose row is drawn from the record `tool.call` resolved as `result`.
These are specified in `claude-send-name.test.ts`.

- `claudeSendResult(to, message)` is Claude's own result for a `SendMessage` that reached a `uds:` address: `{ result: { success, message, display, msg_id } }`, with `display` `“<message>” → <to>` drawing the row and the rest read by the model.
  The observed `message` goes on after `;` with a delivery note; the fixture keeps only its start, and the observed `ref`, `text`, and `isReadOnly` beside `result` are left out, since a hook returning `{ result }` alone drew the row the same way.
- A test sets it as `nativeResult` for the address the call reaches, so the fake still does not implement Claude's `SendMessage`; Claude's delivery is simulated by posting its line to that address, as in the native reply tests.
- Comms reply sockets are named `9` followed by nine digits, `.sock` (`REPLY_SOCKET`); other `uds:` sockets stand in for Claude's own peers.

## Parent watch (HANDOFF-FIXES-2 fix 4)

These are specified in `attach-parent.test.ts`.

- The platform module's `watchParent(onGone)` calls `onGone` once the process that started this one is gone and returns a function that stops watching.
- The rig's platform records each call in `parentWatchers`; a test calls `gone()` to report the parent gone, and `stopped` shows whether the CLI stopped watching.
  No real process tree is read and no test waits on the once-a-second check.
- On Unix, gone means the parent PID differs from the one seen at start.
  Checked on 2026-10-17 with Bun 1.3.13 on macOS: `process.ppid` is a getter, and a child whose parent shell exited read the shell's PID at start and `1` a second later.

## Codex

Sources: a since-retired probe MCP server that recorded Codex 0.162.1's JSON-RPC `tools/call` requests and their `_meta` values, the session-binding observations in `internal/ARCHITECTURE.md`, and the installed Codex CLI 0.162.1 `codex queue --help` output.
The observed SessionStart input was captured in a temporary research log, since removed; the fields below record it.

- MCP calls carry `{ jsonrpc, id, method: "tools/call", params: { name, arguments, _meta } }`.
- `_meta["x-codex-turn-metadata"].thread_id` identifies the caller; `session_id` is a separate field.
- SessionStart input contains `hook_event_name`, `session_id`, `cwd`, and `source`, with optional transcript/model/permission fields.
- A parent PID is process context, not a fabricated field in the hook input.
- Queue arguments are exactly `codex queue --thread <id> --message <text>`.
- The fake gates process completion so tests can distinguish starting delivery from successful acceptance.

### Messages, reply approval, and activity (ADR-018)

Sources: the observations of Codex 0.162.1 sessions with the 0.163.0 app-server daemon on 2026-10-17 quoted in `internal/HANDOFF-CODEX.md`, and the app-server schema generated with `codex app-server generate-json-schema` from the installed Codex CLI 0.162.1 into a temporary directory, with `CODEX_HOME` pointing at a temporary path.

- The queued text is checked exactly in the `codex queue --thread <id> --message <text>` argument; the fake still records arguments only.
- `Thread` in `v2/ThreadReadResponse.json` has a required `updatedAt` and a nullable `recencyAt`, both Unix seconds ("used for thread recency ordering"); the fake daemon in `tests/support/fakes/codex-daemon.ts` answers `thread/read` with both in `tests/activity.test.ts`, which changes them between the snapshots of two connections.
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

### Presence and stale lists (HANDOFF-PRESENCE)

Sources: the decision in `internal/HANDOFF-PRESENCE.md`, and the app-server protocol generated on 2026-10-18 with `codex app-server generate-ts --out <temporary directory>` from the installed Codex CLI 0.163.0.
These are specified in `presence.test.ts`.

- `config/read` is a `ClientRequest` with `params: ConfigReadParams`, `{ includeLayers?: boolean, cwd?: string | null }`, both optional.
- Its result is `ConfigReadResponse`, `{ config: Config, origins: { [key]?: ConfigLayerMetadata }, layers: Array<ConfigLayer> | null }`.
- `Config` names common keys such as `model` and is intersected with an open map of `number | string | boolean | array | object | null` values; `thread_unload_delay_secs` is not a named key, so it arrives through that map, and only when set.
  The fake daemon answers `config/read` without it by default (`noDelay`), with a chosen value, or with a JSON-RPC error.
- The transport reports a numeric `thread_unload_delay_secs` as `unload_delay_secs` on that connection's `comms/daemon-snapshot`, and leaves it out when the read failed, the key was absent, or the value was not a number.
- The core takes the threshold for every Codex agent from the latest snapshot, so a later snapshot without a value goes back to 1800 seconds.
- No `config/` request other than `config/read` is ever sent.
- Presence and the one-day stale rule use the core's injected `now`, and `last_seen` follows it too.
- Boundaries are tested just inside and just past each threshold (29 and 31 minutes, 14 and 16, 23 and 25 hours), not at the exact instant.
- `rig.agents()` lists with `include_stale: true`, as an observer that sees everything.
- Pi's rows read Pi's own clock for relative activity, so that test runs the core's clock on real time.
- The hidden-count line is `N offline agents not shown`: the last line of Claude's `ListAgents` listing and of Pi's text, and a second text content item after Codex's JSON, which stays parseable.
  Tests use two hidden agents, so the singular wording is not specified.
- Claude's `ListAgents` runs `comms list` with `include_stale: false`; `comms list` otherwise adds `include_stale: true`.

### Offline Codex agents stay stale, and rows say last active (HANDOFF-STALE-FIX)

Source: the decision in `internal/HANDOFF-STALE-FIX.md`, after the real check in `internal/VALIDATION-RESULTS-0.1.22.md`.
These are specified in the `stale:` tests in `presence.test.ts`, and the row text also in `activity.test.ts`.

- `last_seen` changes only when an agent goes from online to offline, or comes online; a daemon-owned Codex agent already offline keeps it through a later end, a snapshot that omits it, a daemon disconnect, and a core restart.
- A Codex thread online when the core stopped goes offline at the first snapshot after the restart that omits it, and `last_seen` records that moment, as before.
- The relative activity text is `last active now`, `last active 5m ago`, and so on, in Claude's `ListAgents` rows and Pi's `comms_list` lines; presence words are unchanged.

## Claude lifecycle

Claude lifecycle tests use the generated 2.1.289 `SessionEndInput` and `ClassicEventOf` declarations, confirmed in the real 2.1.296 clear check.
`session.start` is per process or fresh mod load and never fires for `/clear`.
`session.end` reports the old ID and reason; `classic.SessionStart` reports the replacement native ID after clear.
The fake emits those events and changes its host session ID; registration, disconnect, tokens, and mailboxes remain product code.

- `holdRun(command)` holds the next `$.process.run` of that command after recording it in `runs`, and `release(error?)` lets it run or makes it reject; the concurrent-start tests in `claude-lifecycle.test.ts` hold `ensure` to keep a start in flight.
  A rejected run stands in for a `comms` binary that fails to start, as `faults` does.
- `settle()` in `tests/support/helpers.ts` waits one macrotask, so hooks already started reach their next real wait; while `ensure` is held every other fake step is a microtask, so this is ordering, not timing.
- Starts and attachments are counted from the `ensure` entries in `runs` and the `attach` entries in `spawns`.
- `end(reason)` runs the `session.end` chain for the current ID on its own; `clear(nextId)` is `end("clear")`, the ID change, and `classicStart("clear")`.
- `holdReceive()` holds the innermost `next` of the next `session.receive` chain before it queues the delivery, with `entered` and `release()` like `holdRun`; several holds queue in order.
- The tests in `claude-generation.test.ts` hold `detach`, `send`, `ensure`, `prompt.submit` (through `acceptGate`), and `session.receive`'s `next`, and fire a scheduled attach retry with `runScheduled()`, so every interleaving is set by a hold or the fake clock, not by timing.
  A retry is scheduled by destroying the attachment's in-memory link and awaiting that child's `spawnResults` entry.

## Names (HANDOFF-NAMES)

Sources: the decisions in `internal/HANDOFF-NAMES.md` and `internal/NAMING-DESIGN.md`; for Claude, the generated Claude Code 2.1.296 mod types that the `plugin-authoring` skill writes as `types/claude-code.d.ts` in its bundled skill folder (`$.tool.register`, `ToolSpec`, `$.command.register`, `CommandSpec`, `command.run`, `CommandRunInput`, `CommandRunResult`, `McpToolCallInputFallback`) and its `reference.md` and `examples/pane.tsx`; for Pi, the installed 0.85.1 `docs/extensions.md` (`pi.registerCommand`, session switch events) and `dist/core/extensions/types.d.ts` (`RegisteredCommand`, `ExtensionCommandContext`, `ExtensionUIContext.notify`), and Pi Intercom 0.13.0's `/alias` in `index.ts` (`registerCommand("alias")`, `setIntercomAlias`, which answers with `ctx.ui.notify`).
These are specified in `names.test.ts`.

- Claude: `$.command.register({ name, description, argumentHint?, immediate? })` declares `/<name>` and resolves `{ command }`; a `command.run` hook on that command answers `{ text }` without calling `next`, and a run no hook answers says so as its output.
  `FakeClaude.command(name, args)` runs the `command.run` chain with `{ command, args, origin, presentation }`; it throws for a command never registered, since the typeahead offers only registered ones.
- Claude: `$.tool.register({ name, description, inputSchema?, isDeferred? })` declares a tool the model calls as `mcp__<plugin>__<name>` and resolves `{ tool }` with that full name; a `tool.call` hook on that name answers, with the input fields flat beside `tool` as for every tool, and a call no hook answers fails.
  `FakeClaude.tool` throws for an `mcp__` tool never registered and answers `{ deny }` when no hook answers one; the plugin name is `cross-harness-comms`, so the name tool is `mcp__cross-harness-comms__comms_name` (`FakeClaude.toolName`).
  Both are declared in `session.start`, which the generated types say a `$.tool.register` awaited there is listed by turn one; `/clear` fires no `session.start`, and the fake keeps registrations across it.
  These methods are in the 2.1.296 generated types; whether 2.1.289 had them was not checked.
- Claude: a hook's answer to a `$.tool.register` tool must have a `result` that is a string, an array of MCP content blocks, or undefined (HANDOFF-FIXES-3 fix 1).
  The generated 2.1.296 `ToolCallResult` says "Core validates a hook's answer against the tool's output schema when it has one", and `McpToolResult` gives the content blocks as `McpContentBlock[]`, each with a string `type`.
  The real 2.1.296 check 9 in `internal/VALIDATION-RESULTS-0.1.24.md` showed the model, for the 0.1.24 answer `{ result: { success: true, message } }`, `<tool_use_error>tool.call step resolved mcp__cross-harness-comms__comms_name with a result that does not match its output shape`, followed by a Zod `invalid_union` of `expected string`, `expected array`, and `expected undefined`, each `received object`.
  `FakeClaude.tool` rejects any other `result` for a registered tool with an error starting with that same sentence; the check that each array item has a string `type` follows `McpContentBlock`, since the observed error shows only `expected array`.
  A `{ deny }` answer and the results of built-in tools such as `SendMessage` and `ListAgents` are not checked.
- Pi: `pi.registerCommand(name, { description?, handler(args, ctx) })` registers `/<name>`; the handler gets the text after the name and an `ExtensionCommandContext`, of which the structural subset declares only `ui.notify(message, type?)`.
  `FakePi.command(name, args)` runs the handler and records each notification in `notifications`.
- Pi reloads and rebinds extensions for a new session (`session_shutdown`, then `session_start` with reason `new`), so a new Pi session is a new extension instance; the test starts a new `FakePi` for it.
- The `name` refusal for an online holder is `NAME_TAKEN` with a message containing the holder's harness and the last part of its working directory; the exact wording is left to the implementation.
- Plain names (HANDOFF-FIXES-3 fix 2): the `plain names:` tests in `names.test.ts` and `core.test.ts` send from Pi and Codex and rename with addresses that have no scheme.
  A refused Pi send throws the core's error, so the test reads its `data.code`; Codex keeps only the message text in its error result, so its tests check `isError` and that the text names the address.
- The migration test drops `agents.name_chosen` from a current database to stand in for one from before chosen names, so the column must stay droppable (not part of an index, key, or check constraint).

## Pi session names, lookups, the Pi outbox, and comms install pi (HANDOFF-PI-LIVE-SUBAGENTS)

Sources: the decisions in `internal/HANDOFF-PI-LIVE-SUBAGENTS.md`; for Pi, the installed 0.85.1 `docs/extensions.md` (`pi.events`, `pi.setSessionName`, `pi.getSessionName`, `session_info_changed`, `pi.sendMessage` and its `deliverAs`) and, under `/opt/homebrew/Cellar/pi-coding-agent/0.85.1/libexec/lib/node_modules/@earendil-works/pi-coding-agent/dist/`, `core/extensions/types.d.ts` (`SessionInfoChangedEvent`, `ExtensionAPI.events`, `setSessionName`, `getSessionName`), `core/event-bus.d.ts` and `core/event-bus.js` (`EventBus`), `core/agent-session.js` (`setSessionName`), and `core/session-manager.js` (`appendSessionInfo`, `getSessionName`); for the outbox, Pi Intercom 0.13.0 at `~/.pi/agent/npm/node_modules/pi-intercom/` (`extension-api.ts`, and in `index.ts` `parseOutboxRequestPayload`, `handleOutboxRequest`, and `resolveOutboxTarget`), and pi-live-subagents' `src/intercom.ts`, its only caller.
These are specified in `names.test.ts`, `pi-session-names.test.ts`, `pi-outbox.test.ts`, `pi-delivery.test.ts`, and `install-pi.test.ts`.

- `FakePi.events` is Pi's `EventBus`: `on(channel, handler)` returns an unsubscribe function, and `emit(channel, data)` runs every listener synchronously in order, as Node's `EventEmitter` does, with an async listener's rejection only logged.
  `emitted` records every emit on any channel, so a test reads the adapter's `comms:outbox-result` answers from it.
- `getSessionName()` returns the latest name trimmed, or undefined when unset or cleared with an empty name, as `SessionManager.getSessionName` does.
  `setSessionName(name)` stores the name with runs of line breaks turned into a space and trimmed (`appendSessionInfo`), then fires `session_info_changed` with `{ type, name }`, where `name` is the new `getSessionName()`, without awaiting the handlers (`void this._extensionRunner.emit(event)`); `renamed()` lets a test wait for them.
- A name Pi already has at start, as with `pi -n <alias>` or a resumed named session, is the `sessionName` constructor option, and `rig.harness(..., { pi: { sessionName } })` passes it.
- Event handlers get an `ExtensionContext`, which has `ui.notify` like a command's context, so the fake passes one context with a recorded `ui.notify` to both, and the refusal warning is read from `notifications` with type `warning`.
- The busy session model follows `deliverAs` in `docs/extensions.md`: while streaming, `steer` (the default) "Queues the message while streaming. Delivered after the current assistant turn finishes executing its tool calls, before the next LLM call", `followUp` waits for the agent to finish, and `nextTurn` waits for the next user prompt.
  `FakePi.toolRunning(tool)` starts a streaming turn with one running tool call and returns the function that ends it; a `sendMessage` while it runs is held and lands in `timeline` after the `tool_end`, and one with `nextTurn` does not land at all.
  Pi gives an extension no way to deliver a custom message into a running tool call, so the test pins that the adapter's choice of `deliverAs` keeps the message behind the call and that nothing goes through `sendUserMessage`.
- The outbox mirrors Intercom's v1 shapes on `comms:` channels with the brief's departures: a malformed or duplicate request is `failed` (Intercom answers `rejected`), a request without `version: 1` gets no answer (Intercom answers `rejected` `invalid_request` when it has a `requestId`), and there is no confirmation, so `rejected`, `user_cancelled`, and `confirmation_unavailable` never occur.
  Malformed follows `parseOutboxRequestPayload`: a nonempty string `requestId`, `extensionId`, `extensionName`, and `to`, and a string `message`; a payload without a usable `requestId` cannot be answered and is ignored.
  `requestId` values look like pi-live-subagents' `live-<uuid>`; they are not comms message IDs, so `messageId` is checked against the stored row instead.
  A target is ambiguous through the ID-prefix rule only, since names are unique; the test builds the prefix from two agents' UUIDv7 IDs, whose first 8 characters are shared by IDs minted within about 65 seconds.
  `delivery_failed` is produced with a message over the 1 MB protocol line limit, the one refusal a test can force that is neither a lookup failure nor a missing session.
- `comms install pi` finds the built Pi package as `plugins/pi` beside the running compiled binary (`runtime.command[0]`, which is `dist/comms` after `bun run build`), and names the install after that package's `package.json` version.
  The tests give the CLI a platform whose data directory is `<temporary home>/.local/share/comms` and also set `HOME`, so neither reading of `~` reaches the real home.
  The printed path is absolute, since Pi's `docs/packages.md` lists local packages by absolute path.
  "Newest" is by `compareVersions`, which the test separates from lexical order with 0.1.9 and 0.1.10.

## Retention (HANDOFF-RETENTION)

Source: the decisions in `internal/HANDOFF-RETENTION.md`, from `internal/LIST-AND-RETENTION.md` and `internal/NAMING-DESIGN.md`.
These are specified in `retention.test.ts`; no fake or rig changed.

- Time comes only from the core's injected `now`; agents age by `leave` at one reading and a later reading, never by waiting.
- Boundaries are one minute either side: `last_seen` 30 days and a minute old is removed, 30 days less a minute stays, and the same for a tombstone's age.
- Removal is checked in the database (`agents`, `messages`, `codex_threads`, `codex_lifecycle`, `released_names`), as the token and name tests read it, and also in `list`.
- A sweep is triggered by `rig.restart()` for core start, and by a new wire session or a new Codex thread's SessionStart hook for registration.
- The tombstone refusal is `NAME_TAKEN` with a message containing `released`; the rest of the wording is left to the implementation.
- An agent online when the core stopped counts as online for the next start's sweep: a Pi session on a connection, whose stored `last_seen` is still its registration time, and a daemon-owned Codex thread, which stays online until the first snapshot after the start omits it (the `stale:` tests).
- The pre-change database is written by hand with the 0.1.24 schema from `packages/core/src/store.ts` at `4965387`, rather than by dropping a table from a current one, so any index the change adds is also missing.
- The reply socket test reads the removed agent's `claude_address` before the sweep and then checks that nothing accepts connections on that path.

## Detach

`tests/detach.test.ts` uses the real client and core over the rig's in-memory streams.
Self-detach must return `{ ok: true }` before ending the registered connection.
Detaching another connection must end the owner while leaving the caller usable, including repeated detach of an offline session.

## Narrow choices for the first specification

- Pi and Codex tool names are `comms_send`, `comms_list`, and `comms_name`.
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
The fake Claude inbox and core reply sockets live in `/tmp/cc-*`, while the fake daemon uses `/tmp/cxd-*`; each fixture removes its own directory.
No real harnesses, model servers, installation/download behavior, or cross-machine transports are exercised.
