import { inject, type Ref } from 'vue';

export interface FloatingWindowAPI {
  key: string;
  content: Ref<string | (() => Promise<string>)>;
  html: Ref<string>;
  title: Ref<string>;
  status: Ref<string>;
  notifyContentChange(smooth?: boolean): void;
  setContent(text: string): void;
  appendContent(text: string): void;
  setTitle(title: string): void;
  setStatus(status: string): void;
  setColor(color: string): void;
  bringToFront(): void;
  minimize(): void;
  close(): void;
  onResize(callback: (w: number, h: number) => void): void;
}

export const FLOATING_WINDOW_KEY = Symbol('floating-window');

export function useFloatingWindow(): FloatingWindowAPI {
  const api = inject<FloatingWindowAPI>(FLOATING_WINDOW_KEY);
  if (!api) {
    throw new Error('useFloatingWindow must be used within a FloatingWindow component');
  }
  return api;
}
