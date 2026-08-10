export type LocalFileChange = {
  sessionId: string;
  content: string;
};

export type LocalFileEditor = {
  open(payload: {
    sessionId: string;
    applicationPath: string;
    fileName: string;
    content: string;
    maxContentBytes?: number;
  }): Promise<{ sessionId: string; localPath: string }>;
  close(sessionId: string): Promise<void>;
  closeAll(): Promise<void>;
};

export function createLocalFileEditor(options: {
  onChange(change: LocalFileChange): void;
  onError?(error: { sessionId: string; message: string; closed?: boolean }): void;
  onClosed?(sessionId: string): void;
  watchDelayMs?: number;
  launchApplication?(applicationPath: string, localPath: string): void | Promise<void>;
}): LocalFileEditor;
