/// <reference types="vite/client" />

interface QueryLocalFontsOptions {
  postscriptNames?: string[];
}

interface FontData {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
}

interface Window {
  electronAPI?: {
    platform: string,
    versions: {
      node: string,
      electron: string,
      chrome: string,
    },
    getAppVersion: () => Promise<string>,
    getPlatform: () => Promise<string>,
    persistentStorage?: {
      getItem: (key: string) => string | null,
      setItem: (key: string, value: string) => void,
      removeItem: (key: string) => void,
    },
    localFile?: {
      selectApplication: () => Promise<string | null>,
      clearApplication: () => Promise<void>,
      open: (payload: {
        sessionId: string,
        fileName: string,
        content: string,
      }) => Promise<{ sessionId: string }>,
      close: (sessionId: string) => Promise<void>,
      onChanged: (listener: (change: { sessionId: string; content: string }) => void) => void,
      offChanged: (listener: (change: { sessionId: string; content: string }) => void) => void,
      onError: (listener: (error: { sessionId: string; message: string; closed?: boolean }) => void) => void,
      offError: (listener: (error: { sessionId: string; message: string; closed?: boolean }) => void) => void,
    },
  };
  queryLocalFonts?: (options?: QueryLocalFontsOptions) => Promise<FontData[]>;
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<{}, {}, any>;
  export default component;
}
