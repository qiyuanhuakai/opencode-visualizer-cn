import type { MessageDiffEntry } from '../types/message';
import { reconstructSourcesFromDiff } from './unifiedDiff';

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
  if (!hasCompleteBeforeAfter(diff) && diff.diff.trim()) {
    const reconstructed = reconstructSourcesFromDiff(diff.diff);
    return {
      file: diff.file,
      before: reconstructed.before,
      after: reconstructed.after,
      patch: undefined,
    };
  }

  return {
    file: diff.file,
    before: diff.before,
    after: diff.after,
    patch: hasCompleteBeforeAfter(diff) ? undefined : diff.diff || undefined,
  };
}
