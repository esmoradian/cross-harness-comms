import { deferred } from "../helpers.ts";

// Native daemon notifications, with the executable supplied by the transport.
// This fixture only supplies events; the real core must own every state change.
export type CodexEvent =
  | { method: "thread/started"; executable: string; params: { thread: { id: string; cwd: string; parentThreadId?: string | null; ephemeral?: boolean; active_at?: string } } }
  | { method: "thread/status/changed"; params: { threadId: string; status: { type: "notLoaded" | "idle" | "systemError" } | { type: "active"; activeFlags: string[] } }; active_at?: string }
  | { method: "comms/daemon-snapshot"; executable: string; params: { threads: { id: string; cwd: string; active_at?: string }[] } }
  | { method: "comms/daemon-disconnected" };

type Entry = { event: CodexEvent; handled: ReturnType<typeof deferred<void>> };

export class FakeCodexEvents implements AsyncIterable<CodexEvent> {
  private readonly entries: Entry[] = [];
  private readonly readers = new Set<(entry: Entry | null) => void>();

  async publish(event: CodexEvent): Promise<void> {
    const handled = deferred<void>();
    const reader = this.readers.values().next().value;
    if (reader) { this.readers.delete(reader); reader({ event, handled }); }
    else this.entries.push({ event, handled });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        handled.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Core did not consume ${event.method}`)), 1500);
        }),
      ]);
    } finally { clearTimeout(timer); }
  }

  [Symbol.asyncIterator](): AsyncIterator<CodexEvent> {
    let stopped = false;
    let handled: ReturnType<typeof deferred<void>> | undefined;
    let reader: ((entry: Entry | null) => void) | undefined;
    return {
      next: async () => {
        handled?.resolve();
        if (stopped) return { done: true, value: undefined };
        const entry = this.entries.shift() ?? await new Promise<Entry | null>(resolve => {
          reader = resolve;
          this.readers.add(resolve);
        });
        if (!entry || stopped) return { done: true, value: undefined };
        handled = entry.handled;
        return { done: false, value: entry.event };
      },
      return: async () => {
        stopped = true;
        handled?.resolve();
        if (reader) { this.readers.delete(reader); reader(null); }
        return { done: true, value: undefined };
      },
    };
  }

  close() { for (const reader of this.readers) reader(null); this.readers.clear(); }
}
