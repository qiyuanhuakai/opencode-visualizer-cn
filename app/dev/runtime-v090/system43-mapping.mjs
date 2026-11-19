// Task 43 — THE ONE SOURCE of the old-feature mapping and the scenario catalog.
//
// The plan's acceptance criterion is "旧功能 mapping 每 row 有 observed scenario": every row of
// the old-feature mapping must carry an OBSERVED scenario, not a checkbox. This module is that
// mapping, and it is the ONLY place the rows are written (the task-39 one-source lesson: two
// realms must derive a shared value from ONE source). Its three consumers all read it from here:
//
//   * app/runtime/system.integration.test.ts loads it through createRequire (the repo's
//     established boundary for a .d.ts-less module, the same reason handoff.test.ts and
//     artifactIntegration.test.ts declare their own contracts) and asserts that every row the
//     SYSTEM lane owns names a scenario the test actually executed and recorded;
//   * scripts/qa/runtime-v090-system.mjs and scripts/qa/runtime-v090-faults.mjs import it
//     statically and assert the same completeness for the lane each of them drives, over the
//     scenario ids the lane really observed;
//   * app/dev/runtime-v090/task43.ts receives the rows through page.evaluate's argument (never a
//     second copy) so the browser realm proves the UI-owned rows against the scenarios IT drove.
//
// A row without a scenario is not a warning here — `assertMappingIntegrity` REFUSES it, and
// `mappingRowsWithoutScenario` reports exactly which rows an observed set fails to cover, so the
// named test can fail on the row rather than on a count.
import assert from 'node:assert/strict';

/**
 * Every old feature this plan replaces, one row each, with the scenario that OBSERVES its
 * replacement. `gap` is the plan's own GAP row, `is` the IS row the scenario proves, `lane` which
 * QA lane drives the observing scenario ('system' = the happy lane, 'faults' = the failure lane,
 * 'both' = observed in each lane on its own).
 */
export const OLD_FEATURE_MAPPING = Object.freeze([
  Object.freeze({
    id: 'GAP-1',
    gap: 'GAP-1',
    is: 'IS-1',
    lane: 'system',
    oldFeature: 'registry.ts activeBackendKind plus the OpenCode direct connection decided global behaviour, so the user picked a backend before reaching any session',
    newSurface: 'one entry, five sources: the unified session index over the real identity layer, one repository/worktree tree across every supported harness',
    scenario: 'SYS-02-five-source-unified-index',
  }),
  Object.freeze({
    id: 'GAP-2',
    gap: 'GAP-2',
    is: 'IS-2',
    lane: 'both',
    oldFeature: 'the OpenCode layer capped Global at 1000 and reported a full-tree completion even when a source failed, while Codex defaulted its active list to 50',
    newSurface: 'per-source discovery with explicit completeness and per-source failure isolation on the real discovery scheduler, so one failing source never reports the others complete',
    scenario: 'SYS-10-source-failure-isolation',
    negativeScenario: 'FLT-08-source-partial',
  }),
  Object.freeze({
    id: 'GAP-3',
    gap: 'GAP-3',
    is: 'IS-3',
    lane: 'both',
    oldFeature: 'BackendAdapter mixed workspace and harness operations and the native sessionId acted as a global key',
    newSurface: 'SessionRef {environmentId, harnessInstanceId, nativeSessionId} and the base64url SessionKey tuple, so the same native id on two hosts is two sessions',
    scenario: 'SYS-04-sessionref-identity',
    negativeScenario: 'FLT-09-same-id-across-hosts',
  }),
  Object.freeze({
    id: 'GAP-4',
    gap: 'GAP-4',
    is: 'IS-4',
    lane: 'both',
    oldFeature: 'Electron and browser history namespaces and endpoint ownership were separate and no Bridge-common database existed',
    newSurface: 'the legacy store is imported read-only into the unified store: the export revision is stable across every page and the source bytes never change',
    scenario: 'SYS-01-legacy-store-import',
    negativeScenario: 'FLT-10-legacy-import-target-switch',
  }),
  Object.freeze({
    id: 'GAP-5',
    gap: 'GAP-5',
    is: 'IS-5',
    lane: 'faults',
    oldFeature: 'there was no formal SSH/Slurm path, health carried no stable environment identity, and update judgement depended on the URL',
    newSurface: 'transport failures are typed at the real boundary (source_unavailable / reconcile_required) and the store re-opens against the same durable state root',
    scenario: 'FLT-05-transport-break',
  }),
  Object.freeze({
    id: 'GAP-6',
    gap: 'GAP-6',
    is: 'IS-7',
    lane: 'system',
    oldFeature: 'there was no Host Thread, no handoff and no durable collaboration object',
    newSurface: 'one Host Thread with two participants across two harnesses, the real handoff ladder, and the real team/fan-out services',
    scenario: 'SYS-05-thread-two-participants',
  }),
  Object.freeze({
    id: 'GAP-7',
    gap: 'GAP-7',
    is: 'IS-8',
    lane: 'system',
    oldFeature: 'only OpenCode had a native worktree and there was no source-common change review or integration',
    newSurface: 'the writer lease, the durable artifact and the serialized post-review integration over a real private git repository',
    scenario: 'SYS-08-artifact-integration',
  }),
  Object.freeze({
    id: 'GAP-8',
    gap: 'GAP-8',
    is: 'IS-2',
    lane: 'both',
    oldFeature: 'the history loader read every page, caches had no clear upper bound, and SEA/Electron worker packaging was split',
    newSurface: 'bounded paging over the real store with a bounded observer, so a slow consumer cannot grow the buffer without limit',
    scenario: 'SYS-11-bounded-paging',
    negativeScenario: 'FLT-07-slow-consumer',
  }),
]);

