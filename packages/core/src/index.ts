import type { Duplex } from "node:stream";
import type { VersionPolicy } from "@cross-harness-comms/protocol";

export interface Core {
  attach(stream: Duplex): void;
  close(): Promise<void>;
}

export function createCore(options: { databasePath: string; protocol?: VersionPolicy }): Core {
  throw new Error("not implemented");
}
