import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { OPEN_IN_EDITOR_SHELL_COMMAND } from './openInEditorCommand';

describe('open-in-editor shell command', () => {
  it('passes the path as a literal argument without evaluating shell substitutions', () => {
    const path = "/tmp/it's $(printf PWNED)";
    const result = spawnSync('/bin/sh', ['-c', OPEN_IN_EDITOR_SHELL_COMMAND, 'vis-open-editor', path], {
      encoding: 'utf8',
      env: { ...process.env, VISUAL: 'printf %s', EDITOR: '' },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(path);
  });
});
