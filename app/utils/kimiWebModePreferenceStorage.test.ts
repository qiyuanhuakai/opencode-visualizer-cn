import { beforeEach, describe, expect, it } from 'vitest';
import { createKimiWebModePreferenceStore } from './kimiWebModePreferenceStorage';

describe('Kimi Web mode preferences', () => {
  beforeEach(() => localStorage.clear());

  it('restores independent session preferences after recreating the store', () => {
    // Given
    const original = createKimiWebModePreferenceStore(() => 'server-a');
    original.write('session-a', { field: 'planMode', value: true });
    original.write('session-a', { field: 'swarmMode', value: false });
    original.write('session-a', { field: 'towerMode', value: true });
    original.write('session-b', { field: 'planMode', value: false });
    // When
    const restored = createKimiWebModePreferenceStore(() => 'server-a');
    // Then
    expect(restored.read('session-a')).toEqual({
      planMode: true,
      swarmMode: false,
      towerMode: true,
    });
    expect(restored.read('session-b')).toEqual({ planMode: false });
  });

  it('isolates preferences by backend scope', () => {
    // Given
    let scope = 'server-a';
    const store = createKimiWebModePreferenceStore(() => scope);
    store.write('same-session', { field: 'planMode', value: true });
    // When
    scope = 'server-b';
    // Then
    expect(store.read('same-session')).toBeUndefined();
  });

  it('inherits missing mode fields from the previous local Bridge without overwriting them', () => {
    const previous = createKimiWebModePreferenceStore(() => 'ws://127.0.0.1:23004/kimi-web');
    previous.write('session-a', { field: 'permissionMode', value: 'auto' });
    previous.write('session-a', { field: 'planMode', value: true });
    let previousScope: string | undefined = 'ws://127.0.0.1:23004/kimi-web';
    const qualified = createKimiWebModePreferenceStore(() => 'environment:instance', () => previousScope);
    expect(qualified.read('session-a')).toEqual({ permissionMode: 'auto', planMode: true });
    qualified.write('session-a', { field: 'planMode', value: false });
    expect(qualified.read('session-a')).toEqual({ permissionMode: 'auto', planMode: false });
    expect(previous.read('session-a')).toEqual({ permissionMode: 'auto', planMode: true });
    previousScope = undefined;
    expect(qualified.read('session-a')).toEqual({ planMode: false });
  });

  it('keeps valid boolean fields while discarding malformed stored fields', () => {
    // Given
    const store = createKimiWebModePreferenceStore(() => 'server-a');
    store.write('session-a', { field: 'planMode', value: true });
    const key = localStorage.key(0);
    if (!key) throw new Error('Expected a persisted preference');
    localStorage.setItem(
      key,
      JSON.stringify({ planMode: 'false', swarmMode: false, permissionMode: 'invalid' }),
    );
    // When
    const restored = store.read('session-a');
    // Then
    expect(restored).toEqual({ swarmMode: false });
  });

  it.each(['{broken', 'null', '[]', '{"planMode":0}'])(
    'discards malformed stored preferences: %s',
    (raw) => {
      // Given
      const store = createKimiWebModePreferenceStore(() => 'server-a');
      store.write('session-a', { field: 'planMode', value: true });
      const key = localStorage.key(0);
      if (!key) throw new Error('Expected a persisted preference');
      localStorage.setItem(key, raw);
      // When
      const restored = store.read('session-a');
      // Then
      expect(restored).toBeUndefined();
    },
  );
});