/** The IS user paths, each with the scenario that walks it end to end. */
export const IS_USER_PATHS = Object.freeze([
  Object.freeze({ is: 'IS-1', path: 'one connection browses every supported source by repository/worktree with the harness identity shown', scenario: 'SYS-02-five-source-unified-index' }),
  Object.freeze({ is: 'IS-2', path: 'sessions, worktrees and sources become progressively usable; a slow or failing source stays visible on its own', scenario: 'SYS-10-source-failure-isolation' }),
  Object.freeze({ is: 'IS-3', path: 'send, permission, model, attachment, cancel and history always belong to the right session and environment', scenario: 'SYS-04-sessionref-identity' }),
  Object.freeze({ is: 'IS-4', path: 'legacy history, drafts, pins and auxiliary metadata migrate completely with backup, retry, recovery and ambiguous binding', scenario: 'SYS-01-legacy-store-import' }),
  Object.freeze({ is: 'IS-5', path: 'local/direct/SSH/Slurm are usable and a disconnect is separated from a job exit', scenario: 'FLT-05-transport-break' }),
  Object.freeze({ is: 'IS-6', path: 'native capability is preserved and a missing capability, a source failure and a version mismatch are shown explicitly', scenario: 'SYS-10-source-failure-isolation' }),
  Object.freeze({ is: 'IS-7', path: 'one Host Thread joins several harnesses and hands off, with each native binding kept separate', scenario: 'SYS-06-thread-handoff-ladder' }),
  Object.freeze({ is: 'IS-8', path: 'fan-out, Lead/Worker and Team/Task/Attempt run concurrently with recovery, cancel, review and isolated change integration', scenario: 'SYS-08-artifact-integration' }),
]);

/**
 * The scenario catalog. `command` is the REAL command or check the scenario performs — the plan's
 * standing requirement that an attached command must actually be started/checked by the scenario,
 * never merely listed. `realm` says where it runs ('worker' = the QA worker / Vitest node realm,
 * 'browser' = a real headless Chromium over the case-owned Vite server).
 */
