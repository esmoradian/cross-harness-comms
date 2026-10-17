import type { Duplex } from "node:stream";
import { MAX_LINE_BYTES, failure, type WirePacket } from "@cross-harness-comms/protocol";

// Count bytes after UTF-8 decoding, including frames split across stream chunks.
export function readPackets(stream: Duplex, receive: (packet: WirePacket) => void, invalid: (error: Error) => void): void {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
        invalid(failure("INVALID_MESSAGE", "Protocol line exceeds 1 MB"));
        stream.destroy();
        return;
      }
      try { receive(JSON.parse(line)); }
      catch (error) { invalid(error instanceof Error ? error : new Error("Invalid packet")); }
    }
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
      invalid(failure("INVALID_MESSAGE", "Protocol line exceeds 1 MB"));
      stream.destroy();
    }
  });
}

export function writePacket(stream: Duplex, packet: WirePacket): void {
  const line = JSON.stringify(packet);
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw failure("INVALID_MESSAGE", "Protocol line exceeds 1 MB");
  if (stream.destroyed || stream.writableEnded) throw failure("DISCONNECTED");
  stream.write(line + "\n");
}
