import { describe, expect, it } from 'vitest';

import {
  MAX_RESOLVED_TEXT_TRANSFORMER_BODY_LENGTH,
  MAX_TEXT_TRANSFORMER_MATCHES,
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

  it('treats astral letters as complete trigger and boundary code points', () => {
    // Given: an astral Deseret letter appears both inside a trigger and before a custom prefix.
    const astralTransformers = [
      { trigger: '𐐀go', replacement: 'astral trigger' },
      { trigger: '::go', replacement: 'custom trigger' },
    ];

    // When: exact sequences and a sequence attached to an astral identifier are expanded.
    const result = expandTextTransformers(String.raw`\𐐀go 𐐀::go`, astralTransformers);

    // Then: the astral trigger receives its legacy slash and the attached custom prefix is rejected.
    expect(result).toBe('astral trigger 𐐀::go');
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
    const result = applyTextTransformerSelectionAtCursor(
      input,
      cursor,
      cursor,
      transformers[1],
      ' ',
    );

    // Then: the whole trigger is replaced without deleting the punctuation delimiter.
    expect(result).toEqual({
      text: 'Before 千万不要这样做 , after',
      cursor: 'Before 千万不要这样做 '.length,
      replaced: true,
    });
  });

  it('replaces the selected range consumed by a selection variable', () => {
    // Given: a snippet trigger is immediately followed by selected text.
    const input = String.raw`Before \wrapselected after`;
    const cursor = String.raw`Before \wrap`.length;
    const wrapper = {
      id: 'snippet-wrap',
      trigger: 'wrap',
      name: 'Wrap selection',
      body: '[{selection}]',
      enabled: true,
      tags: [],
    };

    // When: the explicit completion is applied with the selected value.
    const result = applyTextTransformerSelectionAtCursor(
      input,
      cursor,
      cursor + 'selected'.length,
      wrapper,
      ' ',
      { selection: 'selected' },
    );

    // Then: the trigger and selected range are replaced exactly once.
    expect(result).toEqual({
      text: 'Before [selected]  after',
      cursor: 'Before [selected] '.length,
      replaced: true,
    });
  });

  it('returns case-insensitive prefix matches for completion', () => {
    // Given: the user types a partial sequence at the cursor.
    const input = String.raw`Try \H`;

    // When: completion candidates are requested.
    const matches = findTextTransformerMatches(input, input.length, transformers);

    // Then: the configured sequence is offered with its complete snippet metadata.
    expect(matches).toEqual([
      {
        id: matches[0]?.id,
        trigger: 'hi',
        name: 'hi',
        body: '你好',
        enabled: true,
        tags: [],
      },
    ]);
  });

  it('caps broad completion results before the popup renders them', () => {
    // Given: a maximum-size library shares one broad trigger prefix.
    const largeLibrary = Array.from({ length: 1_000 }, (_, index) => ({
      trigger: `a${String(index).padStart(4, '0')}`,
      replacement: `Body ${index}`,
    }));

    // When: completion is requested for the shared prefix.
    const matches = findTextTransformerMatches(String.raw`\a`, 2, largeLibrary);

    // Then: only the bounded working set reaches the rendered list.
    expect(matches).toHaveLength(MAX_TEXT_TRANSFORMER_MATCHES);
  });

  it('rejects dynamic-variable expansion above the resolved body budget', () => {
    // Given: a compact body repeats a large selection beyond the output budget.
    const transformer = {
      trigger: 'amplify',
      replacement: '{selection}'.repeat(513),
    };
    const input = String.raw`\amplify`;
    const selection = 'x'.repeat(2_048);
    expect(selection.length * 513).toBeGreaterThan(MAX_RESOLVED_TEXT_TRANSFORMER_BODY_LENGTH);

    // When: explicit and send-boundary expansion resolve the body.
    const applied = applyTextTransformerAtCursor(input, input.length, [transformer], ' ', {
      selection,
    });
    const expanded = expandTextTransformers(input, [transformer], { selection });

    // Then: the original input remains unchanged instead of allocating an oversized result.
    expect(applied).toEqual({ text: input, cursor: input.length, replaced: false });
    expect(expanded).toBe(input);
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
    expect(result).toEqual([
      {
        id: result[0]?.id,
        trigger: 'hi',
        name: 'hi',
        body: 'second',
        enabled: true,
        tags: [],
      },
    ]);
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

  it('migrates legacy mappings into stable snippet metadata', () => {
    // Given: persisted v1 mappings only contain trigger and replacement.
    const legacy = [{ trigger: 'review', replacement: 'Review this change carefully.' }];

    // When: the same persisted value is normalized more than once.
    const first = normalizeTextTransformers(legacy);
    const second = normalizeTextTransformers(legacy);

    // Then: migration produces a complete snippet with a stable generated identity.
    expect(first).toEqual([
      {
        id: first[0]?.id,
        trigger: 'review',
        name: 'review',
        body: 'Review this change carefully.',
        enabled: true,
        tags: [],
      },
    ]);
    expect(first[0]?.id).toMatch(/^snippet-/);
    expect(second[0]?.id).toBe(first[0]?.id);
  });

  it('preserves snippet metadata and normalizes tags at the storage boundary', () => {
    // Given: a metadata-rich snippet contains duplicate and blank tags.
    const persisted = [
      {
        id: 'snippet-review',
        trigger: '::review',
        name: 'Review changes',
        body: 'Review the selected changes.',
        description: 'Checks correctness and regressions',
        enabled: false,
        tags: ['Review', ' review ', '', 'Quality'],
      },
    ];

    // When: persisted JSON crosses the storage boundary.
    const result = normalizeTextTransformers(persisted);

    // Then: metadata is retained while tags become a compact case-insensitive set.
    expect(result).toEqual([
      {
        id: 'snippet-review',
        trigger: '::review',
        name: 'Review changes',
        body: 'Review the selected changes.',
        description: 'Checks correctness and regressions',
        enabled: false,
        tags: ['Review', 'Quality'],
      },
    ]);
  });

  it('matches custom trigger prefixes and omits disabled snippets', () => {
    // Given: enabled and disabled snippets share a custom prefix.
    const snippets = normalizeTextTransformers([
      {
        id: 'snippet-review',
        trigger: '::review',
        name: 'Review',
        body: 'Review this.',
        enabled: true,
        tags: [],
      },
      {
        id: 'snippet-rewrite',
        trigger: '::rewrite',
        name: 'Rewrite',
        body: 'Rewrite this.',
        enabled: false,
        tags: [],
      },
    ]);

    // When: completion is requested for the custom prefix.
    const result = findTextTransformerMatches('Try ::re', 'Try ::re'.length, snippets);

    // Then: only the enabled matching snippet is offered.
    expect(result.map((snippet) => snippet.id)).toEqual(['snippet-review']);
  });

  it('resolves dynamic variables and places the cursor marker inside multiline bodies', () => {
    // Given: a snippet body uses every supported dynamic context variable.
    const snippet = normalizeTextTransformers([
      {
        id: 'snippet-context',
        trigger: 'context',
        name: 'Insert context',
        body: [
          '{selection}',
          '{clipboard}',
          '{activeFile}',
          '{cwd}',
          '{date} {time}',
          '{datetime}',
          '{uuid}{cursor}tail',
        ].join('\n'),
        enabled: true,
        tags: [],
      },
    ])[0];
    const input = String.raw`Before \con`;
    const now = new Date(2026, 7, 22, 10, 20, 30);

    // When: the user selects the completion with editor context available.
    const result = applyTextTransformerSelectionAtCursor(
      input,
      input.length,
      input.length,
      snippet!,
      '',
      {
        now,
        uuid: () => '00000000-0000-4000-8000-000000000000',
        clipboard: 'clipboard text',
        activeFile: '/repo/src/main.ts',
        cwd: '/repo',
        selection: 'selected text',
      },
    );

    // Then: variables resolve without executing code and the caret lands at the marker.
    const expectedPrefix = [
      'Before selected text',
      'clipboard text',
      '/repo/src/main.ts',
      '/repo',
      '2026-08-22 10:20:30',
      '2026-08-22 10:20:30',
      '00000000-0000-4000-8000-000000000000',
    ].join('\n');
    expect(result).toEqual({
      text: `${expectedPrefix}tail`,
      cursor: expectedPrefix.length,
      replaced: true,
    });
  });
});
