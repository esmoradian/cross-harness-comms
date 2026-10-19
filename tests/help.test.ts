import { expect, test } from "bun:test";
import { runCli, type CliRuntime } from "@cross-harness-comms/core/cli";

// `comms help` lists the commands people run, then those the harness plugins run, each once with its existing description.

const PEOPLE: Record<string, string> = {
  list: "List agents and presence as JSON; optional JSON stdin: token, include_stale",
  status: "Show core and protocol versions",
  "inspect <message-id>": "Inspect delivery state",
  "rename <address> <name>": "Rename an agent",
  version: "Print binary version",
  help: "Show this help",
};
const PLUGINS: Record<string, string> = {
  ensure: "Install/start the newest local core; print its address",
  serve: "Run the core until interrupted",
  attach: "Register from JSON stdin and stream protocol packets",
  send: "Send JSON on stdin: token, id, to, body, optional reply_to",
  ack: "Acknowledge JSON on stdin: token, id",
  "native-ack": "Acknowledge a native Claude inbox line, JSON on stdin: token, from",
  detach: "Close a session using its token on stdin",
  resolve: "Find the agent named exactly, JSON on stdin: name, optional token, skip_claude",
  "name <name>": "Choose this session's name, using its token on stdin",
  mcp: "Run the Codex MCP server over stdio",
  "session-start": "Mark a Codex thread online from its SessionStart hook JSON",
  "session-end": "Mark a Codex thread offline from its SessionEnd hook JSON",
};
const COMMANDS = "Commands:", PLUGIN_COMMANDS = "Used by the harness plugins:";

async function help(): Promise<string[]> {
  const refuse = async () => { throw new Error("help must not touch the platform or the core"); };
  const runtime = { connect: refuse, platform: new Proxy({}, { get: () => refuse }) } as unknown as CliRuntime;
  let stdout = "";
  const exitCode = await runCli(["help"], { stdin: (async function* () {})(), signal: new AbortController().signal,
    stdout: text => { stdout += text; }, stderr: () => {} }, runtime);
  expect(exitCode).toBe(0);
  return stdout.split("\n");
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The command an entry line names, when the line is exactly that command and its description.
function entry(line: string): string {
  const all = { ...PEOPLE, ...PLUGINS };
  return Object.keys(all).find(command => new RegExp(`^\\s+${escape(command)}\\s+${escape(all[command]!)}$`).test(line)) ?? line;
}

test("comms help has a Commands section after Usage, then a section for the harness plugins", async () => {
  const lines = await help();
  const usage = lines.findIndex(line => line.startsWith("Usage:"));
  const people = lines.findIndex(line => line.trim() === COMMANDS);
  const plugins = lines.findIndex(line => line.trim() === PLUGIN_COMMANDS);
  expect(usage).toBeGreaterThanOrEqual(0);
  expect(people).toBeGreaterThan(usage);
  expect(plugins).toBeGreaterThan(people);
  expect(lines.filter(line => line.trim() === COMMANDS)).toHaveLength(1);
  expect(lines.filter(line => line.trim() === PLUGIN_COMMANDS)).toHaveLength(1);
  // Nothing but the two headings, blank lines, and their entries follows the Usage line.
  const section = (from: number, to: number) => lines.slice(from + 1, to).filter(line => line.trim()).map(entry);
  expect(lines.slice(usage + 1, people).filter(line => line.trim())).toEqual([]);
  expect(section(people, plugins).sort()).toEqual(Object.keys(PEOPLE).sort());
  expect(section(plugins, lines.length).sort()).toEqual(Object.keys(PLUGINS).sort());
});
