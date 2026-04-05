import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TypedEmitter } from './eventEmitter';

describe('TypedEmitter', () => {
  let emitter: TypedEmitter<{ msg: string; num: number }>;

  beforeEach(() => {
    emitter = new TypedEmitter();
  });

  it('delivers payload to a registered listener', () => {
    const listener = vi.fn();
    emitter.on('msg', listener);
    emitter.emit('msg', 'hello');
    expect(listener).toHaveBeenCalledExactlyOnceWith('hello');
  });

  it('allows unsubscribing without affecting other listeners', () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = emitter.on('num', a);
    emitter.on('num', b);

    offA();
    emitter.emit('num', 42);

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledExactlyOnceWith(42);
  });

  it('supports multiple listeners for the same event', () => {
    const a = vi.fn();
    const b = vi.fn();
    emitter.on('msg', a);
    emitter.on('msg', b);
    emitter.emit('msg', 'x');
    expect(a).toHaveBeenCalledExactlyOnceWith('x');
    expect(b).toHaveBeenCalledExactlyOnceWith('x');
  });

  it('clears all listeners on dispose', () => {
    const listener = vi.fn();
    emitter.on('msg', listener);
    emitter.dispose();
    emitter.emit('msg', 'y');
    expect(listener).not.toHaveBeenCalled();
  });

  it('throws no error when emitting to an event with no listeners', () => {
    expect(() => emitter.emit('msg', 'silent')).not.toThrow();
  });
});
