import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'app/App.vue'), 'utf8');

describe('backend initialization cancellation lifecycle', () => {
  it('invalidates startup before an SSE authentication failure clears credentials', () => {
    const handlerStart = source.indexOf("ge.on('connection.error'");
    const handlerEnd = source.indexOf("sessionScope.on('permission.asked'", handlerStart);
    const handlerSource = source.slice(handlerStart, handlerEnd);

    expect(handlerStart).toBeGreaterThan(-1);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    expect(handlerSource.indexOf('abortInitialization()')).toBeGreaterThan(-1);
    expect(handlerSource.indexOf('abortInitialization()')).toBeLessThan(
      handlerSource.indexOf('credentials.clear()'),
    );
  });
});
