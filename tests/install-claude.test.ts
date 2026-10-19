import { expect, test } from "bun:test";
import { runCli, type CliRuntime } from "@cross-harness-comms/core/cli";

// `comms install claude` prints the published install, the release branch marketplace and the plugin from it, each command
// on a line of its own, instead of the dist-based local instructions. It reads and writes nothing.

const PUBLISHED = ["claude plugin marketplace add esmoradian/cross-harness-comms#release", "claude plugin install cross-harness-comms@comms"];
const refuse = (what: string) => async () => { throw new Error(`install claude must not ${what}`); };

const runtime: CliRuntime = {
  connect: refuse("connect to the core"),
  platform: {
    dataDirectory: () => { throw new Error("install claude must not use the data directory"); },
    socketAddress: () => "memory://comms", binaryName: () => "comms", processExecutable: async () => undefined,
    codexHome: () => { throw new Error("install claude must not read Codex's config"); },
    prepareListen: refuse("listen"), restrictAccess: refuse("change socket permissions"), publishLink: refuse("publish a Pi package"),
    watchParent: () => () => {},
  },
};

test("install claude: prints the published marketplace and plugin install commands, not the dist-based instructions", async () => {
  let stdout = "", stderr = "";
  async function* stdin() {}
  const exitCode = await runCli(["install", "claude"], { stdin: stdin(), signal: new AbortController().signal,
    stdout: text => { stdout += text; }, stderr: text => { stderr += text; } }, runtime);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  const lines = stdout.split("\n").map(line => line.trim());
  const [marketplace, plugin] = PUBLISHED.map(command => lines.indexOf(command));
  expect(marketplace).toBeGreaterThanOrEqual(0);
  expect(plugin).toBeGreaterThan(marketplace!);
  expect(stdout).not.toMatch(/\bdist\b|comms-local/);
});
