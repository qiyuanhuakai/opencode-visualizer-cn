import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createComposerDraftScheduler } from './utils/composerDraftScheduler';

const source = readFileSync(join(process.cwd(), 'app', 'App.vue'), 'utf8');
const scriptSource = source.match(/<script lang="ts" setup>([\s\S]*?)<\/script>/)?.[1];
if (!scriptSource) throw new Error('App.vue script setup block was not found');
const script = ts.createSourceFile('App.vue.ts', scriptSource, ts.ScriptTarget.Latest, true);
const functions = [
  'normalizeStoredAttachment',
  'normalizeStoredComposerDraft',
  'parseComposerDraftStore',
  'handleComposerDraftStorage',
].map((name) => {
  const declaration = script.statements.find(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (!declaration) throw new Error(`App.vue function ${name} was not found`);
  return declaration.getText(script);
});
const program = ts.transpileModule(
  [...functions, 'handleComposerDraftStorage(event);'].join('\n'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
).outputText;

function draft(messageInput: string, rev = 1) {
  return { messageInput, rev, updatedAt: 1, writerTabId: 'other-window', attachments: [] };
}

function composer(initialInput = 'saved', knownRev = 1) {
  const state = { messageInput: initialInput };
  const persist = vi.fn();
  const scheduler = createComposerDraftScheduler(persist, 150);
  const revisions = new Map([['session-a', knownRev]]);
  function dispatch(oldStore: unknown, newStore: unknown) {
    runInNewContext(program, {
      event: {
        key: 'composer',
        oldValue: oldStore === null ? null : JSON.stringify(oldStore),
        newValue: newStore === null ? null : JSON.stringify(newStore),
      },
      StorageKeys: { drafts: { composer: 'composer' } },
      storageKey: (key: string) => key,
      draftKeyForSelectedContext: () => 'session-a',
      composerDraftPersistence: scheduler,
      composerDraftRevisionByContext: revisions,
      composerDraftTabId: 'local-window',
      clearComposerInputState: () => {
        state.messageInput = '';
      },
      applyComposerDraftToComposerState: (value: { messageInput: string; rev: number }) => {
        state.messageInput = value.messageInput;
        revisions.set('session-a', value.rev);
      },
    });
  }
  return { state, scheduler, persist, dispatch };
}

afterEach(() => vi.useRealTimers());

describe('composer draft storage synchronization', () => {
  it('preserves typing during the debounce when another window writes a newer draft', () => {
    vi.useFakeTimers();
    const fixture = composer('saved plus new typing');
    fixture.scheduler.schedule();
    fixture.dispatch({ 'session-a': draft('saved') }, { 'session-a': draft('remote', 2) });
    expect(fixture.state.messageInput).toBe('saved plus new typing');
    vi.advanceTimersByTime(150);
    expect(fixture.persist).toHaveBeenCalledTimes(1);
  });

  it('does not replay the current draft when another session changes', () => {
    const fixture = composer('local text');
    fixture.dispatch(
      { 'session-a': draft('saved') },
      { 'session-a': draft('saved'), 'session-b': draft('another session') },
    );
    expect(fixture.state.messageInput).toBe('local text');
  });

  it('does not clear an absent current draft on an unrelated session write', () => {
    const fixture = composer('first input');
    fixture.dispatch({}, { 'session-b': draft('another session') });
    expect(fixture.state.messageInput).toBe('first input');
  });

  it('protects pending input when another window removes the current draft', () => {
    vi.useFakeTimers();
    const fixture = composer('unsaved text');
    fixture.scheduler.schedule();
    fixture.dispatch({ 'session-a': draft('saved') }, {});
    expect(fixture.state.messageInput).toBe('unsaved text');
  });

  it('applies a changed foreign draft when local input is settled, including equal revisions', () => {
    const fixture = composer();
    fixture.dispatch({ 'session-a': draft('saved') }, { 'session-a': draft('remote') });
    expect(fixture.state.messageInput).toBe('remote');
  });

  it('clears a settled draft when its own context is removed', () => {
    const fixture = composer();
    fixture.dispatch({ 'session-a': draft('saved') }, null);
    expect(fixture.state.messageInput).toBe('');
  });

  it('rejects an older revision even when its event changes the current context', () => {
    const fixture = composer('newer local', 3);
    fixture.dispatch({ 'session-a': draft('old') }, { 'session-a': draft('remote', 2) });
    expect(fixture.state.messageInput).toBe('newer local');
  });
});
