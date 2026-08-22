import { describe, expect, it } from 'vitest';

import {
  mergeTextTransformers,
  normalizeTextTransformers,
  parseTextTransformerImport,
  serializeTextTransformers,
} from './snippets';

const snippet = {
  id: 'snippet-review',
  trigger: '::review',
  name: 'Review changes',
  body: 'Review {selection}.{cursor}',
  description: 'Checks correctness and regressions',
  enabled: true,
  tags: ['Review', 'Quality'],
} as const;

describe('snippet import and export', () => {
  it('round-trips a versioned JSON backup without losing metadata', () => {
    // Given: a metadata-rich snippet is ready for backup.
    const exported = serializeTextTransformers([snippet]);

    // When: the exported JSON is parsed for import.
    const imported = parseTextTransformerImport(exported);

    // Then: the version and every snippet field survive the round trip.
    expect(JSON.parse(exported)).toEqual({ version: 1, snippets: [snippet] });
    expect(imported).toEqual({ ok: true, snippets: [snippet] });
  });

  it('rejects malformed JSON, unsupported versions, and invalid snippet rows', () => {
    // Given: import payloads violate each public boundary independently.
    const malformed = '{';
    const futureVersion = JSON.stringify({ version: 2, snippets: [] });
    const invalidRows = JSON.stringify({
      version: 1,
      snippets: [{ id: 'bad', trigger: 'has space', body: 'ignored' }],
    });

    // When: each payload is parsed.
    const results = [
      parseTextTransformerImport(malformed),
      parseTextTransformerImport(futureVersion),
      parseTextTransformerImport(invalidRows),
    ];

    // Then: callers receive precise non-throwing failure reasons.
    expect(results).toEqual([
      { ok: false, reason: 'invalid-json' },
      { ok: false, reason: 'unsupported-version' },
      { ok: false, reason: 'invalid-snippets' },
    ]);
  });

  it('rejects reserved mention prefixes and resource-exhausting import rows', () => {
    // Given: untrusted backups try to shadow built-in mentions or force pathological tag work.
    const reservedTriggers = ['/command', '@agent', '$skill'].map((trigger, index) => ({
      ...snippet,
      id: `snippet-reserved-${index}`,
      trigger,
    }));
    const excessiveTags = {
      ...snippet,
      tags: Array.from({ length: 257 }, (_, index) => `tag-${index}`),
    };

    // When: both payload shapes cross the versioned import boundary.
    const results = [reservedTriggers, [excessiveTags]].map((snippets) =>
      parseTextTransformerImport(JSON.stringify({ version: 1, snippets })),
    );

    // Then: neither payload reaches settings state.
    expect(results).toEqual([
      { ok: false, reason: 'invalid-snippets' },
      { ok: false, reason: 'invalid-snippets' },
    ]);
  });

  it('merges imported snippets by id or trigger without deleting unrelated entries', () => {
    // Given: imported snippets update one trigger and add one new entry.
    const current = [
      { ...snippet, body: 'Old body' },
      {
        id: 'snippet-keep',
        trigger: 'keep',
        name: 'Keep',
        body: 'Keep me',
        enabled: true,
        tags: [],
      },
    ];
    const imported = [
      { ...snippet, id: 'snippet-imported', body: 'New body' },
      {
        id: 'snippet-new',
        trigger: ';new',
        name: 'New',
        body: 'New entry',
        enabled: true,
        tags: [],
      },
    ];

    // When: imported data is merged into local snippets.
    const result = mergeTextTransformers(current, imported);

    // Then: imported collisions win while unrelated local data remains.
    expect(result.map(({ id, body }) => ({ id, body }))).toEqual([
      { id: 'snippet-keep', body: 'Keep me' },
      { id: 'snippet-imported', body: 'New body' },
      { id: 'snippet-new', body: 'New entry' },
    ]);
  });

  it('removes every crossed id and trigger collision before importing', () => {
    // Given: one imported row collides with the id of one local row and trigger of another.
    const current = [
      { ...snippet, id: 'snippet-a', trigger: 'alpha' },
      { ...snippet, id: 'snippet-b', trigger: 'beta' },
      { ...snippet, id: 'snippet-keep', trigger: 'keep' },
    ];
    const imported = [{ ...snippet, id: 'snippet-a', trigger: 'beta', body: 'Imported' }];

    // When: the imported library is merged.
    const result = mergeTextTransformers(current, imported);

    // Then: both colliding rows are removed and the unrelated row remains.
    expect(result.map(({ id, trigger, body }) => ({ id, trigger, body }))).toEqual([
      { id: 'snippet-keep', trigger: 'keep', body: snippet.body },
      { id: 'snippet-a', trigger: 'beta', body: 'Imported' },
    ]);
  });

  it('normalizes a maximum-size unique snippet library within an interactive budget', () => {
    // Given: a maximum-size library contains one thousand unique non-ASCII snippets.
    const largeLibrary = Array.from({ length: 1_000 }, (_, index) => ({
      id: `snippet-${index}`,
      trigger: String.fromCodePoint(0x4e00 + index),
      name: `Snippet ${index}`,
      body: `Body ${index}`,
      enabled: true,
      tags: [],
    }));

    // When: the settings boundary canonicalizes the library.
    const startedAt = performance.now();
    const result = parseTextTransformerImport(
      JSON.stringify({ version: 1, snippets: largeLibrary }),
    );
    const durationMs = performance.now() - startedAt;

    // Then: normalization remains linear enough for completion-time use.
    expect(result).toMatchObject({ ok: true });
    expect(durationMs).toBeLessThan(150);
  });

  it('deduplicates exact Unicode simple-fold classes without merging unrelated letters', () => {
    // Given: triggers cover long-s, sigma, astral case pairs, and Turkish exceptions.
    const unicodeSnippets = [
      { ...snippet, id: 'latin-s', trigger: 's' },
      { ...snippet, id: 'long-s', trigger: 'ſ' },
      { ...snippet, id: 'sigma', trigger: 'σ' },
      { ...snippet, id: 'final-sigma', trigger: 'ς' },
      { ...snippet, id: 'deseret-upper', trigger: '𐐀' },
      { ...snippet, id: 'deseret-lower', trigger: '𐐨' },
      { ...snippet, id: 'latin-i', trigger: 'I' },
      { ...snippet, id: 'dotless-i', trigger: 'ı' },
      { ...snippet, id: 'dotted-capital-i', trigger: 'İ' },
    ];

    // When: the library is normalized with the same semantics as /iu matching.
    const result = normalizeTextTransformers(unicodeSnippets);

    // Then: later exact fold-equivalents win while Turkish non-equivalents remain distinct.
    expect(result).toMatchObject([
      { id: 'long-s' },
      { id: 'final-sigma' },
      { id: 'deseret-lower' },
      { id: 'latin-i' },
      { id: 'dotless-i' },
      { id: 'dotted-capital-i' },
    ]);
  });

  it('canonicalizes asymmetric Unicode fold classes independently of input order', () => {
    // Given: micro-sign and iota-subscript pairs reach their fold classes asymmetrically.
    const forward = [
      { ...snippet, id: 'greek-mu', trigger: 'μ' },
      { ...snippet, id: 'micro-sign', trigger: 'µ' },
      { ...snippet, id: 'greek-iota', trigger: 'ι' },
      { ...snippet, id: 'iota-subscript', trigger: 'ͅ' },
      { ...snippet, id: 'sharp-s', trigger: 'ß' },
      { ...snippet, id: 'capital-sharp-s', trigger: 'ẞ' },
    ];
    const reverse = [...forward].reverse();

    // When: both orders are normalized and normalized again.
    const forwardResult = normalizeTextTransformers(forward);
    const reverseResult = normalizeTextTransformers(reverse);

    // Then: each fold class has one stable last-wins key and normalization is idempotent.
    expect(forwardResult.map(({ id }) => id)).toEqual([
      'micro-sign',
      'iota-subscript',
      'capital-sharp-s',
    ]);
    expect(reverseResult.map(({ id }) => id)).toEqual(['sharp-s', 'greek-iota', 'greek-mu']);
    expect(normalizeTextTransformers(forwardResult)).toEqual(forwardResult);
    expect(normalizeTextTransformers(reverseResult)).toEqual(reverseResult);
  });

  it('preserves legacy reserved triggers as disabled data and round-trips their backup', () => {
    // Given: old storage contains triggers that now belong to command, agent, and skill mentions.
    const legacyReserved = ['/command', '@agent', '$skill'].map((trigger, index) => ({
      id: `legacy-${index}`,
      trigger,
      name: trigger,
      body: `Legacy ${trigger}`,
      enabled: true,
      tags: [],
    }));

    // When: storage is migrated and its versioned backup is parsed.
    const migrated = normalizeTextTransformers(legacyReserved);
    const imported = parseTextTransformerImport(serializeTextTransformers(migrated));

    // Then: no user data is deleted and reserved snippets stay inert.
    expect(migrated).toHaveLength(3);
    expect(migrated.every((entry) => entry.enabled === false)).toBe(true);
    expect(imported).toEqual({ ok: true, snippets: migrated });
  });

  it('rejects imports above the interactive library limit', () => {
    // Given: an otherwise valid backup contains one more than one thousand snippets.
    const excessiveLibrary = Array.from({ length: 1_001 }, (_, index) => ({
      ...snippet,
      id: `snippet-limit-${index}`,
      trigger: `limit-${index}`,
    }));

    // When: the backup crosses the import boundary.
    const result = parseTextTransformerImport(
      JSON.stringify({ version: 1, snippets: excessiveLibrary }),
    );

    // Then: settings never receive a collection that can overwhelm list rendering.
    expect(result).toEqual({ ok: false, reason: 'invalid-snippets' });
  });
});
