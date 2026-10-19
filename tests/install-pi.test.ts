import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliRuntime } from "@cross-harness-comms/core/cli";

// HANDOFF-PI-LIVE-SUBAGENTS: `comms install pi` copies the built Pi package, `plugins/pi` beside the compiled binary (as
// `dist/comms` sits beside `dist/plugins/pi`), to `<data directory>/pi/<version>/`, where the version is the copied
// package's own `package.json` version; it points the symlink `<data directory>/pi/current` at it atomically, keeps the two
// newest versions and deletes older ones, and prints the `current` path to put in Pi's settings `packages`.
// The data directory is the platform's (`~/.local/share/comms` on Unix). Every test uses a temporary home, through both
// the platform and HOME, so the real ~/.local/share/comms and ~/.pi are never read or written.

let home: string;
let previousHome: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "comms-pi-home-"));
  previousHome = process.env.HOME;
  process.env.HOME = home;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

const data = () => join(home, ".local", "share", "comms");
const installs = () => join(data(), "pi");
const current = () => join(installs(), "current");

// A built `dist/` with the compiled binary and the Pi package as `bun run build` lays them out.
function dist(version: string, marker = "extension"): string {
  const root = mkdtempSync(join(home, "dist-"));
  writeFileSync(join(root, "comms"), "#!/bin/sh\necho dist comms\n");
  chmodSync(join(root, "comms"), 0o755);
  const pkg = join(root, "plugins", "pi");
  mkdirSync(join(pkg, "src"), { recursive: true });
  mkdirSync(join(pkg, "bin"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@cross-harness-comms/pi", version, type: "module", pi: { extensions: ["./src/index.js"] } }, null, 2) + "\n");
  writeFileSync(join(pkg, "src", "index.js"), `export default function extension() {} // ${marker} ${version}\n`);
  writeFileSync(join(pkg, "bin", "comms"), `#!/bin/sh\necho comms ${version}\n`);
  chmodSync(join(pkg, "bin", "comms"), 0o755);
  return root;
}

function runtime(root: string): CliRuntime {
  return {
    connect: async () => { throw new Error("install must not connect to the core"); },
    compiled: true, command: [join(root, "comms")],
    platform: {
      dataDirectory: data, socketAddress: () => join(data(), "comms.sock"), binaryName: () => "comms",
      processExecutable: async () => undefined, codexHome: () => join(home, ".codex"),
      prepareListen: async () => { throw new Error("Unit tests must not listen"); },
      restrictAccess: async () => { throw new Error("Unit tests must not change socket permissions"); },
      watchParent: () => () => {},
    },
  };
}

async function install(root: string) {
  let stdout = "", stderr = "";
  async function* stdin() {}
  const exitCode = await runCli(["install", "pi"], { stdin: stdin(), signal: new AbortController().signal,
    stdout: text => { stdout += text; }, stderr: text => { stderr += text; } }, runtime(root));
  return { exitCode, stdout, stderr };
}

const versions = () => readdirSync(installs()).filter(entry => entry !== "current").sort();
const points = () => realpathSync(current());

test("install pi: copies the built Pi package to pi/<version>, with its bin/comms still executable", async () => {
  const root = dist("0.1.27");
  const result = await install(root);
  expect(result.exitCode, result.stderr).toBe(0);
  const installed = join(installs(), "0.1.27");
  for (const file of ["package.json", "src/index.js", "bin/comms"]) {
    expect(readFileSync(join(installed, file), "utf8"), file).toBe(readFileSync(join(root, "plugins", "pi", file), "utf8"));
  }
  expect(statSync(join(installed, "bin", "comms")).mode & 0o111).not.toBe(0);
  // The source is copied, not linked, so rebuilding dist leaves the installed package alone.
  expect(lstatSync(installed).isSymbolicLink()).toBe(false);
  rmSync(root, { recursive: true, force: true });
  expect(existsSync(join(installed, "src", "index.js"))).toBe(true);
});

test("install pi: points the current symlink at the installed version and prints its path for Pi's settings packages", async () => {
  const result = await install(dist("0.1.27"));
  expect(result.exitCode, result.stderr).toBe(0);
  expect(lstatSync(current()).isSymbolicLink()).toBe(true);
  expect(points()).toBe(realpathSync(join(installs(), "0.1.27")));
  expect(result.stdout).toContain(current());
  expect(result.stdout).toMatch(/packages/);
  expect(readFileSync(join(current(), "package.json"), "utf8")).toContain('"version": "0.1.27"');
});

test("install pi: a newer install switches current and leaves no temporary entries beside the versions", async () => {
  expect((await install(dist("0.1.27"))).exitCode).toBe(0);
  const result = await install(dist("0.1.28"));
  expect(result.exitCode, result.stderr).toBe(0);
  expect(lstatSync(current()).isSymbolicLink()).toBe(true);
  expect(points()).toBe(realpathSync(join(installs(), "0.1.28")));
  expect(readdirSync(installs()).sort()).toEqual(["0.1.27", "0.1.28", "current"]);
  expect(result.stdout).toContain(current());
});

test("install pi: keeps the two newest versions by version order and deletes older ones", async () => {
  // Earlier installs, where lexical order would wrongly put 0.1.9 after 0.1.10.
  for (const version of ["0.1.9", "0.1.10"]) {
    mkdirSync(join(installs(), version, "src"), { recursive: true });
    writeFileSync(join(installs(), version, "src", "index.js"), `// ${version}\n`);
  }
  expect((await install(dist("0.1.27"))).exitCode).toBe(0);
  expect(versions()).toEqual(["0.1.10", "0.1.27"]);
  expect((await install(dist("0.1.28"))).exitCode).toBe(0);
  expect(versions()).toEqual(["0.1.27", "0.1.28"]);
  expect((await install(dist("0.2.0"))).exitCode).toBe(0);
  expect(versions()).toEqual(["0.1.28", "0.2.0"]);
  expect(points()).toBe(realpathSync(join(installs(), "0.2.0")));
});

test("install pi: reinstalling the same version replaces its contents and keeps current on it", async () => {
  expect((await install(dist("0.1.27", "first"))).exitCode).toBe(0);
  const result = await install(dist("0.1.27", "second"));
  expect(result.exitCode, result.stderr).toBe(0);
  expect(readFileSync(join(current(), "src", "index.js"), "utf8")).toContain("second 0.1.27");
  expect(versions()).toEqual(["0.1.27"]);
});

test("install pi: installing an older version than those kept still leaves current pointing at an installed copy", async () => {
  expect((await install(dist("0.1.28"))).exitCode).toBe(0);
  expect((await install(dist("0.1.29"))).exitCode).toBe(0);
  const result = await install(dist("0.1.27"));
  expect(result.exitCode, result.stderr).toBe(0);
  expect(points()).toBe(realpathSync(join(installs(), "0.1.27")));
  expect(readFileSync(join(current(), "package.json"), "utf8")).toContain('"version": "0.1.27"');
});

test("install pi: without a built Pi package beside the binary it fails, says where it looked, and installs nothing", async () => {
  const root = dist("0.1.27");
  rmSync(join(root, "plugins"), { recursive: true, force: true });
  const result = await install(root);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(join(root, "plugins", "pi"));
  expect(existsSync(current())).toBe(false);
});
