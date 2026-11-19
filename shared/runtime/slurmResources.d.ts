/**
 * The ONE Slurm resource normalizer, shared by the bridge and the renderer.
 *
 * Both realms ask these two functions what a resource expression means, so the answer cannot have
 * two owners. See `slurmResources.js` for why this lives in `shared/runtime/` rather than beside
 * the bridge.
 */
/** Parses a Slurm time limit into seconds. Accepts `mm`, `mm:ss`, `hh:mm:ss`, `d-hh`, `d-hh:mm`, `d-hh:mm:ss`. */
export function parseSlurmTime(value: unknown): number;
/** Parses a Slurm memory request into MiB (`2048`, `2048M`, `2G`, `1T`). */
export function parseSlurmMemory(value: string | number): number;