export const SYSTEM_SCENARIOS = Object.freeze([
  Object.freeze({ id: 'SYS-01-legacy-store-import', lane: 'system', realm: 'worker', command: 'openLegacyExport + readLegacyExportPage walk the real legacy store files through createBrowserLegacySourcePort, then resolveLegacyLocalBinding and bindLegacySource bind every history record', surface: 'shared/runtime/migration/legacyExport.js + app/runtime/migration/browserSourcePort.ts over real legacy store files' }),
  Object.freeze({ id: 'SYS-02-five-source-unified-index', lane: 'system', realm: 'worker', command: 'every bound legacy session of all five harnesses is encoded with encodeSessionKey and round-tripped through encodeFrame/decodeFrame against the independent seed090 oracle', surface: 'shared/runtime/identity.js + shared/runtime/protocol.js over app/dev/runtime-v090/fixtures/inventory.mjs' }),
  Object.freeze({ id: 'SYS-03-workspace-repo-merge', lane: 'system', realm: 'worker', command: 'two worktrees of one repository and one orphan workspace are encoded with encodeWorkspaceKey/encodeRepoKey and merge on the canonical common-dir', surface: 'shared/runtime/identity.js path tuples over the seed090 worktree fixture' }),
  Object.freeze({ id: 'SYS-04-sessionref-identity', lane: 'system', realm: 'worker', command: 'the same nativeSessionId under two harnessInstanceIds of one environment parses to two SessionRefs with two different SessionKeys', surface: 'shared/runtime/identity.js parseSessionRef/encodeSessionKey' }),
  Object.freeze({ id: 'SYS-05-thread-two-participants', lane: 'system', realm: 'worker', command: 'createThreadService binds one session and joins a second from another harness, and each participant keeps its own native history', surface: 'bridge/runtime/threads/threadService.js + participantService.js' }),
  Object.freeze({ id: 'SYS-06-thread-handoff-ladder', lane: 'system', realm: 'worker', command: 'createHandoffService walks begin -> attach -> prepare -> deliver -> observe over the real checkpoint service, and restoreOriginalSelection returns the selection', surface: 'bridge/runtime/threads/handoffService.js + handoffRecovery.js + checkpointService.js' }),
  Object.freeze({ id: 'SYS-07-team-fanout', lane: 'system', realm: 'worker', command: 'createCollaborationCoordinator opens a team across three harnesses and createFanoutService fans one prompt out to two recipients with per-recipient recovery', surface: 'bridge/runtime/collaboration/coordinator.js + fanoutService.js' }),
  Object.freeze({ id: 'SYS-08-artifact-integration', lane: 'system', realm: 'worker', command: 'writerLeases.allocate against a real private git repository, artifacts.capture, reviews.approve and integration.integrate apply the change and fast-forward the target', surface: 'bridge/runtime/collaboration/{writerLeases,artifactStore,artifactService,integrationReview,repositoryLocks,integrationService}.js over a real private git repository' }),
  Object.freeze({ id: 'SYS-09-restart-continuation', lane: 'system', realm: 'worker', command: 'createRuntimeStore writes an entity, the worker is terminated with SIGKILL, and a second store over the same state root reads the entity back byte-identically', surface: 'bridge/runtime/storage/runtimeStore.js + runtimeDatabaseWorker.mjs (real node:sqlite)' }),
  Object.freeze({ id: 'SYS-10-source-failure-isolation', lane: 'system', realm: 'worker', command: 'createDiscoveryScheduler schedules all five sources; two actions reject source_unavailable and the other three still settle, then a later demand still runs', surface: 'bridge/runtime/discoveryScheduler.js' }),
  Object.freeze({ id: 'SYS-11-bounded-paging', lane: 'system', realm: 'worker', command: 'the real store pages a collection with limit 100 and the paging cursor terminates, with every row read back under the store page budget', surface: 'bridge/runtime/storage/runtimeStore.js page/get' }),
  Object.freeze({ id: 'SYS-12-migration-hash-unchanged', lane: 'system', realm: 'worker', command: 'sha256 of every legacy store file before the import walk equals sha256 after it, and the export revision is identical across two opens and every page', surface: 'node:crypto over the real legacy store files + legacyExport.js revision' }),
]);

