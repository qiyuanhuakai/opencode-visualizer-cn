import type { FloatingWindowEntry } from '../../composables/useFloatingWindows';

export type HistoryEntry = {
  key: string;
  kind: 'tool';
  time: number;
  part: {
    id: string;
    callID: string;
    sessionID: string;
    messageID: string;
    type: 'tool';
    tool: string;
    state: {
      status: 'completed';
      input: { command: string };
      output: string;
      title: string;
      metadata: Record<string, never>;
      time: { start: number; end: number };
    };
  };
};

export type FixtureApi = {
  ready: boolean;
  scenario: string;
  setSidebarFontSize?: (size: number) => Promise<void>;
  setEditorFontSize?: (size: number | null) => Promise<void>;
  appendHistory?: (count?: number) => Promise<void>;
  shrinkHistory?: (count?: number) => Promise<void>;
  pointerCapture?: { drag: boolean; resize: boolean };
  pointerId?: number;
  floatingEntry?: FloatingWindowEntry;
};

declare global {
  interface Window {
    __uiContracts?: FixtureApi;
  }
}
