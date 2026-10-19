import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { launcherScript } from "../scripts/build.ts";

// A released plugin's `bin/comms` is a POSIX sh launcher that downloads its pinned core from the GitHub release into
// `<data>/releases/<version>/comms`, checks its SHA-256, and execs it. These tests run a script from `launcherScript`
// against a fake release served through `COMMS_RELEASE_URL=file://...`, where each fake core is a small sh script that
// prints its target, PID, and arguments, copies stdin to stdout, and exits with `FAKE_CORE_EXIT`.
// Every run gets a built environment: a temporary HOME and data directory, and a PATH of system directories only, with a
// fake `uname` first, so the real ~/.local/share/comms and the network are never reached.

type Target = "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64";
const TARGETS: Target[] = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
const VERSION = "1.2.3";
const SYSTEM = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const UNAME: Record<Target, [string, string]> = {
  "darwin-arm64": ["Darwin", "arm64"], "darwin-x64": ["Darwin", "x86_64"], "linux-arm64": ["Linux", "aarch64"], "linux-x64": ["Linux", "x86_64"],
};

const sha256 = (content: string) => new Bun.CryptoHasher("sha256").update(content).digest("hex");
const core = (target: Target) => `#!/bin/sh\necho "core ${target} pid=$$"\nfor argument in "$@"; do echo "arg=[$argument]"; done\n`
  + `cat\nexit "\${FAKE_CORE_EXIT:-0}"\n`;
// What a fake core prints for these arguments and stdin.
const expected = (target: Target, pid: number, args: string[], stdin = "") =>
  `core ${target} pid=${pid}\n` + args.map(argument => `arg=[${argument}]\n`).join("") + stdin;

let root: string, assets: string, launcher: string, home: string, data: string, fakes: string;

