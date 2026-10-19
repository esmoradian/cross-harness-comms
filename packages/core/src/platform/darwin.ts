import { dlopen, read } from "bun:ffi";
import { rename, unlink } from "node:fs/promises";
import { createUnixPlatform } from "./unix.ts";
import type { Platform } from "./platform.ts";

const RENAME_SWAP = 2;

export function createDarwinPlatform(): Platform {
  return {
    ...createUnixPlatform(),
    async publishLink(source, destination) {
      // Replacing a symlink with rename() can make concurrent opens fail with EINVAL on macOS.
      // Exchanging the links preserves their vnodes through lookup; only the first install uses rename().
      const library = dlopen("/usr/lib/libSystem.B.dylib", {
        renamex_np: { args: ["cstring", "cstring", "u32"], returns: "i32" },
        __error: { args: [], returns: "ptr" },
      });
      try {
        if (library.symbols.renamex_np(Buffer.from(source + "\0"), Buffer.from(destination + "\0"), RENAME_SWAP) === 0) {
          await unlink(source);
        } else {
          const errno = read.i32(library.symbols.__error()!);
          if (errno !== 2) throw new Error(`Cannot publish package link (errno ${errno})`);
          await rename(source, destination);
        }
      } finally { library.close(); }
    },
  };
}
