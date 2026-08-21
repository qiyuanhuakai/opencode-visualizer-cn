import type { Ref } from 'vue';

export interface ReconcileDialogRequestsOptions<T, E> {
  /** Maps a request to the stable dialog id used for stale-entry removal. */
  encodeId: (request: T) => string;
  /** Converts a request into the entry shape consumed by `upsert`. */
  normalize: (request: T) => E;
  /** Creates or updates the dialog entry for a current request. */
  upsert: (entry: E) => void;
  /** Removes the dialog entry for a stale id. */
  remove: (id: string) => void;
  /** The tracked set of live dialog ids; replaced with the next id set. */
  ids: Ref<Set<string>>;
}

/**
 * Reconciles dialog entries against the current request list with a fixed
 * order: stale entries are removed first, then every current request is
 * upserted, then the tracked id set is replaced. Shared by the App.vue deep
 * watchers that reconcile permission/structured/question dialog ids.
 */
export function reconcileDialogRequests<T, E>(
  requests: readonly T[],
  options: ReconcileDialogRequestsOptions<T, E>,
): void {
  const nextIds = new Set(requests.map(options.encodeId));
  options.ids.value.forEach((id) => {
    if (!nextIds.has(id)) options.remove(id);
  });
  requests.forEach((request) => options.upsert(options.normalize(request)));
  options.ids.value = nextIds;
}
