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
  queryLocalFonts?: (options?: QueryLocalFontsOptions) => Promise<FontData[]>;
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<{}, {}, any>;
  export default component;
}
