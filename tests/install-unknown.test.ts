import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliRuntime } from "@cross-harness-comms/core/cli";

// `comms install pi` is gone: it fails as any unknown `install` argument does and writes nothing, even with a built Pi
// package beside the binary, which the removed command would have installed into the data directory.

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "comms-install-unknown-"));
  mkdirSync(join(root, "data"));
  mkdirSync(join(root, "bin", "plugins", "pi"), { recursive: true });
  writeFileSync(join(root, "bin", "plugins", "pi", "package.json"), JSON.stringify({ name: "cross-harness-comms", version: "0.1.0" }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function runtime(): CliRuntime {
  const refuse = (what: string) => async () => { throw new Error(`install must not ${what}`); };
  return {
    connect: refuse("connect to the core"), command: [join(root, "bin", "comms")], compiled: true,
    platform: {
      dataDirectory: () => join(root, "data"), socketAddress: () => "memory://comms", binaryName: () => "comms",
      processExecutable: async () => undefined, codexHome: () => join(root, "codex"),
      prepareListen: refuse("listen"), restrictAccess: refuse("change socket permissions"), watchParent: () => () => {},
    },
  };
}

async function cli(...argv: string[]) {
  let stdout = "", stderr = "";
  const exitCode = await runCli(argv, { stdin: (async function* () {})(), signal: new AbortController().signal,
    stdout: text => { stdout += text; }, stderr: text => { stderr += text; } }, runtime());
  return { exitCode, stdout, stderr };
}

test("install pi: fails like an unknown install argument and creates nothing in the data directory", async () => {
  const unknown = await cli("install", "no-such-harness");
  expect(unknown.exitCode).not.toBe(0);
  const pi = await cli("install", "pi");
  expect(pi).toEqual(unknown);
  expect(pi.stdout).toBe("");
  // The refusal must not offer pi as a supported integration.
  expect(pi.stderr).not.toMatch(/\bpi\b/i);
  expect(readdirSync(join(root, "data"), { recursive: true })).toEqual([]);
});

test("comms help no longer mentions install pi", async () => {
  const help = await cli("help");
  expect(help.exitCode).toBe(0);
  expect(help.stdout).toMatch(/^ {2}install <harness>\s+\S/m);
  expect(help.stdout).not.toMatch(/install pi\b/);
});
