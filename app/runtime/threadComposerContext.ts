import { ProtocolError, textValue } from '../../shared/runtime/capabilities.js';
import { encodeSessionKey, parseConnectionProfileId, parseEnvironmentId, parseSessionRef } from '../../shared/runtime/identity.js';
import type { ConnectionProfileId, EnvironmentId } from '../../shared/runtime/identity.js';
import type { QualifiedSession } from './selectionScope';

export type ThreadBodyIdentity = Readonly<{ profileId: ConnectionProfileId; environmentId: EnvironmentId; threadId: string }>;
export type ComposerBodyOwner = Readonly<{ kind: 'session'; selection: QualifiedSession }> | Readonly<ThreadBodyIdentity & { kind: 'thread' }>;
export type ComposerTransitionInput = Readonly<{ selection: QualifiedSession }> & (
  | Readonly<{ origin: 'thread-enter'; thread: ThreadBodyIdentity }>
  | Readonly<{ origin: 'thread-target' | 'session-navigation' | 'thread-close' }>
);
export type ComposerTransition = Readonly<{
  generation: number;
  origin: ComposerTransitionInput['origin'];
  body: ComposerBodyOwner;
  bodyKey: string;
  preferenceKey: string;
  sessionKey: string;
  selection: QualifiedSession;
  isCurrent(): boolean;
}>;
export type ComposerReady = Readonly<ComposerTransition & { ready: true }>;

export function composerBodyKey(owner: ComposerBodyOwner): string {
  if (owner.kind === 'session') return `${parseConnectionProfileId(owner.selection.profileId)}:${encodeSessionKey(owner.selection.session)}`;
  return `composer-thread:v1:${JSON.stringify([parseConnectionProfileId(owner.profileId), parseEnvironmentId(owner.environmentId), textValue(owner.threadId, 'composer.thread_id')])}`;
}

export function composerPreferenceKey(selection: QualifiedSession): string {
  return `composer-preferences:v1:${JSON.stringify([parseConnectionProfileId(selection.profileId), encodeSessionKey(selection.session)])}`;
}

export function createThreadComposerContext() {
  let generation = 0;
  let transition: ComposerTransition | null = null;
  let ready: ComposerReady | null = null;
  return {
    current: () => transition,
    begin(input: ComposerTransitionInput): ComposerTransition {
      const selection = Object.freeze({ profileId: parseConnectionProfileId(input.selection.profileId), session: parseSessionRef(input.selection.session) });
      let body: ComposerBodyOwner;
      switch (input.origin) {
        case 'thread-enter': body = Object.freeze({ ...input.thread, kind: 'thread' }); break;
        case 'thread-target':
          if (transition?.body.kind !== 'thread') throw new ProtocolError('conflict', 'composer.thread_context');
          body = transition.body; break;
        case 'session-navigation':
        case 'thread-close': body = Object.freeze({ kind: 'session', selection }); break;
        default: input satisfies never; throw new ProtocolError('invalid_request', 'composer.transition');
      }
      const ownerProfile = body.kind === 'session' ? body.selection.profileId : body.profileId;
      if (ownerProfile !== selection.profileId) throw new ProtocolError('unauthorized', 'composer.profile');
      const next: ComposerTransition = Object.freeze({
        generation: ++generation, origin: input.origin, body, bodyKey: composerBodyKey(body),
        preferenceKey: composerPreferenceKey(selection), sessionKey: encodeSessionKey(selection.session), selection,
        isCurrent: () => transition === next,
      });
      transition = next; ready = null;
      return next;
    },
    complete(captured: ComposerTransition, loaded: Readonly<{ bodyKey: string; preferenceKey: string; sessionKey: string; optionsReady: boolean }>): ComposerReady | null {
      if (!captured.isCurrent() || !loaded.optionsReady || captured.bodyKey !== loaded.bodyKey || captured.preferenceKey !== loaded.preferenceKey || captured.sessionKey !== loaded.sessionKey) return null;
      ready = Object.freeze({ ...captured, ready: true });
      return ready;
    },
    captureSend(captured: ComposerReady, bodyRevision: number) {
      if (ready !== captured || !captured.isCurrent()) throw new ProtocolError('reconcile_required', 'composer.not_ready');
      return Object.freeze({
        selection: captured.selection, bodyKey: captured.bodyKey, generation: captured.generation,
        mayClear: (currentBodyRevision: number) => ready === captured && captured.isCurrent() && currentBodyRevision === bodyRevision,
      });
    },
    clear() { generation++; transition = null; ready = null; },
  };
}
