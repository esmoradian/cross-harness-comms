import { mkdir, copyFile, cp, chmod } from "node:fs/promises";
import { join } from "node:path";
import { RELEASE_VERSION } from "@cross-harness-comms/protocol";

const root = join(import.meta.dir, "..");

// Copies a plugin manifest directory and stamps the release version after `name`, so no manifest carries its own copy.
async function copyManifest(source: string, output: string): Promise<void> {
  await cp(source, output, { recursive: true });
  const { name, ...rest } = await Bun.file(`${source}/plugin.json`).json();
  await Bun.write(`${output}/plugin.json`, JSON.stringify({ name, version: RELEASE_VERSION, ...rest }, null, 2) + "\n");
}

// Bundles the Pi extension into `outdir` as `index.js`.
export async function buildPiExtension(outdir: string): Promise<void> {
  // Pi provides pi-tui to extensions at runtime, so the card uses that copy.
  const build = await Bun.build({ entrypoints: [join(root, "adapters/pi/src/index.ts")], outdir, target: "node", format: "esm",
    external: ["@earendil-works/pi-tui"] });
  if (!build.success) throw new AggregateError(build.logs, "Pi build failed");
}

async function main() {
  // The target is chosen at build time. No runtime operating system selection.
  const target = process.argv[2] ?? "bun-darwin-arm64";
  if (!["bun-darwin-arm64", "bun-darwin-x64", "bun-linux-arm64", "bun-linux-x64"].includes(target)) throw new Error("Unsupported Unix target");
  process.chdir(root);
  const entry = target.startsWith("bun-darwin-") ? "packages/core/src/main.darwin.ts" : "packages/core/src/main.unix.ts";
  const compile = Bun.spawn([process.execPath, "build", "--compile", `--target=${target}`, entry, "--outfile", "dist/comms"], { stdout: "inherit", stderr: "inherit" });
  if (await compile.exited) throw new Error("Core build failed");
  for (const harness of ["pi", "claude", "codex"]) {
    const output = `dist/plugins/${harness}`;
    await mkdir(`${output}/bin`, { recursive: true });
    await copyFile("dist/comms", `${output}/bin/comms`);
    await chmod(`${output}/bin/comms`, 0o755);
    if (harness === "pi") {
      await buildPiExtension(`${output}/src`);
      await Bun.write(`${output}/package.json`, JSON.stringify({ name: "@cross-harness-comms/pi", version: RELEASE_VERSION, type: "module",
        pi: { extensions: ["./src/index.js"] } }, null, 2) + "\n");
    } else if (harness === "claude") {
      await copyManifest("adapters/claude/.claude-plugin", `${output}/.claude-plugin`);
      await cp("adapters/claude/hooks", `${output}/hooks`, { recursive: true });
      const build = await Bun.build({ entrypoints: ["adapters/claude/src/index.ts"], outdir: `${output}/hooks`, naming: "register.js", target: "browser", format: "esm" });
      if (!build.success) throw new AggregateError(build.logs, "Claude build failed");
    } else {
      await copyManifest("adapters/codex/.codex-plugin", `${output}/.codex-plugin`);
      await cp("adapters/codex/hooks", `${output}/hooks`, { recursive: true });
      await copyFile("adapters/codex/.mcp.json", `${output}/.mcp.json`);
    }
  }
  await mkdir("dist/.agents/plugins", { recursive: true });
  await Bun.write("dist/.agents/plugins/marketplace.json", JSON.stringify({ name: "comms-local", plugins: [{ name: "cross-harness-comms",
    source: { source: "local", path: "./plugins/codex" }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" }] }, null, 2) + "\n");
  await mkdir("dist/.claude-plugin", { recursive: true });
  await Bun.write("dist/.claude-plugin/marketplace.json", JSON.stringify({ name: "comms-local", owner: { name: "esmoradian" },
    plugins: [{ name: "cross-harness-comms", source: "./plugins/claude" }] }, null, 2) + "\n");
  console.log(`Built core and local harness packages for ${target} in dist/`);
}

if (import.meta.main) await main();
