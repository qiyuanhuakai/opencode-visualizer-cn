import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'app/App.vue'), 'utf8');

describe('root history request ownership', () => {
  it('allocates the request id exactly once inside fetchHistory', () => {
    expect(source).toContain(`async function fetchRootSessionHistory(rootSessionId: string) {
  const loaded = await fetchHistory(rootSessionId);
  return { requestId: primaryHistoryRequestId, loaded };
}`);
  });
});
