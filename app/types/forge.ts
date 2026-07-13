import type { ForgeConversation, ForgeInfo } from '../composables/useForgeAuxiliary';

export type ForgePanelAuxiliary = {
  readonly conversations: readonly ForgeConversation[];
  readonly selectedConversationId: string;
  readonly selectedMarkdown: string;
  readonly selectedDump: string;
  readonly info: ForgeInfo | null;
  readonly loading: boolean;
  readonly error: string;
  readonly onRefresh: () => void;
  readonly onSelectConversation: (id: string) => void;
  readonly onDumpConversation: (id: string) => void;
};