export const FAULT_SCENARIOS = Object.freeze([
  Object.freeze({ id: 'FLT-01-store-kill', lane: 'faults', realm: 'worker', command: 'the real store worker is killed with SIGKILL mid-request; pending callers reject reconcile_required/worker_exit and later callers reject source_unavailable/store_closed', surface: 'bridge/runtime/storage/runtimeStore.js terminate()' }),
  Object.freeze({ id: 'FLT-02-native-kill', lane: 'faults', realm: 'worker', command: 'a real native producer child process is killed with SIGKILL; the intake marks the source failed and the other sources keep their sessions', surface: 'bridge/runtime/nativeEventIntake.js over a real spawned child process' }),
  Object.freeze({ id: 'FLT-03-manager-kill', lane: 'faults', realm: 'worker', command: 'the manager process group is killed; the connection scope releases every owned resource and a reconnect re-derives the same durable state', surface: 'bridge/runtime/connectionScope.js + resourceOwnership.js over a real spawned process group' }),
  Object.freeze({ id: 'FLT-04-ui-disconnect', lane: 'faults', realm: 'browser', command: 'the client WebSocket is closed under the real connection; pending requests settle as typed errors and no duplicate send is issued after reconnect', surface: 'app/runtime/connection.ts + client.ts over a controlled socket in a real headless Chromium' }),
  Object.freeze({ id: 'FLT-05-transport-break', lane: 'faults', realm: 'worker', command: 'the SSH transport refuses a changed host key and reports a typed failure instead of connecting', surface: 'bridge/runtime/transports/sshTransport.js + knownHosts.js' }),
  Object.freeze({ id: 'FLT-06-relay-break', lane: 'faults', realm: 'worker', command: 'the relay step dies before the handshake completes and the transport reports a typed failure with no silent success', surface: 'bridge/runtime/transports/relayHandshake.js + computeRelay.js' }),
  Object.freeze({ id: 'FLT-07-slow-consumer', lane: 'faults', realm: 'worker', command: 'an observer that never reads is closed by the store; the observer set returns to empty and the writer is not blocked forever', surface: 'bridge/runtime/storage/runtimeStore.js observers + bridge/runtime/eventObservers.js' }),
  Object.freeze({ id: 'FLT-08-source-partial', lane: 'faults', realm: 'worker', command: 'one source reports completeness partial with a reason while the others report complete, and the run never reports a full completion', surface: 'bridge/runtime/discoveryScheduler.js + the completeness vocabulary' }),
  Object.freeze({ id: 'FLT-09-same-id-across-hosts', lane: 'faults', realm: 'worker', command: 'two harnesses report the same nativeSessionId; the two SessionRefs stay distinct and neither session is merged or overwritten', surface: 'shared/runtime/identity.js parseSessionRef/encodeSessionKey' }),
  Object.freeze({ id: 'FLT-10-legacy-import-target-switch', lane: 'faults', realm: 'worker', command: 'a real import batch naming a second environment is refused target_changed by the real import service and the staged manifest is unchanged', surface: 'bridge/runtime/migration/importService.js + manifest.js over the real runtime store' }),
]);

export const SCENARIO_CATALOG = Object.freeze([...SYSTEM_SCENARIOS, ...FAULT_SCENARIOS]);

/**
 * Structural integrity of the mapping itself. A row without an observed scenario, a duplicate row
 * id, a scenario that is not in the catalog, or a row whose lane is unknown is REFUSED here — this
 * is the rule the named test proves, so the rule lives beside the data it governs.
 */
