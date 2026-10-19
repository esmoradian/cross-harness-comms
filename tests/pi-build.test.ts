import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPiExtension } from "../scripts/build.ts";

// The built Pi extension imports @earendil-works/pi-tui from the copy Pi provides instead of bundling it.

test("the built pi extension keeps @earendil-works/pi-tui as an external import", async () => {
  const directory = mkdtempSync(join(tmpdir(), "comms-pi-build-"));
  try {
    await buildPiExtension(directory);
    const output = readFileSync(join(directory, "index.js"), "utf8");
    expect(output).toMatch(/\bfrom\s*["']@earendil-works\/pi-tui["']/);
    for (const helper of ["truncateToWidth", "visibleWidth", "wrapTextWithAnsi"]) {
      expect(output).not.toMatch(new RegExp(`function\\s+${helper}\\s*\\(`));
    }
    expect(output).not.toContain("get-east-asian-width");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
