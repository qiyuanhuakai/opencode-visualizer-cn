/**
 * dsh web wire fixtures loader.
 *
 * Mirrors the kimiWeb fixture convention (app/backends/kimiWeb/fixtures/):
 *   - `*.jsonl` bodies stay pure JSON lines (one wire frame per line, no comments),
 *   - version + capture metadata lives in the `<name>.meta.json` sidecar, which
 *     this loader reads and version-gates against the contract in `./types`.
 *
 * Todos 4/5/18 (RPC client, mux client, normalizer) consume fixtures through
 * `loadDshWireFixture`, so the version gate is enforced at load time: a stale
 * or missing `dsh@0.2.0-rc.2` stamp fails loudly instead of silently feeding
 * mismatched shapes into the adapter.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DSH_WIRE_VERSION,
  DshWireParseError,
  type DshMuxFrame,
  parseDshWireLine,
} from './types';

/** Sidecar metadata committed next to every captured fixture. */
export type DshFixtureMeta = {
  readonly dshVersion: string;
  readonly capturedAt: string;
  readonly captureEndpoint: string;
  readonly source: string;
  readonly frames: number;
  readonly [key: string]: unknown;
};

/** One loaded fixture: version-gated metadata plus parsed wire frames. */
export type DshLoadedFixture = {
  readonly name: string;
  readonly meta: DshFixtureMeta;
  readonly frames: readonly DshMuxFrame[];
};

// import.meta.url is http-served under Vitest; resolve fixtures from the working directory.
const FIXTURES_DIR = [
  join(process.cwd(), 'app', 'backends', 'dsh', 'fixtures'),
  join(process.cwd(), 'backends', 'dsh', 'fixtures'),
].find((directory) => existsSync(directory)) ?? join(process.cwd(), 'app', 'backends', 'dsh', 'fixtures');

export function dshFixturePath(name: string): string {
  return join(FIXTURES_DIR, name);
}

export function dshFixtureMetaPath(name: string): string {
  return dshFixturePath(name.replace(/\.jsonl$/, '.meta.json'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate one sidecar payload and enforce the version stamp.
 * Throws a classified `DshWireParseError` when the stamp is missing or stale.
 */
export function assertDshFixtureMeta(value: unknown, name: string): DshFixtureMeta {
  if (!isRecord(value)) {
    throw new DshWireParseError('fixture-unreadable', `dsh fixture ${name}: meta sidecar is not an object`, value);
  }
  if (value.dshVersion !== DSH_WIRE_VERSION) {
    throw new DshWireParseError(
      'version-mismatch',
      `dsh fixture ${name}: captured against ${JSON.stringify(value.dshVersion)}, contract anchors ${DSH_WIRE_VERSION}; re-capture before use`,
      value,
    );
  }
  if (typeof value.capturedAt !== 'string' || Number.isNaN(Date.parse(value.capturedAt))) {
    throw new DshWireParseError('fixture-unreadable', `dsh fixture ${name}: meta sidecar has no valid capturedAt`, value);
  }
  if (typeof value.captureEndpoint !== 'string' || value.captureEndpoint.length === 0) {
    throw new DshWireParseError('fixture-unreadable', `dsh fixture ${name}: meta sidecar has no captureEndpoint`, value);
  }
  if (typeof value.source !== 'string' || value.source.length === 0) {
    throw new DshWireParseError('fixture-unreadable', `dsh fixture ${name}: meta sidecar has no source`, value);
  }
  if (typeof value.frames !== 'number' || !Number.isInteger(value.frames) || value.frames < 1) {
    throw new DshWireParseError('fixture-unreadable', `dsh fixture ${name}: meta sidecar has no frame count`, value);
  }
  return value as DshFixtureMeta;
}

/** Read and version-gate the `<name>.meta.json` sidecar of a fixture. */
export function readDshFixtureMeta(name: string): DshFixtureMeta {
  const path = dshFixtureMetaPath(name);
  if (!existsSync(path)) {
    throw new DshWireParseError('fixture-unreadable', `dsh fixture ${name}: missing ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new DshWireParseError('fixture-unreadable', `dsh fixture ${name}: meta sidecar is not JSON: ${String(cause)}`);
  }
  return assertDshFixtureMeta(parsed, name);
}

/**
 * Load one fixture: version-gated sidecar plus every JSONL line parsed as a mux
 * frame. Malformed lines throw a classified `DshWireParseError` from
 * `parseDshWireLine` (never silently skipped).
 */
export function loadDshWireFixture(name: string): DshLoadedFixture {
  const meta = readDshFixtureMeta(name);
  const raw = readFileSync(dshFixturePath(name), 'utf8');
  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length !== meta.frames) {
    throw new DshWireParseError(
      'fixture-unreadable',
      `dsh fixture ${name}: sidecar declares ${meta.frames} frames but body carries ${lines.length}`,
    );
  }
  const frames = lines.map((line) => parseDshWireLine(line));
  return { name, meta, frames };
}
