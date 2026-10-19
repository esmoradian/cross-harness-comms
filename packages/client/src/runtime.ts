import { connect } from "node:net";
import { hostname } from "node:os";
import { spawn } from "node:child_process";
import type { AdapterRuntime } from "./index.ts";

async function runProcess(argv: readonly string[], input?: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", text => { stdout += text; });
    child.stderr.setEncoding("utf8").on("data", text => { stderr += text; });
    child.on("error", reject);
    child.stdin.on("error", () => {});
    child.on("close", code => resolve({ exitCode: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });
}

export function localRuntime(binary: string): AdapterRuntime {
  return {
    host: hostname(),
    notice: text => process.stderr.write(text + "\n"),
    async ensure() {
      const result = await runProcess([binary, "ensure"]);
      if (result.exitCode) throw new Error(result.stderr.trim() || "comms ensure failed");
      return result.stdout.trim();
    },
    connect: address => new Promise((resolve, reject) => {
      const socket = connect(address);
      socket.once("error", reject);
      socket.once("connect", () => { socket.off("error", reject); resolve(socket); });
    }),
  };
}
