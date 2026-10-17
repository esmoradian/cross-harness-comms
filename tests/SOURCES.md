# Harness fake sources and test contract

These unit fakes reproduce only the host APIs the adapters use.
They record calls and delegate transport to product code; they do not route messages or maintain mailboxes themselves.
The product exports initially throw `new Error("not implemented")`.

## Pi

Source: [Pi extension documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md), checked against the installed 0.85.1 copy under `/opt/homebrew/Cellar/pi-coding-agent/0.85.1/libexec/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`.
Relevant sections are `session_start`, `session_shutdown`, `pi.registerTool`, and `pi.sendMessage`.

- Registration uses `pi.on(event, handler)` and `pi.registerTool(definition)`.
- The tool executes with `(toolCallId, params, signal, onUpdate, ctx)`.
- Identity comes from `ctx.sessionManager.getSessionId()`.
- `pi.sendMessage(message, options)` accepts a custom message and returns void, so acceptance is a successful synchronous call.
- `triggerTurn: true` requests a follow-up; the tests accept either documented `followUp` or `steer` delivery.
- `parameters` is deliberately opaque in the structural subset; the fake does not claim to validate or implement TypeBox schemas.
- The `sendUserMessage` recorder detects accidental use of the user channel.

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

The fake intentionally splits output into seven-character chunks.
Both process methods call the actual `runCli` export in process, including `ensure`, `attach`, `send`, and `ack`.
No real subprocess is launched.
The fake implements neither the engine's permission dialogs nor its native message transport.
Native path tests check the exact event and result objects passed through middleware.

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
- Claude replies to a marked comms address use `message: 'comms-reply:' + JSON.stringify({ text, reply_to })` because its native schema has no `reply_to` argument.
  Plain messages remain plain text, and unmarked recipients are never parsed or intercepted.
  The adapter must explain this convention through the host's tool-description extension when implemented.
- Claude's native listing remains text; this suite tests appending comms peers but does not fabricate native session IDs for deduplication.
- Formatting lives in the I/O-free protocol package so Claude can share it without importing Node.
- `hello` without `session` negotiates only and creates no agent or presence.
  It lets one-shot CLI connections authenticate `send` or `ack` with the live attachment's token without creating a second session attachment.
- `attach` reads `HelloParams` from stdin and writes JSON-RPC response and notification lines.
  `send` and `ack` read their protocol parameter objects from stdin and write a protocol response, without echoing the token.
- JSON-RPC application failures carry a symbolic `error.data.code`; the suite does not allocate numeric application error codes.
  Missing/invalid credentials use `INVALID_TOKEN`, and acknowledging another recipient's message uses `FORBIDDEN`.
- Unknown identity fields cannot override native session identity or token ownership.
- Codex errors at the MCP tool boundary use `isError: true` and explain the missing `thread_id`.
- Pi's custom message type is `cross-harness-message`.
  Claude omits `asUser`; Codex has only a text queue interface, so provenance comes from the shared wrapper.
- Synthetic protocol versions 100 and 101 exercise older wire shapes while storing the canonical current message shape.
  They are fixtures, not planned release versions; production starts at version 1 with no conversion steps.
- The SQLite assertions use the documented table and column names and stored insertion order.
  They check committed visibility and restart persistence, not power-loss behavior or fsync policy.

No socket listeners, real harnesses, model servers, installation/download behavior, or cross-machine transports are exercised.
