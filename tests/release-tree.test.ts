import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RELEASE_VERSION } from "@cross-harness-comms/protocol";
import { launcherScript } from "../scripts/build.ts";

// `writeReleaseTree` writes the `release` branch: marketplaces named `comms` for Claude and Codex, the three plugins as the
// local build lays them out but with the launcher as each `bin/comms`, and a root package.json for a Git Pi install.
// It compiles nothing, so no file in the tree is a native binary.
// It runs in its own Bun process, as `bun scripts/build.ts release` runs it: bundling in the test process with the whole
// suite loaded intermittently failed with "Unexpected reading file" or killed the runner.

const checksums = { "darwin-arm64": "a".repeat(64), "darwin-x64": "b".repeat(64), "linux-arm64": "c".repeat(64), "linux-x64": "0123456789abcdef".repeat(4) };
let root: string, tree: string;
const json = (path: string) => JSON.parse(readFileSync(join(tree, path), "utf8"));
const repo = join(import.meta.dir, "..");

// Prints `written`, or `rejected:` and the error, so a missing export, which fails the import, is neither.
async function writeTree(outdir: string) {
  const script = `import { writeReleaseTree } from ${JSON.stringify(join(repo, "scripts", "build.ts"))};\n`
    + `try { await writeReleaseTree(${JSON.stringify(outdir)}, ${JSON.stringify(checksums)}); console.log("written"); }\n`
    + `catch (error) { console.log("rejected: " + (error instanceof Error ? error.message : String(error))); }\n`;
  const proc = Bun.spawn([process.execPath, "-e", script], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "comms-release-tree-"));
  tree = join(root, "tree");
  const result = await writeTree(tree);
  if (result.exitCode !== 0 || result.stdout.trim() !== "written") throw new Error(`writeReleaseTree failed:\n${result.stdout}${result.stderr}`);
}, 60_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

function files(directory: string): string[] {
  return (readdirSync(directory, { recursive: true }) as string[]).filter(entry => statSync(join(directory, entry)).isFile()).sort();
}

test("release tree: holds exactly the marketplaces, the root package.json, and the three plugins", () => {
  expect(files(tree)).toEqual([
    ".agents/plugins/marketplace.json",
    ".claude-plugin/marketplace.json",
    "package.json",
    "plugins/claude/.claude-plugin/plugin.json",
    "plugins/claude/bin/comms",
    "plugins/claude/hooks/hooks.json",
    "plugins/claude/hooks/register.js",
    "plugins/codex/.codex-plugin/plugin.json",
    "plugins/codex/.mcp.json",
    "plugins/codex/bin/comms",
    "plugins/codex/hooks/hooks.json",
    "plugins/pi/bin/comms",
    "plugins/pi/package.json",
    "plugins/pi/src/index.js",
  ]);
});

