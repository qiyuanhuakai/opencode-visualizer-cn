import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cloneNullPrototypeRecord } from './historyMaps';

type HistoryMeta = {
  readonly marker: string;
};

const appSource = readFileSync(resolve(__dirname, '../App.vue'), 'utf8');

describe('history metadata maps', () => {
  it('uses the safe clone for both reactive history maps', () => {
    expect(appSource).toContain(
      "import { cloneNullPrototypeRecord } from './utils/historyMaps';",
    );
    expect(appSource).toContain(
      'const nextUserMessageMetaById = cloneNullPrototypeRecord(userMessageMetaById.value);',
    );
    expect(appSource).toContain(
      'const nextUserMessageTimeById = cloneNullPrototypeRecord(userMessageTimeById.value);',
    );
  });

  it('keeps prototype-shaped backend IDs as own properties without changing Object.prototype', () => {
    const prototypeNames = Object.getOwnPropertyNames(Object.prototype);
    const prototypeDescriptors = new Map(
      prototypeNames.map((name) => [name, Object.getOwnPropertyDescriptor(Object.prototype, name)]),
    );
    const ids = prototypeNames.flatMap((name) => [name, ` ${name} `, `\t${name}\n`]);
    const nextUserMessageMetaById = cloneNullPrototypeRecord<HistoryMeta>({
      retained: { marker: 'retained-meta' },
    });
    const nextUserMessageTimeById = cloneNullPrototypeRecord({ retained: 42 });

    expect(() => {
      ids.forEach((id, index) => {
        nextUserMessageMetaById[id] = { marker: id };
        nextUserMessageTimeById[id] = index;
      });
    }).not.toThrow();

    expect(Object.getPrototypeOf(nextUserMessageMetaById)).toBeNull();
    expect(Object.getPrototypeOf(nextUserMessageTimeById)).toBeNull();
    expect(nextUserMessageMetaById.retained).toEqual({ marker: 'retained-meta' });
    expect(nextUserMessageTimeById.retained).toBe(42);
    ids.forEach((id, index) => {
      expect(Object.hasOwn(nextUserMessageMetaById, id)).toBe(true);
      expect(Object.hasOwn(nextUserMessageTimeById, id)).toBe(true);
      expect(nextUserMessageMetaById[id]).toEqual({ marker: id });
      expect(nextUserMessageTimeById[id]).toBe(index);
    });

    expect(Object.getOwnPropertyNames(Object.prototype)).toEqual(prototypeNames);
    prototypeNames.forEach((name) => {
      expect(Object.getOwnPropertyDescriptor(Object.prototype, name)).toEqual(
        prototypeDescriptors.get(name),
      );
    });
  });
});
