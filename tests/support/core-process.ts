// A real socket server in a separate process, so SIGKILL cannot run Core.close().
import { createServer } from "node:net";
import { readFileSync, unlinkSync } from "node:fs";
import { createCore } from "@cross-harness-comms/core";

const directory = process.argv[2]!;
const core = createCore({ databasePath: `${directory}/comms.sqlite`, now: () => Number(readFileSync(`${directory}/clock`, "utf8")) });
try { unlinkSync(`${directory}/core.sock`); } catch {}
const server = createServer(socket => core.attach(socket));
server.listen(`${directory}/core.sock`, () => process.stdout.write("ready\n"));
process.on("SIGTERM", async () => { await core.close(); server.close(); });
