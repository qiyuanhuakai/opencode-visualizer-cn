import { describe, expect, it } from 'vitest';

import { guessLanguageFromPath } from './utils';

describe('guessLanguageFromPath', () => {
  it('maps fasta-family extensions to fasta grammar', () => {
    expect(guessLanguageFromPath('reads.fasta')).toBe('fasta');
    expect(guessLanguageFromPath('reads.fa')).toBe('fasta');
    expect(guessLanguageFromPath('reads.fna')).toBe('fasta');
    expect(guessLanguageFromPath('reads.faa')).toBe('fasta');
  });

  it('maps gtf-family extensions to gtf grammar', () => {
    expect(guessLanguageFromPath('genes.gtf')).toBe('gtf');
    expect(guessLanguageFromPath('genes.gff')).toBe('gtf');
    expect(guessLanguageFromPath('genes.gff3')).toBe('gtf');
  });
});
