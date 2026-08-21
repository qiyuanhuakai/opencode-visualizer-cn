import { describe, expect, it } from 'vitest';

import { guessLanguageFromPath } from './utils';

const extensionCases = [
  ['ts', 'typescript'],
  ['tsx', 'tsx'],
  ['js', 'javascript'],
  ['cjs', 'javascript'],
  ['mjs', 'javascript'],
  ['jsx', 'jsx'],
  ['vue', 'vue'],
  ['svelte', 'svelte'],
  ['astro', 'astro'],
  ['json', 'json'],
  ['json5', 'json'],
  ['jsonc', 'json'],
  ['yml', 'yaml'],
  ['yaml', 'yaml'],
  ['toml', 'toml'],
  ['md', 'markdown'],
  ['mdc', 'markdown'],
  ['mdx', 'markdown'],
  ['html', 'html'],
  ['htm', 'html'],
  ['xml', 'xml'],
  ['svg', 'xml'],
  ['css', 'css'],
  ['scss', 'scss'],
  ['sass', 'sass'],
  ['less', 'less'],
  ['sh', 'shellscript'],
  ['bash', 'shellscript'],
  ['zsh', 'shellscript'],
  ['py', 'python'],
  ['pyw', 'python'],
  ['c', 'c'],
  ['cpp', 'cpp'],
  ['cc', 'cpp'],
  ['cxx', 'cpp'],
  ['h', 'cpp'],
  ['hpp', 'cpp'],
  ['hh', 'cpp'],
  ['java', 'java'],
  ['cs', 'csharp'],
  ['go', 'go'],
  ['rs', 'rust'],
  ['rb', 'ruby'],
  ['erb', 'ruby'],
  ['php', 'php'],
  ['pl', 'perl'],
  ['pm', 'perl'],
  ['lua', 'lua'],
  ['sql', 'sql'],
  ['dockerfile', 'dockerfile'],
  ['mk', 'makefile'],
  ['mak', 'makefile'],
  ['diff', 'diff'],
  ['patch', 'diff'],
  ['gql', 'graphql'],
  ['graphql', 'graphql'],
  ['regex', 'regex'],
  ['regexp', 'regex'],
  ['coffee', 'coffee'],
  ['coffeescript', 'coffee'],
  ['r', 'r'],
  ['jl', 'julia'],
  ['wasm', 'wasm'],
  ['wgsl', 'wgsl'],
  ['fasta', 'fasta'],
  ['fa', 'fasta'],
  ['fna', 'fasta'],
  ['faa', 'fasta'],
  ['fastq', 'fastq'],
  ['fq', 'fastq'],
  ['sam', 'sam'],
  ['vcf', 'vcf'],
  ['bed', 'bed'],
  ['gtf', 'gtf'],
  ['gff', 'gtf'],
  ['gff3', 'gtf'],
] as const;

describe('guessLanguageFromPath', () => {
  it.each(extensionCases)('maps .%s to %s grammar', (extension, language) => {
    // Given
    const path = `example.${extension}`;

    // When
    const result = guessLanguageFromPath(path);

    // Then
    expect(result).toBe(language);
  });

  it.each([
    ['Makefile', 'makefile'],
    ['PROJECT.MAKEFILE', 'makefile'],
    ['Dockerfile', 'dockerfile'],
    ['CONTAINER.DOCKERFILE', 'dockerfile'],
  ] as const)('maps extensionless %s names to %s grammar', (path, language) => {
    // When
    const result = guessLanguageFromPath(path);

    // Then
    expect(result).toBe(language);
  });

  it.each([undefined, '', 'README', 'archive.unknown'])(
    'falls back to text for unsupported path %s',
    (path) => {
      // When
      const result = guessLanguageFromPath(path);

      // Then
      expect(result).toBe('text');
    },
  );

  it('matches extensions without case sensitivity', () => {
    // When
    const result = guessLanguageFromPath('Component.TSX');

    // Then
    expect(result).toBe('tsx');
  });
});