function script(path: string, text: string) {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "comms-launcher-")));
  assets = join(root, "assets");
  mkdirSync(assets);
  const checksums = {} as Record<Target, string>;
  for (const target of TARGETS) {
    // Assets are not executable as served; the launcher makes its copy executable.
    writeFileSync(join(assets, `comms-${target}`), core(target), { mode: 0o644 });
    checksums[target] = sha256(core(target));
  }
  mkdirSync(join(root, "plugin", "bin"), { recursive: true });
  launcher = join(root, "plugin", "bin", "comms");
  script(launcher, launcherScript(VERSION, checksums));
  home = join(root, "home");
  mkdirSync(home);
  // Not created in advance: the launcher creates it.
  data = join(root, "data");
  fakes = join(root, "fakes");
  mkdirSync(join(fakes, "uname"), { recursive: true });
  script(join(fakes, "uname", "uname"),
    '#!/bin/sh\ncase "$1" in -s) echo "$FAKE_OS";; -m) echo "$FAKE_ARCH";; *) echo "fake uname: unexpected $*" >&2; exit 1;; esac\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// A directory linking every system command except `missing`, standing in for a machine without them.
function systemWithout(...missing: string[]): string {
  const directory = join(fakes, `without-${missing.join("-")}`);
  mkdirSync(directory, { recursive: true });
  for (const source of SYSTEM) {
    if (!existsSync(source)) continue;
    for (const name of readdirSync(source)) {
      if (missing.includes(name) || existsSync(join(directory, name))) continue;
      symlinkSync(join(source, name), join(directory, name));
    }
  }
  return directory;
}

interface Run { args?: string[]; stdin?: string; target?: Target; uname?: [string, string]; path?: string[]; env?: Record<string, string | undefined> }

async function run({ args = [], stdin = "", target = "darwin-arm64", uname = UNAME[target], path, env = {} }: Run = {}) {
  const variables: Record<string, string | undefined> = {
    PATH: (path ?? [join(fakes, "uname"), ...SYSTEM]).join(":"), HOME: home, COMMS_DATA_DIR: data,
    COMMS_RELEASE_URL: `file://${assets}`, FAKE_OS: uname[0], FAKE_ARCH: uname[1], ...env,
  };
  const proc = Bun.spawn([launcher, ...args], {
    env: Object.fromEntries(Object.entries(variables).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { pid: proc.pid, stdout, stderr, exitCode };
}

// Every file under a directory, relative to it, so temporary downloads show up wherever they are left.
function files(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return (readdirSync(directory, { recursive: true }) as string[]).filter(entry => statSync(join(directory, entry)).isFile())
    .map(entry => relative(directory, join(directory, entry))).sort();
}

const installed = (base = data) => join(base, "releases", VERSION, "comms");
const assetUrl = (target: Target) => `file://${assets}/comms-${target}`;

test("launcher: a first run downloads, verifies, installs, and execs the core with arguments, stdin, stdout, and exit code intact", async () => {
  const args = ["send", "two words", "", "$HOME *", "--flag=x"];
  const stdin = '{"hook_event_name":"SessionStart","session_id":"a"}\n{"second":"line"}\n';
  const result = await run({ args, stdin, env: { FAKE_CORE_EXIT: "7" } });
  expect(result.stderr).toBe("");
  // The core replaced the launcher process, so it has the launcher's PID, and nothing else reached stdout.
  expect(result.stdout).toBe(expected("darwin-arm64", result.pid, args, stdin));
  expect(result.exitCode).toBe(7);
  expect(files(data)).toEqual([`releases/${VERSION}/comms`]);
  expect(readFileSync(installed(), "utf8")).toBe(core("darwin-arm64"));
  expect(statSync(installed()).mode & 0o777).toBe(0o700);
  for (const directory of [data, join(data, "releases"), join(data, "releases", VERSION)]) {
    expect(statSync(directory).mode & 0o077, directory).toBe(0);
  }
});

test("launcher: a second run uses the installed core after the release asset is gone", async () => {
  expect((await run()).exitCode).toBe(0);
  rmSync(assets, { recursive: true, force: true });
  const result = await run({ args: ["version"], stdin: "again\n" });
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe(expected("darwin-arm64", result.pid, ["version"], "again\n"));
  expect(files(data)).toEqual([`releases/${VERSION}/comms`]);
});

test("launcher: without COMMS_DATA_DIR the data directory is $HOME/.local/share/comms", async () => {
  const result = await run({ args: ["ensure"], env: { COMMS_DATA_DIR: undefined } });
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe(expected("darwin-arm64", result.pid, ["ensure"]));
  expect(files(join(home, ".local", "share", "comms"))).toEqual([`releases/${VERSION}/comms`]);
  expect(existsSync(data)).toBe(false);
});

for (const [os, arch, target] of [
  ["Darwin", "arm64", "darwin-arm64"], ["Darwin", "x86_64", "darwin-x64"],
  ["Linux", "aarch64", "linux-arm64"], ["Linux", "arm64", "linux-arm64"], ["Linux", "x86_64", "linux-x64"],
] as const) {
  test(`launcher: uname ${os} ${arch} downloads comms-${target}`, async () => {
    const result = await run({ args: ["status"], uname: [os, arch] });
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(expected(target, result.pid, ["status"]));
    expect(readFileSync(installed(), "utf8")).toBe(core(target));
  });
}

for (const [os, arch] of [["Linux", "riscv64"], ["FreeBSD", "x86_64"], ["Darwin", "aarch64"], ["MINGW64_NT-10.0", "x86_64"]] as const) {
  test(`launcher: uname ${os} ${arch} is an unsupported platform and installs nothing`, async () => {
    const result = await run({ args: ["status"], uname: [os, arch] });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`comms: unsupported platform ${os} ${arch}\n`);
    expect(files(data)).toEqual([]);
  });
}

test("launcher: with the real uname it picks this machine's asset", async () => {
  const target = `${process.platform}-${process.arch}` as Target;
  expect(TARGETS).toContain(target);
  const result = await run({ args: ["version"], path: SYSTEM });
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe(expected(target, result.pid, ["version"]));
});

test("launcher: a checksum mismatch exits 1 with its message, installs nothing, and leaves no temporary file", async () => {
  writeFileSync(join(assets, "comms-darwin-arm64"), core("darwin-arm64") + "# tampered\n");
  const result = await run({ args: ["status"] });
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(`comms: checksum mismatch for ${assetUrl("darwin-arm64")}\n`);
  expect(files(data)).toEqual([]);
});

test("launcher: a missing asset exits 1 with its message, installs nothing, and leaves no temporary file", async () => {
  rmSync(join(assets, "comms-darwin-arm64"));
  const result = await run({ args: ["status"] });
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(`comms: could not download the comms core ${VERSION} from ${assetUrl("darwin-arm64")}\n`);
  expect(files(data)).toEqual([]);
});

test("launcher: eight concurrent first runs all succeed and leave exactly one installed core and no temporary files", async () => {
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => run({ args: ["attach", String(index)], stdin: `run ${index}\n` })));
  results.forEach((result, index) => {
    expect(result.stderr, `run ${index}`).toBe("");
    expect(result.exitCode, `run ${index}`).toBe(0);
    expect(result.stdout).toBe(expected("darwin-arm64", result.pid, ["attach", String(index)], `run ${index}\n`));
  });
  expect(files(data)).toEqual([`releases/${VERSION}/comms`]);
  expect(readFileSync(installed(), "utf8")).toBe(core("darwin-arm64"));
});

test("launcher: without curl it exits 1 with its message and installs nothing", async () => {
  const result = await run({ path: [join(fakes, "uname"), systemWithout("curl")] });
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("comms: curl is required to download the comms core\n");
  expect(files(data)).toEqual([]);
});

test("launcher: without shasum or sha256sum it exits 1 with its message and installs nothing", async () => {
  const result = await run({ path: [join(fakes, "uname"), systemWithout("shasum", "sha256sum")] });
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("comms: shasum or sha256sum is required to verify the comms core\n");
  expect(files(data)).toEqual([]);
});

const hasSha256sum = SYSTEM.some(directory => existsSync(join(directory, "sha256sum")));
test.skipIf(!hasSha256sum)("launcher: without shasum it verifies with sha256sum", async () => {
  const result = await run({ args: ["version"], path: [join(fakes, "uname"), systemWithout("shasum")] });
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe(expected("darwin-arm64", result.pid, ["version"]));
  expect(files(data)).toEqual([`releases/${VERSION}/comms`]);
});

test("launcher: by default it downloads from the GitHub release with the agreed curl options, without letting curl read stdin", async () => {
  // A recording curl that fails, so nothing is fetched and the GitHub URL is only observed.
  mkdirSync(join(fakes, "curl"));
  const log = join(root, "curl.log");
  script(join(fakes, "curl", "curl"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\ncat > "${log}.stdin"\nexit 22\n`);
  const result = await run({ args: ["session-start"], stdin: '{"hook_event_name":"SessionStart"}\n',
    path: [join(fakes, "uname"), join(fakes, "curl"), ...SYSTEM], env: { COMMS_RELEASE_URL: undefined } });
  const url = `https://github.com/esmoradian/cross-harness-comms/releases/download/v${VERSION}/comms-darwin-arm64`;
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(`comms: could not download the comms core ${VERSION} from ${url}\n`);
  const args = readFileSync(log, "utf8").split("\n").slice(0, -1);
  expect(args).toContain(url);
  expect(args).toContain("-fsSL");
  expect(args[args.indexOf("--retry") + 1]).toBe("2");
  expect(args[args.indexOf("--connect-timeout") + 1]).toBe("10");
  expect(readFileSync(`${log}.stdin`, "utf8")).toBe("");
  expect(files(data)).toEqual([]);
});

test("launcherScript: starts with #!/bin/sh and carries the version and every checksum", () => {
  const checksums = { "darwin-arm64": "a".repeat(64), "darwin-x64": "b".repeat(64), "linux-arm64": "c".repeat(64), "linux-x64": "0123456789abcdef".repeat(4) };
  const text = launcherScript("0.2.0", checksums);
  expect(text.startsWith("#!/bin/sh\n")).toBe(true);
  expect(text).toContain("0.2.0");
  for (const checksum of Object.values(checksums)) expect(text).toContain(checksum);
});

test("launcherScript: rejects a version that is not plain MAJOR.MINOR.PATCH", () => {
  const checksums = Object.fromEntries(TARGETS.map(target => [target, "a".repeat(64)])) as Record<Target, string>;
  for (const version of ["0.2.0-dev.1", "0.2.0+build.5", "v0.2.0", "0.2", "0.2.0.1", "../0.2.0", "0.2.0\n", ""]) {
    expect(() => launcherScript(version, checksums), JSON.stringify(version)).toThrow();
  }
});

test("launcherScript: rejects a checksum that is not 64 lowercase hex characters", () => {
  const good = "a".repeat(64);
  for (const bad of ["A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64), `${"a".repeat(63)}\n`, `${"a".repeat(32)} ${"a".repeat(31)}`, ""]) {
    const checksums = { "darwin-arm64": good, "darwin-x64": good, "linux-arm64": bad, "linux-x64": good };
    expect(() => launcherScript("0.2.0", checksums), JSON.stringify(bad)).toThrow();
  }
});
