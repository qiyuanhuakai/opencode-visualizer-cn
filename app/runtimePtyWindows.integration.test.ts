import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stopProcessTree } from '../bridge/processTree.js';

describe.skipIf(process.platform !== 'win32')('native Windows PTY lifetime', () => {
  for (const mode of ['exited', 'live']) {
    it(`drains native handles after ${mode} terminal cleanup`, async () => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./test/windowsPtyLifecycleProbe.mjs', import.meta.url)), mode], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', errors = '';
      child.stdout.on('data', data => { output += data; });
      child.stderr.on('data', data => { errors += data; });
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`PTY did not drain: ${errors}`)), 20000);
          child.once('error', error => { clearTimeout(timer); reject(error); });
          child.once('close', code => { clearTimeout(timer); resolve(code); });
        });
        expect(code, errors).toBe(0);
        const receipt = JSON.parse(output.trim().split('\n').at(-1)!);
        expect(receipt).toMatchObject({ phase: 'removed', mode, exitedBeforeCleanup: mode === 'exited' });
        expect(receipt.terminalPid).toBeGreaterThan(0);
      } finally {
        await stopProcessTree(child);
      }
    }, 25000);
  }
});
