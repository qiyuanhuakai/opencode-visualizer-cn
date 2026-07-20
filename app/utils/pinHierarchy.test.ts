import { describe, expect, it } from 'vitest';
import { applyPinHierarchyTransition, type PinHierarchy } from './pinHierarchy';

const hierarchy: PinHierarchy = {
  projectKey: 'project:project',
  branches: [
    { key: 'sandbox:project:one', sessionKeys: ['project:one-a', 'project:one-b'] },
    { key: 'sandbox:project:two', sessionKeys: ['project:two-a', 'project:two-b'] },
  ],
};

describe('applyPinHierarchyTransition', () => {
  it('forces every descendant when toggling the project', () => {
    const next = applyPinHierarchyTransition(
      { 'project:one-a': -1, 'project:two-b': 1 }, hierarchy, { level: 'project' }, true, 10,
    );
    expect(next).toEqual({
      'project:project': 10, 'sandbox:project:one': 10, 'sandbox:project:two': 10,
      'project:one-a': 10, 'project:one-b': 10, 'project:two-a': 10, 'project:two-b': 10,
    });
  });

  it('forces every session in a branch and updates the project only when branches agree', () => {
    const next = applyPinHierarchyTransition(
      { 'project:project': 1, 'sandbox:project:two': -1, 'project:two-a': -1, 'project:two-b': -1 },
      hierarchy, { level: 'branch', key: 'sandbox:project:one' }, false, 10,
    );
    expect(next['sandbox:project:one']).toBe(-10);
    expect(next['project:one-a']).toBe(-10);
    expect(next['project:one-b']).toBe(-10);
    expect(next['project:project']).toBe(-10);
  });

  it('updates only the leaf until all sibling leaves agree', () => {
    const next = applyPinHierarchyTransition(
      { 'project:project': 1, 'sandbox:project:one': 1, 'project:one-a': 1, 'project:one-b': 1 },
      hierarchy, { level: 'session', key: 'project:one-a' }, false, 10,
    );
    expect(next['project:one-a']).toBe(-10);
    expect(next['sandbox:project:one']).toBe(1);
    expect(next['project:project']).toBe(1);
  });

  it('aggregates a branch then its project when the final leaf changes', () => {
    const next = applyPinHierarchyTransition(
      {
        'project:project': 1, 'sandbox:project:one': 1, 'sandbox:project:two': -1,
        'project:one-a': -1, 'project:one-b': -1, 'project:two-a': -1, 'project:two-b': -1,
      }, hierarchy, { level: 'session', key: 'project:one-b' }, false, 10,
    );
    expect(next['sandbox:project:one']).toBe(-10);
    expect(next['project:project']).toBe(-10);
  });

  it('uses server pin state when reconciling siblings without local overrides', () => {
    const serverBackedHierarchy: PinHierarchy = {
      projectKey: 'project:project',
      branches: [
        {
          key: 'sandbox:project:server-only',
          sessionKeys: ['project:server-a', 'project:server-b'],
          serverPinnedBySession: {
            'project:server-a': true,
            'project:server-b': true,
          },
        },
        {
          key: 'sandbox:project:one',
          sessionKeys: ['project:one-a', 'project:one-b'],
          serverPinnedBySession: {
            'project:one-a': true,
            'project:one-b': false,
          },
        },
      ],
    };
    const next = applyPinHierarchyTransition(
      {}, serverBackedHierarchy, { level: 'session', key: 'project:one-b' }, true, 10,
    );

    expect(next['project:one-b']).toBe(10);
    expect(next['sandbox:project:one']).toBe(10);
    expect(next['project:project']).toBe(10);
  });
});
