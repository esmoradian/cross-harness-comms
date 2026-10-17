import { connect } from "node:net";
import { createUnixPlatform } from "./platform/unix.ts";
import { runCli } from "./cli.ts";

export async function main(argv: readonly string[]): Promise<number> {
  const abort = new AbortController();
  const stop = () => { abort.abort(); process.stdin.destroy(); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  process.stdin.setEncoding("utf8");
  const compiled = import.meta.path.includes("$bunfs");
  try {
    return await runCli(argv, {
      // A terminal supplies no JSON, so `comms list` typed by a person does not wait for input.
      stdin: process.stdin.isTTY ? (async function* () {})() : process.stdin as unknown as AsyncIterable<string>,
      stdout: text => { process.stdout.write(text); }, stderr: text => { process.stderr.write(text); }, signal: abort.signal,
    }, {
      platform: createUnixPlatform(), compiled,
      command: compiled ? [process.execPath] : [process.execPath, import.meta.path],
      connect: address => new Promise((resolve, reject) => {
        const socket = connect(address);
        socket.once("error", reject);
        socket.once("connect", () => { socket.off("error", reject); resolve(socket); });
      }),
    });
  } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
