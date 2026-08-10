import { describe, expect, it } from 'vitest';

import {
  applyTextTransformerAtCursor,
  applyTextTransformerSelectionAtCursor,
  expandTextTransformers,
  findTextTransformerMatches,
  getTextTransformerTriggerIssue,
  normalizeTextTransformers,
} from './textTransformers';

const transformers = [
  { trigger: 'hi', replacement: '你好' },
  { trigger: 'never', replacement: '千万不要这样做' },
] as const;

describe('text transformers', () => {
  it('expands every configured backslash sequence before sending', () => {
    // Given: a prompt contains configured and unknown sequences.
    const input = String.raw`Say \hi, then \never but keep \unknown`;

    // When: the prompt crosses the send boundary.
    const result = expandTextTransformers(input, transformers);

    // Then: configured sequences expand and unknown input remains byte-for-byte unchanged.
    expect(result).toBe(String.raw`Say 你好, then 千万不要这样做 but keep \unknown`);
  });

  it('expands before Unicode punctuation without matching identifier continuations', () => {
    // Given: configured sequences precede punctuation, letters, and connector punctuation.
    const input = String.raw`(\hi) "\hi" \hi- \hi。 \hi） but keep \high \hi_suffix \hi‿suffix`;

    // When: the prompt crosses the send boundary.
    const result = expandTextTransformers(input, transformers);

    // Then: punctuation delimits exact sequences while every identifier continuation stays unchanged.
    expect(result).toBe(
      String.raw`(你好) "你好" 你好- 你好。 你好） but keep \high \hi_suffix \hi‿suffix`,
    );
    expect(
      expandTextTransformers(String.raw`\hi_ \hi_suffix`, [
        { trigger: 'hi_', replacement: '下划线' },
      ]),
    ).toBe(String.raw`下划线 \hi_suffix`);
  });

  it('uses the regex case fold result without a locale-sensitive lookup', () => {
    // Given: configured triggers have locale-sensitive and Unicode simple-fold variants.
    const caseFoldTransformers = [
      { trigger: 'I', replacement: 'latin-i' },
      { trigger: 's', replacement: 'first-s' },
      { trigger: 'ſ', replacement: 'latin-s' },
    ];

    // When: the prompt uses the lowercase I and long-s forms accepted by the /iu regex.
    const result = expandTextTransformers(String.raw`\i \s \ſ`, caseFoldTransformers);

    // Then: both matched regex branches resolve to their configured replacements.
    expect(result).toBe('latin-i latin-s latin-s');
  });

  it('replaces only the exact sequence immediately before the cursor', () => {
    // Given: the cursor follows a configured sequence in the middle of a prompt.
    const input = String.raw`Before \hi after`;
    const cursor = String.raw`Before \hi`.length;

    // When: a delimiter triggers the transformer.
    const result = applyTextTransformerAtCursor(input, cursor, transformers, ' ');

    // Then: the replacement and delimiter are inserted without disturbing the suffix.
    expect(result).toEqual({
      text: 'Before 你好  after',
      cursor: 'Before 你好 '.length,
      replaced: true,
    });
  });

  it('leaves unmatched sequences unchanged at the cursor', () => {
    // Given: the cursor follows an unknown sequence.
    const input = String.raw`Keep \missing`;

    // When: a delimiter attempts expansion.
    const result = applyTextTransformerAtCursor(input, input.length, transformers, ' ');

    // Then: no replacement or delimiter is synthesized by the transformer.
    expect(result).toEqual({ text: input, cursor: input.length, replaced: false });
  });

  it('replaces the complete current token when a completion is selected mid-token', () => {
    // Given: the cursor sits inside a partially typed transformer token followed by punctuation.
    const input = String.raw`Before \ne|ver, after`.replace('|', '');
    const cursor = String.raw`Before \ne`.length;

    // When: the matching completion is selected.
    const result = applyTextTransformerSelectionAtCursor(input, cursor, transformers[1], ' ');

    // Then: the whole trigger is replaced without deleting the punctuation delimiter.
    expect(result).toEqual({
      text: 'Before 千万不要这样做 , after',
      cursor: 'Before 千万不要这样做 '.length,
      replaced: true,
    });
  });

  it('returns case-insensitive prefix matches for completion', () => {
    // Given: the user types a partial sequence at the cursor.
    const input = String.raw`Try \H`;

    // When: completion candidates are requested.
    const matches = findTextTransformerMatches(input, input.length, transformers);

    // Then: the configured sequence is offered with its replacement content.
    expect(matches).toEqual([{ trigger: 'hi', replacement: '你好' }]);
  });

  it('normalizes persisted mappings and keeps the final duplicate', () => {
    // Given: persisted JSON contains whitespace, a leading slash, duplicates, and malformed rows.
    const persisted = [
      { trigger: String.raw`\hi`, replacement: ' first ' },
      { trigger: 'hi', replacement: 'second' },
      { trigger: 'bad key', replacement: 'ignored' },
      { trigger: 42, replacement: 'ignored' },
    ];

    // When: the storage boundary parses the value.
    const result = normalizeTextTransformers(persisted);

    // Then: only a canonical, unambiguous mapping remains.
    expect(result).toEqual([{ trigger: 'hi', replacement: 'second' }]);
  });

  it('normalizes editable mappings before expanding at the send boundary', () => {
    // Given: live settings contain an empty draft, an invalid trigger, and duplicate rows.
    const editableTransformers = [
      { trigger: '', replacement: 'removed' },
      { trigger: 'bad key', replacement: 'invalid' },
      { trigger: 'dup', replacement: 'first' },
      { trigger: 'dup', replacement: 'last' },
    ];

    // When: a prompt crosses the send boundary before the editor is reloaded.
    const result = expandTextTransformers(
      String.raw`keep \ and \bad key but expand \dup`,
      editableTransformers,
    );

    // Then: drafts and invalid rows stay inert while the final duplicate wins.
    expect(result).toBe(String.raw`keep \ and \bad key but expand last`);
  });

  it('classifies invalid and duplicate transformer triggers', () => {
    // Given: editable mappings include a valid blank draft, an invalid name, and duplicates.
    const editableTransformers = [
      { trigger: '', replacement: '' },
      { trigger: 'bad key', replacement: 'ignored' },
      { trigger: 'Hi', replacement: 'first' },
      { trigger: 'hi', replacement: 'second' },
    ];

    // When: each editable row is validated.
    // Then: only malformed and case-insensitive duplicate names report an issue.
    expect(getTextTransformerTriggerIssue(editableTransformers, 0)).toBeNull();
    expect(getTextTransformerTriggerIssue(editableTransformers, 1)).toBe('invalid');
    expect(getTextTransformerTriggerIssue(editableTransformers, 2)).toBe('duplicate');
    expect(getTextTransformerTriggerIssue(editableTransformers, 3)).toBe('duplicate');
  });
});