export function assertMappingIntegrity(mapping = OLD_FEATURE_MAPPING, catalog = SCENARIO_CATALOG) {
  assert(Array.isArray(mapping) && mapping.length > 0, 'old-feature mapping is empty');
  const catalogIds = new Set(catalog.map((scenario) => scenario.id));
  const rowIds = new Set();
  for (const row of mapping) {
    assert(row !== null && typeof row === 'object' && !Array.isArray(row), 'mapping row must be an object');
    for (const key of ['id', 'gap', 'is', 'lane', 'oldFeature', 'newSurface', 'scenario']) {
      assert(typeof row[key] === 'string' && row[key].length > 0, `mapping row ${String(row.id)} is missing ${key}`);
    }
    assert(!rowIds.has(row.id), `duplicate mapping row ${row.id}`);
    rowIds.add(row.id);
    assert(['system', 'faults', 'both'].includes(row.lane), `mapping row ${row.id} has an unknown lane ${row.lane}`);
    assert(catalogIds.has(row.scenario), `mapping row ${row.id} names a scenario outside the catalog: ${row.scenario}`);
    if (row.negativeScenario !== undefined) {
      assert(typeof row.negativeScenario === 'string' && catalogIds.has(row.negativeScenario), `mapping row ${row.id} names a negative scenario outside the catalog`);
    }
  }
  const seen = new Set();
  for (const scenario of catalog) {
    assert(!seen.has(scenario.id), `duplicate catalog scenario ${scenario.id}`);
    seen.add(scenario.id);
    assert(typeof scenario.command === 'string' && scenario.command.length > 0, `catalog scenario ${scenario.id} has no real command`);
  }
  return { rows: mapping.length, catalog: catalog.length };
}

/**
 * The rows a lane must cover, and the rows an observed scenario set fails to cover. A row is
 * covered only when its scenario (and, when it declares one, its negative scenario) was really
 * observed — a checkbox can never satisfy this, because the observed set is built from executed
 * scenarios.
 */
export function mappingRowsWithoutScenario(mapping = OLD_FEATURE_MAPPING, observed = new Set(), lane = 'system', catalog = SCENARIO_CATALOG) {
  const seen = observed instanceof Set ? observed : new Set(observed ?? []);
  const laneOf = new Map(catalog.map((scenario) => [scenario.id, scenario.lane]));
  // The scenarios THIS lane owns for one row. A `both` row's happy scenario belongs to the system
  // lane and its negative scenario to the faults lane, so a single lane is complete exactly when
  // every scenario the catalog assigns to THAT lane was really observed — otherwise no single lane
  // could ever be complete and the check would be unsatisfiable by construction.
  const requiredFor = (row) => [row.scenario, row.negativeScenario]
    .filter((id) => typeof id === 'string' && id.length > 0 && (lane === 'both' || laneOf.get(id) === lane));
  return mapping
    .filter((row) => lane === 'both' || row.lane === lane || row.lane === 'both')
    .filter((row) => requiredFor(row).some((id) => !seen.has(id)))
    .map((row) => ({
      id: row.id, lane: row.lane, scenario: row.scenario,
      negativeScenario: row.negativeScenario ?? null,
      required: requiredFor(row),
      missing: requiredFor(row).filter((id) => !seen.has(id)),
    }));
}

/** The completeness assertion both lanes and the integration test call, over their own observed set. */
export function assertMappingComplete(mapping = OLD_FEATURE_MAPPING, observed = new Set(), lane = 'system', catalog = SCENARIO_CATALOG) {
  const integrity = assertMappingIntegrity(mapping, catalog);
  const missing = mappingRowsWithoutScenario(mapping, observed, lane);
  assert.deepEqual(missing, [], `old-feature mapping rows without an observed scenario (${lane} lane)`);
  return { ...integrity, lane, observed: [...(observed instanceof Set ? observed : new Set(observed ?? []))].sort() };
}
