import type { Duplex } from "node:stream";
import type { Platform } from "./platform/platform.ts";

export interface CliIO {
  stdin: AsyncIterable<string>;
  stdout(text: string): void;
  stderr(text: string): void;
  signal: AbortSignal;
}
export interface CliRuntime {
  platform: Platform;
  connect(address: string): Promise<Duplex>;
}

// argv excludes the executable. attach reads HelloParams on stdin and streams raw RPC lines.
// send/ack read their MethodTable params on stdin; they must not echo credentials.
export function runCli(argv: readonly string[], io: CliIO, runtime: CliRuntime): Promise<number> {
  throw new Error("not implemented");
}
