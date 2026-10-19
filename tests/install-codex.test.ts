import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliRuntime } from "@cross-harness-comms/core/cli";

// `comms install codex` offers the standing approval for the plugin's comms_send tool, and
// `--allow-replies` appends it to $CODEX_HOME/config.toml without touching the rest of the file.
// Every test uses a temporary CODEX_HOME, through both the platform and the environment, so the real
// ~/.codex is never read or written.

// Keyed on the published plugin; a local build's `@comms-local` approval is declared elsewhere.
const HEADER = '[plugins."cross-harness-comms@comms".mcp_servers.comms.tools.comms_send]';
const SECTION = `${HEADER}\napproval_mode = "approve"`;
// The published install, which `comms install codex` prints, each command on a line of its own, before it offers the standing approval.
const PUBLISHED = ["codex plugin marketplace add esmoradian/cross-harness-comms --ref release", "codex plugin add cross-harness-comms@comms"];

let home: string;
let previous: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "comms-codex-home-"));
  previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
});
afterEach(() => {
  if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
  rmSync(home, { recursive: true, force: true });
});

function runtime(): CliRuntime {
  return {
    connect: async () => { throw new Error("install must not connect to the core"); },
    platform: {
      dataDirectory: () => join(home, "comms-data"), socketAddress: () => "memory://comms", binaryName: () => "comms",
      processExecutable: async () => undefined, codexHome: () => home,
      prepareListen: async () => { throw new Error("Unit tests must not listen"); },
      restrictAccess: async () => { throw new Error("Unit tests must not change socket permissions"); },
      watchParent: () => () => {},
      publishLink: async () => { throw new Error("Codex setup must not publish a Pi package"); },
    },
  };
}

async function install(...flags: string[]) {
  let stdout = "", stderr = "";
  async function* stdin() {}
  const exitCode = await runCli(["install", "codex", ...flags], { stdin: stdin(), signal: new AbortController().signal,
    stdout: text => { stdout += text; }, stderr: text => { stderr += text; } }, runtime());
  return { exitCode, stdout, stderr };
}

const config = () => join(home, "config.toml");
// One comment line, then the section, ending in a newline.
const APPENDED = new RegExp(`^# [^\\n]+\\n${HEADER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\napproval_mode = "approve"\\n$`);

function approval(text: string): unknown {
  const parsed = Bun.TOML.parse(text) as { plugins?: Record<string, { mcp_servers?: { comms?: { tools?: { comms_send?: { approval_mode?: unknown } } } } }> };
  return parsed.plugins?.["cross-harness-comms@comms"]?.mcp_servers?.comms?.tools?.comms_send?.approval_mode;
}

test("install codex: prints the published install commands, then offers the reply approval section and --allow-replies, changing nothing", async () => {
  const result = await install();
  expect(result.exitCode).toBe(0);
  const lines = result.stdout.split("\n").map(line => line.trim());
  const [marketplace, plugin] = PUBLISHED.map(command => lines.indexOf(command));
  expect(marketplace).toBeGreaterThanOrEqual(0);
  expect(plugin).toBeGreaterThan(marketplace!);
  // The dist-based local instructions are gone, and the approval names the published plugin.
  expect(result.stdout).not.toMatch(/\bdist\b|comms-local/);
  const offer = lines.slice(plugin! + 1).join("\n");
  expect(offer).toContain(SECTION + "\n");
  expect(offer).toContain("comms install codex --allow-replies");
  expect(existsSync(config())).toBe(false);
});

test("install codex --allow-replies: creates a missing config.toml with the commented section and says so", async () => {
  const result = await install("--allow-replies");
  expect(result.exitCode).toBe(0);
  expect(existsSync(config())).toBe(true);
  const text = readFileSync(config(), "utf8");
  expect(text).toMatch(APPENDED);
  expect(approval(text)).toBe("approve");
  expect(result.stdout).toContain(config());
});

const existing = 'model = "gpt-5.5"\napprovals_reviewer = "auto_review"\n\n# Local plugins, kept   as written\n'
  + '[plugins."cross-harness-comms@comms-local"]\nenabled = true\n\n[mcp_servers.other]\ncommand = "other"\nargs = ["--flag", "é 🐾"]';

for (const [label, original] of [["ending in a newline", existing + "\n"], ["without a final newline", existing]] as const) {
  test(`install codex --allow-replies: appends the section to a config.toml ${label}, preserving it byte for byte`, async () => {
    writeFileSync(config(), original);
    const result = await install("--allow-replies");
    expect(result.exitCode).toBe(0);
    const text = readFileSync(config(), "utf8");
    expect(text.startsWith(original)).toBe(true);
    const added = text.slice(original.length);
    expect(added.replace(/^\n+/, "")).toMatch(APPENDED);
    // The comment starts on a line of its own.
    expect((original + added.match(/^\n*/)![0]).endsWith("\n")).toBe(true);
    const parsed = Bun.TOML.parse(text) as { model?: unknown; mcp_servers?: { other?: unknown } };
    expect(parsed.model).toBe("gpt-5.5");
    expect(parsed.mcp_servers?.other).toEqual({ command: "other", args: ["--flag", "é 🐾"] });
    expect(approval(text)).toBe("approve");
    expect(result.stdout).toContain(config());
  });
}

test("install codex --allow-replies: a config.toml that already has the section is left unchanged", async () => {
  const original = 'model = "gpt-5.5"\n\n# Let agents reply through comms.\n' + SECTION + '\n\n[mcp_servers.other]\ncommand = "other"\n';
  writeFileSync(config(), original);
  const result = await install("--allow-replies");
  expect(result.exitCode).toBe(0);
  expect(readFileSync(config(), "utf8")).toBe(original);
  expect(result.stdout).toMatch(/already/i);
});

test("install codex --allow-replies: a config.toml with only the local build's approval still gets the published one", async () => {
  const local = '[plugins."cross-harness-comms@comms-local".mcp_servers.comms.tools.comms_send]\napproval_mode = "approve"\n';
  writeFileSync(config(), local);
  const result = await install("--allow-replies");
  expect(result.exitCode).toBe(0);
  const text = readFileSync(config(), "utf8");
  expect(text.startsWith(local)).toBe(true);
  expect(text.slice(local.length).replace(/^\n+/, "")).toMatch(APPENDED);
  expect(approval(text)).toBe("approve");
});
