import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliRuntime } from "@cross-harness-comms/core/cli";

// `comms install` is gone: with any arguments it fails exactly as any unknown command does, and writes nothing to the data
// directory or to Codex's config. Codex's home is a temporary directory, through both the platform and CODEX_HOME, so the
// real ~/.codex is never read or written.

let root: string;
let previous: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "comms-install-unknown-"));
  mkdirSync(join(root, "data"));
  mkdirSync(join(root, "codex"));
  previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(root, "codex");
});
afterEach(() => {
  if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
  rmSync(root, { recursive: true, force: true });
});

function runtime(): CliRuntime {
  const refuse = (what: string) => async () => { throw new Error(`an unknown command must not ${what}`); };
  return {
    connect: refuse("connect to the core"),
    platform: {
      dataDirectory: () => join(root, "data"), socketAddress: () => "memory://comms", binaryName: () => "comms",
      processExecutable: async () => undefined, codexHome: () => join(root, "codex"),
      prepareDataDirectory: refuse("prepare the data directory"), prepareListen: refuse("listen"), restrictAccess: refuse("change socket permissions"), watchParent: () => () => {},
    },
  };
}

async function cli(...argv: string[]) {
  let stdout = "", stderr = "";
  const exitCode = await runCli(argv, { stdin: (async function* () {})(), signal: new AbortController().signal,
    stdout: text => { stdout += text; }, stderr: text => { stderr += text; } }, runtime());
  return { exitCode, stdout, stderr };
}

for (const argv of [["install"], ["install", "claude"], ["install", "codex", "--allow-replies"], ["install", "pi"]]) {
  test(`comms ${argv.join(" ")} fails like an unknown command and writes nothing`, async () => {
    const unknown = await cli("no-such-command");
    expect(unknown.exitCode).not.toBe(0);
    expect(await cli(...argv)).toEqual(unknown);
    expect(readdirSync(join(root, "data"), { recursive: true })).toEqual([]);
    expect(existsSync(join(root, "codex", "config.toml"))).toBe(false);
  });
}

test("comms help does not mention install", async () => {
  const help = await cli("help");
  expect(help.exitCode).toBe(0);
  expect(help.stdout).not.toMatch(/^\s*install\b/m);
  expect(help.stdout).not.toMatch(/comms install/);
});
