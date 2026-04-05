import { describe, expect, it } from 'vitest';

import {
  contextSeverityClass,
  formatElapsedTime,
  formatMessageError,
  formatMessageTime,
  formatTokenCount,
} from './formatters';

describe('formatTokenCount', () => {
  it('formats edge and common values', () => {
    expect(formatTokenCount(-1)).toBe('0');
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(999)).toBe('999');
    expect(formatTokenCount(1500)).toBe('1.5K');
    expect(formatTokenCount(10_500)).toBe('11K');
    expect(formatTokenCount(2_000_000)).toBe('2.0M');
  });
});

describe('contextSeverityClass', () => {
  it('returns correct severity classes', () => {
    expect(contextSeverityClass(0)).toBe('ib-ctx-low');
    expect(contextSeverityClass(50)).toBe('ib-ctx-moderate');
    expect(contextSeverityClass(75)).toBe('ib-ctx-high');
    expect(contextSeverityClass(90)).toBe('ib-ctx-critical');
  });
});

describe('formatMessageTime', () => {
  it('handles invalid values', () => {
    expect(formatMessageTime(undefined)).toBe('');
    expect(formatMessageTime(NaN)).toBe('');
  });

  it('formats a valid date', () => {
    const ts = new Date('2024-01-15T09:05:00').getTime();
    expect(formatMessageTime(ts)).toBe('2024-01-15 09:05');
  });
});

describe('formatMessageError', () => {
  it('returns message for MessageAbortedError', () => {
    expect(formatMessageError({ name: 'MessageAbortedError', message: 'stop' })).toBe('stop');
  });

  it('uses custom translator for plain Error name', () => {
    const t = (key: string) => `[${key}]`;
    expect(formatMessageError({ name: 'Error', message: 'fail' }, t)).toBe('[common.error]: fail');
  });

  it('prefers original name when not plain Error', () => {
    expect(formatMessageError({ name: 'CustomError', message: 'details' })).toBe(
      'CustomError: details',
    );
  });

  it('falls back to generic error when both fields empty', () => {
    expect(formatMessageError({ name: '', message: '' })).toBe('common.error');
  });
});

describe('formatElapsedTime', () => {
  it('returns empty string for sub-second durations', () => {
    expect(formatElapsedTime(0, 499)).toBe('');
  });

  it('formats seconds', () => {
    expect(formatElapsedTime(0, 1000)).toBe('1s');
    expect(formatElapsedTime(0, 59_000)).toBe('59s');
  });

  it('formats minutes with remainder', () => {
    expect(formatElapsedTime(0, 90_000)).toBe('1m30s');
  });

  it('formats whole minutes', () => {
    expect(formatElapsedTime(0, 120_000)).toBe('2m');
  });

  it('returns empty when inputs are missing', () => {
    expect(formatElapsedTime(undefined as unknown as number, 1000)).toBe('');
  });
});
