import { describe, expect, it } from 'vitest';

import {
  MAX_TEXT_TRANSFORMER_IMPORT_BYTES,
  MAX_TEXT_TRANSFORMER_TOTAL_TAGS,
  mergeTextTransformers,
  normalizeTextTransformers,
  parseTextTransformerImport,
  serializeTextTransformers,
  textTransformerTriggerKey,
  validateTextTransformerLibrary,
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

  it('assigns deterministic unique ids when distinct legacy snippets collide', () => {
    // Given: two distinct legacy snippets reproduce the current 32-bit hash collision.
    const colliding = [
      { trigger: 'tmrkyczzoeosd', replacement: 'bixntxizktiha' },
      { trigger: 'trgbyrbeujkiu', replacement: 'bsxjtgyuqazzr' },
    ];

    // When: legacy storage is normalized twice as it would be across reloads.
    const firstMigration = normalizeTextTransformers(colliding);
    const secondMigration = normalizeTextTransformers(firstMigration);

    // Then: both rows survive with unique ids that remain stable after persistence.
    expect(firstMigration).toHaveLength(2);
    expect(new Set(firstMigration.map(({ id }) => id))).toHaveLength(2);
    expect(secondMigration).toEqual(firstMigration);
  });

  it('preserves generated-id hash collisions split across merge operands', () => {
    // Given: one legacy hash-collision row exists locally and its pair arrives in an import.
    const local = [{ trigger: 'tmrkyczzoeosd', replacement: 'bixntxizktiha' }];
    const imported = [{ trigger: 'trgbyrbeujkiu', replacement: 'bsxjtgyuqazzr' }];

    // When: both independently normalized inputs are merged.
    const result = mergeTextTransformers(local, imported);

    // Then: neither unrelated row is mistaken for an id-based update.
    expect(result).toHaveLength(2);
    expect(new Set(result.map(({ id }) => id))).toHaveLength(2);
    expect(result.map(({ trigger }) => trigger)).toEqual(['tmrkyczzoeosd', 'trgbyrbeujkiu']);
  });

  it('preserves decimal generated-id suffixes across large collision merges', () => {
    // Given: twenty distinct bounded rows share one hash input and each half allocates through -10.
    const segments = Array.from({ length: 21 }, (_, index) => `p${index}`);
    const colliding = Array.from({ length: 20 }, (_, splitIndex) => ({
      trigger: segments.slice(0, splitIndex + 1).join('\0'),
      replacement: segments.slice(splitIndex + 1).join('\0'),
    }));
    const local = normalizeTextTransformers(colliding.slice(0, 10));
    const imported = normalizeTextTransformers(colliding.slice(10));

    // When: independently generated identifiers are merged.
    const result = mergeTextTransformers(local, imported);

    // Then: suffix -10 remains generated, is reallocated, and no row is overwritten.
    expect(result).toHaveLength(20);
    expect(new Set(result.map(({ id }) => id))).toHaveLength(20);
    expect(result.map(({ trigger }) => trigger)).toEqual(colliding.map(({ trigger }) => trigger));
  });

  it('reserves later imported ids before allocating collision suffixes', () => {
    // Given: a generated-id collision and a later imported row already owning the first suffix.
    const local = [{ trigger: 'tmrkyczzoeosd', replacement: 'bixntxizktiha' }];
    const baseId = normalizeTextTransformers(local)[0]!.id;
    const imported = [
      { trigger: 'trgbyrbeujkiu', replacement: 'bsxjtgyuqazzr' },
      {
        id: `${baseId}-2`,
        trigger: 'reserved-future-id',
        name: 'Reserved future id',
        body: 'Keep this row',
        enabled: true,
        tags: [],
      },
    ];

    // When: both imported rows are merged in source order.
    const result = mergeTextTransformers(local, imported);

    // Then: collision allocation skips the future explicit id and all three rows survive.
    expect(result.map(({ trigger }) => trigger)).toEqual([
      'tmrkyczzoeosd',
      'trgbyrbeujkiu',
      'reserved-future-id',
    ]);
    expect(new Set(result.map(({ id }) => id))).toHaveLength(3);
  });

  it('rejects a merged library whose complete backup exceeds the UTF-8 budget', () => {
    // Given: two bounded libraries are individually importable but exceed five MiB together.
    const library = (prefix: string) =>
      Array.from({ length: 3 }, (_, index) => ({
        ...snippet,
        id: `${prefix}-${index}`,
        trigger: `${prefix}-${index}`,
        body: '界'.repeat(300_000),
      }));
    const current = library('current');
    const imported = library('imported');
    expect(validateTextTransformerLibrary(current)).not.toBeNull();
    expect(validateTextTransformerLibrary(imported)).not.toBeNull();

    // When: the imported rows are merged with the local library.
    const merged = mergeTextTransformers(current, imported);

    // Then: the shared whole-library boundary rejects the non-restorable result.
    expect(validateTextTransformerLibrary(merged)).toBeNull();
  });

  it('enforces an aggregate tag budget across otherwise bounded rows', () => {
    // Given: no row exceeds its per-snippet tag limit, but their aggregate exceeds the UI budget.
    const excessiveTags = Array.from({ length: 5 }, (_, snippetIndex) => ({
      ...snippet,
      id: `aggregate-tags-${snippetIndex}`,
      trigger: `aggregate-tags-${snippetIndex}`,
      tags: Array.from(
        { length: Math.ceil((MAX_TEXT_TRANSFORMER_TOTAL_TAGS + 1) / 5) },
        (_, tagIndex) => `tag-${snippetIndex}-${tagIndex}`,
      ),
    }));

    // When: the versioned payload crosses the import boundary.
    const result = parseTextTransformerImport(JSON.stringify({ version: 1, snippets: excessiveTags }));

    // Then: the complete collection is rejected before the settings UI renders its tags.
    expect(result).toEqual({ ok: false, reason: 'invalid-snippets' });
  });

  it('serializes duplicate explicit ids into an importable backup', () => {
    // Given: corrupted legacy storage contains distinct triggers sharing one explicit id.
    const duplicateIds = [
      { ...snippet, id: 'duplicate-id', trigger: 'alpha' },
      { ...snippet, id: 'duplicate-id', trigger: 'beta' },
    ];

    // When: the public serializer produces a versioned backup.
    const imported = parseTextTransformerImport(serializeTextTransformers(duplicateIds));

    // Then: every source row survives and the serializer output is accepted by its parser.
    expect(imported).toMatchObject({ ok: true });
    if (!imported.ok) throw new Error('Expected the serialized backup to be importable');
    expect(imported.snippets).toHaveLength(2);
    expect(new Set(imported.snippets.map(({ id }) => id))).toHaveLength(2);
  });

  it('refuses to serialize libraries that exceed the public import contract', () => {
    // Given: one library exceeds the row limit and another exceeds the body limit.
    const excessiveLibrary = Array.from({ length: 1_001 }, (_, index) => ({
      ...snippet,
      id: `snippet-export-${index}`,
      trigger: `export-${index}`,
    }));
    const excessiveBody = [{ ...snippet, body: 'x'.repeat(1_048_577) }];

    // When: callers request backups that the public parser cannot restore.
    const serializeLibrary = () => serializeTextTransformers(excessiveLibrary);
    const serializeBody = () => serializeTextTransformers(excessiveBody);

    // Then: the serializer fails before emitting a non-importable backup.
    expect(serializeLibrary).toThrow(RangeError);
    expect(serializeBody).toThrow(RangeError);
  });

  it('measures the import payload limit in UTF-8 bytes', () => {
    // Given: a valid JSON payload is below the UTF-16 length limit but above five MiB as UTF-8.
    const emojiBody = '😀'.repeat(250_000);
    const oversizedUtf8 = JSON.stringify({
      version: 1,
      snippets: Array.from({ length: 6 }, (_, index) => ({
        ...snippet,
        id: `snippet-utf8-${index}`,
        trigger: `utf8-${index}`,
        body: emojiBody,
      })),
    });
    expect(oversizedUtf8.length).toBeLessThan(MAX_TEXT_TRANSFORMER_IMPORT_BYTES);
    expect(new TextEncoder().encode(oversizedUtf8).byteLength).toBeGreaterThan(
      MAX_TEXT_TRANSFORMER_IMPORT_BYTES,
    );

    // When: the payload crosses the parser boundary.
    const result = parseTextTransformerImport(oversizedUtf8);

    // Then: encoded bytes, rather than UTF-16 code units, enforce the resource budget.
    expect(result).toEqual({ ok: false, reason: 'invalid-snippets' });
  });

  it('uses one key for every reviewed Unicode simple-fold pair', () => {
    // Given: the reviewed pairs compare equal under the runtime matcher used for triggers.
    const pairs = [
      ['\u0345', '\u1fbe'],
      ['\u03f2', '\u03f9'],
      ['\u1c89', '\u1c8a'],
    ] as const;
    expect(pairs.every(([left, right]) => new RegExp(`^${left}$`, 'iu').test(right))).toBe(true);

    // When: each side is canonicalized independently.
    const keys = pairs.map(([left, right]) => [
      textTransformerTriggerKey(left),
      textTransformerTriggerKey(right),
    ]);

    // Then: key equality matches the trigger comparison contract.
    expect(keys.every(([left, right]) => left === right)).toBe(true);
  });

  it('rejects ids that exceed their bound after collision allocation', () => {
    // Given: two valid raw rows share an explicit id at the maximum accepted length.
    const maximumId = 'x'.repeat(512);
    const input = JSON.stringify({
      version: 1,
      snippets: [
        { ...snippet, id: maximumId, trigger: 'maximum-a' },
        { ...snippet, id: maximumId, trigger: 'maximum-b' },
      ],
    });

    // When: collision allocation appends a suffix during import normalization.
    const result = parseTextTransformerImport(input);

    // Then: the post-normalization row is rechecked and rejected instead of becoming unexportable.
    expect(result).toEqual({ ok: false, reason: 'invalid-snippets' });
  });

  it('accepts an importable serialized backup at the exact byte limit', () => {
    // Given: six bounded ASCII snippets are padded to the exact public payload limit.
    const rows = Array.from({ length: 6 }, (_, index) => ({
      ...snippet,
      id: `snippet-exact-${index}`,
      trigger: `exact-${index}`,
      body: '',
    }));
    const emptySize = new TextEncoder().encode(serializeTextTransformers(rows)).byteLength;
    const bodyBytes = MAX_TEXT_TRANSFORMER_IMPORT_BYTES - emptySize;
    const baseBodySize = Math.floor(bodyBytes / rows.length);
    const exactRows = rows.map((row, index) => ({
      ...row,
      body: 'x'.repeat(baseBodySize + (index < bodyBytes % rows.length ? 1 : 0)),
    }));

    // When: the exact-limit backup is serialized and parsed again.
    const serialized = serializeTextTransformers(exactRows);
    const result = parseTextTransformerImport(serialized);

    // Then: no extra byte is introduced and the public round trip succeeds.
    expect(new TextEncoder().encode(serialized).byteLength).toBe(
      MAX_TEXT_TRANSFORMER_IMPORT_BYTES,
    );
    expect(result).toMatchObject({ ok: true });
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
