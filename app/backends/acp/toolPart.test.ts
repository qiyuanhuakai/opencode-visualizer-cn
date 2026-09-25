import { describe, expect, it } from 'vitest';
import { createAcpToolPart } from './toolPart';

describe('ACP tool history identity', () => {
  it.each([
    ['Glob', 'read', 'glob'],
    ['Grep', 'read', 'grep'],
    ['Read file', 'read', 'read'],
    ['WebFetch', 'read', 'webfetch'],
    ['List directory', 'read', 'list'],
  ])('uses the %s tool title instead of the coarse %s kind', (title, kind, expected) => {
    const started = createAcpToolPart('s1', 'm1', {
      toolCallId: 'call-1',
      title,
      kind,
      status: 'in_progress',
      rawInput: { pattern: '*.ts' },
    }, undefined, 100);
    const completed = createAcpToolPart('s1', 'm1', {
      toolCallId: 'call-1',
      status: 'completed',
      rawOutput: 'found',
    }, started, 200);

    expect(started.tool).toBe(expected);
    expect(completed.tool).toBe(expected);
  });

  it('accepts a later coarse kind when the first frame had no tool identity', () => {
    const started = createAcpToolPart('s1', 'm1', {
      toolCallId: 'call-2',
      status: 'in_progress',
    }, undefined, 100);
    const updated = createAcpToolPart('s1', 'm1', {
      toolCallId: 'call-2',
      kind: 'read',
      status: 'completed',
    }, started, 200);

    expect(started.tool).toBe('other');
    expect(updated.tool).toBe('read');
  });

  it('accepts a later explicit kind when earlier titles do not identify a specific tool', () => {
    const started = createAcpToolPart('s1', 'm1', {
      toolCallId: 'call-3',
      title: 'Inspect workspace',
      kind: 'read',
      status: 'in_progress',
    }, undefined, 100);
    const updated = createAcpToolPart('s1', 'm1', {
      toolCallId: 'call-3',
      title: 'Modify workspace',
      kind: 'edit',
      status: 'completed',
    }, started, 200);

    expect(started.tool).toBe('read');
    expect(updated.tool).toBe('edit');
  });
});
