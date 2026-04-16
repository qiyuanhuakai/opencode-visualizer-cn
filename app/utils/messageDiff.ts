import type { MessageDiffEntry } from '../types/message';

export type MessageDiffViewerEntry = {
  file: string;
  before?: string;
  after?: string;
  patch?: string;
};

export function hasCompleteBeforeAfter(diff: MessageDiffEntry): boolean {
  return typeof diff.before === 'string' && typeof diff.after === 'string';
}

export function toMessageDiffViewerEntry(diff: MessageDiffEntry): MessageDiffViewerEntry {
  return {
    file: diff.file,
    before: diff.before,
    after: diff.after,
    patch: hasCompleteBeforeAfter(diff) ? undefined : diff.diff || undefined,
  };
}
