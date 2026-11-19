import { ProtocolError } from '../../shared/runtime/capabilities.js';
import { parseEvidenceHash, parseEvidenceOrigin, parseEvidenceRef, parseTarget } from '../../shared/runtime/context.js';
import type { EvidencePageView, EvidenceRecordView, ReadEvidencePageInput } from '../../shared/runtime/context.js';
import { hostObject, hostString } from './hostCollaborationViews';

export type EvidencePageRequest = Omit<ReadEvidencePageInput, 'readEvidence'>;
export type AsyncEvidencePageReader = (request: EvidencePageRequest) => Promise<EvidencePageView>;
export type EvidenceCaptureInput = { readonly kind: 'file' | 'diff'; readonly path: string };
export type AsyncEvidenceCapture = (input: EvidenceCaptureInput) => Promise<EvidenceRecordView | null>;

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ProtocolError('invalid_request', 'evidence.result.integer');
  return value;
}

export function hostEvidenceRecord(value: unknown): EvidenceRecordView {
  const raw = hostObject(value);
  const reference = parseEvidenceRef({ hash: raw.hash, bytes: raw.bytes, target: raw.target });
  return { ...reference, origin: parseEvidenceOrigin(raw.origin), at: integer(raw.at) };
}

export function hostEvidencePage(value: unknown): EvidencePageView {
  const raw = hostObject(value);
  if (raw.available === false) return { available: false, unavailableReason: hostString(raw.unavailableReason) };
  if (raw.available !== true || raw.encoding !== 'base64') throw new ProtocolError('invalid_request', 'evidence.result.encoding');
  const encoded = hostString(raw.data);
  if (encoded.length > 87384) throw new ProtocolError('invalid_request', 'evidence.result.size');
  let decoded: string;
  try { decoded = atob(encoded); } catch { throw new ProtocolError('invalid_request', 'evidence.result.base64'); }
  const offset = integer(raw.offset), length = integer(raw.length), totalBytes = integer(raw.totalBytes);
  const nextOffset = raw.nextOffset === null ? null : integer(raw.nextOffset);
  if (length !== decoded.length || length > 65536 || offset + length > totalBytes || nextOffset !== (offset + length < totalBytes ? offset + length : null)) throw new ProtocolError('invalid_request', 'evidence.result.bounds');
  return {
    available: true, hash: parseEvidenceHash(raw.hash), offset, length, totalBytes, nextOffset,
    bytes: Uint8Array.from(decoded, (character) => character.charCodeAt(0)), target: parseTarget(raw.target),
  };
}
