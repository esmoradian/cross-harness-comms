import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiAPI } from "../adapters/pi/src/index.ts";
import { FakePi } from "./support/fakes/pi.ts";
import { uuid } from "./support/helpers.ts";

// The Pi package runs only its own `bin/comms`, never a `comms` on PATH. The extension is built as the release builds it,
// into a package laid out like the published one (`src/index.js` beside `bin/comms`), since its binary is found relative to
// the module. The build runs in its own Bun process, as in `pi-build.test.ts`. Pi provides pi-tui, so the package's
// node_modules links the repo's copy. Both `comms` are scripts that record that they ran and fail, so no core starts.

const repo = join(import.meta.dir, "..");
let root: string, bundled: string, onPath: string, ran: string, previousPath: string | undefined;
let extension: (pi: PiAPI) => void;

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "comms-pi-binary-")));
  const pkg = join(root, "package");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  mkdirSync(join(pkg, "node_modules", "@earendil-works"), { recursive: true });
  symlinkSync(realpathSync(join(repo, "node_modules", "@earendil-works", "pi-tui")), join(pkg, "node_modules", "@earendil-works", "pi-tui"));
  const script = `import { buildPiExtension } from ${JSON.stringify(join(repo, "scripts", "build.ts"))};\n`
    + `await buildPiExtension(${JSON.stringify(join(pkg, "src"))});\n`;
  const proc = Bun.spawn([process.execPath, "-e", script], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode) throw new Error(`Pi build failed: ${stderr}`);
  bundled = join(pkg, "bin", "comms");
  onPath = join(root, "path", "comms");
  ran = join(root, "ran");
  mkdirSync(join(root, "path"));
  extension = (await import(join(pkg, "src", "index.js"))).default;
  previousPath = process.env.PATH;
  process.env.PATH = `${join(root, "path")}:/usr/bin:/bin`;
}, 60_000);

afterAll(() => {
  process.env.PATH = previousPath;
  rmSync(root, { recursive: true, force: true });
});

// A `comms` that appends `label` to the record and fails with `label` on stderr.
function fakeComms(path: string, label: string) {
  writeFileSync(path, `#!/bin/sh\necho ${label} >> '${ran}'\necho ${label} >&2\nexit 1\n`);
  chmodSync(path, 0o755);
}
const record = () => existsSync(ran) ? Bun.file(ran).text() : Promise.resolve("");

beforeEach(() => {
  rmSync(ran, { force: true });
  rmSync(bundled, { force: true });
  fakeComms(onPath, "path");
});

test("pi runs the package's own bin/comms even when a different comms is first on PATH", async () => {
  fakeComms(bundled, "bundled");
  const pi = new FakePi(uuid(), "/projects/shared");
  extension(pi);
  await expect(pi.emit("session_start")).rejects.toThrow("bundled");
  expect(await record()).toBe("bundled\n");
});

test("pi without bin/comms fails on its first run with an error naming the missing path, without falling back to PATH", async () => {
  const pi = new FakePi(uuid(), "/projects/shared");
  extension(pi);
  await expect(pi.emit("session_start")).rejects.toThrow(bundled);
  expect(await record()).toBe("");
});
