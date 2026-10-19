export interface Platform {
  dataDirectory(): string;
  socketAddress(): string;
  binaryName(): string;
  // Creates the data directory if needed and returns its path, refusing one that is not a real directory owned by this user.
  prepareDataDirectory(): Promise<string>;
  prepareListen(): Promise<void>;
  restrictAccess(): Promise<void>;
  // The executable of a running process, such as the Codex that ran a hook or hosts the daemon.
  processExecutable(pid: number): Promise<string | undefined>;
  // Codex's home directory, which holds its app-server daemon socket and pid file.
  codexHome(): string;
  // Calls `onGone` once the process that started this one is gone, and returns a function that stops watching.
  watchParent(onGone: () => void): () => void;
}
