export interface Platform {
  dataDirectory(): string;
  socketAddress(): string;
  binaryName(): string;
  prepareListen(): Promise<void>;
  restrictAccess(): Promise<void>;
  // The executable of this process's parent, such as the Codex that ran a hook.
  parentExecutable(): Promise<string | undefined>;
}