test("release tree: both marketplaces are named comms and point at the right plugin directories", () => {
  expect(json(".claude-plugin/marketplace.json")).toEqual({ name: "comms", owner: { name: "esmoradian" },
    plugins: [{ name: "cross-harness-comms", source: "./plugins/claude" }] });
  expect(json(".agents/plugins/marketplace.json")).toEqual({ name: "comms", plugins: [{ name: "cross-harness-comms",
    source: { source: "local", path: "./plugins/codex" }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" }] });
  expect(existsSync(join(tree, "plugins/claude/.claude-plugin/plugin.json"))).toBe(true);
  expect(existsSync(join(tree, "plugins/codex/.codex-plugin/plugin.json"))).toBe(true);
});

test("release tree: every plugin manifest carries RELEASE_VERSION, stamped after the name", () => {
  for (const [manifest, source] of [["plugins/claude/.claude-plugin/plugin.json", "adapters/claude/.claude-plugin/plugin.json"],
    ["plugins/codex/.codex-plugin/plugin.json", "adapters/codex/.codex-plugin/plugin.json"]] as const) {
    const { name, ...rest } = JSON.parse(readFileSync(join(repo, source), "utf8"));
    expect(JSON.stringify(json(manifest)), manifest).toBe(JSON.stringify({ name, version: RELEASE_VERSION, ...rest }));
  }
  expect(json("plugins/pi/package.json")).toEqual({ name: "@cross-harness-comms/pi", version: RELEASE_VERSION, type: "module",
    pi: { extensions: ["./src/index.js"] } });
});

test("release tree: hooks and the Codex MCP config are the adapters' own, and the bundles are built", () => {
  for (const [built, source] of [["plugins/claude/hooks/hooks.json", "adapters/claude/hooks/hooks.json"],
    ["plugins/codex/hooks/hooks.json", "adapters/codex/hooks/hooks.json"], ["plugins/codex/.mcp.json", "adapters/codex/.mcp.json"]] as const) {
    expect(readFileSync(join(tree, built), "utf8"), built).toBe(readFileSync(join(repo, source), "utf8"));
  }
  for (const bundle of ["plugins/claude/hooks/register.js", "plugins/pi/src/index.js"]) {
    expect(readFileSync(join(tree, bundle), "utf8"), bundle).toMatch(/\bexport\b/);
  }
  // The Pi bundle leaves pi-tui to the copy Pi provides, as the local build does.
  expect(readFileSync(join(tree, "plugins/pi/src/index.js"), "utf8")).toMatch(/\bfrom\s*["']@earendil-works\/pi-tui["']/);
});

test("release tree: each bin/comms is the executable launcher with the version and all four checksums", () => {
  for (const harness of ["claude", "codex", "pi"]) {
    const path = join(tree, "plugins", harness, "bin", "comms");
    const text = readFileSync(path, "utf8");
    expect(statSync(path).mode & 0o777, harness).toBe(0o755);
    expect(text.startsWith("#!/bin/sh\n"), harness).toBe(true);
    expect(text).toContain(RELEASE_VERSION);
    for (const checksum of Object.values(checksums)) expect(text, harness).toContain(checksum);
    expect(text, harness).toBe(launcherScript(RELEASE_VERSION, checksums));
  }
});

test("release tree: no file is a Mach-O or ELF binary", () => {
  const magic = ["7f454c46", "feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca"];
  for (const file of files(tree)) {
    const head = readFileSync(join(tree, file)).subarray(0, 4).toString("hex");
    expect(magic, file).not.toContain(head);
  }
});

test("release tree: the root package.json lets Pi install the branch from Git, naming an extension that exists", () => {
  expect(json("package.json")).toEqual({ name: "cross-harness-comms", version: RELEASE_VERSION, private: true, type: "module",
    pi: { extensions: ["./plugins/pi/src/index.js"] } });
  expect(statSync(join(tree, "plugins/pi/src/index.js")).isFile()).toBe(true);
});

test("release tree: refuses an output directory that already contains files", async () => {
  const occupied = join(root, "occupied");
  mkdirSync(occupied);
  writeFileSync(join(occupied, "keep.txt"), "mine\n");
  const result = await writeTree(occupied);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toStartWith("rejected: ");
  expect(readdirSync(occupied)).toEqual(["keep.txt"]);
});

test("release tree: accepts an existing empty output directory", async () => {
  const empty = join(root, "empty");
  mkdirSync(empty);
  const result = await writeTree(empty);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("written");
  expect(files(empty)).toEqual(files(tree));
});

// `main` carries hand-written marketplaces whose `git-subdir` sources point into the `release` branch, so
// `marketplace add owner/repo` works without naming a branch; each pointer must name a plugin directory the release tree has.
test("main marketplaces: point into the release branch at plugin directories the release tree writes", () => {
  const main = (path: string) => JSON.parse(readFileSync(join(repo, path), "utf8"));
  const pointer = (path: string) => ({ source: "git-subdir", url: "https://github.com/esmoradian/cross-harness-comms.git", path, ref: "release" });
  const claude = main(".claude-plugin/marketplace.json"), codex = main(".agents/plugins/marketplace.json");
  expect(claude).toEqual({ name: "comms", owner: { name: "esmoradian" }, plugins: [{ name: "cross-harness-comms", source: pointer("plugins/claude") }] });
  expect(codex).toEqual({ name: "comms", plugins: [{ name: "cross-harness-comms", source: pointer("plugins/codex"),
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" }] });
  expect(statSync(join(tree, claude.plugins[0].source.path, ".claude-plugin/plugin.json")).isFile()).toBe(true);
  expect(statSync(join(tree, codex.plugins[0].source.path, ".codex-plugin/plugin.json")).isFile()).toBe(true);
  const released = { claude: json(".claude-plugin/marketplace.json"), codex: json(".agents/plugins/marketplace.json") };
  for (const [ours, theirs] of [[claude, released.claude], [codex, released.codex]]) {
    expect(ours.name).toBe(theirs.name);
    expect(ours.plugins[0].name).toBe(theirs.plugins[0].name);
  }
  const { policy, category } = released.codex.plugins[0];
  expect(codex.plugins[0]).toMatchObject({ policy, category });
});
