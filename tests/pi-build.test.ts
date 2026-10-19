import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The built Pi extension imports @earendil-works/pi-tui from the copy Pi provides instead of bundling it.
// The build runs in its own Bun process: a second in-process Bun.build with the whole suite loaded intermittently failed with
// EISDIR or "Could not resolve", or crashed the runner on a guarded file descriptor (Bun 1.3.13).

const repo = join(import.meta.dir, "..");

test("the built pi extension keeps @earendil-works/pi-tui as an external import", async () => {
  const directory = mkdtempSync(join(tmpdir(), "comms-pi-build-"));
  try {
    const script = `import { buildPiExtension } from ${JSON.stringify(join(repo, "scripts", "build.ts"))};\n`
      + `await buildPiExtension(${JSON.stringify(directory)});\n`;
    const proc = Bun.spawn([process.execPath, "-e", script], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const output = readFileSync(join(directory, "index.js"), "utf8");
    expect(output).toMatch(/\bfrom\s*["']@earendil-works\/pi-tui["']/);
    for (const helper of ["truncateToWidth", "visibleWidth", "wrapTextWithAnsi"]) {
      expect(output).not.toMatch(new RegExp(`function\\s+${helper}\\s*\\(`));
    }
    expect(output).not.toContain("get-east-asian-width");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
