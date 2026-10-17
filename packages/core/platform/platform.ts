export interface Platform {
  dataDirectory(): string;
  socketAddress(): string;
  binaryName(): string;
  prepareListen(): Promise<void>;
  restrictAccess(): Promise<void>;
  // The executable of a running process, such as the Codex that ran a hook or hosts the daemon.
  processExecutable(pid: number): Promise<string | undefined>;
  // Codex's home directory, which holds its app-server daemon socket and pid file.
  codexHome(): string;
}
