import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'app/App.vue'), 'utf8');

describe('PTY font-ready ownership', () => {
  it('does not let a stale callback close a replacement window', () => {
    expect(source).toContain(`if (shellSessionsByPtyId.get(pty.id)?.terminal !== terminal) {
          terminal.dispose();
          return;
        }`);
  });
});
