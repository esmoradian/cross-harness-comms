import { main } from "./main.unix.ts";
import { createDarwinPlatform } from "./platform/darwin.ts";

process.exitCode = await main(process.argv.slice(2), createDarwinPlatform());
