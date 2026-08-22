import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'app/App.vue'), 'utf8');

describe('message cache authentication lifecycle', () => {
  it('synchronously clears warm snapshots when any backend credential changes', () => {
    expect(source).toMatch(
      /watch\(\s*\[\s*\(\) => credentials\.authHeader\.value,\s*\(\) => credentials\.codexBridgeToken\.value,\s*\(\) => credentials\.acpBridgeToken\.value,/,
    );
    expect(source).toContain('messageCacheAuthGeneration.value += 1;');
    expect(source).toContain('sessionReloadRequestId.value += 1;');
    expect(source).toContain('msg.clearSessionCache();');
    expect(source).toContain('backendSessionReload.invalidateMessageCacheContext();');
    expect(source).toContain("{ flush: 'sync' }");
    expect(source).toMatch(
      /getMessageCacheNamespace:[\s\S]*messageCacheAuthGeneration\.value,[\s\S]*\]\),/,
    );
  });
});
