export interface Platform {
  dataDirectory(): string;
  socketAddress(): string;
  binaryName(): string;
  prepareListen(): Promise<void>;
  restrictAccess(): Promise<void>;
}
