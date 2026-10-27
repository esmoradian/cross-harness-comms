import { open, readFile, unlink, chmod, copyFile, rename, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createClient } from "@cross-harness-comms/client";
import { RELEASE_VERSION, VERSION_RANGE, compareVersions } from "@cross-harness-comms/protocol";
import { createCore } from "./core.ts";
import { watchCodexDaemon, steerCodexThread } from "./codex/daemon.ts";
import type { CommandIO } from "@cross-harness-comms/client";
import type { CliRuntime } from "./cli.ts";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function lock(path: string): Promise<() => Promise<void>> {
  for (let i = 0; i < 200; i++) {
    try {
      const file = await open(path, "wx", 0o600);
      try { await file.writeFile(String(process.pid)); } finally { await file.close(); }
      return () => unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number(await readFile(path, "utf8").catch(() => ""));
      if (Number.isSafeInteger(owner) && owner > 0) {
        try { process.kill(owner, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") await unlink(path).catch(() => {});
        }
      }
      await sleep(25);
    }
  }
  throw new Error("Timed out waiting for core lifecycle lock");
}
async function probe(runtime: CliRuntime) {
  const client = createClient(await runtime.connect(runtime.platform.socketAddress()));
  try {
    return await Promise.race([
      (async () => { await client.hello({ versions: VERSION_RANGE }); return await client.request("status", {}); })(),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("Core did not respond")), 1500); timer.unref(); }),
    ]);
  } finally { await client.close(); }
}
// Removes old launcher downloads under `<data>/releases/`, keeping `current` and the two newest other plain versions.
// Anything else there is left alone, and a failure only leaves files behind, so it never throws.
export async function pruneReleases(dataDirectory: string, current: string): Promise<void> {
  try {
    const releases = join(dataDirectory, "releases");
    const versions = (await readdir(releases, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name) && entry.name !== current)
      .map(entry => entry.name).sort((a, b) => compareVersions(b, a));
    await Promise.all(versions.slice(2).map(version => rm(join(releases, version), { recursive: true, force: true }).catch(() => {})));
  } catch {}
}

export async function ensure(runtime: CliRuntime): Promise<string> {
  const address = await start(runtime);
  if (runtime.compiled) await pruneReleases(runtime.platform.dataDirectory(), RELEASE_VERSION);
  return address;
}

async function start(runtime: CliRuntime): Promise<string> {
  // Injected transports need no installation or process creation.
  if (!runtime.command) { await probe(runtime); return runtime.platform.socketAddress(); }
  const path = await runtime.platform.prepareDataDirectory();
  const unlock = await lock(join(path, "setup.lock"));
  try {
    let command = runtime.command;
    const installed = join(path, runtime.platform.binaryName());
    const metadata = join(path, "installed-version");
    if (runtime.compiled) {
      const version = await readFile(metadata, "utf8").catch(() => "0.0.0");
      if (compareVersions(RELEASE_VERSION, version.trim()) > 0) {
        const temporary = installed + ".new";
        await copyFile(command[0]!, temporary);
        await chmod(temporary, 0o700);
        await rename(temporary, installed);
        await Bun.write(metadata, RELEASE_VERSION);
      }
      command = [installed];
    }
    const installedVersion = runtime.compiled ? (await readFile(metadata, "utf8")).trim() : RELEASE_VERSION;
    const running = await probe(runtime).catch(() => undefined);
    if (running && compareVersions(running.version, installedVersion) >= 0) return runtime.platform.socketAddress();
    if (running) {
      const client = createClient(await runtime.connect(runtime.platform.socketAddress()));
      try { await client.hello({ versions: VERSION_RANGE }); await client.request("shutdown", {}); }
      finally { await client.close(); }
      for (let i = 0; i < 100; i++) { if (!await probe(runtime).catch(() => undefined)) break; await sleep(25); }
    }
    const log = await open(join(path, "core.log"), "a", 0o600);
    try {
      const child = spawn(command[0]!, [...command.slice(1), "serve"], { detached: true, stdio: ["ignore", log.fd, log.fd] });
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      child.unref();
    } finally { await log.close(); }
    for (let i = 0; i < 150; i++) {
      const ready = await probe(runtime).catch(() => undefined);
      if (ready && compareVersions(ready.version, installedVersion) >= 0) return runtime.platform.socketAddress();
      await sleep(20);
    }
    throw new Error("Core failed to start; inspect core.log in the data directory");
  } finally { await unlock(); }
}

export async function serve(io: CommandIO, runtime: CliRuntime): Promise<number> {
  const path = await runtime.platform.prepareDataDirectory();
  const unlock = await lock(join(path, "serve.lock"));
  let core: ReturnType<typeof createCore> | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let listening = false;
  let stop!: () => void;
  const stopped = new Promise<void>(resolve => { stop = resolve; });
  const abort = () => stop();
  io.signal.addEventListener("abort", abort, { once: true });
  try {
    await runtime.platform.prepareListen();
    core = createCore({ databasePath: join(path, "comms.sqlite"), onShutdown: stop, codexEvents: watchCodexDaemon(runtime.platform),
      codexSteer: (threadId, text, messageId) => steerCodexThread(runtime.platform, threadId, text, messageId) });
    await chmod(join(path, "comms.sqlite"), 0o600);
    server = createServer(stream => core!.attach(stream));
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(runtime.platform.socketAddress(), resolve);
    });
    listening = true;
    await runtime.platform.restrictAccess();
    if (!io.signal.aborted) await stopped;
    return 0;
  } finally {
    io.signal.removeEventListener("abort", abort);
    await core?.close();
    if (server && listening) await new Promise<void>(resolve => server!.close(() => resolve()));
    await unlock();
  }
}
