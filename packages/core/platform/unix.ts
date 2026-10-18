import { chmod, mkdir, lstat, readlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import type { Platform } from "./platform.ts";

export function createUnixPlatform(): Platform {
  const directory = process.env.COMMS_DATA_DIR || join(homedir(), ".local", "share", "comms");
  const address = join(directory, "comms.sock");
  return {
    dataDirectory: () => directory,
    socketAddress: () => address,
    binaryName: () => "comms",
    async prepareListen() {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw new Error("Unsafe comms data directory");
      await chmod(directory, 0o700);
      const socket = await lstat(address).catch(error => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!socket) return;
      if (!socket.isSocket()) throw new Error("Refusing to replace a non-socket at the comms address");
      await new Promise<void>((resolve, reject) => {
        const probe = connect(address);
        probe.once("connect", () => { probe.destroy(); reject(new Error("Core already listening")); });
        probe.once("error", error => {
          if (["ECONNREFUSED", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) resolve();
          else reject(error);
        });
      });
      await unlink(address).catch(error => { if (error.code !== "ENOENT") throw error; });
    },
    async restrictAccess() { await chmod(address, 0o600); },
    codexHome: () => process.env.CODEX_HOME || join(homedir(), ".codex"),
    watchParent(onGone) {
      // A parent that exits leaves this process reparented, to PID 1 or a subreaper, so a changed
      // parent PID means it is gone. The timer is unreferenced so it never keeps the process alive.
      const parent = process.ppid;
      const timer = setInterval(() => {
        if (process.ppid === parent) return;
        clearInterval(timer);
        onGone();
      }, 1000);
      timer.unref();
      return () => clearInterval(timer);
    },
    async processExecutable(pid) {
      // Linux exposes /proc; macOS and other Unix systems answer through ps.
      const fromProc = await readlink(`/proc/${pid}/exe`).catch(() => undefined);
      if (fromProc) return fromProc;
      const ps = Bun.spawnSync(["ps", "-o", "comm=", "-p", String(pid)]);
      const path = ps.success ? ps.stdout.toString().trim() : "";
      return path.startsWith("/") ? path : undefined;
    },
  };
}
