// The ONE Slurm resource normalizer, shared by the bridge and the renderer.
//
// `parseSlurmTime` and `parseSlurmMemory` decide what a resource EXPRESSION means: `8G` is 8192
// MiB, `60` is 3600 seconds, `2-01:00:00` is 176400 seconds. That decision has exactly one owner,
// and it lives here because BOTH realms must be able to ask it:
//
//   * the bridge (`bridge/runtime/transports/slurmJobs.js`) normalizes a request before it is
//     written into an `sbatch` script and before it is echoed back as a `SlurmResourcePreview`;
//   * the renderer must decide whether a preview it is holding still describes the request on
//     screen, which means asking the SAME normalizer what that request means.
//
// A second copy of these two functions in the renderer would be a second truth for one value, and
// the two would drift: `parseInt('8G')` is 8 while the bridge reads 8192 MiB, so a preview
// answering `8` still looked like a match after the field became `8G`, and a correct 8192 MiB
// preview was refused as stale. That is why this module exists in `shared/runtime/` (importable
// from Node and from a browser bundle) rather than beside the bridge, whose module graph pulls
// `node:crypto` / `node:fs` and cannot be loaded by a renderer at all.
//
// The bridge re-exports both functions from here, so `slurmJobs.js` keeps its public surface and
// there is still exactly ONE implementation. Nothing here is re-derived anywhere else.
import { ProtocolError, requireValue, textValue } from './capabilities.js';

/** Parses a Slurm time limit into seconds. Accepts `mm`, `mm:ss`, `hh:mm:ss`, `d-hh`, `d-hh:mm`, `d-hh:mm:ss`. */
export function parseSlurmTime(value) {
  const text = textValue(value, 'resources.time');
  const match = /^(?:(\d+)-)?(?:(\d+)(?::(\d+))?(?::(\d+))?)$/u.exec(text);
  if (match === null) throw new ProtocolError('invalid_request', 'resources.time');
  const days = match[1] === undefined ? 0 : Number(match[1]);
  const first = Number(match[2]);
  const second = match[3] === undefined ? 0 : Number(match[3]);
  const third = match[4] === undefined ? 0 : Number(match[4]);
  if (second > 59 || third > 59) throw new ProtocolError('invalid_request', 'resources.time');
  // Without a day prefix the units are minutes / minutes:seconds / hours:minutes:seconds.
  // With a day prefix they are days-hours / days-hours:minutes / days-hours:minutes:seconds.
  let seconds;
  if (match[1] === undefined) {
    if (match[4] !== undefined) seconds = first * 3600 + second * 60 + third;
    else if (match[3] !== undefined) seconds = first * 60 + second;
    else seconds = first * 60;
  } else {
    seconds = days * 86400 + first * 3600 + second * 60 + third;
  }
  requireValue(Number.isSafeInteger(seconds) && seconds > 0, 'resources.time');
  return seconds;
}

/** Parses a Slurm memory request into MiB (`2048`, `2048M`, `2G`, `1T`). */
export function parseSlurmMemory(value) {
  const text = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  const match = /^(\d+)([KMGTP])?$/iu.exec(text);
  if (match === null) throw new ProtocolError('invalid_request', 'resources.memory');
  const amount = Number(match[1]);
  const unit = (match[2] ?? 'M').toUpperCase();
  const factor = { K: 1 / 1024, M: 1, G: 1024, T: 1024 * 1024, P: 1024 * 1024 * 1024 }[unit];
  const mebibytes = Math.ceil(amount * factor);
  requireValue(Number.isSafeInteger(mebibytes) && mebibytes > 0, 'resources.memory');
  return mebibytes;
}
