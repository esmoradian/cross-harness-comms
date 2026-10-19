import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliRuntime } from "@cross-harness-comms/core/cli";
import { createUnixPlatform } from "../packages/core/src/platform/unix.ts";

// The Unix platform's `prepareDataDirectory` is the one data-directory check, used by `comms ensure` and `comms serve`.
// Each test points COMMS_DATA_DIR at a temporary path, so the real data directory is never touched. The CLI runtime's
// command is a path that does not exist and its transport refuses to connect, so no core starts.

let root: string;
let previous: string | undefined;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "comms-data-directory-")));
  previous = process.env.COMMS_DATA_DIR;
});
afterEach(() => {
  if (previous === undefined) delete process.env.COMMS_DATA_DIR; else process.env.COMMS_DATA_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

function platform(directory: string) {
  process.env.COMMS_DATA_DIR = directory;
  return createUnixPlatform();
}
const mode = (path: string) => statSync(path).mode & 0o777;

// A symlink to a real directory of this user's, and a regular file.
function symlinked() {
  mkdirSync(join(root, "target"), { mode: 0o755 });
  chmodSync(join(root, "target"), 0o755);
  symlinkSync(join(root, "target"), join(root, "data"));
  return join(root, "data");
}
function file() {
  writeFileSync(join(root, "data"), "not a directory");
  return join(root, "data");
}

test("prepareDataDirectory creates a missing data directory with mode 0700 and returns its path", async () => {
  const directory = join(root, "nested", "data");
  expect(await platform(directory).prepareDataDirectory()).toBe(directory);
  expect(statSync(directory).isDirectory()).toBe(true);
  expect(mode(directory)).toBe(0o700);
});

test("prepareDataDirectory tightens an existing directory with a looser mode to 0700", async () => {
  const directory = join(root, "data");
  mkdirSync(directory);
  chmodSync(directory, 0o755);
  expect(await platform(directory).prepareDataDirectory()).toBe(directory);
  expect(mode(directory)).toBe(0o700);
});

test("prepareDataDirectory refuses a symlinked data directory and leaves its target alone", async () => {
  const directory = symlinked();
  await expect(platform(directory).prepareDataDirectory()).rejects.toThrow("Unsafe comms data directory");
  expect(mode(join(root, "target"))).toBe(0o755);
  expect(readdirSync(join(root, "target"))).toEqual([]);
});

test("prepareDataDirectory refuses a data directory path that is not a directory", async () => {
  const directory = file();
  await expect(platform(directory).prepareDataDirectory()).rejects.toThrow("Unsafe comms data directory");
  expect(Bun.file(directory).size).toBe("not a directory".length);
});

// Another user's directory, without root: a system directory owned by root. Run as root, it would be this user's.
const rootOwned = "/usr";
test.skipIf(process.getuid?.() === 0 || statSync(rootOwned).uid === process.getuid?.())(
  "prepareDataDirectory refuses a directory owned by another user", async () => {
    await expect(platform(rootOwned).prepareDataDirectory()).rejects.toThrow("Unsafe comms data directory");
  });

test("prepareListen leaves the data directory alone", async () => {
  const directory = join(root, "data");
  mkdirSync(directory);
  chmodSync(directory, 0o755);
  await platform(directory).prepareListen();
  expect(mode(directory)).toBe(0o755);
  const missing = join(root, "missing");
  await platform(missing).prepareListen();
  expect(existsSync(missing)).toBe(false);
});

async function cli(command: string, directory: string) {
  const runtime: CliRuntime = {
    platform: platform(directory), command: [join(root, "no-such-comms")],
    connect: async () => { throw new Error("no core in this test"); },
  };
  let stdout = "", stderr = "";
  const abort = new AbortController();
  const exitCode = await runCli([command], { stdin: (async function* () {})(), signal: abort.signal,
    stdout: text => { stdout += text; }, stderr: text => { stderr += text; } }, runtime);
  return { exitCode, stdout, stderr };
}

for (const command of ["ensure", "serve"]) {
  test(`comms ${command} refuses a symlinked data directory and writes nothing through it`, async () => {
    const result = await cli(command, symlinked());
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Unsafe comms data directory");
    expect(readdirSync(join(root, "target"))).toEqual([]);
    expect(mode(join(root, "target"))).toBe(0o755);
  });

  test(`comms ${command} refuses a data directory path that is not a directory`, async () => {
    const result = await cli(command, file());
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Unsafe comms data directory");
  });
}

test.skipIf(process.getuid?.() === 0 || statSync(rootOwned).uid === process.getuid?.())(
  "comms ensure refuses a data directory owned by another user", async () => {
    const result = await cli("ensure", rootOwned);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Unsafe comms data directory");
  });

test("comms ensure tightens a data directory with a looser mode to 0700", async () => {
  const directory = join(root, "data");
  mkdirSync(directory);
  chmodSync(directory, 0o755);
  // It goes on to fail starting the missing core command; the directory is prepared first.
  expect((await cli("ensure", directory)).exitCode).not.toBe(0);
  expect(mode(directory)).toBe(0o700);
});
