import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Platform } from "../../../packages/core/src/platform/platform.ts";

// `ConfigReadResponse` from `codex app-server generate-ts` 0.163.0, for a daemon whose config sets no unload delay.
export const noDelay = () => ({ config: { model: null }, origins: {}, layers: null });

export interface DaemonRequest { id?: number; method: string; params?: { cursor?: string; threadId?: string } }

// A stand-in for Codex's app-server daemon: JSON-RPC over a WebSocket on a Unix socket, owned by pid 4242, `/daemon/codex`.
// `answer` gives each request's result after `initialize`, and may send notifications ahead of it.
// `config` answers `config/read` instead, by default with no `thread_unload_delay_secs` set; a throw answers with a JSON-RPC error.
export function fakeCodexDaemon(answer: (request: DaemonRequest, send: (packet: unknown) => void) => unknown,
  options: { config?: () => unknown } = {}) {
  // Short base path: macOS caps Unix socket paths at 104 bytes.
  const home = mkdtempSync("/tmp/cxd-");
  mkdirSync(join(home, "app-server-control"));
  mkdirSync(join(home, "app-server-daemon"));
  writeFileSync(join(home, "app-server-daemon", "daemon.pid"), JSON.stringify({ pid: 4242 }));
  const platform = { codexHome: () => home, processExecutable: async (pid: number) => pid === 4242 ? "/daemon/codex" : undefined } as unknown as Platform;
  const requests: string[] = [];
  let peer: { send(data: string): unknown; close(): unknown } | undefined;
  let connections = 0;
  const server = Bun.serve({
    unix: join(home, "app-server-control", "app-server-control.sock"),
    fetch: (request, srv) => srv.upgrade(request) ? undefined : new Response("upgrade required", { status: 426 }),
    websocket: {
      open(ws) { peer = ws; connections++; },
      message(ws, raw) {
        const request = JSON.parse(String(raw)) as DaemonRequest;
        requests.push(request.method);
        if (request.id === undefined) return;
        const send = (packet: unknown) => ws.send(JSON.stringify(packet));
        if (request.method === "config/read") {
          try { send({ id: request.id, result: (options.config ?? noDelay)() }); }
          catch (error) { send({ id: request.id, error: { code: -32603, message: (error as Error).message } }); }
          return;
        }
        send({ id: request.id, result: request.method === "initialize" ? {} : answer(request, send) });
      },
    },
  });
  return { platform, requests, connections: () => connections,
    send: (event: unknown) => peer!.send(JSON.stringify(event)), disconnect: () => peer!.close(),
    close() { server.stop(true); rmSync(home, { recursive: true, force: true }); } };
}

